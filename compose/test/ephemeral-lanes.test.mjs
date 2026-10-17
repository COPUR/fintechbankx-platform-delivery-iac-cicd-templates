// Runner choice, lanes, memory plan and the legacy open-finance host of the ephemeral environment
// (WP-7a: the environment runs on the self-hosted fbx-ci-env VM, which has at most 12 GiB).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

// Every temporary directory this file makes lives under tmpRoot, removed when its tests end.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fbx-test-"));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const composeDir = path.join(repo, "compose");
const workflow = () => YAML.parse(fs.readFileSync(path.join(repo, ".github", "workflows", "ephemeral-env.yml"), "utf8"));
const compose = () => YAML.parse(fs.readFileSync(path.join(composeDir, "docker-compose.yml"), "utf8")).services;
const stepNamed = (re) => workflow().jobs.ephemeral.steps.find((s) => re.test(s.name ?? ""));
const lanes = () =>
  Object.fromEntries(
    fs.readFileSync(path.join(composeDir, "lanes.tsv"), "utf8").split("\n")
      .filter((l) => l && !l.startsWith("#")).map((l) => l.split("\t")).map(([lane, profiles]) => [lane, profiles]),
  );
// A clean environment: no FBX_*_MEM_LIMIT override from the caller's shell.
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^FBX_.*MEM_LIMIT$/.test(k)));
// The compose model as JSON, as `docker compose config --format json` gives it to the script
// (here not interpolated: the script reads ${VAR:-default} in mem_limit from the environment).
const composeJson = () => {
  const file = path.join(fs.mkdtempSync(path.join(tmpRoot, "fbx-plan-")), "compose.json");
  fs.writeFileSync(file, JSON.stringify({ services: compose() }));
  return file;
};
const plan = (profiles, extra = [], env = {}) => {
  const res = spawnSync("node", [path.join(composeDir, "scripts", "plan-memory.mjs"), "--config", composeJson(), "--profiles", profiles, "--json", ...extra],
    { encoding: "utf8", env: { ...cleanEnv(), ...env } });
  return { ...res, json: res.status === 0 || res.status === 1 ? JSON.parse(res.stdout || "{}") : {} };
};
const GIB12_BUDGET = 12 * 1024 - 1024; // a 12 GiB VM less 1 GiB for the OS and the Docker daemon

test("runner: an input, then the caller's CI_RUNNER_ENV variable, then ubuntu-latest", () => {
  const wf = workflow();
  const input = wf.on.workflow_call.inputs.runner;
  assert.equal(input.type, "string");
  assert.equal(input.default, "");
  assert.equal(wf.jobs.ephemeral["runs-on"], "${{ inputs.runner || vars.CI_RUNNER_ENV || 'ubuntu-latest' }}");
});

test("lanes: three lanes of existing compose profiles, each a working subset", () => {
  const l = lanes();
  assert.deepEqual(Object.keys(l).sort(), ["lending", "openfinance", "payments"]);
  assert.equal(l.lending, "lending customer riskcompliance");
  assert.equal(l.payments, "payments");
  assert.equal(l.openfinance, "openfinance");
  const known = new Set(Object.values(compose()).flatMap((s) => s.profiles ?? []));
  for (const [lane, profiles] of Object.entries(l)) {
    for (const p of profiles.split(" ")) assert.ok(known.has(p), `${lane}: unknown profile ${p}`);
  }
});

test("every container has a memory limit, so the plan covers the whole stack", () => {
  for (const [name, svc] of Object.entries(compose())) {
    assert.match(String(svc.mem_limit ?? ""), /^\$\{FBX_[A-Z_]+_MEM_LIMIT:-\d+[mg]\}$/, `${name} needs mem_limit \${FBX_..._MEM_LIMIT:-<n>m}`);
  }
});

test("memory plan: each lane with the monolith and parity actors fits a 12 GiB VM; all 15 services do not", () => {
  for (const [lane, profiles] of Object.entries(lanes())) {
    const p = plan(`${profiles} monolith parity-fixtures`, ["--budget-mib", String(GIB12_BUDGET)]);
    assert.equal(p.status, 0, `${lane}: ${p.stderr}`);
    assert.ok(p.json.peakMiB <= GIB12_BUDGET, `${lane}: ${p.json.peakMiB} MiB`);
    assert.ok(p.json.peakMiB >= p.json.steadyMiB);
  }
  const all = plan("services monolith parity-fixtures", ["--budget-mib", String(GIB12_BUDGET)]);
  assert.equal(all.status, 1, "all 15 services and the monolith exceed the budget");
  assert.match(all.stderr, /exceeds the memory budget/);
});

