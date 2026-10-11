// Tests for scripts/ci/verify-vendored-guard.sh <chart-dir> <expected-sha256>,
// the check a service chart's CI runs on its vendored copy of the guard
// (charts/fintechbankx-service README, "Vendoring the guard", step 1). It
// catches, in conventional chart YAML and template code:
//   (a) a vendored copy that differs: exactly one file under templates/
//       defines fbx.guard, and its whole-file sha256 is the pinned digest (a
//       provenance header changes the digest);
//   (b) an fbx.* redefinition: no other file of the chart, subchart
//       directories and .tgz archives included (an archive read the way Helm
//       loads it), has a define or block of an fbx.* name;
//   (c) a workload template that does not call the guard first: a template
//       is pod-free only when every top-level line of each YAML document it
//       writes is a plain key and its kind is a plain name from the pod-free
//       list; every other template runs the guard, directly or through an
//       adapter define, before it writes any output, and before it only
//       comments, assigns variables, fails or opens blocks that write
//       nothing (no merge*, set or unset other than on a variable bound only
//       to dict calls, no tpl).
// Text inside values and code after the guard call are review matters.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..", "..");
const script = path.join(repo, "scripts", "ci", "verify-vendored-guard.sh");

const GUARD = [
  '{{- define "fbx.guard" -}}',
  '{{- if .Values.forbidden -}}{{- fail "refused" -}}{{- end -}}',
  "{{- end -}}",
  '{{- define "fbx.kafkaProfile" -}}{{- end -}}',
  ""
].join("\n");
const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");
const GUARD_SHA = sha(GUARD);

const DEPLOYMENT_BODY = [
  "apiVersion: apps/v1",
  "kind: Deployment",
  "metadata:",
  "  name: {{ .Release.Name }}",
  "spec:",
  "  template:",
  "    spec:",
  "      containers:",
  "        - name: app",
  "          image: example.invalid/app:1",
  ""
].join("\n");

function workload(kind) {
  const api = kind === "Job" || kind === "CronJob" ? "batch/v1" : "apps/v1";
  return DEPLOYMENT_BODY.replace("apiVersion: apps/v1", `apiVersion: ${api}`).replace("kind: Deployment", `kind: ${kind}`);
}

function baseFiles() {
  return {
    "Chart.yaml": "apiVersion: v2\nname: example\nversion: 0.1.0\n",
    "values.yaml": "forbidden: false\n",
    "templates/_fbx_helpers.tpl": GUARD,
    "templates/deployment.yaml": '{{- include "fbx.guard" . -}}\n' + DEPLOYMENT_BODY
  };
}

function makeChart(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vvg-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    if (content === null) continue;
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
}

