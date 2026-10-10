#!/usr/bin/env bash
# verify-vendored-guard.sh <chart-dir> <expected-sha256>
#
# Checks a service chart that vendors the platform guard
# (charts/fintechbankx-service/templates/_helpers.tpl, README "Vendoring the
# guard"). A service chart's CI runs it with the digest it pins:
#
#   (a) exactly one file under <chart-dir>/templates/ defines fbx.guard, and the
#       sha256 of that whole file is <expected-sha256>. The file is the
#       reference file copied whole and unchanged, without a header: the
#       provenance (source repository, path, commit) goes next to the pinned
#       digest in the CI step, so a header fails here.
#   (b) no other file of the chart defines an fbx.* template, in any spelling
#       ({{define, {{- define, extra white space or line breaks, "..." or `...`
#       names, Go string escapes, block): a later definition would replace the
#       vendored one. Subchart directories and .tgz archives (nested ones too)
#       are read as well, an archive the way Helm loads it: every entry that
#       is not a directory, whatever its typeflag, named by its pax or GNU
#       long name, split on '\' when its name holds one and cleaned. An
#       archive Helm would refuse, or a sparse entry, fails this check. Every
#       file is read without a leading UTF-8 BOM, as Helm reads it.
#   (c) every workload template calls fbx.guard before it writes anything:
#       directly ({{- include "fbx.guard" ... -}}) or through an adapter define
#       of the chart that calls fbx.guard unconditionally before any output of
#       its own. A workload template (also in subcharts; partials and
#       NOTES.txt, which Helm does not render as manifests, aside) is one that,
#       itself or through a define it includes, writes at the top level of a
#       YAML document, in any spelling (block or flow/JSON, quoted key,
#       "kind :", tags, anchors, an indented document, after "---"):
#         - a kind outside POD_FREE_KINDS below (so Pod, ReplicaSet,
#           ReplicationController, Deployment, StatefulSet, DaemonSet, Job,
#           CronJob, a List and a custom resource such as a Rollout count), or
#           a templated or unreadable kind;
#         - text the script cannot read: an output action (tpl, .Files.Get,
#           toYaml of a value, ...) or an include of a template the chart does
#           not define, placed where a document's top-level keys go.
#       It reads the template text, as written and with the trim markers
#       applied; text an action writes inside a value (a value holding a
#       newline) is not followed, which is why every interpolated value is
#       quoted (README step 3). Before the call only comments, variable
#       assignments, fail and if/range/with blocks that write nothing may run,
#       and none of them may change what the guard reads: no set, unset,
#       merge, mergeOverwrite (or a must* form) except on a variable bound to
#       a dict the template built ($vals := dict ...), and no tpl, also
#       through an included define (an include whose name is chosen at render
#       time counts with every template of the chart). The call may sit
#       inside an {{ if }} (without else) that encloses the whole template,
#       the form of an optional migration Job. What runs after the call is
#       not read: a template that changes .Values after the guard has run is
#       a review matter, like the adapter's mapping.
#
# Prints the guard file(s) found with their sha256, one line per check, and
# exits 0 when every check passes, 1 when one fails, 2 on a usage error.
# Needs bash and node (18 or later).
set -euo pipefail

usage() {
  echo "usage: $0 <chart-dir> <expected-sha256>" >&2
  exit 2
}

[ "$#" -eq 2 ] || usage
if [ ! -d "$1" ]; then
  echo "verify-vendored-guard: $1 is not a directory" >&2
  usage
fi
if ! [[ "$2" =~ ^[0-9a-fA-F]{64}$ ]]; then
  echo "verify-vendored-guard: the expected digest must be 64 hex characters (sha256), got '$2'" >&2
  usage
fi
command -v node > /dev/null 2>&1 || { echo "verify-vendored-guard: node is required" >&2; exit 2; }

read -r -d '' program <<'JS' || true
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";

process.on("uncaughtException", (err) => {
  console.error(`verify-vendored-guard: internal error: ${err.stack ?? err}`);
  process.exit(2);
});

const [chartArg, expectedArg] = process.argv.slice(1);
const chartDir = path.resolve(chartArg);
const expected = expectedArg.toLowerCase();
// Kinds known to run no pod. A document whose top-level kind is any other
// (Pod, ReplicaSet, ReplicationController, Deployment, StatefulSet, DaemonSet,
// Job, CronJob, a List, which Helm's client flattens into its items, a custom
// resource such as an Argo Rollout) or is templated or unreadable makes its
// template a workload template.
const POD_FREE_KINDS = [
  "APIService", "AuthorizationPolicy", "Certificate", "ClusterIssuer", "ClusterRole", "ClusterRoleBinding",
  "ClusterSecretStore", "ConfigMap", "CustomResourceDefinition", "DestinationRule", "Endpoints", "EndpointSlice",
  "ExternalSecret", "Gateway", "HorizontalPodAutoscaler", "Ingress", "IngressClass", "Issuer", "KafkaTopic",
  "KafkaUser", "Lease", "LimitRange", "MutatingWebhookConfiguration", "Namespace", "NetworkPolicy",
  "PeerAuthentication", "PersistentVolume", "PersistentVolumeClaim", "PodDisruptionBudget", "PodMonitor",
  "PriorityClass", "PrometheusRule", "RequestAuthentication", "ResourceQuota", "Role", "RoleBinding",
  "RuntimeClass", "Secret", "SecretStore", "Service", "ServiceAccount", "ServiceEntry", "ServiceMonitor",
  "Sidecar", "StorageClass", "Telemetry", "ValidatingAdmissionPolicy", "ValidatingAdmissionPolicyBinding",
  "ValidatingWebhookConfiguration", "VirtualService"
];
const podFree = new Set(POD_FREE_KINDS.map((k) => k.toLowerCase()));
const GUARD = "fbx.guard";
const failures = [];
const lines = [];
const ok = (msg) => lines.push(`ok ${msg}`);
const fail = (msg) => { failures.push(msg); lines.push(`FAIL ${msg}`); };

