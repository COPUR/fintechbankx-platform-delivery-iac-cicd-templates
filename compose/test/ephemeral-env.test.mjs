// Structure tests for the ephemeral-env reusable workflow.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// --- ephemeral-env workflow -----------------------------------------------------

test("ephemeral-env workflow: inputs, health wait, always uploads and always tears down", () => {
  const wf = YAML.parse(fs.readFileSync(path.join(repo, ".github", "workflows", "ephemeral-env.yml"), "utf8"));
  const inputs = wf.on.workflow_call.inputs;
  for (const name of ["service-images", "monolith-image", "test-command", "profiles", "mode", "platform-ref"]) {
    assert.ok(inputs[name], `input ${name} missing`);
  }
  assert.deepEqual(wf.permissions, { contents: "read" });
  for (const [id, job] of Object.entries(wf.jobs)) {
    assert.ok(job["timeout-minutes"], `${id} needs a timeout`);
    const steps = job.steps;
    const teardown = steps.find((s) => /tear ?down/i.test(s.name ?? ""));
    assert.ok(teardown, `${id} has no teardown step`);
    assert.equal(teardown.if, "${{ always() }}");
    assert.equal(steps.indexOf(teardown), steps.length - 1, `${id}: teardown must be the last step`);
    const upload = steps.find((s) => String(s.uses ?? "").startsWith("actions/upload-artifact"));
    assert.ok(upload && upload.if === "${{ always() }}", `${id} must always upload results`);
    assert.ok(steps.some((s) => /wait|health/i.test(s.name ?? "")), `${id} must wait for health`);
    assert.ok(steps.some((s) => String(s.env?.TEST_COMMAND ?? "").includes("inputs.test-command")), `${id} must pass the test command via env`);
  }
});

// --- regression-parity additions -------------------------------------------------------

const workflow = () => YAML.parse(fs.readFileSync(path.join(repo, ".github", "workflows", "ephemeral-env.yml"), "utf8"));
const stepIndex = (steps, re) => steps.findIndex((s) => re.test(s.name ?? ""));

