// Runner, service-port and tool-download rules for the reusable workflows
// (DevSecOps review 2026-10-17):
//   1. jobs without cloud credentials run on inputs.runner, else the caller's
//      CI_RUNNER variable, else ubuntu-latest; jobs that hold AWS credentials
//      (id-token: write) or read the saved Terraform plan (it can hold sensitive
//      values in cleartext) run on inputs.cloud-runner, else the caller's
//      CI_RUNNER_CLOUD, else ubuntu-latest, so they never land on the runner
//      that pull request jobs share unless the caller says so. ephemeral-env
//      keeps its own CI_RUNNER_ENV (ephemeral-lanes.test.mjs);
//   2. service containers publish only their container port and the job reads
//      the mapped host port from job.services: every fbx-ci runner shares one
//      Docker host, so a fixed host port collides between jobs. The job env
//      never sets a name a step writes to GITHUB_ENV (the job env would win);
//   3. tool downloads pick the release asset for the runner's architecture
//      (the fbx-ci runner is arm64) and check the pinned sha256 of the default
//      version before anything is extracted; container images a job runs by
//      default have an arm64 variant.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fbx-test-"));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const wfDir = path.join(repo, ".github/workflows");
const load = (file) => YAML.parse(fs.readFileSync(path.join(wfDir, file), "utf8"));
const reusable = fs
  .readdirSync(wfDir)
  .filter((f) => /\.ya?ml$/.test(f))
  .filter((f) => load(f).on?.workflow_call !== undefined)
  .filter((f) => f !== "ephemeral-env.yml");

const CI_RUNS_ON = "${{ inputs.runner || vars.CI_RUNNER || 'ubuntu-latest' }}";
const CLOUD_RUNS_ON = "${{ inputs.cloud-runner || vars.CI_RUNNER_CLOUD || 'ubuntu-latest' }}";
const holdsCloudCredentials = (wf, job) => (job.permissions ?? wf.permissions)?.["id-token"] === "write";
const readsTerraformPlan = (job) =>
  (job.steps ?? []).some((s) => /^actions\/download-artifact@/.test(s.uses ?? "") && /^tfplan-/.test(String(s.with?.name ?? "")));
const needsCloudRunner = (wf, job) => holdsCloudCredentials(wf, job) || readsTerraformPlan(job);

// --- 1. runners ------------------------------------------------------------------

test("the reusable workflows under test are the eight service workflows", () => {
  assert.deepEqual(reusable.sort(), [
    "container-image.yml", "contract-checks.yml", "db-migration-verify.yml", "helm-deploy.yml",
    "java-service-ci.yml", "security.yml", "tdd-gate.yml", "terraform.yml",
  ]);
});

test("jobs without cloud credentials take inputs.runner or CI_RUNNER; jobs with AWS credentials or the Terraform plan take inputs.cloud-runner or CI_RUNNER_CLOUD", () => {
  const problems = [];
  for (const file of reusable) {
    const wf = load(file);
    const inputs = wf.on.workflow_call.inputs ?? {};
    for (const [id, job] of Object.entries(wf.jobs)) {
      const cloud = needsCloudRunner(wf, job);
      const want = cloud ? CLOUD_RUNS_ON : CI_RUNS_ON;
      if (job["runs-on"] !== want) problems.push(`${file} job ${id}: runs-on ${job["runs-on"]}, want ${want}`);
      const input = inputs[cloud ? "cloud-runner" : "runner"];
      if (!input || input.type !== "string" || input.default !== "") problems.push(`${file} job ${id}: needs input ${cloud ? "cloud-runner" : "runner"} (string, default "")`);
    }
    for (const name of ["runner", "cloud-runner"]) {
      const used = Object.entries(wf.jobs).some(([, job]) => (name === "cloud-runner") === needsCloudRunner(wf, job));
      if (inputs[name] && !used) problems.push(`${file}: input ${name} is declared but no job uses it`);
    }
  }
  assert.deepEqual(problems, []);
});