// ---------------------------------------------------------------- files
// Every file of the chart, with archives expanded. Each entry: display (path
// shown in messages; "!" separates an archive from a member, named as the
// archive names it), chartKey (which chart of the tree the file belongs to,
// "" for the chart itself), chartPath (path inside that chart, as Helm reads
// it), archive (a .tgz or .tar.gz), bytes (as stored), text (latin1, byte for
// byte, without the leading UTF-8 BOM Helm's loader drops from every file).
const files = [];
const unreadable = [];
const isArchiveName = (name) => /\.(tgz|tar\.gz)$/i.test(name);

function chartPosition(segments, chartKey) {
  let key = chartKey;
  let rest = segments;
  while (rest.length > 2 && rest[0] === "charts") {
    key = `${key}/charts/${rest[1]}`;
    rest = rest.slice(2);
  }
  return { chartKey: key, chartPath: rest.join("/") };
}

function addFile(display, segments, chartKey, bytes) {
  const pos = chartPosition(segments, chartKey);
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const body = bom ? bytes.subarray(3) : bytes;
  const archive = isArchiveName(segments[segments.length - 1]);
  files.push({ display, ...pos, archive, bytes, text: body.toString("latin1") });
  if (!archive) return;
  let members;
  try {
    members = chartArchiveFiles(body);
  } catch (err) {
    unreadable.push(`${display} (archive): ${err.message}`);
    return;
  }
  // An archived chart's root is its top directory, whatever its name.
  for (const m of members) addFile(`${display}!${m.member}`, m.name.split("/"), `${display}!`, m.data);
}

function walk(abs, relSegments, seen) {
  const real = fs.realpathSync(abs);
  if (seen.has(real)) return;
  seen.add(real);
  for (const name of fs.readdirSync(abs).sort()) {
    const child = path.join(abs, name);
    const segments = [...relSegments, name];
    let st;
    try {
      st = fs.statSync(child);
      if (st.isDirectory()) walk(child, segments, seen);
      else if (st.isFile()) addFile(segments.join("/"), segments, "", fs.readFileSync(child));
    } catch (err) {
      unreadable.push(`${segments.join("/")}: ${err.code ?? err.message}`);
    }
  }
}

// ---------------------------------------------------------------- archives
// A .tgz is read the way Helm 3 loads a chart archive (pkg/chart/loader
// LoadArchiveFiles over Go's archive/tar reader), so the script reads the
// files Helm reads, under the paths Helm gives them:
//   - every entry that is not a directory (typeflag 5, or the mode bits of a
//     directory), whatever its typeflag; link, device and FIFO entries carry
//     no data, whatever their size field says;
//   - the name: the path and size records of the pax header right before the
//     entry (a later pax header replaces an earlier one; a global header
//     applies to no entry), then a GNU long name, else the header's name with
//     the USTAR or STAR prefix (a GNU header uses the prefix field only when
//     its time fields do not parse);
//   - the path: the name after its top directory, split on '\' when it holds
//     one, else on '/', and cleaned (path.Clean);
//   - a leading UTF-8 BOM dropped (addFile).
// What Helm refuses (a bad header checksum, a truncated archive, an entry
// outside a top directory, an absolute path, '..') and sparse entries, which
// the script does not expand, make the archive unreadable, so check (b)
// fails closed.
const TAR_MAX_SPECIAL = 1 << 20;
const TAR_HEADER_ONLY = new Set(["1", "2", "3", "4", "5", "6"]);
const tarError = (what) => new Error(`invalid tar archive (${what})`);

function tarString(b) {
  const z = b.indexOf(0);
  return (z < 0 ? b : b.subarray(0, z)).toString("latin1");
}

function tarOctal(b) {
  let s = b.toString("latin1").replace(/^[ \0]+|[ \0]+$/g, "");
  const z = s.indexOf("\0");
  if (z >= 0) s = s.slice(0, z);
  if (s === "") return 0n;
  if (!/^[0-7]+$/.test(s) || BigInt(`0o${s}`) >= 1n << 64n) throw tarError("numeric field");
  return BigInt.asIntN(64, BigInt(`0o${s}`));
}

// Octal, or base-256 when the first byte has its high bit set.
function tarNumeric(b) {
  if (b.length === 0 || (b[0] & 0x80) === 0) return tarOctal(b);
  const inv = b[0] & 0x40 ? 0xff : 0;
  let x = 0n;
  for (let i = 0; i < b.length; i++) {
    if (x >> 56n) throw tarError("numeric field");
    x = (x << 8n) | BigInt((b[i] ^ inv) & (i === 0 ? 0x7f : 0xff));
  }
  if (x >> 63n) throw tarError("numeric field");
  return inv ? -x - 1n : x;
}

