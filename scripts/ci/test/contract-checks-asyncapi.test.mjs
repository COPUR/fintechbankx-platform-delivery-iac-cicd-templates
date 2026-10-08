// Tests for the contracts/asyncapi job of contract-checks.yml (ADR-019 section 5: every
// provider gates its own AsyncAPI spec with `asyncapi validate` and the catalog's
// asyncapi-breaking.mjs against origin/main). The step scripts are executed for real
// (bash, a fixture service repository with a bare origin, a stub npx and a stub
// catalog script that records what it was shown). Set FBX_ASYNCAPI_CATALOG_DIR to a
// checkout of the asyncapi catalog (with npm ci done) to also run the real rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const wfPath = path.join(repo, ".github/workflows/contract-checks.yml");
const workflow = () => YAML.parse(fs.readFileSync(wfPath, "utf8"));
const inputs = () => workflow().on.workflow_call.inputs;
const job = () => workflow().jobs.asyncapi;
const step = (re) => {
  const s = (job().steps ?? []).find((x) => re.test(x.name ?? ""));
  if (!s) throw new Error(`step ${re} not found in contracts/asyncapi`);
  return s;
};
const PINNED_CATALOG = "b0e31eeef1fedff3344466f25c352ed93bd79eed";
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

function runStep(s, env, { cwd, pathPrefix } = {}) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fbx-out-")), "github-output");
  fs.writeFileSync(out, "");
  const res = spawnSync("bash", ["--noprofile", "--norc", "-c", s.run], {
    cwd,
    encoding: "utf8",
    env: { ...gitEnv, PATH: `${pathPrefix ? `${pathPrefix}:` : ""}${process.env.PATH}`, GITHUB_OUTPUT: out, BASE_REF: "origin/main", ...env },
  });
  const outputs = Object.fromEntries(
    fs.readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, log: res.stdout + res.stderr, outputs };
}

// A service repository: origin/main holds `main` files, the checked-out branch holds `branch` files.
function serviceRepo({ main = {}, branch, mainOnly = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "fbx-svc-"));
  const work = path.join(base, "work");
  const bare = path.join(base, "origin.git");
  fs.mkdirSync(work);
  const git = (...a) => execFileSync("git", a, { cwd: work, encoding: "utf8", env: gitEnv }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "ci@example.invalid");
  git("config", "user.name", "ci");
  git("config", "commit.gpgsign", "false");
  const write = (files) => {
    for (const [f, content] of Object.entries(files)) {
      const p = path.join(work, f);
      if (content === null) {
        fs.rmSync(p, { force: true });
        continue;
      }
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, typeof content === "string" ? content : YAML.stringify(content));
    }
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", "change");
  };
  write({ "README.md": "service\n", ...main });
  execFileSync("git", ["clone", "-q", "--bare", work, bare], { env: gitEnv });
  git("remote", "add", "origin", bare);
  if (!mainOnly) git("fetch", "-q", "origin");
  if (branch) {
    git("checkout", "-q", "-b", "feature");
    write(branch);
  }
  return { work, git };
}

// --- AsyncAPI fixtures (AsyncAPI 3.0, the shape the catalog rules read) --------------------
const envelope = {
  EventEnvelope: {
    type: "object",
    required: ["eventId", "eventType", "data"],
    properties: { eventId: { type: "string", format: "uuid" }, eventType: { type: "string" }, data: { type: "object" } },
  },
};
const spec = (dataProps = { customerId: { type: "string" }, segment: { type: "string" } }) => ({
  asyncapi: "3.0.0",
  info: { title: "svc-cus-profile-kyc", version: "1.0.0" },
  channels: {
    created: {
      address: "evt.cus.customer.created.v1",
      messages: { CustomerCreated: { $ref: "#/components/messages/CustomerCreated" } },
      bindings: { kafka: { topic: "evt.cus.customer.created.v1" } },
    },
  },
  components: {
    schemas: {
      EventEnvelope: { $ref: "./common/event-envelope.yaml#/EventEnvelope" },
      CustomerCreatedData: { type: "object", required: ["customerId"], properties: dataProps },
    },
    messages: {
      CustomerCreated: {
        payload: {
          allOf: [
            { $ref: "#/components/schemas/EventEnvelope" },
            { type: "object", properties: { data: { $ref: "#/components/schemas/CustomerCreatedData" } } },
          ],
        },
      },
    },
  },
});
const D = "api/asyncapi";
const SPEC = `${D}/svc-cus-profile-kyc.yaml`;
const ENV = `${D}/common/event-envelope.yaml`;