test("ephemeral-env: parity fixtures, SQL fixtures, seed hook and service env, in order before the test command", () => {
  const wf = workflow();
  const inputs = wf.on.workflow_call.inputs;
  assert.equal(inputs["parity-fixtures"].type, "boolean");
  assert.equal(inputs["parity-fixtures"].default, false);
  for (const name of ["seed-command", "service-env", "sql-fixtures"]) {
    assert.equal(inputs[name].type, "string", name);
    assert.equal(inputs[name].default, "", `${name} is optional`);
  }
  const steps = wf.jobs.ephemeral.steps;
  const text = JSON.stringify(steps);
  const validate = stepIndex(steps, /^Validate inputs/);
  const init = stepIndex(steps, /generate dev-only credentials/);
  const up = stepIndex(steps, /Start stack/);
  const exportEnv = stepIndex(steps, /Export test environment/);
  const sql = stepIndex(steps, /SQL fixtures/);
  const seed = stepIndex(steps, /seed command/i);
  const testStep = stepIndex(steps, /Run test command/);
  for (const [n, i] of Object.entries({ validate, init, up, exportEnv, sql, seed, testStep })) assert.ok(i >= 0, `${n} step missing`);
  assert.ok(validate < init && init < up && up < exportEnv && exportEnv < sql && sql < seed && seed < testStep, "step order");
  // Parity fixtures: init-env flag plus the compose profile.
  assert.match(steps[init].run, /--parity-fixtures/);
  assert.match(text, /parity-fixtures/);
  // Service env and SQL fixture lists are validated before anything starts.
  assert.match(steps[validate].run, /service-env/);
  assert.match(steps[validate].run, /apply-sql-fixtures\.sh.*--check/s);
  assert.equal(steps[sql].if, "${{ inputs.sql-fixtures != '' }}");
  assert.equal(steps[seed].if, "${{ inputs.seed-command != '' }}");
  assert.ok(String(steps[seed].env.SEED_COMMAND).includes("inputs.seed-command"), "seed command via env, never inlined");
  assert.equal(steps[seed]["working-directory"], "${{ inputs.working-directory }}");
  assert.ok(!/\$\{\{\s*inputs\.(seed-command|test-command|service-env|sql-fixtures)/.test(
    steps.map((s) => s.run ?? "").join("\n")), "untrusted inputs never interpolated into scripts");
  // The env file stays a file reference; generated credentials are masked in logs.
  assert.match(steps[exportEnv].run, /FBX_ENV_FILE=/);
  assert.match(steps[init].run, /add-mask/);
  assert.match(steps[init].run, /PARITY_\[A-Z0-9_\]\*PRIVATE_JWK=/, "private JWK members of every PARITY_*_PRIVATE_JWK are masked too");
  assert.doesNotMatch(steps[init].run, /startsWith\("PARITY_TPP_PRIVATE_JWK="\)/, "masking must not stop at the first TPP key");
});

test("ephemeral-env: monolith from a pinned image or built from the caller's context", () => {
  const wf = workflow();
  const inputs = wf.on.workflow_call.inputs;
  for (const name of ["monolith-build-context", "monolith-build-command", "monolith-health-path"]) {
    assert.equal(inputs[name].type, "string", name);
  }
  assert.equal(inputs["monolith-spring-profiles"].default, "local", "the oracle's own profile");
  assert.equal(inputs["monolith-health-path"].default, "/actuator/health");
  const steps = wf.jobs.ephemeral.steps;
  const validate = steps[stepIndex(steps, /^Validate inputs/)];
  assert.match(validate.run, /image_ok "\$MONOLITH_IMAGE"/, "pulled images stay pinned");
  assert.match(validate.run, /not both/, "image and build context are exclusive");
  const build = stepIndex(steps, /Build monolith image/);
  assert.ok(build >= 0, "build step missing");
  assert.equal(steps[build].if, "${{ inputs.monolith-build-context != '' }}");
  assert.ok(String(steps[build].env.BUILD_COMMAND).includes("inputs.monolith-build-command"));
  assert.match(steps[build].run, /docker build/);
  assert.match(steps[build].run, /FBX_MONOLITH_IMAGE=/);
  assert.ok(build < stepIndex(steps, /Start stack/));
});

test("ephemeral-env: the exported base URLs carry each service's host port (services.tsv column 9, not the store column after it)", async () => {
  const { spawnSync } = await import("node:child_process");
  const os = await import("node:os");
  const steps = workflow().jobs.ephemeral.steps;
  const step = steps[stepIndex(steps, /Export test environment/)];
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fbx-export-")), "github.env");
  const composeDir = path.join(repo, "compose");
  const res = spawnSync("bash", ["-c", step.run], { encoding: "utf8", env: { ...process.env, FBX_COMPOSE: composeDir, GITHUB_ENV: out } });
  assert.equal(res.status, 0, res.stderr);
  const exported = Object.fromEntries(fs.readFileSync(out, "utf8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  const rows = fs.readFileSync(path.join(composeDir, "services.tsv"), "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split("\t"));
  for (const [key, serviceId, , , , , , , port] of rows) {
    const name = key === "monolith" ? "FBX_MONOLITH_BASE_URL" : `FBX_BASE_URL_${serviceId.replace(/^svc-/, "").toUpperCase().replaceAll("-", "_")}`;
    assert.equal(exported[name], `http://127.0.0.1:${port}`, name);
  }
  assert.equal(exported.FBX_BASE_URL_LN_LOAN_LIFECYCLE, "http://127.0.0.1:18010");
  assert.equal(exported.FBX_BASE_URL_OF_ATM_DIRECTORY, "http://127.0.0.1:18150");
  assert.equal(Object.keys(exported).filter((k) => k.startsWith("FBX_BASE_URL_")).length, 15);
  for (const v of Object.values(exported)) assert.doesNotMatch(v, /\t|postgresql|mongodb/);
  // Decision D5: a service that checks DPoP htu against DPOP_PUBLIC_BASE_URL
  // gets exactly the origin the suite calls (FBX_BASE_URL_*), 127.0.0.1 not localhost.
  const compose = YAML.parse(fs.readFileSync(path.join(composeDir, "docker-compose.yml"), "utf8")).services;
  let dpop = 0;
  for (const [key, serviceId] of rows) {
    const base = compose[key].environment?.DPOP_PUBLIC_BASE_URL;
    if (base === undefined) continue;
    assert.equal(base, exported[`FBX_BASE_URL_${serviceId.replace(/^svc-/, "").toUpperCase().replaceAll("-", "_")}`], key);
    dpop++;
  }
  assert.equal(dpop, 5, "consent, payee, retail, corporate and metadata");
});

test("ephemeral-env: the profiles input names every service profile of the compose runtime", () => {
  const input = workflow().on.workflow_call.inputs.profiles;
  const compose = YAML.parse(fs.readFileSync(path.join(repo, "compose", "docker-compose.yml"), "utf8")).services;
  // monolith and parity-fixtures come from their own inputs.
  const profiles = [...new Set(Object.values(compose).flatMap((x) => x.profiles ?? []))]
    .filter((p) => !["monolith", "parity-fixtures"].includes(p));
  assert.ok(profiles.includes("openfinance"));
  for (const p of profiles) assert.match(input.description, new RegExp(`\\b${p}\\b`), p);
  assert.equal(input.default, "services");
  assert.match(input.description, /services[^,;.]*all 15/, "says that the default starts all 15 services");
  assert.match(input.description, /openfinance[^,;.]*seven open-finance services/, "says what openfinance starts");
});
