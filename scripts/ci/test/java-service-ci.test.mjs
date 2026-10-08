// Tests for the ArchUnit gate step of java-service-ci.yml. The step's run script
// is executed for real (bash) against a stub gate (gradlew + archunit-gate that
// record their arguments), so the package-root rule is checked as CI runs it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const workflow = () => YAML.parse(fs.readFileSync(path.join(repo, ".github/workflows/java-service-ci.yml"), "utf8"));
const gateStep = () => {
  const jobs = Object.values(workflow().jobs);
  for (const job of jobs) {
    const step = (job.steps ?? []).find((s) => /^ArchUnit gate/.test(s.name ?? ""));
    if (step) return step;
  }
  throw new Error("ArchUnit gate step not found");
};

function runGate({ packageRoot = "", reportOnly = "false", gateExit = 0, roots = "", generated = "" } = {}) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "fbx-archunit-"));
  const gateDir = path.join(ws, ".fbx-platform", "tools", "archunit-gate");
  const bin = path.join(gateDir, "build", "install", "archunit-gate", "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(ws, "build", "classes", "java", "main"), { recursive: true });
  const log = path.join(ws, "calls.log");
  fs.writeFileSync(path.join(gateDir, "gradlew"), `#!/usr/bin/env bash\necho "gradlew $*" >> "${log}"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "archunit-gate"), `#!/usr/bin/env bash\necho "gate $*" >> "${log}"\nexit ${gateExit}\n`, { mode: 0o755 });
  const res = spawnSync("bash", ["-c", gateStep().run], {
    cwd: ws, encoding: "utf8",
    env: { ...process.env, ROOTS: roots, PACKAGE_ROOT: packageRoot, LAYOUT: "auto", REPORT_ONLY: reportOnly,
      GENERATED_PACKAGES: generated, GATE_DIR: gateDir },
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
  return { ...res, calls };
}

test("ArchUnit gate fails with a clear message when package-root is empty", () => {
  const r = runGate();
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /::error::.*package-root.*required/);
  assert.doesNotMatch(r.calls, /^gate /m, "the gate does not run without a package root");
});

test("ArchUnit gate passes package-root to the gate", () => {
  const r = runGate({ packageRoot: "com.bank.loan" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.calls, /^gate .*--package-root com\.bank\.loan/m);
  assert.match(r.calls, /--classes \.\/build\/classes\/java\/main/);
});

test("archunit-report-only tolerates a missing package-root and gate failures, visibly", () => {
  let r = runGate({ reportOnly: "true" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /::warning::.*package-root/);
  r = runGate({ packageRoot: "com.bank.loan", reportOnly: "true", gateExit: 1 });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /::warning::ArchUnit gate failed/);
  r = runGate({ packageRoot: "com.bank.loan", gateExit: 1 });
  assert.equal(r.status, 1);
});

test("java-service-ci documents package-root as required and every sample caller sets it", () => {
  const input = workflow().on.workflow_call.inputs["package-root"];
  assert.match(input.description, /[Rr]equired/);
  const callers = ["templates/github/workflows", "templates/ci/github/workflows", "templates/microservice/.github/workflows"]
    .flatMap((d) => fs.readdirSync(path.join(repo, d)).map((f) => path.join(d, f)));
  let seen = 0;
  for (const f of callers) {
    const wf = YAML.parse(fs.readFileSync(path.join(repo, f), "utf8"));
    for (const [id, job] of Object.entries(wf.jobs ?? {})) {
      if (!/java-service-ci\.yml/.test(job.uses ?? "")) continue;
      seen++;
      assert.match(String(job.with?.["package-root"] ?? ""), /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, `${f} ${id} must set package-root`);
    }
  }
  assert.ok(seen >= 3, `expected the three sample callers, saw ${seen}`);
});