function tarHeader(h) {
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < 512; i++) {
    const c = i >= 148 && i < 156 ? 0x20 : h[i];
    unsigned += c;
    signed += c > 127 ? c - 256 : c;
  }
  let sum;
  try { sum = tarOctal(h.subarray(148, 156)); } catch { sum = null; }
  if (sum !== BigInt(unsigned) && sum !== BigInt(signed)) throw tarError("header checksum");
  const magic = h.toString("latin1", 257, 263);
  const format = magic === "ustar\0" ? (h.toString("latin1", 508, 512) === "tar\0" ? "star" : "ustar")
    : magic === "ustar " && h.toString("latin1", 263, 265) === " \0" ? "gnu" : "v7";
  const hdr = {
    type: String.fromCharCode(h[156]),
    name: tarString(h.subarray(0, 100)),
    mode: tarNumeric(h.subarray(100, 108)),
    size: tarNumeric(h.subarray(124, 136))
  };
  for (const [from, to] of [[108, 116], [116, 124], [136, 148]]) tarNumeric(h.subarray(from, to));
  if (format === "v7") return hdr;
  tarNumeric(h.subarray(329, 337));
  tarNumeric(h.subarray(337, 345));
  let prefix = "";
  if (format === "ustar") prefix = tarString(h.subarray(345, 500));
  else if (format === "star") {
    prefix = tarString(h.subarray(345, 476));
    tarNumeric(h.subarray(476, 488));
    tarNumeric(h.subarray(488, 500));
  } else {
    try {
      if (h[345] !== 0) tarNumeric(h.subarray(345, 357));
      if (h[357] !== 0) tarNumeric(h.subarray(357, 369));
    } catch {
      const s = tarString(h.subarray(345, 500));
      if (!/[^\x01-\x7f]/.test(s)) prefix = s;
    }
  }
  if (prefix !== "") hdr.name = `${prefix}/${hdr.name}`;
  return hdr;
}

function paxRecords(d) {
  let s = d.toString("latin1");
  const records = new Map();
  while (s.length > 0) {
    const sp = s.indexOf(" ");
    const n = sp > 0 && /^[+-]?[0-9]+$/.test(s.slice(0, sp)) ? Number(s.slice(0, sp)) : NaN;
    if (!(n >= 5 && n <= s.length && n > sp + 1 && s[n - 1] === "\n")) throw tarError("pax record");
    const rec = s.slice(sp + 1, n - 1);
    const eq = rec.indexOf("=");
    if (eq <= 0) throw tarError("pax record");
    const k = rec.slice(0, eq);
    const v = rec.slice(eq + 1);
    if (["path", "linkpath", "uname", "gname"].includes(k) ? v.includes("\0") : k.includes("\0")) throw tarError("pax record");
    records.set(k, v);
    s = s.slice(n);
  }
  return records;
}

function paxInt(v) {
  if (!/^[+-]?[0-9]+$/.test(v)) throw tarError("pax record");
  const x = BigInt(v);
  if (x < -(1n << 63n) || x >= 1n << 63n) throw tarError("pax record");
  return x;
}

function mergePax(hdr, records) {
  for (const [k, v] of records) {
    if (v === "") continue;
    if (k === "path") hdr.name = v;
    else if (k === "size") hdr.size = paxInt(v);
    else if (k === "uid" || k === "gid") paxInt(v);
    else if (k === "atime" || k === "mtime" || k === "ctime") {
      const dot = v.indexOf(".");
      paxInt(dot < 0 ? v : v.slice(0, dot));
      if (dot >= 0 && !/^[0-9]*$/.test(v.slice(dot + 1))) throw tarError("pax record");
    }
  }
}

// Whether Go reads the entry as a GNU sparse file in pax form (0.0, 0.1, 1.0).
function paxSparse(records) {
  const major = records.get("GNU.sparse.major") ?? "";
  const minor = records.get("GNU.sparse.minor") ?? "";
  if (major === "0" && (minor === "0" || minor === "1")) return true;
  if (major === "1" && minor === "0") return true;
  if (major !== "" || minor !== "") return false;
  return (records.get("GNU.sparse.map") ?? "") !== "" || records.has("GNU.sparse.offset") || records.has("GNU.sparse.numbytes");
}

// The entries Go's tar reader returns, pax, GNU long name and global headers
// consumed. Each: type, name (latin1), mode, data.
function* tarEntries(buf) {
  let off = 0;
  let pad = 0;
  let pax = null;
  let longName = "";
  const block = () => {
    if (off === buf.length) return null;
    if (buf.length - off < 512) throw tarError("truncated");
    off += 512;
    return buf.subarray(off - 512, off);
  };
  const zero = (b) => b.every((x) => x === 0);
  const dataSize = (hdr) => (TAR_HEADER_ONLY.has(hdr.type) ? 0n : hdr.size);
  const data = (n) => {
    if (n < 0n) throw tarError("negative size");
    if (BigInt(buf.length - off) < n) throw tarError("truncated");
    const d = buf.subarray(off, off + Number(n));
    off += d.length;
    pad = (512 - (d.length % 512)) % 512;
    return d;
  };
  for (;;) {
    if (pad > 0) {
      if (buf.length - off < pad) return;
      off += pad;
      pad = 0;
    }
    let h = block();
    if (h === null) return;
    if (zero(h)) {
      h = block();
      if (h === null || zero(h)) return;
      throw tarError("a header after a zero block");
    }
    const hdr = tarHeader(h);
    if (dataSize(hdr) < 0n) throw tarError("negative size");
    if (["x", "g", "L", "K"].includes(hdr.type)) {
      if (dataSize(hdr) > BigInt(TAR_MAX_SPECIAL)) throw tarError("extended header too long");
      const d = data(dataSize(hdr));
      if (hdr.type === "x") pax = paxRecords(d);
      else if (hdr.type === "L") longName = tarString(d);
      else if (hdr.type === "g") {
        // Go returns a global header as an entry of its own; Helm skips it.
        paxRecords(d);
        pax = null;
        longName = "";
      }
      continue;
    }
    if (pax) mergePax(hdr, pax);
    if (longName !== "") hdr.name = longName;
    if (hdr.type === "\0") hdr.type = hdr.name.endsWith("/") ? "5" : "0";
    if (hdr.type === "S" || (pax && paxSparse(pax))) {
      throw new Error(`sparse entry ${Buffer.from(hdr.name, "latin1").toString("utf8")} (not expanded)`);
    }
    pax = null;
    longName = "";
    yield { ...hdr, data: data(dataSize(hdr)) };
  }
}