// Stub catalog with the interface of asyncapi-breaking.mjs at the pinned commit (ASYNCAPI_DIR, BASE_REF, merge
// base computed by the script): records what it was shown, fails when a head spec has "BREAK" or a base spec is gone.
function stubCatalog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbx-catalog-"));
  fs.mkdirSync(path.join(dir, "scripts", "ci"), { recursive: true });
  const log = path.join(dir, "seen.log");
  fs.writeFileSync(
    path.join(dir, "scripts", "ci", "asyncapi-breaking.mjs"),
    `import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const sh = (a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
const dir = process.env.ASYNCAPI_DIR || 'asyncapi';
const base = sh(['merge-base', process.env.BASE_REF, 'HEAD']);
const baseFiles = sh(['ls-tree', '-r', '--name-only', base, '--', dir]).split('\\n').filter(Boolean);
const headFiles = fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map((f) => dir + '/' + f).filter((f) => fs.statSync(f).isFile()).sort() : [];
const specPath = dir + '/svc-cus-profile-kyc.yaml';
const baseSpec = baseFiles.includes(specPath) ? sh(['show', base + ':' + specPath]) : null;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), dir, baseRef: process.env.BASE_REF, base, baseFiles, headFiles, baseSpec }) + '\\n');
const isSpec = (f) => f.startsWith(dir + '/') && /^[^/]+\\.ya?ml$/.test(f.slice(dir.length + 1));
const broken = headFiles.filter((f) => isSpec(f) && fs.readFileSync(f, 'utf8').includes('BREAK'));
const removed = baseFiles.filter((f) => isSpec(f) && !headFiles.includes(f));
if (broken.length || removed.length) { console.error('BREAKING ' + broken.concat(removed).join(' ')); process.exit(1); }
console.log('asyncapi breaking check passed');
`,
  );
  const seen = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { dir, seen };
}

function stubNpx(exitCode = 0) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "fbx-npx-"));
  fs.writeFileSync(path.join(bin, "npx"), `#!/usr/bin/env bash\necho "$*" >> "${bin}/calls"\nexit ${exitCode}\n`, { mode: 0o755 });
  return { bin, calls: () => (fs.existsSync(path.join(bin, "calls")) ? fs.readFileSync(path.join(bin, "calls"), "utf8") : "") };
}

const find = (svc, env = {}) =>
  runStep(step(/^Find AsyncAPI specs/), { SPEC_DIR: inputs()["asyncapi-spec-dir"].default, LEGACY_GLOBS: "", PUBLISHES_EVENTS: "false", ...env }, { cwd: svc.work });
// The catalog step runs in the checked-out service repository, as the job runs it.
function breaking(svc, found, catalog) {
  assert.equal(found.outputs.breaking, "true", found.log);
  return runStep(step(/^AsyncAPI breaking-change check/), { SPEC_DIR: found.outputs.dir, CATALOG_DIR: catalog.dir }, { cwd: svc.work });
}

// --- 1. workflow shape ------------------------------------------------------------------------

test("contract-checks exposes the provider AsyncAPI gate inputs with pinned defaults", () => {
  const i = inputs();
  assert.equal(i["publishes-events"].type, "boolean");
  assert.equal(i["publishes-events"].default, false);
  assert.match(i["publishes-events"].description, /ADR-019/);
  assert.equal(i["asyncapi-catalog-repository"].default, "COPUR/fintechbankx-governance-api-contracts-asyncapi-catalog");
  assert.equal(i["asyncapi-catalog-ref"].default, PINNED_CATALOG);
  assert.match(i["asyncapi-cli-version"].default, /^\d+\.\d+\.\d+$/);
  assert.equal(i["asyncapi-spec-dir"].default, "api/asyncapi", "provider repos keep their spec under api/asyncapi");
  assert.equal(i["asyncapi-globs"].default, "", "legacy input, replaced by asyncapi-spec-dir");
});