test("memory plan: one-shot jobs count only while they can run beside the long-running containers", () => {
  const p = plan("payments monolith parity-fixtures");
  assert.equal(p.status, 0, p.stderr);
  const byName = Object.fromEntries(p.json.containers.map((c) => [c.name, c]));
  assert.equal(byName["realm-import"].oneShot, true);
  assert.equal(byName["payment-initiation-settlement-service"].oneShot, false);
  assert.ok(!byName["mongo"], "mongo is not in the payments lane");
  // Migrations run beside services that do not wait for them, but never beside their own service.
  const peakSet = new Set(p.json.peakSet);
  assert.ok(!(peakSet.has("customer-profile-kyc-service-migrate") && peakSet.has("customer-profile-kyc-service")));
  // Overrides from the environment are honoured.
  const small = plan("payments", [], { FBX_SERVICE_MEM_LIMIT: "512m" });
  const big = plan("payments");
  assert.ok(small.json.steadyMiB < big.json.steadyMiB);
});

test("memory plan: the workflow plans before it starts the stack and passes the budget input", () => {
  const wf = workflow();
  const budget = wf.on.workflow_call.inputs["memory-budget-mib"];
  assert.equal(budget.type, "number");
  assert.equal(budget.default, 0);
  const steps = wf.jobs.ephemeral.steps;
  const planIdx = steps.findIndex((s) => /memory/i.test(s.name ?? ""));
  const upIdx = steps.findIndex((s) => /Start stack/.test(s.name ?? ""));
  assert.ok(planIdx >= 0 && planIdx < upIdx, "memory plan before the stack starts");
  assert.match(steps[planIdx].run, /plan-memory\.mjs/);
  assert.equal(steps[planIdx].env.MEMORY_BUDGET_MIB, "${{ inputs.memory-budget-mib }}");
});

test("lane input: resolved from lanes.tsv in the validate step; lane and a non-default profiles are exclusive", () => {
  const wf = workflow();
  const lane = wf.on.workflow_call.inputs.lane;
  assert.equal(lane.type, "string");
  assert.equal(lane.default, "");
  for (const l of Object.keys(lanes())) assert.match(lane.description, new RegExp(`\\b${l}\\b`));
  const validate = stepNamed(/^Validate inputs/);
  assert.equal(validate.env.LANE, "${{ inputs.lane }}");
  const run = (env) => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "fbx-lane-"));
    const script = validate.run
      // only the lane and profile part of the step: stop before the service env renderer
      .split("# Extra service environment")[0];
    const res = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: { ...process.env, MODE: "compose", SERVICE_IMAGES: "", MONOLITH_IMAGE: "", MONOLITH_BUILD_CONTEXT: "", MONOLITH_HEALTH_PATH: "/actuator/health",
        MONOLITH_PROFILES: "local", PARITY_FIXTURES: "false", LEGACY_OF_HOST: "monolith", FBX_COMPOSE: composeDir, GITHUB_ENV: path.join(dir, "env"), ...env },
    });
    fs.writeFileSync(path.join(dir, "env"), "", { flag: "a" });
    return { ...res, env: fs.readFileSync(path.join(dir, "env"), "utf8") };
  };
  const ok = run({ LANE: "payments", REQUESTED_PROFILES: "services" });
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  assert.match(ok.env, /^FBX_PROFILES_RESOLVED=payments$/m);
  const lending = run({ LANE: "lending", REQUESTED_PROFILES: "services", MONOLITH_IMAGE: "registry.example/elms/monolith@sha256:" + "a".repeat(64) });
  assert.equal(lending.status, 0, lending.stderr + lending.stdout);
  assert.match(lending.env, /^FBX_PROFILES_RESOLVED=lending customer riskcompliance monolith$/m);
  const both = run({ LANE: "payments", REQUESTED_PROFILES: "lending" });
  assert.notEqual(both.status, 0);
  assert.match(both.stdout, /lane or profiles, not both/);
  const unknown = run({ LANE: "everything", REQUESTED_PROFILES: "services" });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stdout, /unknown lane/);
  const badHost = run({ LANE: "", REQUESTED_PROFILES: "services", LEGACY_OF_HOST: "evil host;rm" });
  assert.notEqual(badHost.status, 0);
  assert.match(badHost.stdout, /legacy-open-finance-host/);
});