test("the cloud-runner jobs are the image push, Terraform plan, plan comment and apply, and the Helm deploy", () => {
  const cloudJobs = reusable.flatMap((file) => {
    const wf = load(file);
    return Object.entries(wf.jobs).filter(([, job]) => needsCloudRunner(wf, job)).map(([id]) => `${file}:${id}`);
  });
  assert.deepEqual(cloudJobs.sort(), [
    "container-image.yml:image", "helm-deploy.yml:deploy", "terraform.yml:apply", "terraform.yml:comment", "terraform.yml:plan",
  ]);
});

// --- 2. service ports ------------------------------------------------------------

// Names a job's steps write to GITHUB_ENV with: echo "NAME=..." >> "$GITHUB_ENV".
const githubEnvNames = (job) =>
  new Set((job.steps ?? []).flatMap((s) => [...String(s.run ?? "").matchAll(/echo\s+"([A-Za-z_][A-Za-z0-9_]*)=[^"\n]*"\s*>>\s*"\$GITHUB_ENV"/g)].map((m) => m[1])));

test("the address steps' GITHUB_ENV names are the ones the jobs rely on", () => {
  assert.deepEqual([...githubEnvNames(load("java-service-ci.yml").jobs["build-and-test"])].sort(), ["TEST_DB_URL", "TEST_MONGO_URI"]);
  assert.deepEqual([...githubEnvNames(load("db-migration-verify.yml").jobs.migrate)].sort(), ["FLYWAY_URL", "PGPORT"]);
});

test("service containers publish only their container port, and no job env fixes a host port or shadows a GITHUB_ENV name", () => {
  const problems = [];
  for (const file of reusable) {
    const wf = load(file);
    for (const [id, job] of Object.entries(wf.jobs)) {
      for (const [svc, def] of Object.entries(job.services ?? {})) {
        for (const p of def.ports ?? []) if (!/^\d+$/.test(String(p))) problems.push(`${file} job ${id} service ${svc}: port ${p} binds a fixed host port`);
      }
      const exported = githubEnvNames(job);
      for (const [k, v] of Object.entries(job.env ?? {})) {
        if (/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+/.test(String(v)) || /^(PGPORT|.*_PORT)$/.test(k)) problems.push(`${file} job ${id}: job env ${k}=${v} fixes a host port`);
        if (exported.has(k)) problems.push(`${file} job ${id}: job env ${k} would override the value a step writes to GITHUB_ENV`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

function runScript(run, env, pathPrefix) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "fbx-step-"));
  const ghEnv = path.join(dir, "github-env");
  const ghPath = path.join(dir, "github-path");
  fs.writeFileSync(ghEnv, "");
  fs.writeFileSync(ghPath, "");
  const script = path.join(dir, "step.sh");
  fs.writeFileSync(script, run);
  const res = spawnSync("bash", ["--noprofile", "--norc", "-e", script], {
    cwd: dir,
    encoding: "utf8",
    env: { PATH: `${pathPrefix ? `${pathPrefix}:` : ""}${process.env.PATH}`, HOME: dir, RUNNER_TEMP: path.join(dir, "runner-temp"), GITHUB_ENV: ghEnv, GITHUB_PATH: ghPath, ...env },
  });
  const read = (f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
  return { status: res.status, out: res.stdout + res.stderr, env: read(ghEnv), path: read(ghPath), dir };
}
const stepNamed = (job, name) => job.steps.find((s) => s.name === name);

test("java-service-ci exports the mapped PostgreSQL and MongoDB ports as TEST_DB_URL and TEST_MONGO_URI", () => {
  const job = load("java-service-ci.yml").jobs["build-and-test"];
  const step = stepNamed(job, "Service container addresses");
  assert.ok(step, "step 'Service container addresses' missing");
  assert.equal(step.env.POSTGRES_PORT, "${{ job.services.postgres.ports['5432'] }}");
  assert.equal(step.env.MONGO_PORT, "${{ job.services.mongo.ports['27017'] }}");
  assert.ok(job.steps.indexOf(step) < job.steps.findIndex((s) => /^Build/.test(s.name ?? "")), "addresses are exported before the build");
  const on = runScript(step.run, { POSTGRES_ENABLED: "true", POSTGRES_PORT: "49153", POSTGRES_DB: "db_x", MONGO_ENABLED: "true", MONGO_PORT: "49154", MONGO_DB: "m_x" });
  assert.equal(on.status, 0, on.out);
  assert.deepEqual(on.env, ["TEST_DB_URL=jdbc:postgresql://localhost:49153/db_x", "TEST_MONGO_URI=mongodb://localhost:49154/m_x"]);
  const off = runScript(step.run, { POSTGRES_ENABLED: "false", POSTGRES_PORT: "", POSTGRES_DB: "db_x", MONGO_ENABLED: "false", MONGO_PORT: "", MONGO_DB: "m_x" });
  assert.equal(off.status, 0, off.out);
  assert.deepEqual(off.env, ["TEST_DB_URL=", "TEST_MONGO_URI="]);
  const missing = runScript(step.run, { POSTGRES_ENABLED: "true", POSTGRES_PORT: "", POSTGRES_DB: "db_x", MONGO_ENABLED: "false", MONGO_PORT: "", MONGO_DB: "m_x" });
  assert.notEqual(missing.status, 0, "an enabled service without a mapped port must fail the step");
  assert.match(missing.out, /::error::postgres/);
  const mongoMissing = runScript(step.run, { POSTGRES_ENABLED: "false", POSTGRES_PORT: "", POSTGRES_DB: "db_x", MONGO_ENABLED: "true", MONGO_PORT: "", MONGO_DB: "m_x" });
  assert.notEqual(mongoMissing.status, 0, "an enabled MongoDB without a mapped port must fail the step");
  assert.match(mongoMissing.out, /::error::mongo/);
  assert.deepEqual(mongoMissing.env, []);
});

test("db-migration-verify exports the mapped PostgreSQL port as PGPORT and FLYWAY_URL", () => {
  const job = load("db-migration-verify.yml").jobs.migrate;
  const step = stepNamed(job, "Service container address");
  assert.ok(step, "step 'Service container address' missing");
  assert.equal(step.env.POSTGRES_PORT, "${{ job.services.postgres.ports['5432'] }}");
  assert.ok(job.steps.indexOf(step) < job.steps.findIndex((s) => /Flyway/.test(s.name ?? "")), "the address is exported before Flyway runs");
  const r = runScript(step.run, { POSTGRES_PORT: "49155", DATABASE: "migration_verify" });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.env, ["PGPORT=49155", "FLYWAY_URL=jdbc:postgresql://localhost:49155/migration_verify"]);
  const missing = runScript(step.run, { POSTGRES_PORT: "", DATABASE: "migration_verify" });
  assert.notEqual(missing.status, 0);
});

// flyway/flyway:<v>-alpine is published for linux/amd64 only; the plain tag is a
// multi-arch index (amd64, arm64, arm/v7), checked on Docker Hub 2026-10-17.
test("db-migration-verify's default Flyway image has an arm64 variant", () => {
  const input = load("db-migration-verify.yml").on.workflow_call.inputs["flyway-image"];
  assert.equal(input.default, "flyway/flyway:10.20.1");
});

// --- 3. tool downloads -----------------------------------------------------------

// Release sha256 of each default version, from the releases' own checksum files
// (the same pins as the governance runner snippet tool-downloads-by-arch).
const TOOLS = [
  { file: "contract-checks.yml", job: "openapi", step: "Install oasdiff", versionEnv: "OASDIFF_VERSION", version: "1.12.1", bin: "oasdiff",
    asset: { x86_64: "oasdiff_1.12.1_linux_amd64.tar.gz", aarch64: "oasdiff_1.12.1_linux_arm64.tar.gz" },
    sha: { x86_64: "85514a6044d9cce53816b3558b17be4f784e481e43bf345b1029a6ccc5c0e439", aarch64: "eff7c6d6d361fc29085925f6871d8b41406baadede6b87a4a055a2b640ac8a05" } },
  { file: "security.yml", job: "gitleaks", step: "Install gitleaks", versionEnv: "GITLEAKS_VERSION", version: "8.24.3", bin: "gitleaks",
    asset: { x86_64: "gitleaks_8.24.3_linux_x64.tar.gz", aarch64: "gitleaks_8.24.3_linux_arm64.tar.gz" },
    sha: { x86_64: "9991e0b2903da4c8f6122b5c3186448b927a5da4deef1fe45271c3793f4ee29c", aarch64: "5f2edbe1f49f7b920f9e06e90759947d3c5dfc16f752fb93aaafc17e9d14cf07" } },
  { file: "helm-deploy.yml", job: "validate", step: "Install kubeconform", versionEnv: "KUBECONFORM_VERSION", version: "v0.6.7", bin: "kubeconform",
    asset: { x86_64: "kubeconform-linux-amd64.tar.gz", aarch64: "kubeconform-linux-arm64.tar.gz" },
    sha: { x86_64: "95f14e87aa28c09d5941f11bd024c1d02fdc0303ccaa23f61cef67bc92619d73", aarch64: "dc82f79bb03c5479b1ae5fd4af221e4b5a3111f62bf01a2795d9c5c20fa96644" } },
];

// Stubs for uname, curl, sha256sum and tar that log their calls; tar creates the binary.
function stubs(arch, shaExit = 0) {
  const bin = fs.mkdtempSync(path.join(tmpRoot, "fbx-bin-"));
  const log = path.join(bin, "calls.log");
  const write = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  write("uname", `[ "$1" = "-m" ] && echo ${arch} || echo Linux`);
  write("curl", `echo "curl $*" >> ${log}; out=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done; [ -n "$out" ] && echo fake > "$out"; exit 0`);
  write("sha256sum", `echo "sha256sum $* <<$(cat)" >> ${log}; exit ${shaExit}`);
  write("tar", `echo "tar $*" >> ${log}; dir=""; while [ $# -gt 0 ]; do [ "$1" = "-C" ] && dir="$2"; shift; done; for b in oasdiff gitleaks kubeconform; do touch "$dir/$b"; chmod +x "$dir/$b"; done`);
  return { bin, log: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "") };
}

for (const t of TOOLS) {
  test(`${t.file} '${t.step}' downloads the ${t.bin} asset for the runner architecture and checks its pinned sha256`, () => {
    const wf = load(t.file);
    const step = stepNamed(wf.jobs[t.job], t.step);
    assert.ok(step, `${t.file} job ${t.job}: step '${t.step}' missing`);
    assert.match(String(step.env?.[t.versionEnv]), /\$\{\{ inputs\.[a-z-]+-version \}\}/, `${t.step} reads its version from an input`);
    for (const arch of ["x86_64", "aarch64"]) {
      const s = stubs(arch);
      const r = runScript(step.run, { [t.versionEnv]: t.version }, s.bin);
      assert.equal(r.status, 0, r.out);
      const calls = s.log();
      assert.match(calls, new RegExp(`curl .*/${t.asset[arch].replace(/[.]/g, "\\.")}( |$)`, "m"), calls);
      assert.match(calls, new RegExp(`sha256sum -c - <<${t.sha[arch]}  `), calls);
      assert.ok(calls.indexOf("sha256sum") < calls.indexOf("tar "), "checksum before extract");
      assert.equal(r.path.length, 1, "the tool directory is added to GITHUB_PATH");
      assert.ok(r.path[0].startsWith(path.join(r.dir, "runner-temp")), `tools go under RUNNER_TEMP, got ${r.path[0]}`);
      assert.ok(fs.existsSync(path.join(r.path[0], t.bin)), `${t.bin} is in the GITHUB_PATH directory`);
    }
    const bad = stubs("aarch64", 1);
    const mismatch = runScript(step.run, { [t.versionEnv]: t.version }, bad.bin);
    assert.notEqual(mismatch.status, 0, "a checksum mismatch fails the step");
    assert.doesNotMatch(bad.log(), /^tar /m, "nothing is extracted after a mismatch");
    const odd = stubs("riscv64");
    const unsupported = runScript(step.run, { [t.versionEnv]: t.version }, odd.bin);
    assert.notEqual(unsupported.status, 0);
    assert.match(unsupported.out, /::error::.*riscv64/);
    const other = stubs("aarch64");
    const unpinned = runScript(step.run, { [t.versionEnv]: "9.9.9" }, other.bin);
    assert.equal(unpinned.status, 0, unpinned.out);
    assert.match(unpinned.out, /::warning::.*no pinned sha256/);
    assert.doesNotMatch(other.log(), /sha256sum/);
  });
}
