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

// Every curl or wget in a run: block saves the download to a file, nothing after it
// on its line uses that file, and the next line of the block is an unconditional
// `sha256sum -c` of that file, before anything extracts, installs, moves or runs it
// (DevSecOps review 2026-10-17). The check is a plain pipeline (no if, elif, while,
// until, !, &&, ||, ; or &) and the block does not turn errexit off before it.
// Piping a download (curl ... | tar, wget -O- | sh) or keeping it on stdout fails.
// A download is a curl or wget command with an http(s):// URL argument, wherever it
// runs: after an assignment prefix, a wrapper (timeout, command, env, nice, time,
// exec, sudo), a keyword, inside $( ), backticks or { }, by path or quoted.
// Applies to every workflow above, the legacy reference copy included, and to the
// before_script, script and after_script lines of every GitLab CI file (each
// section is one shell session, checked as one block). PENDING_DOWNLOADS lists the
// downloads allowed to fail the rule, each by its block and the URL of its download,
// with the reason; every entry must match exactly one download, so the list only
// shrinks.
const PENDING_DOWNLOADS = [
  { where: "templates/ci/gitlab/java23-quality-gates.yml job quality_gates before_script", download: "https://deb.nodesource.com/setup_22.x",
    reason: "an install script, not a release asset; replacing it changes how the template provisions Node" },
];

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
const COMMAND_KEYWORDS = new Set(["if", "elif", "while", "until", "then", "do", "else", "!", "{", "}"]);
const COMMAND_WRAPPERS = new Set(["timeout", "command", "env", "nice", "time", "exec", "sudo", "nohup"]);
const plainWord = (w) => w.text.replace(/\\(.)/g, "$1").replace(/["']/g, "");
const commandName = (w) => plainWord(w).split("/").pop();

// The downloads on one logical line: each curl or wget command (directly, or run by a
// wrapper) that has an http(s):// URL argument.
function lineDownloads(line) {
  const downloads = [];
  for (const { words, end } of simpleCommands(line)) {
    let j = 0;
    while (j < words.length && (COMMAND_KEYWORDS.has(plainWord(words[j])) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[j].text))) j++;
    if (j >= words.length) continue;
    let at = -1;
    if (DOWNLOAD_TOOLS.has(commandName(words[j]))) at = j;
    else if (COMMAND_WRAPPERS.has(commandName(words[j]))) at = words.findIndex((w, n) => n > j && DOWNLOAD_TOOLS.has(commandName(w)));
    if (at < 0) continue;
    const url = words.slice(at + 1).map((w) => plainWord(w).match(/https?:\/\/\S*/i)).find(Boolean);
    if (url) downloads.push({ tool: commandName(words[at]), start: words[at].start, end, url: url[0] });
  }
  return downloads;
}

const unquote = (s) => s.replace(/^(["'])(.*)\1$/, "$2");
// One spelling for a path: no quotes, ${name} written as $name.
const samePath = (s) => s.replace(/["']/g, "").replace(/\$\{(\w+)\}/g, "$$$1");
const ERREXIT_OFF = /(^|[\s;&|({])set\s+(?:-\S*\s+)*(?:\+[A-Za-z]*e|\+o\s+errexit\b)/;

// One problem per download that breaks the rule: { url, message }.
function downloadProblems(run) {
  const problems = [];
  const lines = String(run)
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  lines.forEach((line, i) => {
    for (const { tool, start, end, url } of lineDownloads(line)) {
      const problem = (message) => problems.push({ url, message });
      const rest = line.slice(start);
      if (/(^|[^|])\|(?!\|)/.test(rest)) { problem(`${tool} pipes the download into another command: ${line}`); continue; }
      const command = line.slice(start, end);
      const out = tool === "curl"
        ? command.match(/\s(?:--output[ =]|-[A-Za-z]*o\s+)("[^"]+"|'[^']+'|[^\s;&|)]+)/)
        : command.match(/\s(?:--output-document[ =]|-[A-Za-z]*O\s*)("[^"]+"|'[^']+'|[^\s;&|)]+)/);
      const file = out ? samePath(unquote(out[1])) : "";
      if (!file || file === "-") { problem(`${tool} does not save the download to a file: ${line}`); continue; }
      if (samePath(line.slice(end)).includes(file.split("/").pop())) { problem(`${file} is used on the download's own line, before it is checked: ${line}`); continue; }
      const check = lines[i + 1] ?? "";
      if (!/\bsha256sum\b.*(\s-c\b|\s--check\b)/.test(check) || !samePath(check).includes(file)) {
        problem(`the line after the download of ${file} is not its sha256sum -c check: ${check || "(none)"}`);
        continue;
      }
      if (/^(if|elif|while|until)\b|(^|\s)!(\s|$)|&&|\|\||;|(^|[^&<>])&(?![&>])/.test(check)) {
        problem(`the check of ${file} is not a plain sha256sum -c pipeline, so its failure can be ignored: ${check}`);
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
    // Every download on a line is checked (review F4).
    "second download on the line, unchecked": 'curl -sSfL -o "$d/a.tgz" https://example.test/a; curl -sSfL -o "$d/b.tgz" https://example.test/b\necho "${sha}  $d/a.tgz" | sha256sum -c -\ntar -xzf "$d/a.tgz"; tar -xzf "$d/b.tgz"',
  };
  for (const [name, run] of Object.entries(bad)) assert.notDeepEqual(downloadProblems(run), [], name);
});

test("a PENDING_DOWNLOADS entry suppresses exactly the one download it names", () => {
  const where = "templates/ci/gitlab/java23-quality-gates.yml job quality_gates before_script";
  const nodesource = "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -";
  assert.deepEqual(unlistedDownloadProblems([{ where, run: nodesource }]), []);
  const cases = {
    "a second download on the NodeSource line": `${nodesource} && curl -fsSL https://get.example.test/install.sh | sh`,
    "the NodeSource download twice": `${nodesource}\n${nodesource}`,
  };
  for (const [name, run] of Object.entries(cases)) assert.notDeepEqual(unlistedDownloadProblems([{ where, run }]), [], name);
});