test("legacy open-finance host: the monolith container by default (K4), exported to the seed and test commands", () => {
  const wf = workflow();
  const input = wf.on.workflow_call.inputs["legacy-open-finance-host"];
  assert.equal(input.type, "string");
  assert.equal(input.default, "monolith");
  const step = stepNamed(/Export test environment/);
  assert.equal(step.env.LEGACY_OF_HOST, "${{ inputs.legacy-open-finance-host }}");
  const exportWith = (env) => {
    const out = path.join(fs.mkdtempSync(path.join(tmpRoot, "fbx-legacy-")), "github.env");
    const res = spawnSync("bash", ["-c", step.run], { encoding: "utf8", env: { ...process.env, FBX_COMPOSE: composeDir, GITHUB_ENV: out, ...env } });
    assert.equal(res.status, 0, res.stderr);
    return Object.fromEntries(fs.readFileSync(out, "utf8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  };
  const monolithPort = fs.readFileSync(path.join(composeDir, "services.tsv"), "utf8").split("\n").find((l) => l.startsWith("monolith\t")).split("\t")[8];
  const withMonolith = exportWith({ LEGACY_OF_HOST: "monolith", FBX_PROFILES_RESOLVED: "openfinance monolith" });
  assert.equal(withMonolith.LEGACY_OPEN_FINANCE_HOST, `127.0.0.1:${monolithPort}`);
  assert.equal(withMonolith.FBX_LEGACY_OPEN_FINANCE_BASE_URL, `http://127.0.0.1:${monolithPort}`);
  const noMonolith = exportWith({ LEGACY_OF_HOST: "monolith", FBX_PROFILES_RESOLVED: "openfinance" });
  assert.equal(noMonolith.LEGACY_OPEN_FINANCE_HOST, undefined, "no monolith in the stack: nothing to point at");
  const explicit = exportWith({ LEGACY_OF_HOST: "legacy.example.test:8443", FBX_PROFILES_RESOLVED: "openfinance" });
  assert.equal(explicit.LEGACY_OPEN_FINANCE_HOST, "legacy.example.test:8443");
  const off = exportWith({ LEGACY_OF_HOST: "", FBX_PROFILES_RESOLVED: "openfinance monolith" });
  assert.equal(off.LEGACY_OPEN_FINANCE_HOST, undefined);
});

// fbx-local.sh in a scratch copy of compose/ with a docker stand-in that records its arguments and
// prints the compose model as JSON (like `docker compose config --format json`), so the lane and
// plan commands can be tested without Docker.
function scratchCompose({ env = true } = {}) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "fbx-local-"));
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.copyFileSync(path.join(composeDir, "fbx-local.sh"), path.join(dir, "fbx-local.sh"));
  fs.copyFileSync(path.join(composeDir, "lanes.tsv"), path.join(dir, "lanes.tsv"));
  fs.copyFileSync(path.join(composeDir, "docker-compose.yml"), path.join(dir, "docker-compose.yml"));
  fs.copyFileSync(path.join(composeDir, "scripts", "plan-memory.mjs"), path.join(dir, "scripts", "plan-memory.mjs"));
  fs.writeFileSync(path.join(dir, "scripts", "init-env.sh"), "exit 0\n");
  for (const f of [".cache/identity/fintechbankx-realm.json", ".cache/kafka/topics/generated/topics.tsv"]) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), f.endsWith(".json") ? "{}\n" : "");
  }
  if (env) fs.writeFileSync(path.join(dir, ".env"), "");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const log = path.join(dir, "docker.jsonl");
  const model = path.join(dir, "model.json");
  fs.writeFileSync(model, JSON.stringify({ services: compose() }));
  fs.writeFileSync(path.join(bin, "docker"), [
    "#!/usr/bin/env node",
    "const fs = require('fs');",
    "const args = process.argv.slice(2);",
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");`,
    // Like `docker compose config`: only services without a profile or in an active --profile.
    "const active = args.flatMap((a, i) => (args[i - 1] === '--profile' ? [a] : []));",
    `if (args.includes("config") && args.includes("json")) {`,
    `  const m = JSON.parse(fs.readFileSync(${JSON.stringify(model)}, "utf8"));`,
    "  m.services = Object.fromEntries(Object.entries(m.services).filter(([, s]) => !s.profiles || s.profiles.some((p) => active.includes(p))));",
    "  process.stdout.write(JSON.stringify(m));",
    "}",
    ""
  ].join("\n"), { mode: 0o755 });
  const local = (...args) => {
    const res = spawnSync("bash", [path.join(dir, "fbx-local.sh"), ...args],
      { encoding: "utf8", env: { ...cleanEnv(), PATH: `${bin}:${process.env.PATH}` } });
    const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    return { ...res, calls };
  };
  local.dir = dir;
  local.bin = bin;
  return local;
}
const profilesOf = (call) => call.flatMap((a, i) => (call[i - 1] === "--profile" ? [a] : []));