// Go's path.Clean for a relative path.
function cleanPath(p) {
  const out = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === ".." && out.length > 0 && out[out.length - 1] !== "..") out.pop();
    else out.push(seg);
  }
  return out.length === 0 ? "." : out.join("/");
}

// The files of a chart archive as Helm's LoadArchiveFiles returns them:
// member (the entry's name), name (its path in the chart), data.
function chartArchiveFiles(bytes) {
  const out = [];
  const utf8 = (s) => Buffer.from(s, "latin1").toString("utf8");
  for (const e of tarEntries(zlib.gunzipSync(bytes))) {
    if (e.type === "5" || (BigInt.asUintN(32, e.mode) & ~0o7777n) === 0o40000n) continue;
    const parts = e.name.split(e.name.includes("\\") ? "\\" : "/");
    const joined = parts.slice(1).join("/");
    if (joined.startsWith("/")) throw new Error(`${utf8(e.name)}: absolute path`);
    const name = cleanPath(joined);
    if (name === ".") throw new Error(`${utf8(e.name)}: content outside the base directory`);
    if (name.startsWith("..")) throw new Error(`${utf8(e.name)}: references the parent directory`);
    if (/^[a-zA-Z]:\//.test(name)) throw new Error(`${utf8(e.name)}: a drive path`);
    if (parts[0] === "Chart.yaml") throw new Error("Chart.yaml is not in a top directory");
    out.push({ member: utf8(e.name), name: utf8(name), data: e.data });
  }
  if (out.length === 0) throw new Error("no files in the archive");
  return out;
}

// ---------------------------------------------------------------- lexer
// Splits Go template source into text, comment and action tokens, the way
// text/template delimits them ({{ }}, trim markers, "..." `...` '...'
// literals, /* */ comments).
const lineStarts = new Map();
function lineAt(src, offset) {
  let starts = lineStarts.get(src);
  if (!starts) {
    starts = [0];
    for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
    lineStarts.set(src, starts);
  }
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function lex(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{{", i);
    if (open < 0) { tokens.push({ type: "text", value: src.slice(i), start: i }); break; }
    if (open > i) tokens.push({ type: "text", value: src.slice(i, open), start: i });
    let k = open + 2;
    if (src[k] === "-" && /\s/.test(src[k + 1] ?? "")) k += 1;
    let m = k;
    while (m < src.length && /\s/.test(src[m])) m++;
    if (src.startsWith("/*", m)) {
      const close = src.indexOf("*/", m + 2);
      if (close < 0) throw new Error(`unclosed comment at line ${lineAt(src, open)}`);
      let n = close + 2;
      while (n < src.length && /\s/.test(src[n])) n++;
      if (src.startsWith("-}}", n)) n += 3;
      else if (src.startsWith("}}", n)) n += 2;
      else throw new Error(`comment does not end its action at line ${lineAt(src, open)}`);
      tokens.push({ type: "comment", start: open, end: n });
      i = n;
      continue;
    }
    let p = k;
    let body = null;
    while (p < src.length) {
      const c = src[p];
      if (c === '"' || c === "'") {
        p++;
        while (p < src.length && src[p] !== c) {
          if (src[p] === "\\") p++;
          if (src[p] === "\n") throw new Error(`newline in a quoted literal at line ${lineAt(src, p)}`);
          p++;
        }
        if (p >= src.length) throw new Error(`unterminated literal at line ${lineAt(src, open)}`);
        p++;
        continue;
      }
      if (c === "`") {
        const close = src.indexOf("`", p + 1);
        if (close < 0) throw new Error(`unterminated raw string at line ${lineAt(src, open)}`);
        p = close + 1;
        continue;
      }
      if (src.startsWith("}}", p)) { body = src.slice(k, p); break; }
      p++;
    }
    if (body === null) throw new Error(`unclosed action at line ${lineAt(src, open)}`);
    body = body.replace(/\s-$/, "").trim();
    tokens.push({ type: "action", body, start: open, end: p + 2 });
    i = p + 2;
  }
  for (const t of tokens) {
    const at = t.type === "text" ? t.start + (t.value.length - t.value.trimStart().length) : t.start;
    t.line = lineAt(src, at);
  }
  return tokens;
}

// Trim markers of an action or comment token: {{- removes the white space
// before it, -}} the white space after it.
const leftTrim = (src, t) => src[t.start + 2] === "-" && /\s/.test(src[t.start + 3] ?? "");
const rightTrim = (src, t) => src.startsWith("-}}", t.end - 3) && /\s/.test(src[t.end - 4] ?? "");

// Go string literal ("..." with escapes, or `...`) at the start of s.
function readString(s) {
  if (s[0] === "`") {
    const close = s.indexOf("`", 1);
    if (close < 0) return null;
    return { value: s.slice(1, close).replace(/\r/g, ""), rest: s.slice(close + 1) };
  }
  if (s[0] !== '"') return null;
  let out = "";
  let i = 1;
  const simple = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", '"': '"', "'": "'" };
  while (i < s.length && s[i] !== '"') {
    if (s[i] !== "\\") { out += s[i++]; continue; }
    const e = s[i + 1];
    if (e in simple) { out += simple[e]; i += 2; continue; }
    if (e === "x") { out += String.fromCharCode(parseInt(s.slice(i + 2, i + 4), 16)); i += 4; continue; }
    if (e === "u") { out += String.fromCodePoint(parseInt(s.slice(i + 2, i + 6), 16)); i += 6; continue; }
    if (e === "U") { out += String.fromCodePoint(parseInt(s.slice(i + 2, i + 10), 16)); i += 10; continue; }
    if (/[0-7]/.test(e ?? "")) { out += String.fromCharCode(parseInt(s.slice(i + 1, i + 4), 8)); i += 4; continue; }
    return null;
  }
  if (s[i] !== '"') return null;
  return { value: out, rest: s.slice(i + 1) };
}

function classify(body) {
  const word = (/^[A-Za-z_][A-Za-z0-9_]*/.exec(body) ?? [""])[0];
  if (["if", "range", "with", "define", "block"].includes(word)) {
    const r = word === "define" || word === "block" ? readString(body.slice(word.length).trimStart()) : null;
    return { type: "open", word, name: r ? r.value : null };
  }
  if (word === "else") return { type: "else" };
  if (word === "end") return { type: "end" };
  if (word === "break" || word === "continue") return { type: "quiet" };
  if (word === "include" || word === "template") {
    const r = readString(body.slice(word.length).trimStart());
    return { type: "call", via: word, name: r ? r.value : null };
  }
  if (/^\$[A-Za-z0-9_]*\s*:?=/.test(body)) return { type: "quiet" };
  if (word === "fail") return { type: "quiet" };
  return { type: "output" };
}

function tokenize(file) {
  if (!("tokens" in file)) {
    try {
      file.tokens = lex(file.text).map((t) => (t.type === "action" ? { ...t, ...classify(t.body) } : t));
      file.lexError = null;
    } catch (err) {
      file.tokens = null;
      file.lexError = err.message;
    }
  }
  return file.tokens;
}

// Index of the end matching the block opened at tokens[i].
function matchingEnd(tokens, i) {
  let depth = 0;
  for (let j = i; j < tokens.length; j++) {
    const t = tokens[j];
    if (t.type === "open") depth++;
    else if (t.type === "end" && --depth === 0) return j;
  }
  return -1;
}

function definesIn(file) {
  const tokens = tokenize(file);
  const found = [];
  if (tokens) {
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type === "open" && (t.word === "define" || t.word === "block")) {
        const end = matchingEnd(tokens, i);
        found.push({ name: t.name, word: t.word, line: t.line, file, body: tokens.slice(i + 1, end < 0 ? tokens.length : end),
          trimStart: rightTrim(file.text, t) });
      }
    }
    return found;
  }
  // Not a parsable template: look for any define or block spelling.
  const re = /\{\{-?\s*(define|block)\s+("(?:[^"\\\n]|\\.)*"|`[^`]*`)/g;
  for (const m of file.text.matchAll(re)) {
    const r = readString(m[2]);
    found.push({ name: r ? r.value : m[2], word: m[1], line: lineAt(file.text, m.index), file, body: [], trimStart: false });
  }
  return found;
}

// ---------------------------------------------------------------- scan
try {
  walk(chartDir, [], new Set());
} catch (err) {
  console.error(`verify-vendored-guard: cannot read ${chartArg}: ${err.message}`);
  process.exit(2);
}

const isTemplate = (f) => f.chartPath.startsWith("templates/");
const isPartial = (f) => path.posix.basename(f.chartPath).startsWith("_");
const templateFiles = files.filter(isTemplate);

const defines = new Map();
for (const f of templateFiles) {
  for (const d of definesIn(f)) {
    if (d.name === null) continue;
    if (!defines.has(d.name)) defines.set(d.name, []);
    defines.get(d.name).push(d);
  }
}

// (a)
const rootTemplates = templateFiles.filter((f) => f.chartKey === "");
const guardFiles = rootTemplates.filter((f) => definesIn(f).some((d) => d.name === GUARD));
console.log(`verify-vendored-guard: chart ${chartArg}`);
if (guardFiles.length === 0) console.log("guard file: none");
for (const f of guardFiles) {
  console.log(`guard file: ${f.display}`);
  console.log(`sha256: ${crypto.createHash("sha256").update(f.bytes).digest("hex")}`);
}
console.log(`expected: ${expected}`);
if (guardFiles.length === 0) {
  fail("(a) no file under templates/ defines fbx.guard: copy the reference charts/fintechbankx-service/templates/_helpers.tpl whole into templates/ (e.g. as templates/_fbx_helpers.tpl)");
} else if (guardFiles.length > 1) {
  fail(`(a) ${guardFiles.length} files under templates/ define fbx.guard: ${guardFiles.map((f) => f.display).join(", ")} (vendor exactly one copy)`);
} else {
  const f = guardFiles[0];
  const digest = crypto.createHash("sha256").update(f.bytes).digest("hex");
  if (digest === expected) ok(`(a) ${f.display} is the only file under templates/ that defines fbx.guard, and its sha256 is the pinned digest`);
  else fail(`(a) ${f.display}: sha256 ${digest} is not the pinned ${expected}: vendor the reference file whole and unchanged, without a header, and record its source repository, path and commit next to the pinned digest in CI`);
}

// (b)
const vendored = guardFiles.length === 1 ? guardFiles[0] : null;
let bFailures = 0;
for (const f of files) {
  if (f === vendored || f.archive) continue;
  for (const d of definesIn(f)) {
    if (typeof d.name === "string" && d.name.startsWith("fbx.")) {
      bFailures++;
      fail(`(b) ${f.display} defines ${d.name} (line ${d.line}; {{ ${d.word} }}): only the vendored guard file may define fbx.* templates, and a later definition replaces the vendored one`);
    }
  }
}
for (const u of unreadable) { bFailures++; fail(`(b) cannot read ${u}, so it may define fbx.* templates`); }
if (bFailures === 0) ok(`(b) no other file defines an fbx.* template (${files.length} files read, subchart directories and archives included)`);

// (c)
const quote = (body) => {
  const flat = body.replace(/\s+/g, " ");
  return `{{ ${flat.length > 70 ? `${flat.slice(0, 67)}...` : flat} }}`;
};

const reachMemo = new Map();
function reachesGuard(name, seen = new Set()) {
  if (name === GUARD) return true;
  if (name === null || !defines.has(name) || seen.has(name)) return false;
  if (reachMemo.has(name)) return reachMemo.get(name);
  seen.add(name);
  const result = defines.get(name).some((d) => callsIn(d.body).some((c) => reachesGuard(c.name, seen)));
  reachMemo.set(name, result);
  return result;
}

// Call tokens of a token list, outside nested defines.
function callsIn(tokens) {
  const calls = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "open" && t.word === "define") { const e = matchingEnd(tokens, i); i = e < 0 ? tokens.length : e; continue; }
    if (t.type === "call" || (t.type === "open" && t.word === "block")) calls.push(t);
  }
  return calls;
}

