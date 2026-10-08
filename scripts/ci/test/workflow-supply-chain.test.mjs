// Supply-chain tests for the GitHub Actions workflows in this repository:
//   1. every action used by a job that can mint OIDC tokens (id-token: write) is
//      pinned to a full commit SHA with the version as a trailing comment, and
//      reusable workflows called from such jobs are pinned to a SHA or release tag;
//   2. helm-deploy validates and deploys the same chart bytes (one checkout,
//      digest-checked bundle), prod requires a commit SHA or tag as platform-ref;
//   3. helm-deploy verifies the image signature with cosign before helm upgrade.
// The platform-ref guard and the cosign step are executed for real (bash, a
// local bare git repository and a stub cosign on PATH).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const workflowDirs = [
  ".github/workflows",
  "templates/github/workflows",
  "templates/ci/github/workflows",
  "templates/microservice/.github/workflows",
];
const workflowFiles = workflowDirs.flatMap((dir) =>
  fs
    .readdirSync(path.join(repo, dir))
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => path.join(dir, f)),
);

const SHA_PIN = /^[^@\s]+@[0-9a-f]{40}$/;
const RELEASE_TAG = /^v\d+(\.\d+){0,2}$/;

const mintsOidc = (wf, job) => {
  const perms = job.permissions ?? wf.permissions;
  if (perms === "write-all") return true;
  return typeof perms === "object" && perms !== null && perms["id-token"] === "write";
};

// --- 1. pinning -------------------------------------------------------------------

test("actions in jobs with id-token: write are pinned to a full commit SHA with a version comment", () => {
  const problems = [];
  for (const file of workflowFiles) {
    const text = fs.readFileSync(path.join(repo, file), "utf8");
    const wf = YAML.parse(text);
    for (const [id, job] of Object.entries(wf.jobs ?? {})) {
      if (!mintsOidc(wf, job)) continue;
      for (const step of job.steps ?? []) {
        const uses = step.uses;
        if (!uses || uses.startsWith("./") || uses.startsWith("docker://")) continue;
        if (!SHA_PIN.test(uses)) {
          problems.push(`${file} job ${id}: ${uses} is not pinned to a 40-hex commit SHA`);
          continue;
        }
        const line = text.split("\n").find((l) => l.includes(`uses: ${uses}`));
        if (!/#\s*v?\d+(\.\d+)*\s*$/.test(line ?? "")) {
          problems.push(`${file} job ${id}: ${uses} needs a trailing "# <version>" comment`);
        }
      }
      if (typeof job.uses === "string" && !job.uses.startsWith("./")) {
        const ref = job.uses.split("@")[1] ?? "";
        if (!/^[0-9a-f]{40}$/.test(ref) && !RELEASE_TAG.test(ref)) {
          problems.push(`${file} job ${id}: reusable workflow ${job.uses} must be pinned to a commit SHA or release tag`);
        }
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("the pin check itself rejects tags, branches and short SHAs", () => {
  for (const bad of ["actions/checkout@v4", "actions/checkout@main", "actions/checkout@11d5960", "aquasecurity/trivy-action@0.28.0"]) {
    assert.equal(SHA_PIN.test(bad), false, bad);
  }
  assert.equal(SHA_PIN.test("actions/checkout@11d5960a326750d5838078e36cf38b85af677262"), true);
});

test("sample callers pin platform-ref to the same release as their reusable workflows", () => {
  const callers = workflowFiles.filter((f) => f.startsWith("templates/"));
  for (const file of callers) {
    const wf = YAML.parse(fs.readFileSync(path.join(repo, file), "utf8"));
    for (const [id, job] of Object.entries(wf.jobs ?? {})) {
      if (typeof job.uses !== "string" || job.uses.startsWith("./")) continue;
      const ref = job.uses.split("@")[1];
      assert.notEqual(ref, "main", `${file} job ${id} calls a reusable workflow at @main`);
      if (/helm-deploy|java-service-ci|tdd-gate/.test(job.uses)) {
        assert.equal(job.with?.["platform-ref"], ref, `${file} job ${id}: platform-ref must equal the workflow ref ${ref}`);
      }
    }
  }
});

// --- 2. helm-deploy: same bytes, pinned ref -------------------------------------------

const helmDeploy = () => YAML.parse(fs.readFileSync(path.join(repo, ".github/workflows/helm-deploy.yml"), "utf8"));
const stepById = (job, id) => job.steps.find((s) => s.id === id);

test("helm-deploy checks out the platform chart once, at the resolved commit, and never in the deploy job", () => {
  const wf = helmDeploy();
  const { validate, deploy } = wf.jobs;
  const checkouts = (job) => job.steps.filter((s) => String(s.uses ?? "").startsWith("actions/checkout@"));
  assert.equal(checkouts(deploy).length, 0, "deploy job must not check anything out (it deploys the validated bundle)");
  const platform = checkouts(validate).filter((s) => s.with?.repository);
  assert.equal(platform.length, 1, "validate checks out the platform repository exactly once");
  assert.equal(platform[0].with.ref, "${{ steps.platform-ref.outputs.sha }}");
  assert.ok(stepById(validate, "platform-ref"), "validate has the platform-ref guard step");
  assert.equal(validate.outputs?.["bundle-digest"], "${{ steps.bundle.outputs.digest }}");
});

test("helm-deploy deploy job verifies the bundle digest and deploys the packaged chart from it", () => {
  const { deploy } = helmDeploy().jobs;
  const names = deploy.steps.map((s) => s.id ?? s.name);
  const download = deploy.steps.findIndex((s) => String(s.uses ?? "").startsWith("actions/download-artifact@"));
  const verify = names.indexOf("verify-bundle");
  const helm = names.indexOf("deploy");
  assert.ok(download >= 0 && verify > download && helm > verify, `order download < verify-bundle < deploy, got ${names.join(", ")}`);
  assert.match(deploy.steps[verify].env.EXPECTED_DIGEST, /needs\.validate\.outputs\.bundle-digest/);
  assert.match(deploy.steps[helm].run, /fbx-deploy-bundle\/chart\//);
});

function runStep(step, env, { cwd, pathPrefix } = {}) {
  const dir = cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), "fbx-step-"));
  const out = path.join(dir, "github-output");
  fs.writeFileSync(out, "");
  const script = path.join(dir, "step.sh");
  fs.writeFileSync(script, step.run);
  const res = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", script], {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: `${pathPrefix ? `${pathPrefix}:` : ""}${process.env.PATH}`,
      HOME: dir,
      GITHUB_OUTPUT: out,
      GITHUB_STEP_SUMMARY: path.join(dir, "summary"),
      ...env,
    },
  });
  const outputs = Object.fromEntries(
    fs.readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, outputs, dir };
}

function fixturePlatformRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "fbx-platform-"));
  const work = path.join(base, "work");
  const bare = path.join(base, "platform.git");
  const git = (...args) => execFileSync("git", args, { cwd: work, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).trim();
  fs.mkdirSync(work);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "ci@example.invalid");
  git("config", "user.name", "ci");
  fs.writeFileSync(path.join(work, "f"), "1");
  git("add", "f");
  git("commit", "-q", "-m", "one");
  const first = git("rev-parse", "HEAD");
  git("tag", "-a", "v1.0.0", "-m", "release");
  git("tag", "v1.0.1-light");
  git("branch", "both");
  git("tag", "both");
  fs.writeFileSync(path.join(work, "f"), "2");
  git("commit", "-q", "-am", "two");
  const head = git("rev-parse", "HEAD");
  execFileSync("git", ["clone", "-q", "--bare", work, bare]);
  return { bare, first, head };
}

const guard = () => stepById(helmDeploy().jobs.validate, "platform-ref");

test("platform-ref guard: prod accepts a 40-char SHA or a tag and resolves it to a commit", () => {
  const { bare, first, head } = fixturePlatformRepo();
  const base = { TARGET_ENV: "prod", USES_PLATFORM_CHART: "true", PLATFORM_REMOTE: bare, PLATFORM_TOKEN: "" };
  let r = runStep(guard(), { ...base, PLATFORM_REF: head });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.outputs.sha, head);
  r = runStep(guard(), { ...base, PLATFORM_REF: "v1.0.0" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.outputs.sha, first, "annotated tag is dereferenced to its commit");
  r = runStep(guard(), { ...base, PLATFORM_REF: "refs/tags/v1.0.1-light" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.outputs.sha, first);
});

test("platform-ref guard: prod rejects branches, ambiguous names, short SHAs and unknown refs", () => {
  const { bare, head } = fixturePlatformRepo();
  const base = { TARGET_ENV: "prod", USES_PLATFORM_CHART: "true", PLATFORM_REMOTE: bare, PLATFORM_TOKEN: "" };
  for (const ref of ["main", "refs/heads/main", "both", head.slice(0, 12), "does-not-exist", ""]) {
    const r = runStep(guard(), { ...base, PLATFORM_REF: ref });
    assert.notEqual(r.status, 0, `prod must reject platform-ref '${ref}'`);
    assert.equal(r.outputs.sha, undefined);
  }
  const prodAlias = runStep(guard(), { ...base, TARGET_ENV: "production", PLATFORM_REF: "main" });
  assert.notEqual(prodAlias.status, 0, "production is treated as prod");
});

test("platform-ref guard: dev resolves a branch to its current commit; chart-path skips the guard", () => {
  const { bare, head } = fixturePlatformRepo();
  let r = runStep(guard(), { TARGET_ENV: "dev", USES_PLATFORM_CHART: "true", PLATFORM_REMOTE: bare, PLATFORM_TOKEN: "", PLATFORM_REF: "main" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.outputs.sha, head);
  r = runStep(guard(), { TARGET_ENV: "prod", USES_PLATFORM_CHART: "false", PLATFORM_REMOTE: bare, PLATFORM_TOKEN: "", PLATFORM_REF: "main" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.outputs.sha, "");
});

// --- 3. cosign verify before helm upgrade ----------------------------------------------

test("helm-deploy verifies the image signature with cosign before helm upgrade", () => {
  const wf = helmDeploy();
  const inputs = wf.on.workflow_call.inputs;
  assert.equal(inputs["cosign-certificate-oidc-issuer"].default, "https://token.actions.githubusercontent.com");
  assert.ok(inputs["cosign-certificate-identity-regexp"], "identity regexp input");
  const { deploy } = wf.jobs;
  const ids = deploy.steps.map((s) => s.id);
  const verify = ids.indexOf("verify-signature");
  assert.ok(verify >= 0, "verify-signature step");
  assert.ok(verify < ids.indexOf("deploy"), "signature is verified before helm upgrade");
  assert.equal(deploy.steps[verify]["continue-on-error"], undefined, "verification must fail closed");
  assert.equal(deploy.steps[verify].if, undefined, "verification must not be skippable");
});

function stubCosign(exitCode) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "fbx-cosign-"));
  fs.writeFileSync(
    path.join(bin, "cosign"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${bin}/args"\nexit ${exitCode}\n`,
    { mode: 0o755 },
  );
  return bin;
}

const cosignEnv = {
  TARGET_ENV: "prod",
  IMAGE_REPOSITORY: "123456789012.dkr.ecr.me-central-1.amazonaws.com/fintechbankx/loan-lifecycle-service",
  IMAGE_DIGEST: `sha256:${"a".repeat(64)}`,
  IDENTITY_REGEXP: "",
  OIDC_ISSUER: "https://token.actions.githubusercontent.com",
  SOURCE_REPOSITORY: "COPUR/fintechbankx-lendingpayments-loan-lifecycle-core",
  PLATFORM_REPOSITORY: "COPUR/fintechbankx-platform-delivery-iac-cicd-templates",
};
const verifyStep = () => stepById(helmDeploy().jobs.deploy, "verify-signature");

test("cosign step: keyless verify of the digest bound to the platform image workflow and the calling repo", () => {
  const bin = stubCosign(0);
  const r = runStep(verifyStep(), cosignEnv, { pathPrefix: bin });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const args = fs.readFileSync(path.join(bin, "args"), "utf8").trim().split("\n");
  assert.equal(args[0], "verify");
  const flag = (name) => args[args.indexOf(name) + 1];
  assert.equal(flag("--certificate-oidc-issuer"), "https://token.actions.githubusercontent.com");
  assert.equal(flag("--certificate-github-workflow-repository"), cosignEnv.SOURCE_REPOSITORY);
  assert.equal(args.at(-1), `${cosignEnv.IMAGE_REPOSITORY}@${cosignEnv.IMAGE_DIGEST}`);
  const re = new RegExp(flag("--certificate-identity-regexp"));
  const wfUrl = "https://github.com/COPUR/fintechbankx-platform-delivery-iac-cicd-templates/.github/workflows/container-image.yml";
  assert.ok(re.test(`${wfUrl}@refs/tags/v1.0.0`));
  assert.ok(re.test(`${wfUrl}@${"b".repeat(40)}`));
  assert.ok(!re.test(`${wfUrl}@refs/heads/main`), "prod does not accept images signed from a branch of the platform workflow");
  assert.ok(!re.test(`${wfUrl}@refs/heads/feature`));
  assert.ok(!re.test(`https://github.com/COPUR/other/.github/workflows/container-image.yml@refs/tags/v1.0.0`));
  assert.ok(!re.test(`${wfUrl}x@refs/tags/v1.0.0`));
});

test("cosign step: dev accepts images signed by the platform workflow at main", () => {
  const bin = stubCosign(0);
  const r = runStep(verifyStep(), { ...cosignEnv, TARGET_ENV: "dev" }, { pathPrefix: bin });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const args = fs.readFileSync(path.join(bin, "args"), "utf8").trim().split("\n");
  const re = new RegExp(args[args.indexOf("--certificate-identity-regexp") + 1]);
  assert.ok(re.test("https://github.com/COPUR/fintechbankx-platform-delivery-iac-cicd-templates/.github/workflows/container-image.yml@refs/heads/main"));
});

test("cosign step fails closed: failed verification, tag instead of digest, unanchored identity", () => {
  assert.notEqual(runStep(verifyStep(), cosignEnv, { pathPrefix: stubCosign(1) }).status, 0, "cosign failure stops the deploy");
  assert.notEqual(runStep(verifyStep(), { ...cosignEnv, IMAGE_DIGEST: "latest" }, { pathPrefix: stubCosign(0) }).status, 0);
  assert.notEqual(runStep(verifyStep(), { ...cosignEnv, IDENTITY_REGEXP: ".*" }, { pathPrefix: stubCosign(0) }).status, 0);
  const custom = runStep(verifyStep(), { ...cosignEnv, IDENTITY_REGEXP: "^https://github\\.com/COPUR/x/\\.github/workflows/image\\.yml@refs/tags/.+$" }, { pathPrefix: stubCosign(0) });
  assert.equal(custom.status, 0, custom.stdout + custom.stderr);
});