// Packs <dir>/<name>/ (written from files) into <dir>/<archive> with tar -czf.
function pack(dir, archive, name, files) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "vvg-pack-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const file = path.join(staging, name, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    fs.mkdirSync(path.dirname(path.join(dir, archive)), { recursive: true });
    const r = spawnSync("tar", ["-czf", path.join(dir, archive), "-C", staging, name], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function verify(dir, expected = GUARD_SHA) {
  const r = spawnSync("bash", [script, dir, expected], { encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function assertPass(r) {
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /all checks passed/);
}

function assertFail(r, ...patterns) {
  assert.equal(r.status, 1, r.out);
  for (const p of patterns) assert.match(r.out, p);
}

test("the script exists and is executable with bash", () => {
  assert.ok(fs.existsSync(script), `${path.relative(repo, script)} is missing`);
});

test("usage: two arguments, an existing chart directory and a 64-hex digest", (t) => {
  const dir = makeChart(t, baseFiles());
  for (const args of [[], [dir], [dir, "abc"], [path.join(dir, "missing"), GUARD_SHA]]) {
    const r = spawnSync("bash", [script, ...args], { encoding: "utf8" });
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /usage: .*verify-vendored-guard\.sh <chart-dir> <expected-sha256>/);
  }
});

// (a) the vendored file

test("(a) passes for a header-less whole-file copy and prints the file and its digest", (t) => {
  const r = verify(makeChart(t, baseFiles()));
  assertPass(r);
  assert.match(r.out, /guard file: templates\/_fbx_helpers\.tpl/);
  assert.match(r.out, new RegExp(`sha256: ${GUARD_SHA}`));
  assert.match(r.out, new RegExp(`expected: ${GUARD_SHA}`));
  assert.match(r.out, /ok \(a\)/);
  assert.match(r.out, /ok \(b\)/);
  assert.match(r.out, /ok \(c\) templates\/deployment\.yaml \(Deployment\)/);
});

test("(a) the digest check accepts an upper-case pinned digest", (t) => {
  assertPass(verify(makeChart(t, baseFiles()), GUARD_SHA.toUpperCase()));
});

test("(a) fails when a provenance header is added to the vendored file", (t) => {
  const files = baseFiles();
  files["templates/_fbx_helpers.tpl"] = "{{/*\nsource: platform templates, commit: 0000000\n*/}}\n" + GUARD;
  const r = verify(makeChart(t, files));
  assertFail(r, /FAIL \(a\) templates\/_fbx_helpers\.tpl: sha256 [0-9a-f]{64} is not the pinned/, /without a header/);
  assert.match(r.out, new RegExp(`sha256: ${sha(files["templates/_fbx_helpers.tpl"])}`));
});

test("(a) fails when the vendored file is edited", (t) => {
  const files = baseFiles();
  files["templates/_fbx_helpers.tpl"] = GUARD.replace('fail "refused"', 'fail "changed"');
  assertFail(verify(makeChart(t, files)), /FAIL \(a\) .*is not the pinned/);
});

test("(a) fails when no file under templates/ defines fbx.guard", (t) => {
  const files = baseFiles();
  files["templates/_fbx_helpers.tpl"] = null;
  assertFail(verify(makeChart(t, files)), /FAIL \(a\) no file under templates\/ defines fbx\.guard/);
});

test("(a) fails when two files under templates/ define fbx.guard", (t) => {
  const files = baseFiles();
  files["templates/zz/_copy.tpl"] = GUARD;
  assertFail(
    verify(makeChart(t, files)),
    /FAIL \(a\) 2 files under templates\/ define fbx\.guard: templates\/_fbx_helpers\.tpl, templates\/zz\/_copy\.tpl/
  );
});

test("(a) a guard defined only in a subchart is not the vendored file", (t) => {
  const files = baseFiles();
  files["templates/_fbx_helpers.tpl"] = null;
  files["charts/sub/Chart.yaml"] = "apiVersion: v2\nname: sub\nversion: 0.1.0\n";
  files["charts/sub/templates/_fbx_helpers.tpl"] = GUARD;
  assertFail(verify(makeChart(t, files)), /FAIL \(a\) no file under templates\/ defines fbx\.guard/);
});

// (b) no other fbx.* definition

const defineSpellings = {
  "{{define": '{{define "fbx.validateKafkaTls"}}{{end}}',
  "{{- define": '{{- define "fbx.validateKafkaTls" -}}{{- end -}}',
  "{{ define (extra spaces)": '{{    define     "fbx.validateKafkaTls"   }}{{ end }}',
  "{{- define after a newline": '{{-\n  define\n  "fbx.validateKafkaTls" -}}{{- end -}}',
  "define with a raw string": "{{ define `fbx.validateKafkaTls` }}{{ end }}",
  "block": '{{ block "fbx.validateKafkaTls" . }}{{ end }}',
  "escaped dot in the name": '{{ define "fbx\\x2evalidateKafkaTls" }}{{ end }}'
};
for (const [label, text] of Object.entries(defineSpellings)) {
  test(`(b) fails for another template file defining fbx.* (${label})`, (t) => {
    const files = baseFiles();
    files["templates/_override.tpl"] = `{{/* later file wins */}}\n${text}\n`;
    assertFail(verify(makeChart(t, files)), /FAIL \(b\) templates\/_override\.tpl defines fbx\.validateKafkaTls/);
  });
}

test("(b) fails for an fbx.* definition in a non-template file of the chart", (t) => {
  const files = baseFiles();
  files["files/extra.tpl"] = '{{- define "fbx.guard" -}}{{- end -}}\n';
  assertFail(verify(makeChart(t, files)), /FAIL \(b\) files\/extra\.tpl defines fbx\.guard/);
});

test("(b) fails for an fbx.* definition in a subchart directory", (t) => {
  const files = baseFiles();
  files["charts/sub/Chart.yaml"] = "apiVersion: v2\nname: sub\nversion: 0.1.0\n";
  files["charts/sub/templates/_helpers.tpl"] = '{{- define "fbx.guard" -}}{{- end -}}\n';
  assertFail(verify(makeChart(t, files)), /FAIL \(b\) charts\/sub\/templates\/_helpers\.tpl defines fbx\.guard/);
});

test("(b) fails for an fbx.* definition inside a subchart .tgz", (t) => {
  const dir = makeChart(t, baseFiles());
  pack(dir, "charts/sub-0.1.0.tgz", "sub", {
    "Chart.yaml": "apiVersion: v2\nname: sub\nversion: 0.1.0\n",
    "templates/_helpers.tpl": '{{- define "fbx.isDbUrlName" -}}{{- end -}}\n'
  });
  assertFail(verify(dir), /FAIL \(b\) charts\/sub-0\.1\.0\.tgz!sub\/templates\/_helpers\.tpl defines fbx\.isDbUrlName/);
});

test("(b) fails for an fbx.* definition in a .tgz nested in a subchart .tgz", (t) => {
  const dir = makeChart(t, baseFiles());
  const inner = makeChart(t, {});
  pack(inner, "inner-0.1.0.tgz", "inner", { "templates/_x.tpl": '{{ define "fbx.guard" }}{{ end }}\n' });
  pack(dir, "charts/outer-0.1.0.tgz", "outer", {
    "Chart.yaml": "apiVersion: v2\nname: outer\nversion: 0.1.0\n",
    "charts/inner-0.1.0.tgz": fs.readFileSync(path.join(inner, "inner-0.1.0.tgz"))
  });
  assertFail(verify(dir), /FAIL \(b\) charts\/outer-0\.1\.0\.tgz!outer\/charts\/inner-0\.1\.0\.tgz!inner\/templates\/_x\.tpl defines fbx\.guard/);
});

test("(b) fails closed on a file it cannot read (a dangling symbolic link)", (t) => {
  const dir = makeChart(t, baseFiles());
  fs.symlinkSync("missing-target.tpl", path.join(dir, "templates", "_dangling.tpl"));
  assertFail(verify(dir), /FAIL \(b\) cannot read templates\/_dangling\.tpl: ENOENT, so it may define fbx\.\* templates/);
});

test("(b) passes when other files only call or mention fbx.* and define their own prefix", (t) => {
  const files = baseFiles();
  files["templates/_helpers.tpl"] = [
    '{{/* fbx.guard is vendored; {{ define "fbx.x" }} in a comment defines nothing */}}',
    '{{- define "example.labels" -}}app: example{{- end -}}',
    '{{- define "example.fbx.note" -}}{{- end -}}',
    ""
  ].join("\n");
  files["templates/configmap.yaml"] = '{{- include "fbx.guard" . -}}\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n';
  assertPass(verify(makeChart(t, files)));
});

// (c) every workload template runs the guard before any output

for (const kind of ["Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob"]) {
  test(`(c) fails for a ${kind} template without a guard call`, (t) => {
    const files = baseFiles();
    files["templates/workload.yaml"] = workload(kind);
    assertFail(verify(makeChart(t, files)), new RegExp(`FAIL \\(c\\) templates/workload\\.yaml \\(${kind}\\): no fbx\\.guard call`));
  });
  test(`(c) passes for a ${kind} template whose first action is the guard`, (t) => {
    const files = baseFiles();
    files["templates/workload.yaml"] = '{{- include "fbx.guard" . -}}\n' + workload(kind);
    assertPass(verify(makeChart(t, files)));
  });
}

test("(c) fails when text is written before the guard call", (t) => {
  const files = baseFiles();
  files["templates/deployment.yaml"] = "apiVersion: apps/v1\n" + '{{- include "fbx.guard" . -}}\n' + DEPLOYMENT_BODY.replace("apiVersion: apps/v1\n", "");
  assertFail(verify(makeChart(t, files)), /FAIL \(c\) templates\/deployment\.yaml \(Deployment\): text is written before the guard call: "apiVersion: apps\/v1" \(line 1\)/);
});

test("(c) fails when an action that can write output runs before the guard call", (t) => {
  const files = baseFiles();
  files["templates/_helpers.tpl"] = '{{- define "example.prelude" -}}# rendered{{- end -}}\n';
  files["templates/deployment.yaml"] = '{{- include "example.prelude" . }}\n{{- include "fbx.guard" . -}}\n' + DEPLOYMENT_BODY;
  assertFail(verify(makeChart(t, files)), /FAIL \(c\) templates\/deployment\.yaml \(Deployment\): .*include "example\.prelude".* can write output before the guard/);
});

test("(c) fails when the guard call is inside a condition that does not enclose the workload", (t) => {
  const files = baseFiles();
  files["templates/deployment.yaml"] = '{{- if .Values.strict }}\n{{- include "fbx.guard" . -}}\n{{- end }}\n' + DEPLOYMENT_BODY;
  assertFail(verify(makeChart(t, files)), /FAIL \(c\) templates\/deployment\.yaml \(Deployment\): the guard call is inside \{\{ if \}\}/);
});

test("(c) fails when the enclosing condition has an else branch that renders without the guard", (t) => {
  const files = baseFiles();
  files["templates/deployment.yaml"] =
    '{{- if .Values.strict }}\n{{- include "fbx.guard" . -}}\n' + DEPLOYMENT_BODY + "{{- else }}\n" + DEPLOYMENT_BODY + "{{- end }}\n";
  assertFail(verify(makeChart(t, files)), /FAIL \(c\) templates\/deployment\.yaml \(Deployment\): the guard call is inside \{\{ if \}\}/);
});

test("(c) fails when the guard call is inside range or with", (t) => {
  for (const block of ["range .Values.items", "with .Values.guard"]) {
    const files = baseFiles();
    files["templates/deployment.yaml"] = `{{- ${block} }}\n{{- include "fbx.guard" $ -}}\n` + DEPLOYMENT_BODY + "{{- end }}\n";
    assertFail(verify(makeChart(t, files)), new RegExp(`the guard call is inside \\{\\{ ${block.split(" ")[0]} \\}\\}`));
  }
});

test("(c) passes when the whole file is wrapped in one condition and the guard runs first inside it", (t) => {
  const files = baseFiles();
  files["templates/migration-job.yaml"] = [
    "{{- if .Values.migration.enabled }}",
    "{{- /* the Job reads the same values */ -}}",
    '{{- include "fbx.guard" . -}}',
    workload("Job") + "{{- end }}",
    ""
  ].join("\n");
  assertPass(verify(makeChart(t, files)));
});

test("(c) passes with comments, assignments and fail-only conditions before the guard", (t) => {
  const files = baseFiles();
  files["templates/_helpers.tpl"] = '{{- define "example.data" -}}{"data": []}{{- end -}}\n';
  files["templates/deployment.yaml"] = [
    "{{- /*",
    "adapter: map this chart's values onto the guard's names",
    "*/ -}}",
    '{{- $data := fromJson (include "example.data" .) -}}',
    "{{- if .Values.javaToolOptions -}}",
    '{{- fail "javaToolOptions is not supported" -}}',
    "{{- end -}}",
    '{{- range $k := list "data" "extraData" -}}',
    '{{- if index ($.Values.externalSecret | default dict) $k -}}{{- fail "no" -}}{{- end -}}',
    "{{- end -}}",
    '{{- $runtime := "msk" -}}',
    '{{- if contains "strimzi" (toString .Values.kafka) -}}{{- $runtime = "strimzi" -}}{{- end -}}',
    '{{- include "fbx.guard" (dict "Values" (dict "config" .Values.config "kafka" (dict "runtime" $runtime))) -}}',
    DEPLOYMENT_BODY
  ].join("\n");
  assertPass(verify(makeChart(t, files)));
});

test("(c) passes for an adapter define that runs the guard first (include and template)", (t) => {
  for (const call of ['{{- include "example.guard" . -}}', '{{- template "example.guard" . -}}']) {
    const files = baseFiles();
    files["templates/_helpers.tpl"] = [
      '{{- define "example.guard" -}}',
      "{{- $es := .Values.externalSecret | default dict -}}",
      '{{- include "fbx.guard" (dict "Values" (dict "config" .Values.config "externalSecret" $es)) -}}',
      '{{- include "example.ownRules" . -}}',
      "{{- end -}}",
      '{{- define "example.ownRules" -}}{{- end -}}',
      ""
    ].join("\n");
    files["templates/deployment.yaml"] = call + "\n" + DEPLOYMENT_BODY;
    assertPass(verify(makeChart(t, files)));
  }
});

test("(c) passes for an adapter that calls another adapter first", (t) => {
  const files = baseFiles();
  files["templates/_helpers.tpl"] = [
    '{{- define "example.guard" -}}{{- include "example.sharedGuard" . -}}{{- end -}}',
    '{{- define "example.sharedGuard" -}}{{- include "fbx.guard" . -}}{{- end -}}',
    ""
  ].join("\n");
  files["templates/deployment.yaml"] = '{{- include "example.guard" . -}}\n' + DEPLOYMENT_BODY;
  assertPass(verify(makeChart(t, files)));
});

test("(c) fails for an adapter whose guard call is conditional", (t) => {
  const files = baseFiles();
  files["templates/_helpers.tpl"] = '{{- define "example.guard" -}}{{- if .Values.strict -}}{{- include "fbx.guard" . -}}{{- end -}}{{- end -}}\n';
  files["templates/deployment.yaml"] = '{{- include "example.guard" . -}}\n' + DEPLOYMENT_BODY;
  assertFail(verify(makeChart(t, files)), /FAIL \(c\) templates\/deployment\.yaml \(Deployment\): .*example\.guard.*the guard call is inside \{\{ if \}\}/);
});

test("(c) fails for an include of a define that does not call the guard", (t) => {
  const files = baseFiles();
  files["templates/_helpers.tpl"] = '{{- define "example.validate" -}}{{- if .Values.bad -}}{{- fail "bad" -}}{{- end -}}{{- end -}}\n';
  files["templates/deployment.yaml"] = '{{- include "example.validate" . -}}\n' + DEPLOYMENT_BODY;
  assertFail(verify(makeChart(t, files)), /FAIL \(c\) templates\/deployment\.yaml \(Deployment\): no fbx\.guard call/);
});

test("(c) a workload rendered through a define counts as a workload template", (t) => {
  const files = baseFiles();
  files["templates/_workloads.tpl"] = '{{- define "example.job" -}}\n' + workload("Job") + "{{- end -}}\n";
  files["templates/job.yaml"] = '{{ include "example.job" . }}\n';
  assertFail(verify(makeChart(t, files)), /FAIL \(c\) templates\/job\.yaml \(Job\): no fbx\.guard call/);
});

test("(c) fails for a workload template of a subchart without the guard", (t) => {
  const files = baseFiles();
  files["charts/sub/Chart.yaml"] = "apiVersion: v2\nname: sub\nversion: 0.1.0\n";
  files["charts/sub/templates/statefulset.yaml"] = workload("StatefulSet");
  assertFail(verify(makeChart(t, files)), /FAIL \(c\) charts\/sub\/templates\/statefulset\.yaml \(StatefulSet\): no fbx\.guard call/);
});

test("(c) fails for a workload template inside a subchart .tgz without the guard", (t) => {
  const dir = makeChart(t, baseFiles());
  pack(dir, "charts/sub-0.1.0.tgz", "sub", {
    "Chart.yaml": "apiVersion: v2\nname: sub\nversion: 0.1.0\n",
    "templates/daemonset.yaml": workload("DaemonSet")
  });
  assertFail(verify(dir), /FAIL \(c\) charts\/sub-0\.1\.0\.tgz!sub\/templates\/daemonset\.yaml \(DaemonSet\): no fbx\.guard call/);
});

// A subchart archive is read the way Helm 3 loads one (pkg/chart/loader
// archive.go over Go's archive/tar reader): every member that is not a
// directory whatever its typeflag, the path after the top directory with '\'
// as the separator when the name holds one and path.Clean applied, the pax
// size and path records of the one pax header before the member, GNU long
// names, no data for link and device entries, the GNU prefix rule, a leading
// UTF-8 BOM dropped. The archives below are written member by member;
// helm template (3.16) renders the Job each one hides.
function tarHeader({ name, type = "0", size = 0, mode = 0o644, magic = "ustar\0", version = "00", prefix = "", linkname = "" }) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "latin1");
  h.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, 8, "latin1");
  h.write("0000000\0", 108, 8, "latin1");
  h.write("0000000\0", 116, 8, "latin1");
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "latin1");
  h.write("00000000000\0", 136, 12, "latin1");
  h[156] = type.charCodeAt(0);
  h.write(linkname, 157, 100, "latin1");
  h.write(magic, 257, 6, "latin1");
  h.write(version, 263, 2, "latin1");
  h.write(prefix, 345, 155, "latin1");
  return tarChecksum(h);
}
function tarChecksum(h) {
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
  return h;
}
const tarPad = (data) => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
function tarMember(name, content, opts = {}) {
  const data = Buffer.from(content, "latin1");
  return Buffer.concat([tarHeader({ name, size: data.length, ...opts }), tarPad(data)]);
}
function paxMember(records, type = "x") {
  let text = "";
  for (const [k, v] of records) {
    const body = ` ${k}=${v}\n`;
    let n = body.length + 1;
    while (`${n}${body}`.length !== n) n++;
    text += `${n}${body}`;
  }
  return tarMember("PaxHeaders/0", text, { type });
}
function writeArchive(dir, rel, ...members) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), zlib.gzipSync(Buffer.concat([...members, Buffer.alloc(1024)])));
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const HIDDEN_JOB = workload("Job");
const SUB_CHART_YAML = () => tarMember("sub/Chart.yaml", "apiVersion: v2\nname: sub\nversion: 0.1.0\n");
// The pax size (1 block more than the header's 0) makes the next 512 bytes
// part of the template, a Go template comment for Helm; a reader that takes
// the header's size reads them as a header of a file outside templates/.
function paxSizeMembers() {
  const tail = `*/}}\n${HIDDEN_JOB}`;
  return [
    paxMember([["size", String(512 + tail.length)]]),
    tarHeader({ name: "sub/templates/job.yaml", size: 0 }),
    tarPad(Buffer.concat([tarHeader({ name: "{{/* sub/files/note.txt", size: tail.length }), Buffer.from(tail, "latin1")]))
  ];
}
const helmMembers = {
  "an unknown typeflag ('A')": [[tarMember("sub/templates/job.yaml", HIDDEN_JOB, { type: "A" })], "sub/templates/job.yaml"],
  "'\\' as the separator": [[tarMember("sub\\templates\\job.yaml", HIDDEN_JOB)], "sub\\templates\\job.yaml"],
  "a pax size larger than the header's": [paxSizeMembers(), "sub/templates/job.yaml"],
  "a GNU long name followed by a long link name": [
    [tarMember("././@LongLink", "sub/templates/job.yaml", { type: "L" }), tarMember("././@LongLink", "x", { type: "K" }), tarMember("sub/README.md", HIDDEN_JOB)],
    "sub/templates/job.yaml"
  ],
  "a GNU long name consumed by a pax global header": [
    [tarMember("././@LongLink", "sub/README.md", { type: "L" }), paxMember([["comment", "x"]], "g"), tarMember("sub/templates/job.yaml", HIDDEN_JOB)],
    "sub/templates/job.yaml"
  ],
  "a symbolic link entry with a size (no data follows)": [
    [tarHeader({ name: "sub/link", type: "2", size: 1024, linkname: "Chart.yaml" }), tarMember("sub/templates/job.yaml", HIDDEN_JOB)],
    "sub/templates/job.yaml"
  ],
  "a '..' segment": [[tarMember("sub/x/../templates/job.yaml", HIDDEN_JOB)], "sub/x/../templates/job.yaml"],
  "a '.' segment": [[tarMember("sub/./templates/job.yaml", HIDDEN_JOB)], "sub/./templates/job.yaml"],
  "a pax path (a long name)": [
    [paxMember([["path", `sub/templates/${"j".repeat(120)}.yaml`]]), tarMember("sub/README.md", HIDDEN_JOB)],
    `sub/templates/${"j".repeat(120)}.yaml`
  ],
  "an empty pax path (the header's name stands)": [[paxMember([["path", ""]]), tarMember("sub/templates/job.yaml", HIDDEN_JOB)], "sub/templates/job.yaml"],
  "a later pax header without a path": [
    [paxMember([["path", "sub/README.md"]]), paxMember([["mtime", "1"]]), tarMember("sub/templates/job.yaml", HIDDEN_JOB)],
    "sub/templates/job.yaml"
  ],
  "GNU magic with octal digits where USTAR keeps its prefix": [
    [tarMember("sub/templates/job.yaml", HIDDEN_JOB, { magic: "ustar ", version: " \0", prefix: "1" })],
    "sub/templates/job.yaml"
  ],
  "a leading UTF-8 BOM (dropped, so the first line is a plain key)": [
    [tarMember("sub/templates/job.yaml", `\xef\xbb\xbf${HIDDEN_JOB}`)],
    "sub/templates/job.yaml"
  ]
};
for (const [label, [members, shown]] of Object.entries(helmMembers)) {
  test(`(c) reads a subchart archive member as Helm loads it: ${label}`, (t) => {
    const dir = makeChart(t, baseFiles());
    writeArchive(dir, "charts/sub-0.1.0.tgz", SUB_CHART_YAML(), ...members);
    assertFail(verify(dir), new RegExp(`FAIL \\(c\\) charts/sub-0\\.1\\.0\\.tgz!${escapeRe(shown)} \\(Job\\): no fbx\\.guard call`));
  });
}