// What runs before the guard must not change what it reads. sprig's set,
// unset, merge and mergeOverwrite (and the must* forms) change their first
// argument in place, so they may only target a variable bound to a dict the
// template built itself ($vals := dict ...), never .Values, $, an alias of
// .Values or a dict reached through index; tpl runs template text taken from
// a value. An include counts with what the included define runs, and an
// include whose name is chosen at render time with what any template of the
// chart runs. actionMutation returns why an action can change what the guard
// reads ("calls set", "includes x, which calls set", ...) or null, and records
// in fresh the variables an assignment binds to a new dict.
const MUTATORS = /(?<![\w.$])(set|unset|merge|mergeOverwrite|mustMerge|mustMergeOverwrite)(?![\w])\s*(\$[A-Za-z0-9_]+(?![\w.]))?/g;
const stripStrings = (body) => body.replace(/"(?:[^"\\]|\\.)*"|`[^`]*`|'(?:[^'\\]|\\.)*'/g, '""');
const defineMutationMemo = new Map();
let chartMutationMemo;
let chartMutationBusy = false;

function actionMutation(t, fresh, stack) {
  const flat = stripStrings(t.body);
  if (/(?<![\w.$])tpl(?![\w])/.test(flat)) return "calls tpl";
  for (const m of flat.matchAll(MUTATORS)) {
    if (!(m[2] && fresh.has(m[2]))) return `calls ${m[1]}`;
  }
  for (const m of t.body.matchAll(/(?<![\w.$])(?:include|template)\s+("(?:[^"\\]|\\.)*"|`[^`]*`)/g)) {
    const r = readString(m[1]);
    const why = r ? defineMutation(r.value, stack) : chartMutation();
    if (why) return r ? `includes ${r.value}, which ${why}` : `includes a template chosen at render time, and ${why}`;
  }
  if (/(?<![\w.$])include\s+[^\s"`]/.test(flat)) {
    const why = chartMutation();
    if (why) return `includes a template chosen at render time, and ${why}`;
  }
  const assign = /^(\$[A-Za-z0-9_]+)\s*:?=\s*([\s\S]*)$/.exec(t.body);
  if (assign) {
    if (/^dict(?![\w])/.test(assign[2].trim())) fresh.add(assign[1]);
    else fresh.delete(assign[1]);
  }
  return null;
}

function mutationInTokens(tokens, stack) {
  const fresh = new Set();
  for (const t of tokens) {
    if (t.type === "text" || t.type === "comment") continue;
    const why = actionMutation(t, fresh, stack);
    if (why) return why;
  }
  return null;
}

function defineMutation(name, stack) {
  if (!defines.has(name) || stack.has(name)) return null;
  if (defineMutationMemo.has(name)) return defineMutationMemo.get(name);
  stack.add(name);
  let why = null;
  for (const d of defines.get(name)) {
    why = mutationInTokens(d.body, stack);
    if (why) break;
  }
  stack.delete(name);
  defineMutationMemo.set(name, why);
  return why;
}

function chartMutation() {
  if (chartMutationMemo !== undefined) return chartMutationMemo;
  if (chartMutationBusy) return null;
  chartMutationBusy = true;
  let why = null;
  for (const f of templateFiles) {
    const tokens = tokenize(f);
    const w = tokens ? mutationInTokens(tokens, new Set()) : "cannot be parsed";
    if (w) { why = `${f.display} ${w}`; break; }
  }
  chartMutationBusy = false;
  chartMutationMemo = why;
  return why;
}

// Checks that tokens (a template file, mode "file", or a define body, mode
// "define") call fbx.guard, directly or through an adapter, before any output
// and before anything that can change what it reads.
// Returns { via } or { error }.
function guardFirst(tokens, mode, where, seen) {
  const calls = callsIn(tokens).filter((c) => c.type === "call" && reachesGuard(c.name));
  if (calls.length === 0) return { error: "no fbx.guard call (directly or through an adapter define)" };
  const stack = [];
  const fresh = new Set();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "text") {
      if (t.value.trim() !== "") {
        const first = t.value.trim().split("\n")[0].trim();
        return { error: `text is written before the guard call: "${first.length > 60 ? `${first.slice(0, 57)}...` : first}" (line ${t.line}${where})` };
      }
      continue;
    }
    if (t.type === "comment") continue;
    if (t.type === "quiet" || t.type === "else" || (t.type === "open" && t.word !== "define" && t.word !== "block")) {
      const why = actionMutation(t, fresh, new Set());
      if (why) return { error: `${quote(t.body)} (line ${t.line}${where}) can change what the guard reads before it runs: it ${why}` };
    }
    if (t.type === "quiet" || t.type === "else") continue;
    if (t.type === "open" && t.word === "define") { const e = matchingEnd(tokens, i); i = e < 0 ? tokens.length : e; continue; }
    if (t.type === "open" && t.word !== "block") { stack.push({ word: t.word, index: i, line: t.line }); continue; }
    if (t.type === "end") { stack.pop(); continue; }
    if (t.type === "call" && reachesGuard(t.name)) {
      for (let s = stack.length - 1; s >= 0; s--) {
        const block = stack[s];
        const label = `the guard call is inside {{ ${block.word} }} (line ${block.line}${where})`;
        if (mode !== "file" || block.word !== "if") return { error: label };
        const end = matchingEnd(tokens, block.index);
        let depth = 0;
        for (let j = block.index; j <= end; j++) {
          const u = tokens[j];
          if (u.type === "open") depth++;
          else if (u.type === "end") depth--;
          else if (u.type === "else" && depth === 1) return { error: `${label}, which has an {{ else }} branch that renders without it` };
        }
        const outerEnd = s > 0 ? matchingEnd(tokens, stack[s - 1].index) : tokens.length;
        for (let j = end + 1; j < outerEnd; j++) {
          const u = tokens[j];
          if (u.type === "comment" || (u.type === "text" && u.value.trim() === "")) continue;
          return { error: `${label}, which does not enclose the whole template (line ${u.line}${where} renders outside it)` };
        }
      }
      if (t.name === GUARD) return { via: "direct" };
      if (seen.has(t.name)) return { error: `${t.name} calls itself` };
      for (const d of defines.get(t.name)) {
        const r = guardFirst(d.body, "define", ` of ${d.file.display}`, new Set([...seen, t.name]));
        if (r.error) return { error: `${quote(t.body)} (line ${t.line}${where}) does not run the guard unconditionally before any output: ${t.name} (${d.file.display} line ${d.line}): ${r.error}` };
      }
      return { via: `through ${t.name}` };
    }
    return { error: `${quote(t.body)} (line ${t.line}${where}) can write output before the guard runs` };
  }
  return { error: "no fbx.guard call (directly or through an adapter define)" };
}

