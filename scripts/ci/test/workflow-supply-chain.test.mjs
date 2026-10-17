// Supply-chain tests for the GitHub Actions workflows in this repository:
//   1. every action used by a job that can mint OIDC tokens (id-token: write) is
//      pinned to a full commit SHA with the version as a trailing comment, and
//      reusable workflows called from such jobs are pinned to a SHA or release tag;
//   2. helm-deploy validates and deploys the same chart bytes (one checkout,
//      digest-checked bundle), prod requires a commit SHA or tag as platform-ref;
//   3. helm-deploy verifies the image signature with cosign before helm upgrade.
// The platform-ref guard and the cosign step are executed for real (bash, a
// local bare git repository and a stub cosign on PATH).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

// Every temporary directory this file makes lives under tmpRoot, removed when its tests end.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fbx-test-"));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

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

// Every third-party action, in any job, is pinned the same way (DevSecOps
// review 2026-10-17), here and in the templates services copy. PENDING_SHA
// names the refs whose commit has not been resolved in this repository yet;
// each must still be in use, so the list only shrinks.
const PENDING_SHA = [];
const allWorkflowFiles = [...workflowFiles, "templates/legacy/monorepo/github-ci.yml"];

test("every third-party action in every job is pinned to a full commit SHA with a version comment", () => {
  const problems = [];
  const pendingSeen = new Set();
  for (const file of allWorkflowFiles) {
    const text = fs.readFileSync(path.join(repo, file), "utf8");
    const wf = YAML.parse(text);
    for (const [id, job] of Object.entries(wf.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        const uses = step.uses;
        if (!uses || uses.startsWith("./") || uses.startsWith("docker://")) continue;
        if (PENDING_SHA.includes(uses)) { pendingSeen.add(uses); continue; }
        if (!SHA_PIN.test(uses)) problems.push(`${file} job ${id}: ${uses} is not pinned to a 40-hex commit SHA`);
      }
    }
    // The version comment is checked on every line, not on the first line that
    // names the same pin: one SHA appears in many steps of a file.
    text.split("\n").forEach((l, i) => {
      const m = l.match(/^\s*(?:-\s+)?uses:\s*([^\s#]+)/);
      if (m && /@[0-9a-f]{40}$/.test(m[1]) && !/#\s*v?\d+(\.\d+)*\s*$/.test(l)) problems.push(`${file}:${i + 1}: ${m[1]} needs a trailing "# <version>" comment`);
    });
  }
  assert.deepEqual(problems, []);
  assert.deepEqual([...pendingSeen].sort(), [...PENDING_SHA].sort(), "PENDING_SHA lists a ref no workflow uses any more");
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

// validate checks the install render (a check, not a control: the deploy job renders again
// against the cluster): every container image must be <image-repository>@<image-digest>, and
// no chart template may call lookup by name (validate renders without a cluster, so lookup
// returns empty there; in the deploy job it asks the cluster, and a Secret lookup is Forbidden
// for the deploy Role, which aborts the upgrade).
const IMG_REPO = "123456789012.dkr.ecr.me-central-1.amazonaws.com/fintechbankx/loan-lifecycle-service";
const IMG_DIGEST = `sha256:${"a".repeat(64)}`;
const renderGuard = () => stepById(helmDeploy().jobs.validate, "render-guard");

function runRenderGuard(rendered, templates = { "templates/deployment.yaml": "kind: Deployment\n" }) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "fbx-guard-"));
  const src = path.join(dir, "src");
  for (const [file, text] of Object.entries(templates)) {
    fs.mkdirSync(path.dirname(path.join(src, "svc", file)), { recursive: true });
    fs.writeFileSync(path.join(src, "svc", file), text);
  }
  fs.writeFileSync(path.join(src, "svc", "Chart.yaml"), "apiVersion: v2\nname: svc\nversion: 1.0.0\n");
  fs.mkdirSync(path.join(dir, "fbx-deploy-bundle", "chart"), { recursive: true });
  execFileSync("tar", ["-czf", path.join(dir, "fbx-deploy-bundle", "chart", "svc-1.0.0.tgz"), "-C", src, "svc"]);
  fs.writeFileSync(path.join(dir, "rendered.yaml"), rendered);
  return runStep(renderGuard(), { IMAGE_REPOSITORY: IMG_REPO, IMAGE_DIGEST: IMG_DIGEST }, { cwd: dir });
}

const pod = (...images) =>
  "---\n# Source: svc/templates/deployment.yaml\napiVersion: apps/v1\nkind: Deployment\nspec:\n  template:\n    spec:\n" +
  "      initContainers:\n" + images.slice(1).map((i) => `        - name: init\n          image: ${i}\n`).join("") +
  `      containers:\n        - name: app\n          image: ${images[0]}\n          imagePullPolicy: IfNotPresent\n`;

test("helm-deploy validate runs the render guard on the bundle before uploading it", () => {
  const { validate } = helmDeploy().jobs;
  const ids = validate.steps.map((s) => s.id ?? s.uses ?? s.name);
  const bundle = ids.indexOf("bundle");
  const guard = ids.indexOf("render-guard");
  const upload = validate.steps.findIndex((s) => String(s.uses ?? "").startsWith("actions/upload-artifact@"));
  assert.ok(bundle >= 0 && guard > bundle && upload > guard, `order bundle < render-guard < upload, got ${ids.join(", ")}`);
  assert.equal(renderGuard().env.IMAGE_REPOSITORY, "${{ inputs.image-repository }}");
  assert.equal(renderGuard().env.IMAGE_DIGEST, "${{ inputs.image-digest }}");
});

test("helm-deploy render guard admits a chart whose every image is the verified digest", () => {
  for (const image of [`"${IMG_REPO}@${IMG_DIGEST}"`, `${IMG_REPO}@${IMG_DIGEST}`, `'${IMG_REPO}@${IMG_DIGEST}'`]) {
    const r = runRenderGuard(pod(image, image));
    assert.equal(r.status, 0, image + r.stdout + r.stderr);
  }
});

test("helm-deploy render guard refuses any other image, an image in another YAML form, and a render without one", () => {
  const ok = `"${IMG_REPO}@${IMG_DIGEST}"`;
  const cases = {
    tag: pod(`"${IMG_REPO}:v1"`),
    "other digest": pod(`"${IMG_REPO}@sha256:${"b".repeat(64)}"`),
    "extra init image": pod(ok, '"busybox:1.36"'),
    "digest plus tag": pod(`"${IMG_REPO}:v1@${IMG_DIGEST}"`),
    "flow style": pod(ok).replace("      containers:", `      containers: [{name: side, image: "busybox"}]\n      x:`),
    "json key": pod(ok) + `---\n{"kind": "Pod", "spec": {"containers": [{"name": "x", "image": "busybox"}]}}\n`,
    "no image": "---\napiVersion: v1\nkind: ConfigMap\n",
  };
  for (const [name, rendered] of Object.entries(cases)) {
    const r = runRenderGuard(rendered);
    assert.notEqual(r.status, 0, name);
    assert.match(r.stdout + r.stderr, /::error::/, name);
  }
  const r = runRenderGuard(pod(`"${IMG_REPO}:v1"`));
  assert.match(r.stdout, new RegExp(`::error::every container image must be ${IMG_REPO.replace(/\./g, "\\.")}@${IMG_DIGEST}`));
  assert.match(r.stdout, /image: "123456789012\.dkr\.ecr\.me-central-1\.amazonaws\.com\/fintechbankx\/loan-lifecycle-service:v1"/);
});

// The guard reads lines, not YAML: it is a check for charts that render images the usual way
// (see the helm-deploy.yml header), and values with escapes, '?' or JSON (toPrettyJson | quote)
// must not trip it.
test("helm-deploy render guard passes escapes, '?' and quoted JSON in values", () => {
  const ok = `"${IMG_REPO}@${IMG_DIGEST}"`;
  const benign = pod(ok) +
    '---\napiVersion: v1\nkind: ConfigMap\ndata:\n  "a.b": "line\\nnext \\"q\\""\n  url: "https://x.example/?a=1"\n  q: what?\n' +
    '  app.json: "{\\n  \\"a\\": 1,\\n  \\"b\\": [1, 2]\\n}"\n  list: "[1, ? 2]"\n' +
    "  script: |\n    #!/bin/sh\n    echo hi\n";
  const r = runRenderGuard(benign);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("helm-deploy render guard refuses a chart that calls lookup, in its own or a subchart's templates", () => {
  const ok = pod(`"${IMG_REPO}@${IMG_DIGEST}"`);
  const secretLookup = 'checksum/secret: {{ (lookup "v1" "Secret" .Release.Namespace "db").data | toJson | sha256sum }}\n';
  for (const file of ["templates/deployment.yaml", "templates/_helpers.tpl", "charts/sub/templates/cm.yaml"]) {
    const r = runRenderGuard(ok, { "templates/deployment.yaml": "kind: Deployment\n", [file]: secretLookup });
    assert.notEqual(r.status, 0, file);
    assert.match(r.stdout, new RegExp(`::error::the chart calls lookup.*svc/${file.replace(/\./g, "\\.")}`), file);
  }
  const r = runRenderGuard(ok, { "templates/deployment.yaml": "kind: Deployment\n", "README.md": "uses lookup\n" });
  assert.equal(r.status, 0, "only templates count" + r.stdout + r.stderr);
});

// Helm's default storage driver keeps every release in a Secret; the deploy roles'
// namespaced Role (mesh repository) grants ConfigMaps and no Secrets at all.
const HELM_CLUSTER_COMMAND = /\bhelm\s+(upgrade|install|rollback|history|uninstall|status|list|get|test)\b/;

test("every job that runs helm against a cluster keeps releases in ConfigMaps (job-level HELM_DRIVER=configmap)", () => {
  const problems = [];
  let jobs = 0;
  for (const file of workflowFiles) {
    const wf = YAML.parse(fs.readFileSync(path.join(repo, file), "utf8"));
    for (const [id, job] of Object.entries(wf.jobs ?? {})) {
      const runs = (job.steps ?? []).map((s) => String(s.run ?? ""));
      if (!runs.some((r) => HELM_CLUSTER_COMMAND.test(r))) continue;
      jobs++;
      if (job.env?.HELM_DRIVER !== "configmap") problems.push(`${file} job ${id}: env HELM_DRIVER is ${job.env?.HELM_DRIVER}, not configmap`);
      for (const step of job.steps ?? []) {
        if (step.env && "HELM_DRIVER" in step.env) problems.push(`${file} job ${id} step ${step.id ?? step.name}: overrides HELM_DRIVER`);
        if (/HELM_DRIVER=(?!configmap\b)|(unset|export)\s+HELM_DRIVER\b/.test(String(step.run ?? ""))) {
          problems.push(`${file} job ${id} step ${step.id ?? step.name}: changes HELM_DRIVER`);
        }
      }
    }
  }
  assert.ok(jobs >= 1, "helm-deploy's deploy job runs helm upgrade");
  assert.deepEqual(problems, []);
  assert.equal(helmDeploy().jobs.deploy.env?.HELM_DRIVER, "configmap");
});

test("helm-deploy runs helm upgrade and helm history with HELM_DRIVER=configmap and says so in the rollback hint", () => {
  const { deploy } = helmDeploy().jobs;
  const dir = fs.mkdtempSync(path.join(tmpRoot, "fbx-helm-"));
  fs.mkdirSync(path.join(dir, "fbx-deploy-bundle", "chart"), { recursive: true });
  fs.writeFileSync(path.join(dir, "fbx-deploy-bundle", "chart", "svc-1.0.0.tgz"), "");
  const bin = fs.mkdtempSync(path.join(tmpRoot, "fbx-helm-bin-"));
  fs.writeFileSync(
    path.join(bin, "helm"),
    `#!/usr/bin/env bash\nprintf '%s %s\\n' "\${HELM_DRIVER:-unset}" "$1" >> "${bin}/calls"\n` +
      `if [ "$1" = history ]; then echo '[{"revision":7}]'; fi\n`,
    { mode: 0o755 },
  );
  const r = runStep(
    stepById(deploy, "deploy"),
    {
      ...deploy.env,
      VALUES_FILES: "",
      IMAGE_REPOSITORY: "123456789012.dkr.ecr.me-central-1.amazonaws.com/fintechbankx/loan-lifecycle-service",
      IMAGE_DIGEST: `sha256:${"a".repeat(64)}`,
      IMAGE_TAG: "",
      RELEASE: "loan-lifecycle-service",
      NAMESPACE: "lending",
      HELM_TIMEOUT: "10m",
      TARGET_ENV: "dev",
      GITHUB_SHA: "0".repeat(40),
      GITHUB_WORKFLOW: "deploy",
      GITHUB_RUN_ID: "1",
    },
    { cwd: dir, pathPrefix: bin },
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.outputs.revision, "7");
  assert.deepEqual(fs.readFileSync(path.join(bin, "calls"), "utf8").trim().split("\n"), ["configmap upgrade", "configmap history"]);
  assert.match(
    fs.readFileSync(path.join(dir, "summary"), "utf8"),
    /`HELM_DRIVER=configmap helm rollback loan-lifecycle-service <revision> -n lending`/,
  );
});

function runStep(step, env, { cwd, pathPrefix } = {}) {
  const dir = cwd ?? fs.mkdtempSync(path.join(tmpRoot, "fbx-step-"));
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
  const base = fs.mkdtempSync(path.join(tmpRoot, "fbx-platform-"));
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
  const bin = fs.mkdtempSync(path.join(tmpRoot, "fbx-cosign-"));
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

// --- 4. downloads -------------------------------------------------------------------

// Every curl or wget in a run: block saves the download to a file, only echo, printf,
// exit or true follow it on its line, and the next line of the block is an
// unconditional `sha256sum -c` of that file, before anything extracts, installs,
// moves or runs it (DevSecOps review 2026-10-17). The check is a plain echo or printf
// pipeline ending in sha256sum (no if, elif, while, until, !, &&, ||, ;, &, $( ) or
// backticks) and the block does not turn errexit off before it. Piping a download
// (curl ... | tar, wget -O- | sh) or keeping it on stdout fails. A download is each
// http(s):// URL argument of a curl or wget command, wherever it runs: after an
// assignment prefix, a wrapper (timeout, command, env, nice, time, exec, sudo), a
// keyword, inside $( ), backticks or { }, by path or quoted, or in the command
// string of sh -c, bash -c or eval (always refused there).
// Applies to every workflow above, the legacy reference copy included, and to the
// before_script, script and after_script lines of every GitLab CI file (each
// section is one shell session, checked as one block). PENDING_DOWNLOADS lists the
// downloads allowed to fail the rule, each by its block and the URL of its download,
// with the reason; every entry must match exactly one download, so the list only
// shrinks.
const PENDING_DOWNLOADS = [];

// The GitLab CI files: the templates in templates/ci/gitlab and every *gitlab-ci*.yml
// elsewhere in the repository (ci/templates/*/gitlab-ci.yml, a .gitlab-ci.yml).
const SKIP_DIRS = new Set([".git", "node_modules", ".cache", ".gradle", "build"]);
function findGitlabFiles(dir = "") {
  return fs.readdirSync(path.join(repo, dir), { withFileTypes: true }).flatMap((d) => {
    const rel = path.join(dir, d.name);
    if (d.isDirectory()) return SKIP_DIRS.has(d.name) ? [] : findGitlabFiles(rel);
    if (!d.isFile() || !/\.ya?ml$/.test(d.name)) return [];
    return dir === path.join("templates", "ci", "gitlab") || /gitlab-ci/i.test(d.name) ? [rel] : [];
  });
}
const gitlabFiles = findGitlabFiles().sort();

// Index of the ")" or "`" closing the substitution whose body starts at k, or `to`.
function substitutionEnd(line, k, to, close) {
  let depth = 0;
  let quote = "";
  for (; k < to; k++) {
    const c = line[k];
    if (c === "\\") k++;
    else if (quote) { if (c === quote) quote = ""; }
    else if (c === "'" || c === '"') quote = c;
    else if (close === "`") { if (c === "`") return k; }
    else if (c === "(") depth++;
    else if (c === ")") { if (depth === 0) return k; depth--; }
  }
  return to;
}

// Splits one logical shell line into simple commands: { words: [{ text, start }], end },
// offsets into the line. The bodies of $( ), <( ), >( ) and backticks, also inside
// double quotes, are commands of their own; an unquoted # starts a comment.
function simpleCommands(line, from = 0, to = line.length, out = []) {
  let words = [];
  let word = null;
  const add = (k, text) => { word ??= { text: "", start: k }; word.text += text; };
  const endWord = () => { if (word) words.push(word); word = null; };
  const endCommand = (k) => { endWord(); if (words.length) out.push({ words, end: k }); words = []; };
  const substitution = (k) => {
    const open = line[k] === "`" ? 1 : 2;
    const end = substitutionEnd(line, k + open, to, line[k] === "`" ? "`" : ")");
    simpleCommands(line, k + open, end, out);
    add(k, "$(...)");
    return Math.min(end + 1, to);
  };
  const opensSubstitution = (k) => line[k] === "`" || (/[$<>]/.test(line[k]) && line[k + 1] === "(" && line[k + 2] !== "(");
  let k = from;
  while (k < to) {
    const c = line[k];
    if (c === "\\") { add(k, line.slice(k, k + 2)); k += 2; }
    else if (c === "'") {
      const e = line.indexOf("'", k + 1);
      const stop = e < 0 || e >= to ? to : e + 1;
      add(k, line.slice(k, stop));
      k = stop;
    } else if (c === '"') {
      add(k, c);
      k++;
      while (k < to && line[k] !== '"') {
        if (line[k] === "\\") { add(k, line.slice(k, k + 2)); k += 2; }
        else if (line[k] === "`" || (line[k] === "$" && line[k + 1] === "(" && line[k + 2] !== "(")) k = substitution(k);
        else { add(k, line[k]); k++; }
      }
      if (k < to) { add(k, '"'); k++; }
    } else if (opensSubstitution(k)) k = substitution(k);
    else if (/\s/.test(c)) { endWord(); k++; }
    else if (c === "#" && !word) break;
    else if (c === "&" && (line[k - 1] === ">" || line[k - 1] === "<" || line[k + 1] === ">")) { add(k, c); k++; }
    else if (";&|()".includes(c)) { endCommand(k); k++; }
    else { add(k, c); k++; }
  }
  endCommand(to);
  return out;
}

const DOWNLOAD_TOOLS = new Set(["curl", "wget"]);
// Commands whose argument is shell code of its own: sh -c '...', eval '...'.
const CODE_RUNNERS = new Set(["sh", "bash", "dash", "ksh", "zsh", "eval"]);
const COMMAND_KEYWORDS = new Set(["if", "elif", "while", "until", "then", "do", "else", "!", "{", "}"]);
const COMMAND_WRAPPERS = new Set(["timeout", "command", "env", "nice", "time", "exec", "sudo", "nohup"]);
const plainWord = (w) => w.text.replace(/\\(.)/g, "$1").replace(/["']/g, "");
const commandName = (w) => plainWord(w).split("/").pop();
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// One spelling for a path: no quotes, ${name} written as $name.
const samePath = (s) => s.replace(/["']/g, "").replace(/\$\{(\w+)\}/g, "$$$1");

// The output files of a curl or wget command, in order, and the index of the last
// word each option takes: curl -o FILE / --output FILE / --output=FILE, wget -O FILE /
// -OFILE / --output-document FILE / --output-document=FILE. curl -o"$f" (no space) and
// curl -O name no file.
function outputOption(tool, words, n) {
  const s = samePath(words[n].text);
  const joined = tool === "curl" ? /^--output=(.*)$/ : /^(?:--output-document=|-[A-Za-z]*O)(.+)$/;
  const separate = tool === "curl" ? /^(?:--output|-[A-Za-z]*o)$/ : /^(?:--output-document|-[A-Za-z]*O)$/;
  if (separate.test(s)) return n + 1 < words.length ? { file: samePath(words[n + 1].text), last: n + 1 } : null;
  const m = s.match(joined);
  return m ? { file: m[1], last: n } : null;
}

// The downloads on one logical line: one per http(s):// URL argument of each curl or
// wget command (directly, or run by a wrapper), paired with that command's output
// file in the same position (curl writes its n-th -o to its n-th URL; a URL with no
// output of its own is not saved). A curl or wget in the command string of sh -c,
// bash -c or eval is a download too, marked nested.
function lineDownloads(line) {
  const downloads = [];
  for (const { words, end } of simpleCommands(line)) {
    let j = 0;
    while (j < words.length && (COMMAND_KEYWORDS.has(plainWord(words[j])) || ASSIGNMENT.test(words[j].text))) j++;
    if (j >= words.length) continue;
    const runs = (w) => DOWNLOAD_TOOLS.has(commandName(w)) || CODE_RUNNERS.has(commandName(w));
    let at = -1;
    if (runs(words[j])) at = j;
    else if (COMMAND_WRAPPERS.has(commandName(words[j]))) at = words.findIndex((w, n) => n > j && runs(w));
    if (at < 0) continue;
    const tool = commandName(words[at]);
    if (CODE_RUNNERS.has(tool)) {
      const c = tool === "eval" ? at : words.findIndex((w, n) => n > at && /^-[A-Za-z]*c[A-Za-z]*$/.test(plainWord(w)));
      if (c < 0) continue;
      const code = words.slice(c + 1).map(plainWord).join(" ");
      downloads.push(...lineDownloads(code).map((d) => ({ ...d, nested: true })));
      continue;
    }
    const files = [];
    const urls = [];
    for (let n = at + 1; n < words.length; n++) {
      const out = outputOption(tool, words, n);
      if (out) { files.push(out.file); n = out.last; continue; }
      const url = plainWord(words[n]).match(/https?:\/\/\S*/i);
      if (url) urls.push(url[0]);
    }
    urls.forEach((url, n) => downloads.push({ tool, start: words[at].start, end, url, file: files[n] ?? "" }));
  }
  return downloads;
}

// What may follow a download on its own line: echo, printf, exit, true and : (their
// $( ) bodies are commands of their own) and bare keywords such as the } closing
// `|| { echo ...; exit 1; }`. Anything else might use the file before its check.
const AFTER_DOWNLOAD = new Set(["echo", "printf", "exit", "true", ":"]);
function harmlessAfterDownload({ words }) {
  const j = words.findIndex((w) => !COMMAND_KEYWORDS.has(plainWord(w)));
  return j < 0 || AFTER_DOWNLOAD.has(commandName(words[j]));
}

// A plain checksum line: echo or printf piped into sha256sum -c (or sha256sum -c
// alone, with a here-string), sha256sum the last command, no $( ) or backticks, no
// keyword, no other operator. Under errexit its failure always stops the block.
function plainCheck(line) {
  const commands = simpleCommands(line);
  if (!commands.length || commands.some(({ words }) => words.some((w) => w.text.includes("$(...)")))) return false;
  return commands.every(({ words, end }, n) => {
    const j = words.findIndex((w) => !ASSIGNMENT.test(w.text));
    if (j < 0) return false;
    const name = commandName(words[j]);
    if (n < commands.length - 1) return (name === "echo" || name === "printf") && line[end] === "|" && !"|&".includes(line[end + 1] ?? "");
    return name === "sha256sum" && words.slice(j + 1).some((w) => ["-c", "--check"].includes(plainWord(w))) && line.slice(end).trim() === "";
  });
}

// set +e, set +o errexit, also after other option groups (set +x +e, set +o nounset +o errexit).
const ERREXIT_OFF = /(^|[\s;&|({])set(?:\s+(?:[-+]o\s+\w+|[-+][A-Za-z]+))*?\s+(?:\+[A-Za-z]*e[A-Za-z]*\b|\+o\s+errexit\b)/;

// One problem per download that breaks the rule: { url, message }.
function downloadProblems(run) {
  const problems = [];
  const lines = String(run)
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  lines.forEach((line, i) => {
    const commands = simpleCommands(line);
    for (const { tool, start, end, url, file, nested } of lineDownloads(line)) {
      const problem = (message) => problems.push({ url, message });
      if (nested) { problem(`${tool} runs inside the command string of sh -c or eval, where its check cannot be followed: ${line}`); continue; }
      const rest = line.slice(start);
      if (/(^|[^|])\|(?!\|)/.test(rest)) { problem(`${tool} pipes the download into another command: ${line}`); continue; }
      if (!file || file === "-") { problem(`${tool} does not save the download of ${url} to a file of its own: ${line}`); continue; }
      if (commands.some((c) => c.words[0].start >= end && !harmlessAfterDownload(c))) {
        problem(`a command after the download of ${file} on its own line may use it before it is checked (only echo, printf, exit and true may follow): ${line}`);
        continue;
      }
      const check = lines[i + 1] ?? "";
      if (!/\bsha256sum\b.*(\s-c\b|\s--check\b)/.test(check) || !samePath(check).includes(file)) {
        problem(`the line after the download of ${file} is not its sha256sum -c check: ${check || "(none)"}`);
        continue;
      }
      if (!plainCheck(check)) {
        problem(`the check of ${file} is not a plain echo | sha256sum -c pipeline, so its failure can be ignored or the file used first: ${check}`);
        continue;
      }
      const off = lines.slice(0, i + 2).find((l) => ERREXIT_OFF.test(l));
      if (off) problem(`the block turns errexit off before the check of ${file}: ${off}`);
    }
  });
  return problems;
}

// The shell blocks to check: each run: step of a GitHub workflow, and each script
// section of a GitLab job (or the top-level and default sections).
function downloadBlocks() {
  const blocks = [];
  for (const file of allWorkflowFiles) {
    const wf = YAML.parse(fs.readFileSync(path.join(repo, file), "utf8"));
    for (const [id, job] of Object.entries(wf.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (typeof step.run === "string") blocks.push({ where: `${file} job ${id} step ${step.name ?? "(unnamed)"}`, run: step.run });
      }
    }
  }
  const sections = ["before_script", "script", "after_script"];
  const lines = (v) => (Array.isArray(v) ? v.flat(Infinity) : v === undefined ? [] : [v]).map(String).join("\n");
  for (const file of gitlabFiles) {
    const ci = YAML.parse(fs.readFileSync(path.join(repo, file), "utf8"));
    for (const [key, value] of Object.entries(ci)) {
      if (sections.includes(key)) blocks.push({ where: `${file} ${key}`, run: lines(value) });
      else if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const sec of sections) if (value[sec] !== undefined) blocks.push({ where: `${file} job ${key} ${sec}`, run: lines(value[sec]) });
      }
    }
  }
  return blocks;
}

// The problems left once PENDING_DOWNLOADS is applied: each entry suppresses the one
// download in its block whose URL is the entry's, and is itself a problem when it
// matches no download or more than one.
function unlistedDownloadProblems(blocks, pendingList = PENDING_DOWNLOADS) {
  const problems = [];
  const matched = new Map(pendingList.map((e) => [e, 0]));
  for (const { where, run } of blocks) {
    for (const p of downloadProblems(run)) {
      const pending = pendingList.find((e) => e.where === where && e.download === p.url);
      if (pending) matched.set(pending, matched.get(pending) + 1);
      else problems.push(`${where}: ${p.message}`);
    }
  }
  for (const [e, n] of matched) {
    if (n !== 1) problems.push(`PENDING_DOWNLOADS entry ${e.download} matches ${n} downloads in ${e.where}, not exactly one${n === 0 ? "; remove the entry" : ""}`);
  }
  return problems;
}

test("every curl or wget download in a run: block or GitLab script is checked with sha256sum -c before it is extracted or installed", () => {
  for (const f of ["templates/ci/gitlab/java23-quality-gates.yml", "ci/templates/microservice/gitlab-ci.yml", "ci/templates/bounded-context/gitlab-ci.yml"]) {
    assert.ok(gitlabFiles.includes(f), `the GitLab CI file ${f} is scanned`);
  }
  const blocks = downloadBlocks();
  assert.ok(blocks.some((b) => b.where.startsWith("templates/ci/gitlab/") && /gitleaks/.test(b.run)), "the GitLab gitleaks install is among the scanned blocks");
  assert.deepEqual(unlistedDownloadProblems(blocks), []);
  for (const e of PENDING_DOWNLOADS) assert.ok(e.reason, `PENDING_DOWNLOADS entry ${e.download} needs a reason`);
});

test("the download check itself accepts a checked file and rejects pipes, missing, late or conditional checks", () => {
  const ok = [
    'curl -sSfL -o "$d/t.tar.gz" "https://example.test/t.tar.gz"\necho "${sha}  $d/t.tar.gz" | sha256sum -c -\ntar -xz -C "$d" -f "$d/t.tar.gz"',
    'wget -q -O "$d/t.zip" https://example.test/t.zip\necho "${sha}  $d/t.zip" | sha256sum --check -\nunzip "$d/t.zip"',
    'curl -sSfL \\\n  -o "$d/t.tar.gz" \\\n  "https://example.test/t.tar.gz"\necho "${sha}  $d/t.tar.gz" | sha256sum -c -\ntar -xzf "$d/t.tar.gz"',
    'command -v curl >/dev/null\necho no download here',
    // Not downloads: curl as a package name or with no URL, in a quoted string, in a comment.
    "apt-get update && apt-get install -y curl ca-certificates && curl --version",
    'echo "fetch it later; curl https://example.test/i.sh | sh"',
    "true # later; curl https://example.test/i.sh | sh",
    // A failure message or a log line after the download names the file but does not use it.
    'curl -sSfL -o "$d/jq" https://example.test/jq-linux64 || { echo "jq download failed" >&2; exit 1; }\necho "${sha}  $d/jq" | sha256sum -c -\nchmod +x "$d/jq"',
    'curl -sSfL -o "$d/t" https://example.test/t; echo fetched\necho "${sha}  $d/t" | sha256sum -c -',
    'curl -sSfL -o "$d/t.tar.gz" https://example.test/t && echo "fetched t.tar.gz"\necho "${sha}  $d/t.tar.gz" | sha256sum -c -',
    // Other plain checks: a here-string, printf, --check --status, 2>&1, a trailing comment.
    'curl -sSfL -o "$d/t.tar.gz" https://example.test/t\nsha256sum -c <<< "${sha}  $d/t.tar.gz"',
    'set -e +x\ncurl -sSfL -o "$d/t.tar.gz" https://example.test/t\nprintf \'%s  %s\\n\' "$sha" "$d/t.tar.gz" | sha256sum --check --status - 2>&1 # pinned',
  ];
  for (const run of ok) assert.deepEqual(downloadProblems(run), [], run);
  const get = 'curl -sSfL -o "$d/t.tar.gz" https://example.test/t';
  const check = 'echo "${sha}  $d/t.tar.gz" | sha256sum -c -';
  const extract = 'tar -xzf "$d/t.tar.gz"';
  const bad = {
    "curl into tar": 'curl -sSfL "https://example.test/t.tar.gz" | tar -xz -C "$d"',
    "curl into tar over a line continuation": 'curl -sSfL "https://example.test/t.tar.gz" \\\n  | tar -xz -C "$d" t',
    "wget into sh": "wget -qO- https://example.test/i.sh | sh",
    "curl to stdout": 'v="$(curl -sSf https://example.test/t)"',
    "curl -o -": "curl -sSfL -o - https://example.test/t.tar.gz > t.tar.gz",
    "no check": 'curl -sSfL -o "$d/t.tar.gz" https://example.test/t\ntar -xzf "$d/t.tar.gz"',
    "check after extract": 'curl -sSfL -o "$d/t.tar.gz" https://example.test/t\ntar -xzf "$d/t.tar.gz"\necho "${sha}  $d/t.tar.gz" | sha256sum -c -',
    "hash without -c": 'curl -sSfL -o "$d/t.tar.gz" https://example.test/t\nsha256sum "$d/t.tar.gz"\ntar -xzf "$d/t.tar.gz"',
    "check of another file": 'curl -sSfL -o "$d/t.tar.gz" https://example.test/t\necho "${sha}  $d/other.tar.gz" | sha256sum -c -\ntar -xzf "$d/t.tar.gz"',
    "check only when a pin exists": 'curl -sSfL -o "$d/t.tar.gz" https://example.test/t\nif [ -n "$pinned" ]; then\necho "${pinned}  $d/t.tar.gz" | sha256sum -c -\nelse\necho "::warning::unverified"\nfi\ntar -xzf "$d/t.tar.gz"',
    "check failure ignored": 'curl -sSfL -o "$d/t.tar.gz" https://example.test/t\necho "${sha}  $d/t.tar.gz" | sha256sum -c - || true\ntar -xzf "$d/t.tar.gz"',
    "check guarded by &&": 'curl -sSfL -o "$d/t.tar.gz" https://example.test/t\n[ -n "$sha" ] && echo "${sha}  $d/t.tar.gz" | sha256sum -c -\ntar -xzf "$d/t.tar.gz"',
    // The check is a plain pipeline and errexit stays on (review F1).
    "check under if !, one line": `${get}\nif ! ${check}; then echo "::warning::mismatch"; fi\n${extract}`,
    "check under if !, several lines": `${get}\nif ! ${check}; then\necho "::warning::mismatch"\nfi\n${extract}`,
    "check under elif": `if [ -z "$cached" ]; then ${get}\nelif ${check}; then :\nfi\n${extract}`,
    "check under while !": `${get}\nwhile ! ${check}; do break; done\n${extract}`,
    "check under until": `${get}\nuntil ${check}; do break; done\n${extract}`,
    "check negated with !": `${get}\n! ${check}\n${extract}`,
    "check in the background": `${get}\n${check} &\n${extract}`,
    "check followed by ; true": `${get}\n${check}; true\n${extract}`,
    "set +e before the check": `set +e\n${get}\n${check}\n${extract}`,
    "set +o errexit before the check": `set +o errexit\n${get}\n${check}\n${extract}`,
    // The check is the last command of the pipeline, outside any $( ) (verification V2).
    "check inside $( ) of an echo": `${get}\necho "checksum: $(${check})"\n${extract}`,
    "check inside $( ) of an export": `${get}\nexport r="$(${check})"\n${extract}`,
    "check inside backticks": `${get}\necho "checksum: \`${check}\`"\n${extract}`,
    "check piped on to tee": `${get}\n${check} | tee "$d/check.log"\n${extract}`,
    "file run inside the check pipeline": `${get}\nsh "$d/t.tar.gz" | sha256sum -c -\n${extract}`,
    "set +x +e before the check": `set +x +e\n${get}\n${check}\n${extract}`,
    "set +o nounset +o errexit before the check": `set +o nounset +o errexit\n${get}\n${check}\n${extract}`,
    "set -o pipefail +e before the check": `set -o pipefail +e\n${get}\n${check}\n${extract}`,
    // A curl or wget command anywhere on the line is a download (review F2).
    "assignment prefix": 'GH_HOST=github.com curl -sSfL "https://example.test/t.tar.gz" | tar -xz -C "$d"',
    "timeout": "timeout 60 curl -sSfL https://example.test/i.sh | sh",
    "command": "command curl -sSfL https://example.test/i.sh | sh",
    "env": "env FOO=1 wget -qO- https://example.test/i.sh | sh",
    "nice": "nice -n 5 curl -sSfL https://example.test/i.sh | sh",
    "time -p": "time -p curl -sSfL https://example.test/i.sh | sh",
    "sudo with an option": "sudo -E curl -sSfL https://example.test/i.sh | sh",
    "path": "/usr/bin/curl -sSfL https://example.test/i.sh | sh",
    "leading backslash": "\\curl -sSfL https://example.test/i.sh | sh",
    "quoted command": '"curl" -sSfL https://example.test/i.sh | sh',
    "backticks": "v=`curl -sSf https://example.test/t`",
    "brace group": "{ curl -sSfL https://example.test/i.sh; } | bash",
    "elif": "if [ -n \"$x\" ]; then :; elif curl -sSfL https://example.test/i.sh | sh; then :; fi",
    "while": "while curl -sSfL https://example.test/i.sh | sh; do break; done",
    "until": "until curl -sSfL https://example.test/i.sh | sh; do sleep 1; done",
    // The check is the next line; nothing after the download on its line uses it (review F3).
    "use spelled ${d} before the check": `${get}\ntar -xzf "\${d}/t.tar.gz"\n${check}`,
    'use spelled "$d"/ before the check': `${get}\ntar -xzf "$d"/t.tar.gz\n${check}`,
    "use from inside the directory before the check": `${get}\n(cd "$d" && tar -xzf t.tar.gz)\n${check}`,
    "use on the download's own line": `${get} && tar -xzf "$d"/t.tar.gz\n${check}`,
    // Only echo, printf, exit and true may follow the download on its line (verification V3).
    "use by glob on the download's own line": `${get} && tar -xz -C "$d" -f "$d"/t.*\n${check}`,
    "run by glob on the download's own line": `${get}; sh "$d"/t.*\n${check}`,
    "use through another name on the download's own line": 'f="$d/t.tar.gz"; curl -sSfL -o "$f" https://example.test/t && tar -xzf "$d/t.tar.gz"\necho "${sha}  $f" | sha256sum -c -',
    "use inside $( ) of a later echo": `${get} && echo "$(sh "$d"/t.*)"\n${check}`,
    // Every download on a line is checked (review F4).
    "second download on the line, unchecked": 'curl -sSfL -o "$d/a.tgz" https://example.test/a; curl -sSfL -o "$d/b.tgz" https://example.test/b\necho "${sha}  $d/a.tgz" | sha256sum -c -\ntar -xzf "$d/a.tgz"; tar -xzf "$d/b.tgz"',
    // Every URL of a curl or wget command is a download of its own (verification V1).
    "second URL with its own -o, unchecked": 'curl -sSfL -o "$d/a.tgz" https://example.test/a -o "$d/b.sh" https://example.test/b\necho "${sha}  $d/a.tgz" | sha256sum -c -\ntar -xzf "$d/a.tgz"\nbash "$d/b.sh"',
    "second URL with no -o": 'curl -sSfL -o "$d/a.tgz" https://example.test/a https://example.test/b\necho "${sha}  $d/a.tgz" | sha256sum -c -\ntar -xzf "$d/a.tgz"',
    "wget with two URLs into one file": 'wget -q -O "$d/a.tgz" https://example.test/a https://example.test/b\necho "${sha}  $d/a.tgz" | sha256sum -c -\ntar -xzf "$d/a.tgz"',
    // A download in the command string of sh -c, bash -c or eval (verification V4).
    "sh -c": `sh -c "curl -sSfL 'https://example.test/t.tar.gz' | tar -xz -C '$d'"`,
    "bash -ec": "bash -ec 'curl -sSfL https://example.test/i.sh | sh'",
    "sudo sh -c": "sudo sh -c 'curl -sSfL https://example.test/i.sh | sh'",
    "eval": 'eval "curl -sSfL https://example.test/i.sh | sh"',
    "sh -c even when it saves and checks": `sh -c '${get}'\n${check}\n${extract}`,
  };
  for (const [name, run] of Object.entries(bad)) assert.notDeepEqual(downloadProblems(run), [], name);
});

test("a PENDING_DOWNLOADS entry suppresses exactly the one download it names", () => {
  const where = "templates/ci/gitlab/java23-quality-gates.yml job quality_gates before_script";
  const nodesource = "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -";
  // The list is empty now; the rule is checked with the entry it once held.
  const pending = [{ where, download: "https://deb.nodesource.com/setup_22.x", reason: "test entry" }];
  assert.deepEqual(unlistedDownloadProblems([{ where, run: nodesource }], pending), []);
  assert.notDeepEqual(unlistedDownloadProblems([{ where, run: nodesource }]), [], "an unlisted NodeSource install is refused");
  const cases = {
    "a second download on the NodeSource line": `${nodesource} && curl -fsSL https://get.example.test/install.sh | sh`,
    "the NodeSource download twice": `${nodesource}\n${nodesource}`,
    // A second URL on the NodeSource curl itself (verification V1).
    "a second URL on the NodeSource curl": "curl -fsSL https://deb.nodesource.com/setup_22.x https://get.example.test/install.sh | bash -",
    "a second URL with its own -o on the NodeSource curl": 'curl -fsSL https://deb.nodesource.com/setup_22.x -o "$d/i.sh" https://get.example.test/i.sh | bash -',
  };
  for (const [name, run] of Object.entries(cases)) assert.notDeepEqual(unlistedDownloadProblems([{ where, run }], pending), [], name);
});