test("(b) reads a define in a subchart archive member with an unknown typeflag", (t) => {
  const dir = makeChart(t, baseFiles());
  writeArchive(dir, "charts/sub-0.1.0.tgz", SUB_CHART_YAML(),
    tarMember("sub/templates/_x.tpl", '{{- define "fbx.guard" }}{{ end }}\n', { type: "A" }));
  assertFail(verify(dir), /FAIL \(b\) charts\/sub-0\.1\.0\.tgz!sub\/templates\/_x\.tpl defines fbx\.guard/);
});

test("(c) reads a template with a leading UTF-8 BOM as Helm does (BOM dropped)", (t) => {
  const files = baseFiles();
  files["templates/job.yaml"] = `﻿${HIDDEN_JOB.replace("apiVersion: batch/v1\nkind: Job", "kind: Job\napiVersion: batch/v1")}`;
  assertFail(verify(makeChart(t, files)), /FAIL \(c\) templates\/job\.yaml \(Job\): no fbx\.guard call/);
});

test("(b) fails closed on archive members it cannot read as Helm does (sparse) and on archives Helm refuses", (t) => {
  const sparse = tarHeader({ name: "sub/templates/job.yaml", type: "S", size: HIDDEN_JOB.length, magic: "ustar ", version: " \0" });
  sparse.write("00000000000\0", 386, 12, "latin1");
  sparse.write(`${HIDDEN_JOB.length.toString(8).padStart(11, "0")}\0`, 398, 12, "latin1");
  sparse.write(`${HIDDEN_JOB.length.toString(8).padStart(11, "0")}\0`, 483, 12, "latin1");
  tarChecksum(sparse);
  const cases = {
    "a GNU sparse member": [Buffer.concat([sparse, tarPad(Buffer.from(HIDDEN_JOB))])],
    "a member outside the top directory": [tarMember("README.md", "x")],
    "a header with a bad checksum": [Buffer.concat([tarHeader({ name: "sub/templates/job.yaml", size: 0 }).fill(0x31, 0, 1)])]
  };
  for (const [label, members] of Object.entries(cases)) {
    const dir = makeChart(t, baseFiles());
    writeArchive(dir, "charts/sub-0.1.0.tgz", SUB_CHART_YAML(), ...members);
    const r = verify(dir);
    assert.equal(r.status, 1, `${label}: ${r.out}`);
    assert.match(r.out, /FAIL \(b\) cannot read charts\/sub-0\.1\.0\.tgz \(archive\): /, label);
  }
});