// The text of a token list as YAML will see it: comments removed, every
// action replaced by one MARK character (what it writes is unknown), the trim
// markers applied ({{- removes the white space before, -}} after) when trim is
// set, and the body of a nested define left out (it writes nothing in place).
const MARK = "\u0001";
function skeletonOf(tokens, src, trimStart, trim) {
  let text = "";
  const marks = [];
  let trimNext = trimStart;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "text") {
      text += trim && trimNext ? t.value.replace(/^\s+/, "") : t.value;
      trimNext = false;
      continue;
    }
    if (trim && leftTrim(src, t)) text = text.replace(/\s+$/, "");
    let last = t;
    if (t.type === "open" && t.word === "define") {
      const e = matchingEnd(tokens, i);
      i = e < 0 ? tokens.length : e;
      last = tokens[i];
    } else if (t.type !== "comment") {
      text += MARK;
      marks.push(t);
    }
    trimNext = last ? rightTrim(src, last) : false;
  }
  return { text, marks };
}

// The pod-free test for a kind value (the text after "kind:"): a plain,
// quoted, tagged or anchored name; anything else (a template action, an
// alias, a block scalar, a nested collection, nothing) is unreadable.
function kindLabel(value) {
  let v = value.replace(/^[ \t]+/, "");
  for (let m; (m = /^(?:![^\s,{}[\]]*|&[^\s,{}[\]]+)[ \t]+/.exec(v)); ) v = v.slice(m[0].length);
  const end = "(?=[ \\t]*(?:$|#|,|\\}))";
  const m = new RegExp(`^(?:"([A-Za-z][A-Za-z0-9]*)"|'([A-Za-z][A-Za-z0-9]*)'|([A-Za-z][A-Za-z0-9]*))${end}`).exec(v);
  if (!m) return v.startsWith(MARK) ? "templated kind" : "unreadable kind";
  const name = m[1] ?? m[2] ?? m[3];
  return podFree.has(name.toLowerCase()) ? null : name;
}