test("contracts/asyncapi: full history, pinned actions, catalog fetched at the input commit, steps in order", () => {
  const j = job();
  const text = fs.readFileSync(wfPath, "utf8");
  const checkout = j.steps.find((s) => s.name === "Checkout");
  assert.equal(checkout.with["fetch-depth"], 0);
  for (const s of j.steps.filter((x) => x.uses)) {
    assert.match(s.uses, /^[^@\s]+@[0-9a-f]{40}$/, `${s.name}: ${s.uses} must be pinned to a commit SHA`);
    const line = text.split("\n").find((l) => l.includes(`uses: ${s.uses}`));
    assert.match(line, /#\s*v\d+(\.\d+)*\s*$/, `${s.uses} needs a version comment`);
  }
  const cat = step(/^Checkout AsyncAPI catalog/);
  assert.equal(cat.with.repository, "${{ inputs.asyncapi-catalog-repository }}");
  assert.equal(cat.with.ref, "${{ inputs.asyncapi-catalog-ref }}");
  assert.equal(cat.with["sparse-checkout"], "scripts/ci");
  assert.equal(cat.with["persist-credentials"], false);
  assert.equal(j.env.BASE_REF, "origin/main", "ADR-019: always compared with origin/main");
  const names = j.steps.map((s) => s.name);
  const at = (re) => names.findIndex((n) => re.test(n));
  const order = [/^Pinned tool versions/, /^Checkout$/, /^Find AsyncAPI specs/, /^AsyncAPI validate/, /^Checkout AsyncAPI catalog/, /^Install AsyncAPI catalog/, /^AsyncAPI breaking-change check/].map(at);
  assert.ok(order.every((x, k) => x >= 0 && (k === 0 || x > order[k - 1])), `step order: ${names.join(" | ")}`);
  for (const s of [step(/^AsyncAPI validate/), step(/^AsyncAPI breaking-change check/)]) {
    assert.equal(s["continue-on-error"], undefined, `${s.name} must fail the job`);
  }
});

test("pinned versions step rejects branches, tags, short SHAs and version ranges", () => {
  const s = step(/^Pinned tool versions/);
  const ok = runStep(s, { ASYNCAPI_CLI_VERSION: "2.13.0", CATALOG_REF: PINNED_CATALOG });
  assert.equal(ok.status, 0, ok.log);
  for (const ref of ["main", "v1.0.0", PINNED_CATALOG.slice(0, 7), ""]) {
    const r = runStep(s, { ASYNCAPI_CLI_VERSION: "2.13.0", CATALOG_REF: ref });
    assert.notEqual(r.status, 0, `catalog ref '${ref}' must be rejected`);
    assert.match(r.log, /40-hex/);
  }
  for (const v of ["latest", "^2.13.0", "2"]) {
    assert.notEqual(runStep(s, { ASYNCAPI_CLI_VERSION: v, CATALOG_REF: PINNED_CATALOG }).status, 0, `cli version '${v}'`);
  }
});

// --- 2. which specs, which directories --------------------------------------------------------

test("no AsyncAPI spec: not applicable by default, an error when the repository publishes events", () => {
  const svc = serviceRepo({ branch: { "src/x.txt": "x" } });
  let r = find(svc);
  assert.equal(r.status, 0, r.log);
  assert.equal(r.outputs.count, "0");
  assert.equal(r.outputs.breaking, "false");
  assert.match(r.log, /not applicable/);
  r = find(svc, { PUBLISHES_EVENTS: "true" });
  assert.notEqual(r.status, 0);
  assert.match(r.log, /::error::publishes-events is true.*ADR-019 section 5/);
});

test("only top-level specs are specs; shared fragments in subdirectories are not validated", () => {
  const svc = serviceRepo({ main: { [SPEC]: spec(), [ENV]: envelope } });
  const r = find(svc, { PUBLISHES_EVENTS: "true" });
  assert.equal(r.status, 0, r.log);
  assert.equal(fs.readFileSync(path.join(svc.work, "asyncapi-specs.txt"), "utf8"), `${SPEC}\n`);
  assert.equal(r.outputs.dir, D);
  assert.equal(r.outputs.breaking, "true");
  assert.equal(r.outputs.base, svc.git("rev-parse", "origin/main"));
  const npx = stubNpx(0);
  const v = runStep(step(/^AsyncAPI validate/), { ASYNCAPI_CLI_VERSION: "2.13.0" }, { cwd: svc.work, pathPrefix: npx.bin });
  assert.equal(v.status, 0, v.log);
  assert.equal(npx.calls(), `-y @asyncapi/cli@2.13.0 validate ${SPEC}\n`);
  const bad = runStep(step(/^AsyncAPI validate/), { ASYNCAPI_CLI_VERSION: "2.13.0" }, { cwd: svc.work, pathPrefix: stubNpx(1).bin });
  assert.notEqual(bad.status, 0, "an invalid spec fails the job");
});

test("asyncapi-spec-dir selects the directory; catalog-style asyncapi/ works with asyncapi-spec-dir: asyncapi", () => {
  const svc = serviceRepo({ main: { "asyncapi/svc-x.yaml": spec(), "asyncapi/common/event-envelope.yaml": envelope } });
  let r = find(svc, { PUBLISHES_EVENTS: "true" });
  assert.notEqual(r.status, 0, "default api/asyncapi has no spec here");
  assert.match(r.log, /set asyncapi-spec-dir/);
  r = find(svc, { SPEC_DIR: "asyncapi/", PUBLISHES_EVENTS: "true" });
  assert.equal(r.status, 0, r.log);
  assert.equal(r.outputs.dir, "asyncapi");
  assert.equal(fs.readFileSync(path.join(svc.work, "asyncapi-specs.txt"), "utf8"), "asyncapi/svc-x.yaml\n");
});

test("asyncapi-spec-dir must be repository-relative; the legacy asyncapi-globs input fails loudly", () => {
  const svc = serviceRepo({ main: { [SPEC]: spec(), [ENV]: envelope } });
  for (const bad of ["", "/abs/asyncapi", "../asyncapi", "api/../x", ".", "api asyncapi"]) {
    const r = find(svc, { SPEC_DIR: bad });
    assert.notEqual(r.status, 0, `asyncapi-spec-dir '${bad}' must be rejected`);
    assert.match(r.log, /asyncapi-spec-dir must be/);
  }
  const r = find(svc, { LEGACY_GLOBS: "api/asyncapi/*.yaml" });
  assert.notEqual(r.status, 0);
  assert.match(r.log, /asyncapi-globs is replaced by asyncapi-spec-dir/);
});

test("removing every spec that is on origin/main still runs the breaking check (no bypass)", () => {
  const svc = serviceRepo({ main: { [SPEC]: spec(), [ENV]: envelope }, branch: { [SPEC]: null, [ENV]: null } });
  const r = find(svc);
  assert.equal(r.status, 0, r.log);
  assert.equal(r.outputs.count, "0");
  assert.equal(r.outputs.breaking, "true");
  const catalog = stubCatalog();
  const b = breaking(svc, r, catalog);
  assert.notEqual(b.status, 0, "removed-spec fails");
  assert.match(b.log, /::error::AsyncAPI breaking change in api\/asyncapi/);
});

test("specs on the branch but origin/main unavailable: fails closed", () => {
  const svc = serviceRepo({ main: { [SPEC]: spec(), [ENV]: envelope }, mainOnly: true });
  svc.git("remote", "set-url", "origin", path.join(os.tmpdir(), "fbx-no-such-remote.git"));
  const r = find(svc);
  assert.notEqual(r.status, 0);
  assert.match(r.log, /origin\/main is not available/);
});

// --- 3. breaking check: what the catalog script is shown -------------------------------------

test("breaking check runs the catalog script in the checkout with ASYNCAPI_DIR and BASE_REF=origin/main", () => {
  const svc = serviceRepo({
    main: { [SPEC]: spec(), [ENV]: envelope },
    branch: { [SPEC]: spec({ customerId: { type: "string" }, segment: { type: "string" }, tier: { type: "string" } }), [`${D}/svc-cus-profile-kyc.accepted-breaking.txt`]: "# none\n" },
  });
  const r = find(svc);
  const catalog = stubCatalog();
  const b = breaking(svc, r, catalog);
  assert.equal(b.status, 0, b.log);
  const [seen] = catalog.seen();
  assert.equal(fs.realpathSync(seen.cwd), fs.realpathSync(svc.work), "runs in the checked-out repository, no staging copy");
  assert.equal(seen.dir, D, "ASYNCAPI_DIR = asyncapi-spec-dir");
  assert.equal(seen.baseRef, "origin/main");
  assert.equal(seen.base, svc.git("merge-base", "origin/main", "HEAD"));
  assert.deepEqual(seen.baseFiles, [ENV, SPEC]);
  assert.deepEqual(seen.headFiles, [ENV, `${D}/svc-cus-profile-kyc.accepted-breaking.txt`, SPEC]);
  assert.doesNotMatch(seen.baseSpec, /tier/, "baseline is origin/main, not the branch");
  assert.match(b.log, /\[asyncapi-breaking\] api\/asyncapi against origin\/main/);
});

test("first PR: a spec that is not on origin/main is compared with an empty baseline", () => {
  const svc = serviceRepo({ branch: { [SPEC]: spec(), [ENV]: envelope } });
  const r = find(svc, { PUBLISHES_EVENTS: "true" });
  assert.equal(r.status, 0, r.log);
  const catalog = stubCatalog();
  const b = breaking(svc, r, catalog);
  assert.equal(b.status, 0, b.log);
  assert.deepEqual(catalog.seen()[0].baseFiles, []);
});

test("a finding fails the step; specs outside asyncapi-spec-dir are not the provider's contract", () => {
  const svc = serviceRepo({
    main: { [SPEC]: spec(), [ENV]: envelope, "asyncapi/svc-other.yaml": spec() },
    branch: { [SPEC]: `# BREAK\n${YAML.stringify(spec({ customerId: { type: "string" } }))}`, "asyncapi/svc-other.yaml": null },
  });
  const r = find(svc);
  assert.equal(fs.readFileSync(path.join(svc.work, "asyncapi-base-specs.txt"), "utf8"), `${SPEC}\n`);
  const catalog = stubCatalog();
  const b = breaking(svc, r, catalog);
  assert.notEqual(b.status, 0);
  assert.equal(catalog.seen().length, 1);
  assert.match(b.log, /::error::AsyncAPI breaking change in api\/asyncapi against origin\/main/);
});

test("missing catalog script, or one without ASYNCAPI_DIR support, fails closed", () => {
  const svc = serviceRepo({ main: { [SPEC]: spec(), [ENV]: envelope } });
  const r = find(svc);
  let b = breaking(svc, r, { dir: fs.mkdtempSync(path.join(os.tmpdir(), "fbx-empty-")) });
  assert.notEqual(b.status, 0);
  assert.match(b.log, /not found at the pinned catalog commit/);
  // A catalog commit from before ASYNCAPI_DIR would check asyncapi/ only and pass vacuously for api/asyncapi.
  const old = fs.mkdtempSync(path.join(os.tmpdir(), "fbx-old-catalog-"));
  fs.mkdirSync(path.join(old, "scripts", "ci"), { recursive: true });
  fs.writeFileSync(path.join(old, "scripts", "ci", "asyncapi-breaking.mjs"), "console.log('asyncapi breaking check passed');\n");
  b = breaking(svc, r, { dir: old });
  assert.notEqual(b.status, 0);
  assert.match(b.log, /does not support ASYNCAPI_DIR/);
});

// --- 4. optional: the real catalog rules -------------------------------------------------------

const realCatalog = process.env.FBX_ASYNCAPI_CATALOG_DIR;
test(
  "real catalog asyncapi-breaking.mjs: removed property and removed spec fail, waiver, additive change and first PR pass",
  { skip: realCatalog ? false : "set FBX_ASYNCAPI_CATALOG_DIR to a catalog checkout with npm ci done" },
  () => {
    const catalog = { dir: realCatalog };
    const changed = spec({ customerId: { type: "string" } });
    let svc = serviceRepo({ main: { [SPEC]: spec(), [ENV]: envelope }, branch: { [SPEC]: changed } });
    let b = breaking(svc, find(svc), catalog);
    assert.notEqual(b.status, 0, b.log);
    assert.match(b.log, /BREAKING api\/asyncapi\/svc-cus-profile-kyc\.yaml: removed-property evt\.cus\.customer\.created\.v1 CustomerCreated \$\.data\.segment/);
    svc = serviceRepo({
      main: { [SPEC]: spec(), [ENV]: envelope },
      branch: { [SPEC]: changed, [`${D}/svc-cus-profile-kyc.accepted-breaking.txt`]: "removed-property evt.cus.customer.created.v1 CustomerCreated $.data.segment # v2 plan\n" },
    });
    b = breaking(svc, find(svc), catalog);
    assert.equal(b.status, 0, b.log);
    svc = serviceRepo({ main: { [SPEC]: spec(), [ENV]: envelope }, branch: { [SPEC]: spec({ customerId: { type: "string" }, segment: { type: "string" }, tier: { type: "string" } }) } });
    b = breaking(svc, find(svc), catalog);
    assert.equal(b.status, 0, `an optional field is additive: ${b.log}`);
    svc = serviceRepo({ branch: { [SPEC]: spec(), [ENV]: envelope } });
    b = breaking(svc, find(svc, { PUBLISHES_EVENTS: "true" }), catalog);
    assert.equal(b.status, 0, b.log);
    assert.match(b.log, /skip api\/asyncapi\/svc-cus-profile-kyc\.yaml: new file/, "first PR");
    svc = serviceRepo({ main: { [SPEC]: spec(), [ENV]: envelope }, branch: { [SPEC]: null } });
    b = breaking(svc, find(svc), catalog);
    assert.notEqual(b.status, 0);
    assert.match(b.log, /BREAKING api\/asyncapi\/svc-cus-profile-kyc\.yaml: removed-spec/);
  },
);