test("(b)/(c) pass for members Helm skips or reads as written: directories, pax and GNU long names", (t) => {
  const dir = makeChart(t, baseFiles());
  const longDir = `sub/templates/${"d".repeat(60)}/${"e".repeat(60)}`;
  writeArchive(dir, "charts/sub-0.1.0.tgz",
    tarHeader({ name: "sub/", type: "5", mode: 0o755 }),
    SUB_CHART_YAML(),
    paxMember([["comment", "made by a test"]], "g"),
    paxMember([["path", `${longDir}/cm.yaml`], ["mtime", "1.5"]]),
    tarMember("sub/templates/cm-short-name.yaml", "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n"),
    tarMember("././@LongLink", `${longDir}/cm2.yaml`, { type: "L" }),
    tarMember("sub/templates/cm2-short-name.yaml", "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: b\n"),
    // A directory by its mode bits: Helm skips it, data and all.
    tarMember("sub/templates/_dir.tpl", '{{- define "fbx.guard" }}{{ end }}\n', { mode: 0o40755 }));
  const r = verify(dir);
  assertPass(r);
  // 4 files of the chart, the archive, and sub/Chart.yaml with the two
  // long-named ConfigMaps: the directory entries are not files.
  assert.match(r.out, /\(b\) no other file defines an fbx\.\* template \(8 files read/);
});

test("(c) fails when the chart renders no workload at all", (t) => {
  const files = baseFiles();
  files["templates/deployment.yaml"] = null;
  files["templates/configmap.yaml"] = '{{- include "fbx.guard" . -}}\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n';
  assertFail(verify(makeChart(t, files)), /FAIL \(c\) no workload template/);
});

test("(c) a ConfigMap, a Service or an HPA naming a Deployment is not a workload template", (t) => {
  const files = baseFiles();
  files["templates/hpa.yaml"] = [
    "apiVersion: autoscaling/v2",
    "kind: HorizontalPodAutoscaler",
    "metadata:",
    "  name: x",
    "spec:",
    "  scaleTargetRef:",
    "    apiVersion: apps/v1",
    "    kind: Deployment",
    "    name: x",
    ""
  ].join("\n");
  assertPass(verify(makeChart(t, files)));
});

// (c) a template is pod-free only when every top-level line (column 0,
// outside template actions, not a comment or document marker) of each YAML
// document it writes is a plain key (^[A-Za-z][A-Za-z0-9]*:) and its kind is a
// plain name from the pod-free list. Any other top-level line (a tag, anchor,
// alias, quote or escape, a flow collection, an indented document, ...) and
// any kind outside the list makes it a workload template, which must call the
// guard first. Helm renders each document below as a Job (kubeconform
// -strict: valid; sigs.k8s.io/yaml reads kind Job); the guard never sees the
// env it renders.
const JOB_SPEC = [
  "metadata:",
  "  name: {{ .Release.Name }}-migrate",
  "spec:",
  "  template:",
  "    spec:",
  "      restartPolicy: Never",
  "      containers:",
  "        - name: migrate",
  "          image: example.invalid/migrate:0.1.0",
  "          env: {{ toJson .Values.extraEnv }}",
  ""
].join("\n");
const JOB_JSON_TAIL =
  '"metadata": {"name": "{{ .Release.Name }}-migrate"},\n' +
  ' "spec": {"template": {"spec": {"restartPolicy": "Never", "containers": [{"name": "migrate", ' +
  '"image": "example.invalid/migrate:0.1.0", "env": {{ toJson .Values.extraEnv }}}]}}}}\n';
const kindSpellings = {
  "kind: Job (plain key and value)": ["Job", `apiVersion: batch/v1\nkind: Job\n${JOB_SPEC}`],
  "kind : Job (space before the colon)": ['top-level line "kind : Job"', `apiVersion: batch/v1\nkind : Job\n${JOB_SPEC}`],
  "kind: !!str Job (tag on the value)": ['kind "!!str Job" is not a plain name', `apiVersion: batch/v1\nkind: !!str Job\n${JOB_SPEC}`],
  "kind: &k \"Job\" (anchor, quoted value)": ['kind "&k \\"Job\\"" is not a plain name', `apiVersion: batch/v1\nkind: &k "Job"\n${JOB_SPEC}`],
  '"kind": Job (quoted key)': ['top-level line "\\"kind\\": Job"', `apiVersion: batch/v1\n"kind": Job\n${JOB_SPEC}`],
  "'kind': Job (single-quoted key)": ['top-level line "\'kind\': Job"', `apiVersion: batch/v1\n'kind': Job\n${JOB_SPEC}`],
  "!!str kind: Job (tag on the key)": ['top-level line "!!str kind: Job"', `apiVersion: batch/v1\n!!str kind: Job\n${JOB_SPEC}`],
  "&k kind: Job (anchor on the key)": ['top-level line "&k kind: Job"', `apiVersion: batch/v1\n&k kind: Job\n${JOB_SPEC}`],
  "*k : Job (an alias as the key)": [
    'top-level line "*k : Job"',
    `apiVersion: batch/v1\n${JOB_SPEC.replace("  name: {{ .Release.Name }}-migrate", "  name: {{ .Release.Name }}-migrate\n  labels:\n    role: &k kind")}*k : Job\n`
  ],
  '"\\u006bind": Job (an escape in a quoted key)': ['top-level line "\\"\\\\u006bind\\": Job"', `apiVersion: batch/v1\n"\\u006bind": Job\n${JOB_SPEC}`],
  "an indented document after a comment line": [
    'indented top-level line "apiVersion: batch/v1"',
    `# migration\n${`apiVersion: batch/v1\nkind: Job\n${JOB_SPEC}`.split("\n").map((l) => (l ? `  ${l}` : l)).join("\n")}`
  ],
  "a one-line JSON document": ["top-level line", `{"apiVersion": "batch/v1", "kind": "Job", ${JOB_JSON_TAIL}`],
  "a JSON document with an escape in the kind key": ["top-level line", `{"apiVersion": "batch/v1", "\\u006bind": "Job", ${JOB_JSON_TAIL}`],
  "a tagged root flow mapping (!!map {...})": ['top-level line "!!map', `!!map {"apiVersion": "batch/v1", "kind": "Job", ${JOB_JSON_TAIL}`],
  "an anchored root flow mapping (&doc {...})": ['top-level line "&doc', `&doc {"apiVersion": "batch/v1", "kind": "Job", ${JOB_JSON_TAIL}`],
  "a pretty-printed JSON document": [
    'top-level line "{"',
    [
      "{",
      '  "apiVersion": "batch/v1",',
      '  "metadata": {"name": "{{ .Release.Name }}-migrate"},',
      '  "spec": {"template": {"spec": {"restartPolicy": "Never", "containers": [',
      '    {"name": "migrate", "image": "example.invalid/migrate:0.1.0", "env": {{ toJson .Values.extraEnv }}}]}}},',
      '  "kind": "Job"',
      "}",
      ""
    ].join("\n")
  ],
  "kind: Job after a document marker on the same line (---kind: Job)": ["Job", `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n---kind: Job\napiVersion: batch/v1\n${JOB_SPEC}`],
  // YAML reads CR, NEL (U+0085) and the paragraph and line separators as
  // line breaks, so each of these kind lines is a top-level key.
  "kind: Job after a carriage return": ["Job", `apiVersion: batch/v1\rkind: Job\n${JOB_SPEC}`],
  "kind: Job after a NEL (U+0085)": ["Job", `apiVersion: batch/v1\u0085kind: Job\n${JOB_SPEC}`],
  "kind: Job after a paragraph separator (U+2029)": ["Job", `apiVersion: batch/v1\u2029kind: Job\n${JOB_SPEC}`],
  "a document without a top-level kind": ["no top-level kind", `apiVersion: batch/v1\n${JOB_SPEC}`]
};
for (const [label, [kind, text]] of Object.entries(kindSpellings)) {
  test(`(c) fails for a workload template without a guard call: ${label}`, (t) => {
    const files = baseFiles();
    files["templates/job.yaml"] = text;
    const r = verify(makeChart(t, files));
    assertFail(r, /FAIL \(c\) templates\/job\.yaml \(.*\): no fbx\.guard call/);
    const line = r.out.split("\n").find((l) => l.startsWith("FAIL (c) templates/job.yaml")) ?? "";
    assert.ok(line.includes(kind), `expected ${JSON.stringify(kind)} in: ${line}\n${r.out}`);
  });
}

const POD = [
  "apiVersion: v1",
  "kind: Pod",
  "metadata:",
  "  name: {{ .Release.Name }}-smoke",
  "  annotations:",
  "    helm.sh/hook: test",
  "spec:",
  "  restartPolicy: Never",
  "  containers:",
  "    - name: smoke",
  "      image: example.invalid/smoke:0.1.0",
  "      env: {{ toJson .Values.extraEnv }}",
  ""
].join("\n");
const otherKinds = {
  Pod: POD,
  ReplicaSet: workload("ReplicaSet"),
  ReplicationController: workload("ReplicationController").replace("apps/v1", "v1"),
  List: ["apiVersion: v1", "kind: List", "items:", ...POD.split("\n").map((l, i) => (l ? `${i === 0 ? "  - " : "    "}${l}` : l))].join("\n"),
  Rollout: workload("Rollout").replace("apps/v1", "argoproj.io/v1alpha1")
};
for (const [kind, text] of Object.entries(otherKinds)) {
  test(`(c) fails for a ${kind} template without a guard call`, (t) => {
    const files = baseFiles();
    files["templates/other.yaml"] = text;
    assertFail(verify(makeChart(t, files)), new RegExp(`FAIL \\(c\\) templates/other\\.yaml \\(${kind}\\): no fbx\\.guard call`));
  });
  test(`(c) passes for a ${kind} template whose first action is the guard`, (t) => {
    const files = baseFiles();
    files["templates/other.yaml"] = '{{- include "fbx.guard" . -}}\n' + text;
    assertPass(verify(makeChart(t, files)));
  });
}

test("(c) fails for a template that renders a file through tpl and .Files.Get", (t) => {
  const files = baseFiles();
  files["files/job.yaml"] = `apiVersion: batch/v1\nkind: Job\n${JOB_SPEC}`;
  files["templates/job.yaml"] = '{{ tpl (.Files.Get "files/job.yaml") . }}\n';
  assertFail(
    verify(makeChart(t, files)),
    /FAIL \(c\) templates\/job\.yaml \(text from \{\{ tpl \(\.Files\.Get "files\/job\.yaml"\) \. \}\} at line 1\): no fbx\.guard call/
  );
});

test("(c) fails for a template that renders manifests from a value (extraObjects)", (t) => {
  const files = baseFiles();
  files["templates/extra.yaml"] = "{{- range .Values.extraObjects }}\n---\n{{ toYaml . }}\n{{- end }}\n";
  assertFail(verify(makeChart(t, files)), /FAIL \(c\) templates\/extra\.yaml \(text from \{\{ toYaml \. \}\} at line 3\): no fbx\.guard call/);
});

test("(c) fails for an unguarded Pod while the Deployment template is conditional", (t) => {
  const files = baseFiles();
  files["templates/deployment.yaml"] = '{{- if .Values.deploymentEnabled }}\n{{- include "fbx.guard" . -}}\n' + DEPLOYMENT_BODY + "{{- end }}\n";
  files["templates/smoke-pod.yaml"] = POD;
  const r = verify(makeChart(t, files));
  assertFail(r, /FAIL \(c\) templates\/smoke-pod\.yaml \(Pod\): no fbx\.guard call/);
  assert.match(r.out, /ok \(c\) templates\/deployment\.yaml \(Deployment\)/);
});

test("(c) pod-free documents in conventional chart YAML are not workloads (plain keys, nested kinds, values, sequences, blocks)", (t) => {
  const files = baseFiles();
  files["templates/configmap.yaml"] = [
    "{{- if .Values.config }}",
    "apiVersion: v1",
    "kind: ConfigMap # the service's settings",
    "{{- if .Values.named }}",
    "metadata:",
    "  name: {{ .Release.Name | quote }}",
    "{{- else }}",
    "metadata:",
    "  name: x",
    "{{- end }}",
    "data:",
    "  application.yml: |",
    "    kind: Pod",
    "    spec: {}",
    "{{ (.Files.Glob \"config/*\").AsConfig | indent 2 }}",
    "  inline: {a: 1,",
    "    b: 2}",
    "{{- end }}",
    ""
  ].join("\n");
  files["templates/hpa.yaml"] = [
    "apiVersion: autoscaling/v2",
    "kind: HorizontalPodAutoscaler",
    "metadata:",
    "  name: x",
    "spec:",
    "  scaleTargetRef: {apiVersion: apps/v1, kind: Deployment, name: x}",
    "  maxReplicas: 2",
    ""
  ].join("\n");
  files["templates/rbac.yaml"] = [
    "apiVersion: rbac.authorization.k8s.io/v1",
    "kind: Role",
    "metadata:",
    "  name: x",
    "rules:",
    "{{- range .Values.rules }}",
    "- apiGroups: [\"\"]",
    "  resources: [{{ . | quote }}]",
    "  verbs: [get]",
    "{{- end }}",
    "---",
    "apiVersion: rbac.authorization.k8s.io/v1",
    "kind: RoleBinding",
    "metadata:",
    "  name: x",
    "subjects:",
    "- kind: ServiceAccount",
    "  name: x",
    "roleRef: {apiGroup: rbac.authorization.k8s.io, kind: Role, name: x}",
    ""
  ].join("\n");
  files["templates/NOTES.txt"] = "{{ .Release.Name }} is installed.\n{{ .Values.notes }}\n";
  const r = verify(makeChart(t, files));
  assertPass(r);
  assert.doesNotMatch(r.out, /\(c\) templates\/(configmap\.yaml|hpa\.yaml|rbac\.yaml|NOTES\.txt)/);
});

// A pod-free kind counts only as a plain name under a plain key, in a document
// whose every top-level line is a plain key: anything else makes the
// template a workload template.
const podFreeSpellings = {
  "JSON (a flow mapping at the top level)": [
    "templates/hpa.json",
    '{"apiVersion": "autoscaling/v2", "kind": "HorizontalPodAutoscaler", "metadata": {"name": "x"},\n' +
      ' "spec": {"scaleTargetRef": {"apiVersion": "apps/v1", "kind": "Deployment", "name": "x"}, "maxReplicas": 2}}\n',
    'top-level line "{'
  ],
  "a quoted kind key": ["templates/service.yaml", '"kind": Service\napiVersion: v1\nmetadata:\n  name: x\n', 'top-level line "\\"kind\\": Service"'],
  "kind : (a space before the colon)": ["templates/configmap.yaml", "apiVersion: v1\nkind : ConfigMap\nmetadata:\n  name: x\n", 'top-level line "kind : ConfigMap"'],
  "a quoted kind value": ["templates/configmap.yaml", 'apiVersion: v1\nkind: "ConfigMap"\nmetadata:\n  name: x\n', 'kind "\\"ConfigMap\\"" is not a plain name'],
  "a templated kind": ["templates/configmap.yaml", "apiVersion: v1\nkind: {{ .Values.kind }}\nmetadata:\n  name: x\n", "templated kind"],
  "a kind extended by template output": ["templates/configmap.yaml", 'apiVersion: v1\nkind: Config{{ .Values.suffix }}\nmetadata:\n  name: x\n', "templated kind"],
  "a top-level sequence entry that follows no empty key": [
    "templates/configmap.yaml",
    "apiVersion: v1\nkind: ConfigMap\nmetadata: {name: x}\n- kind: Job\n",
    'top-level line "- kind: Job"'
  ],
  "template output in a flow collection that continues on the next line": [
    "templates/configmap.yaml",
    'apiVersion: batch/v1\nmetadata: {name: {{ printf "%s}" .Release.Name }}\nkind: Job\n' + JOB_SPEC.split("\n").slice(2).join("\n"),
    "template output in a flow collection that spans lines"
  ],
  "a %YAML directive": ["templates/configmap.yaml", "%YAML 1.1\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n", 'top-level line "%YAML 1.1"'],
  "content after a document marker": ["templates/configmap.yaml", "--- !!map\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n", 'top-level line "!!map"']
};
for (const [label, [file, text, reason]] of Object.entries(podFreeSpellings)) {
  test(`(c) a pod-free document makes the template a workload template when it has ${label}`, (t) => {
    const files = baseFiles();
    files[file] = text;
    const r = verify(makeChart(t, files));
    assertFail(r, new RegExp(`FAIL \\(c\\) ${escapeRe(file)} \\(.*\\): no fbx\\.guard call`));
    const line = r.out.split("\n").find((l) => l.startsWith(`FAIL (c) ${file}`)) ?? "";
    assert.ok(line.includes(reason), `expected ${JSON.stringify(reason)} in: ${line}\n${r.out}`);
  });
}

test("(c) a workload template in a spelling other than plain keys passes once it calls the guard first", (t) => {
  const files = baseFiles();
  files["templates/job.json"] = '{{- include "fbx.guard" . -}}\n{"apiVersion": "batch/v1", "kind": "Job", ' + JOB_JSON_TAIL;
  files["templates/service.yaml"] = '{{- include "fbx.guard" . -}}\n"kind": Service\napiVersion: v1\nmetadata:\n  name: x\n';
  const r = verify(makeChart(t, files));
  assertPass(r);
  assert.match(r.out, /ok \(c\) templates\/job\.json \(top-level line/);
  assert.match(r.out, /ok \(c\) templates\/service\.yaml \(top-level line/);
});

// (c) what runs before the guard must not change what the guard reads. merge,
// mergeOverwrite, mustMerge and mustMergeOverwrite are refused there outright
// (they merge nested maps in place, so a dict the template built that holds
// .Values or one of its maps passes the write on). set and unset are accepted
// only on a bare variable every assignment of which in the same template or
// define (:= and =, in any block, also inside parentheses) is a plain dict
// call; tpl is refused. Each form below, itself or through a define it
// includes, can empty .Values.extraEnv for the guard; the template renders the
// list it captured before (helm template renders the refused entry).
const RESTORE = '{{- $_ := set .Values "extraEnv" $env -}}\n';
const mutations = {
  set: '{{- $_ := set .Values "extraEnv" list -}}',
  unset: '{{- $_ := unset .Values "extraEnv" -}}',
  merge: '{{- $_ := merge .Values (dict "extraEnv" list) -}}',
  mergeOverwrite: '{{- $_ := mergeOverwrite .Values (dict "extraEnv" list) -}}',
  mustMergeOverwrite: '{{- $_ := mustMergeOverwrite .Values (dict "extraEnv" list) -}}',
  "set through an alias of .Values": '{{- $v := .Values -}}\n{{- $_ := set $v "extraEnv" list -}}',
  "set inside a local dict that holds .Values": '{{- $d := dict "v" .Values -}}\n{{- $_ := set (index $d "v") "extraEnv" list -}}',
  "set in an if condition": '{{- if set .Values "extraEnv" list }}{{- end }}',
  "tpl of a value": "{{- $_ := tpl .Values.prelude . -}}",
  "an include of a define that calls set": '{{- $_ := include "example.reset" . -}}',
  "mergeOverwrite on a dict the template built that holds .Values": [
    '{{- $f := dict "v" .Values -}}',
    '{{- $_ := mergeOverwrite $f (dict "v" (dict "extraEnv" list)) -}}'
  ].join("\n"),
  "merge into a dict the template built": '{{- $f := dict -}}\n{{- $_ := merge $f (dict "x" 1) -}}',
  "set on a variable redeclared in a block (the outer one is .Values)": [
    "{{- $v := .Values -}}",
    "{{- if true }}{{ $v := dict }}{{ end -}}",
    '{{- $_ := set $v "extraEnv" list -}}'
  ].join("\n"),
  "set on a dict variable assigned .Values later (=)": '{{- $v := dict -}}\n{{- $v = .Values -}}\n{{- $_ := set $v "extraEnv" list -}}',
  "set on a dict variable assigned .Values inside parentheses": [
    "{{- $v := dict -}}",
    "{{- $_ := print ($v = .Values) -}}",
    '{{- $_ := set $v "extraEnv" list -}}'
  ].join("\n"),
  "set on a dict piped into default (dict | default .Values is .Values)": '{{- $v := dict | default .Values -}}\n{{- $_ := set $v "extraEnv" list -}}',
  "set on a range variable": '{{- range $v := list .Values }}{{ $_ := set $v "extraEnv" list }}{{ end -}}',
  "set on the root context $": '{{- $_ := set $ "Values" (dict) -}}'
};
for (const [label, action] of Object.entries(mutations)) {
  test(`(c) fails when an action before the guard can change what it reads: ${label}`, (t) => {
    const files = baseFiles();
    files["templates/_helpers.tpl"] = '{{- define "example.reset" -}}{{- $_ := set .Values "extraEnv" list -}}{{- end -}}\n';
    files["templates/deployment.yaml"] =
      "{{- $env := .Values.extraEnv -}}\n" + action + '\n{{- include "fbx.guard" . -}}\n' + RESTORE + DEPLOYMENT_BODY;
    assertFail(
      verify(makeChart(t, files)),
      /FAIL \(c\) templates\/deployment\.yaml \(Deployment\): \{\{ .* \}\} \(line \d+\) can change what the guard reads before it runs/
    );
  });
}

test("(c) fails for an adapter define that sets a variable it binds to .Values in a block", (t) => {
  const files = baseFiles();
  files["templates/_helpers.tpl"] = [
    '{{- define "example.guard" -}}',
    "{{- $v := .Values -}}",
    "{{- with .Values }}{{ $v := dict }}{{ end -}}",
    '{{- $_ := set $v "extraEnv" list -}}',
    '{{- include "fbx.guard" . -}}',
    "{{- end -}}",
    ""
  ].join("\n");
  files["templates/deployment.yaml"] = '{{- include "example.guard" . -}}\n' + DEPLOYMENT_BODY;
  assertFail(
    verify(makeChart(t, files)),
    /FAIL \(c\) templates\/deployment\.yaml \(Deployment\): .*example\.guard.*can change what the guard reads before it runs: it calls set on \$v/
  );
});

test("(c) fails for an adapter define that changes .Values before it calls the guard", (t) => {
  const files = baseFiles();
  files["templates/_helpers.tpl"] = '{{- define "example.guard" -}}\n{{- $_ := set .Values "extraEnv" list -}}\n{{- include "fbx.guard" . -}}\n{{- end -}}\n';
  files["templates/deployment.yaml"] = '{{- include "example.guard" . -}}\n' + DEPLOYMENT_BODY;
  assertFail(
    verify(makeChart(t, files)),
    /FAIL \(c\) templates\/deployment\.yaml \(Deployment\): .*example\.guard.*can change what the guard reads before it runs/
  );
});

test("(c) fails for an include chosen at render time before the guard when a template calls set", (t) => {
  const files = baseFiles();
  files["templates/configmap.yaml"] = '{{- $_ := set .Values "extraEnv" list -}}\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n';
  files["templates/deployment.yaml"] =
    '{{- $cm := include (print .Template.BasePath "/configmap.yaml") . -}}\n{{- include "fbx.guard" . -}}\n' + DEPLOYMENT_BODY;
  assertFail(
    verify(makeChart(t, files)),
    /FAIL \(c\) templates\/deployment\.yaml \(Deployment\): .* can change what the guard reads before it runs: it includes a template chosen at render time, and templates\/configmap\.yaml calls set/
  );
});

test("(c) passes with a render-time include, a local dict built with set and unset and pure functions before the guard (control)", (t) => {
  const files = baseFiles();
  files["templates/configmap.yaml"] = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n";
  files["templates/deployment.yaml"] = [
    '{{- $cm := include (print .Template.BasePath "/configmap.yaml") . -}}',
    '{{- $vals := dict "config" .Values.config "x" (.Values.x | default dict) -}}',
    '{{- $_ := set $vals "extraEnv" (concat (.Values.extraEnv | default list) (list)) -}}',
    '{{- if .Values.kafka }}{{ $_ := set $vals "kafka" (dict "runtime" "msk") }}{{ end -}}',
    '{{- $_ := unset $vals "x" -}}',
    '{{- include "fbx.guard" (dict "Values" $vals) -}}',
    DEPLOYMENT_BODY
  ].join("\n");
  assertPass(verify(makeChart(t, files)));
});

test("reports every failing check, not only the first", (t) => {
  const files = baseFiles();
  files["templates/_fbx_helpers.tpl"] = "{{/* header */}}\n" + GUARD;
  files["templates/_override.tpl"] = '{{- define "fbx.validateKafkaTls" -}}{{- end -}}\n';
  files["templates/job.yaml"] = workload("Job");
  const r = verify(makeChart(t, files));
  assertFail(r, /FAIL \(a\)/, /FAIL \(b\)/, /FAIL \(c\) templates\/job\.yaml/);
  assert.match(r.out, /3 checks failed/);
});

test("the vendored-guard fixture chart passes with the reference guard and its digest", (t) => {
  const reference = fs.readFileSync(path.join(repo, "charts", "fintechbankx-service", "templates", "_helpers.tpl"));
  const fixture = path.join(repo, "scripts", "ci", "fixtures", "vendored-guard-chart");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vvg-fixture-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(fixture, dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "templates", "_helpers.tpl"), reference);
  const r = verify(dir, sha(reference));
  assertPass(r);
  assert.match(r.out, /guard file: templates\/_helpers\.tpl/);
  assert.match(r.out, /ok \(c\) templates\/deployment\.yaml \(Deployment\)/);
});