// Reads the top level of every YAML document a template writes, laid out as
// written and with the trim markers applied (either can hide a key the other
// shows when an action sits between two lines). A document's
// top level is every line no earlier line of the same document is indented
// less than (an indented document after a comment line is valid YAML), a
// flow mapping that starts such a line ({"kind": "Job", ...}), or a complex
// (?) or merge (<<) key there. Returns the kinds found there that are not
// pod-free, the actions that write text the script cannot read there (an
// output action, or an include of a template the chart does not define; with
// readOutput only), and the include/template calls placed there.
function scanDocuments(tokens, src, trimStart, readOutput) {
  const kinds = [];
  const unread = [];
  const rootCalls = new Set();
  for (const trim of [false, true]) scanLayout(skeletonOf(tokens, src, trimStart, trim), src, readOutput, kinds, unread, rootCalls);
  return { kinds, unread, rootCalls };
}

function scanLayout({ text, marks }, src, readOutput, kinds, unread, rootCalls) {
  const addKind = (label) => { if (label !== null && !kinds.includes(label)) kinds.push(label); };
  let mi = 0;
  let docMin = Infinity;
  let scalarIndent = null;
  let flow = null;
  const placed = (t, column) => {
    const ind = /\|\s*n?indent\s+(\d+)\s*$/.exec(t.body);
    return (ind ? Number(ind[1]) : column) <= docMin;
  };
  const checkAction = (t, column) => {
    if (t.type === "call" && t.name !== null && defines.has(t.name)) {
      if (placed(t, column)) rootCalls.add(t);
    } else if (t.type === "output" || t.type === "call") {
      if (readOutput && placed(t, column) && !unread.includes(t)) unread.push(t);
    }
  };
  const sourceColumn = (t) => {
    const lineStart = src.lastIndexOf("\n", t.start - 1) + 1;
    return /^[ \t]*$/.test(src.slice(lineStart, t.start)) ? t.start - lineStart : null;
  };
  const flowChars = (str) => {
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (flow.quote) {
        if (flow.root && flow.depth === 1) flow.top += c;
        if (c === "\\" && flow.quote === '"') { i++; if (flow.root && flow.depth === 1) flow.top += str[i] ?? ""; continue; }
        if (c === flow.quote) flow.quote = null;
        continue;
      }
      if (c === "#" && /\s/.test(str[i - 1] ?? " ")) break;
      if ((c === '"' || c === "'") && "{[,:".includes(flow.prev)) {
        flow.quote = c;
        if (flow.root && flow.depth === 1) flow.top += c;
        flow.prev = c;
        continue;
      }
      if (c === "{" || c === "[") {
        flow.depth++;
        if (flow.root && flow.depth === 2) flow.top += "\u0002";
        flow.prev = c;
        continue;
      }
      if (c === "}" || c === "]") {
        if (--flow.depth === 0) {
          closeFlow();
          return;
        }
        flow.prev = c;
        continue;
      }
      if (flow.root && flow.depth === 1) flow.top += c;
      if (!/\s/.test(c)) flow.prev = c;
    }
    if (flow && flow.root && flow.depth === 1) flow.top += " ";
  };
  const closeFlow = () => {
    if (flow && flow.root) {
      for (const m of flow.top.matchAll(/(?:^|,)[ \t]*(?:"kind"|'kind'|kind)[ \t]*:([^,]*)/gi)) addKind(kindLabel(m[1].replace(/\u0002/g, "{}")));
    }
    flow = null;
  };
  for (const raw of text.split("\n")) {
    const lineMarks = [];
    for (const ch of raw) if (ch === MARK) lineMarks.push(marks[mi++]);
    const lead = /^[ \t\u0001]*/.exec(raw)[0];
    let rest = raw.slice(lead.length);
    let indent = lead.replace(/\u0001/g, "").length;
    const leading = lead.split(MARK).length - 1;
    const separator = indent === 0 ? /^(?:---|\.\.\.)(?=[ \t]|$)[ \t]*/.exec(rest) : null;
    if (flow && !separator) { flowChars(raw); continue; }
    if (flow) closeFlow();
    if (scalarIndent !== null) {
      if (!separator && (rest === "" || indent > scalarIndent)) continue;
      scalarIndent = null;
    }
    for (let k = 0; k < lineMarks.length; k++) {
      const t = lineMarks[k];
      if (k < leading) checkAction(t, indent);
      else {
        const column = sourceColumn(t);
        if (column !== null) checkAction(t, column);
      }
    }
    if (separator) {
      // "---" starts a document, which may begin on the same line.
      docMin = Infinity;
      rest = rest.slice(separator[0].length);
    }
    if (rest === "" || rest.startsWith("#")) continue;
    const root = indent <= docMin;
    docMin = Math.min(docMin, indent);
    if (root) {
      const key = /^(?:"kind"|'kind'|kind)[ \t]*:/i.exec(rest);
      if (key) addKind(kindLabel(rest.slice(key[0].length)));
      else if (/^\?/.test(rest) || /^<<[ \t]*:/.test(rest)) addKind("unreadable kind");
    }
    const opener = /^(?:(?:-[ \t]+)|(?:(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#:{}[\],"'][^#:]*?)[ \t]*:[ \t]+))*(?:[!&][^\s,{}[\]]*[ \t]+)*([{[])/.exec(rest);
    if (opener) {
      flow = { depth: 0, root: root && opener[0].length === 1 && opener[1] === "{", top: "", quote: null, prev: "{" };
      flowChars(rest.slice(opener[0].length - 1));
      continue;
    }
    if (/(?:^|:|-)[ \t]*(?:[!&][^\s,{}[\]]*[ \t]+)*[|>][-+1-9]*[ \t]*(?:#.*)?$/.test(rest)) scalarIndent = indent;
  }
  closeFlow();
}

// Why a template is a workload template: the kinds it writes at a document's
// top level and the text it cannot read there, also through the defines it
// includes (a define placed at the top level is read for output too).
function workloadKinds(tokens, src, trimStart, readOutput, seen) {
  const r = scanDocuments(tokens, src, trimStart, readOutput);
  const kinds = [...r.kinds];
  for (const t of r.unread) {
    const label = `text from ${quote(t.body)} at line ${t.line}`;
    if (!kinds.includes(label)) kinds.push(label);
  }
  for (const c of callsIn(tokens)) {
    if (c.name === null || !defines.has(c.name)) continue;
    const mode = readOutput && r.rootCalls.has(c);
    const key = `${c.name}\u0000${mode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const d of defines.get(c.name)) {
      for (const k of workloadKinds(d.body, d.file.text, d.trimStart, mode, seen)) if (!kinds.includes(k)) kinds.push(k);
    }
  }
  return kinds;
}

let workloads = 0;
for (const f of templateFiles) {
  // Helm renders neither partials nor a file whose name ends in NOTES.txt.
  if (isPartial(f) || f === vendored || f.chartPath.endsWith("NOTES.txt")) continue;
  const tokens = tokenize(f);
  if (!tokens) { workloads++; fail(`(c) ${f.display}: cannot parse the template, so it may render a workload: ${f.lexError}`); continue; }
  const kinds = workloadKinds(tokens, f.text, false, true, new Set());
  if (kinds.length === 0) continue;
  workloads++;
  const label = `${f.display} (${kinds.join(", ")})`;
  const r = guardFirst(tokens, "file", "", new Set());
  if (r.error) fail(`(c) ${label}: ${r.error}`);
  else ok(`(c) ${label}: runs fbx.guard before any output (${r.via})`);
}
if (workloads === 0) fail("(c) no workload template found under templates/ (no document whose top-level kind is outside the pod-free list)");

for (const l of lines) console.log(l);
if (failures.length === 0) {
  console.log("verify-vendored-guard: all checks passed");
} else {
  console.log(`verify-vendored-guard: ${failures.length} check${failures.length === 1 ? "" : "s"} failed`);
  process.exitCode = 1;
}
JS

exec node --input-type=module -e "$program" -- "$1" "$2"
