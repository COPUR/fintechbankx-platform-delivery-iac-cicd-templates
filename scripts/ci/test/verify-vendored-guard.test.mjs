// Tests for scripts/ci/verify-vendored-guard.sh <chart-dir> <expected-sha256>,
// the check a service chart's CI runs on its vendored copy of the guard
// (charts/fintechbankx-service README, "Vendoring the guard", step 1):
//   (a) exactly one file under templates/ defines fbx.guard, and its whole-file
//       sha256 is the pinned digest (a provenance header changes the digest);
//   (b) no other file of the chart, subchart directories and .tgz archives
//       included, defines an fbx.* template in any spelling;
//   (c) every workload template (one whose document's top-level kind, in any
//       spelling, is outside the pod-free list or unreadable, or that writes
//       unread text there) runs the guard, directly or through an adapter
//       define, before it writes any output and before anything that can
//       change what the guard reads (set, unset, merge*, tpl).
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

// (c) a workload template is found from its document's top-level kind in any
// YAML spelling Helm and Kubernetes accept, from any kind outside the
// pod-free list, and from text the script cannot read written where a
// document's top-level keys go (tpl, .Files, a value). Helm renders each
// spelling below, and the Pod, ReplicaSet and List cases, as that kind
// (kubeconform -strict: valid); the guard never sees the env they render.
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
const kindSpellings = {
  "kind : Job (space before the colon)": ["Job", `apiVersion: batch/v1\nkind : Job\n${JOB_SPEC}`],
  "kind: !!str Job (tag)": ["Job", `apiVersion: batch/v1\nkind: !!str Job\n${JOB_SPEC}`],
  '"kind": Job (quoted key)': ["Job", `apiVersion: batch/v1\n"kind": Job\n${JOB_SPEC}`],
  "'kind': Job (single-quoted key)": ["Job", `apiVersion: batch/v1\n'kind': Job\n${JOB_SPEC}`],
  "kind: &k \"Job\" (anchor, quoted value)": ["Job", `apiVersion: batch/v1\nkind: &k "Job"\n${JOB_SPEC}`],
  "an indented document after a comment line": [
    "Job",
    `# migration\n${`apiVersion: batch/v1\nkind: Job\n${JOB_SPEC}`.split("\n").map((l) => (l ? `  ${l}` : l)).join("\n")}`
  ],
  "a one-line JSON document": [
    "Job",
    '{"apiVersion": "batch/v1", "kind": "Job", "metadata": {"name": "{{ .Release.Name }}-migrate"},\n' +
      ' "spec": {"template": {"spec": {"restartPolicy": "Never", "containers": [{"name": "migrate", ' +
      '"image": "example.invalid/migrate:0.1.0", "env": {{ toJson .Values.extraEnv }}}]}}}}\n'
  ],
  "a pretty-printed JSON document": [
    "Job",
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
  ]
};
for (const [label, [kind, text]] of Object.entries(kindSpellings)) {
  test(`(c) fails for a workload template without a guard call: ${label}`, (t) => {
    const files = baseFiles();
    files["templates/job.yaml"] = text;
    assertFail(verify(makeChart(t, files)), new RegExp(`FAIL \\(c\\) templates/job\\.yaml \\(${kind}\\): no fbx\\.guard call`));
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

test("(c) pod-free kinds in any spelling, nested kinds and unread text inside a value are not workloads", (t) => {
  const files = baseFiles();
  files["templates/configmap.yaml"] = [
    "apiVersion: v1",
    "kind : ConfigMap",
    "metadata:",
    "  name: x",
    "data:",
    "  application.yml: |",
    "    kind: Pod",
    "    spec: {}",
    "{{ (.Files.Glob \"config/*\").AsConfig | indent 2 }}",
    ""
  ].join("\n");
  files["templates/hpa.json"] =
    '{"apiVersion": "autoscaling/v2", "kind": "HorizontalPodAutoscaler", "metadata": {"name": "x"},\n' +
    ' "spec": {"scaleTargetRef": {"apiVersion": "apps/v1", "kind": "Deployment", "name": "x"}, "maxReplicas": 2}}\n';
  files["templates/service.yaml"] = '"kind": Service\napiVersion: v1\nmetadata:\n  name: {{ .Release.Name | quote }}\nspec:\n  ports: [{"port": 80}]\n';
  files["templates/NOTES.txt"] = "{{ .Release.Name }} is installed.\n{{ .Values.notes }}\n";
  const r = verify(makeChart(t, files));
  assertPass(r);
  assert.doesNotMatch(r.out, /\(c\) templates\/(configmap\.yaml|hpa\.json|service\.yaml|NOTES\.txt)/);
});

// (c) what runs before the guard must not change what the guard reads: an
// assignment or condition that calls set, unset, merge, mergeOverwrite (also
// mustMerge, mustMergeOverwrite) or tpl, itself or through a define it
// includes, can empty .Values.extraEnv for the guard and restore it after.
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
  "an include of a define that calls set": '{{- $_ := include "example.reset" . -}}'
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

test("(c) passes with a render-time include, a local dict built with set and pure functions before the guard (control)", (t) => {
  const files = baseFiles();
  files["templates/configmap.yaml"] = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n";
  files["templates/deployment.yaml"] = [
    '{{- $cm := include (print .Template.BasePath "/configmap.yaml") . -}}',
    '{{- $vals := dict "config" .Values.config -}}',
    '{{- $_ := set $vals "extraEnv" (concat (.Values.extraEnv | default list) (list)) -}}',
    '{{- $_ := merge $vals (dict "kafka" (dict "runtime" "msk")) -}}',
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