test("fbx-local.sh plan: a lane's profiles plus extra ones, the budget enforced", () => {
  const local = scratchCompose();
  const fits = local("plan", "--lane", "payments", "monolith", "parity-fixtures", "--budget-mib", "11264");
  assert.equal(fits.status, 0, fits.stderr);
  assert.match(fits.stdout, /peak \d+ MiB/);
  const config = fits.calls.find((c) => c.includes("config"));
  assert.ok(config, "plan reads the compose model");
  assert.deepEqual(profilesOf(config), ["payments", "monolith", "parity-fixtures"]);
  assert.ok(config.includes("--format") && config.includes("json"), config.join(" "));
  const tooBig = local("plan", "services", "monolith", "parity-fixtures", "--budget-mib", "11264");
  assert.equal(tooBig.status, 1);
  assert.match(tooBig.stderr, /exceeds the memory budget of 11264 MiB/);
  const unknown = local("plan", "--lane", "everything");
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown lane/);
  const noLane = local("plan", "--lane");
  assert.notEqual(noLane.status, 0);
  assert.match(noLane.stderr, /--lane needs a lane name/);
});

test("fbx-local.sh plan: needs the generated .env first", () => {
  const res = scratchCompose({ env: false })("plan", "--lane", "lending");
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /fbx-local\.sh init/);
});

test("fbx-local.sh up --lane: starts the lane's profiles with any extra ones", () => {
  const local = scratchCompose();
  const res = local("up", "--lane", "lending", "monolith");
  assert.equal(res.status, 0, res.stderr);
  const up = res.calls.find((c) => c.includes("up"));
  assert.ok(up, "up reaches docker compose");
  assert.deepEqual(profilesOf(up), ["lending", "customer", "riskcompliance", "monolith"]);
  assert.ok(up.includes("--wait"), up.join(" "));
});

test("memory plan step: reads the compose model with the requested profiles, so the budget holds", () => {
  const local = scratchCompose();
  const step = stepNamed(/memory/i);
  const runStep = (profiles) => {
    const out = fs.mkdtempSync(path.join(tmpRoot, "fbx-plan-step-"));
    const res = spawnSync("bash", ["-c", step.run], {
      encoding: "utf8",
      env: { ...cleanEnv(), PATH: `${local.bin}:${process.env.PATH}`, FBX_COMPOSE: local.dir, FBX_PROFILES_RESOLVED: profiles,
        MEMORY_BUDGET_MIB: "11264", RUNNER_TEMP: out, FBX_RESULTS_DIR: out },
    });
    const planned = fs.existsSync(path.join(out, "memory-plan.txt")) ? fs.readFileSync(path.join(out, "memory-plan.txt"), "utf8") : "";
    return { ...res, planned };
  };
  const all = runStep("services monolith parity-fixtures");
  assert.equal(all.status, 1, all.stdout + all.stderr);
  assert.match(all.stderr, /planned peak 17280 MiB .* exceeds the memory budget of 11264 MiB/);
  const lane = runStep("payments monolith parity-fixtures");
  assert.equal(lane.status, 0, lane.stderr);
  assert.match(lane.planned, /payment-initiation-settlement-service/);
  assert.match(lane.planned, /peak 11136 MiB/);
});

test("memory plan: a requested profile with no container in the model fails, so an unprofiled model cannot pass", () => {
  const file = path.join(fs.mkdtempSync(path.join(tmpRoot, "fbx-plan-")), "compose.json");
  const shared = Object.fromEntries(Object.entries(compose()).filter(([, s]) => !s.profiles));
  fs.writeFileSync(file, JSON.stringify({ services: shared }));
  const res = spawnSync("node", [path.join(composeDir, "scripts", "plan-memory.mjs"), "--config", file, "--profiles", "payments monolith"],
    { encoding: "utf8", env: cleanEnv() });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /profile payments matches no container/);
});

test("results upload: the hidden results directory is included, one artifact per lane", () => {
  const upload = stepNamed(/^Upload results/);
  assert.equal(upload.with["include-hidden-files"], true);
  assert.match(upload.with.name, /inputs\.lane/);
  assert.match(upload.with.path, /FBX_RESULTS_DIR/);
});
