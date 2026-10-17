// Test data names no directory of the machine that wrote or runs it. A case that
// needs a file path (a config import, a JVM argument file, a JAAS file, a CA
// bundle, an XML file of bean definitions) uses a relative name such as
// ./override.yml, @jvm.args or client.conf: the guard refuses these cases by the
// property name or option word, so the path itself does not matter, and a
// workstation or runner directory in the repository is a leak. The publication
// guardrails search the whole repository for two of these prefixes only.
//
// Scope: every tracked file of the chart tests and fixtures
// (charts/<chart>/tests, charts/<chart>/ci), of scripts/ (validate-chart.sh and
// its cases, the node tests and their fixtures) and of compose/test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// The temporary, home and root directories of Linux and macOS, and an agent's
// scratch directory. Written with character classes so that this file does not
// match itself.
const LOCAL_PATH = /\/(?:t[m]p|h[o]me|r[o]ot|U[s]ers)\/|[Ss]cratch[p]ad/;
const SCOPE = /^(?:charts\/[^/]+\/(?:tests|ci)\/|scripts\/|compose\/test\/)/;

const trackedInScope = () =>
  execFileSync("git", ["ls-files", "-z"], { cwd: repo, encoding: "utf8" })
    .split("\0")
    .filter((f) => SCOPE.test(f));

test("the scope holds the chart tests, the CI scripts and the compose tests", () => {
  const files = trackedInScope();
  for (const f of [
    "charts/fintechbankx-service/tests/kafka_sasl_names_test.yaml",
    "charts/fintechbankx-service/tests/spring_main_names_test.yaml",
    "charts/fintechbankx-service/ci/loan-lifecycle-values.yaml",
    "scripts/ci/validate-chart.sh",
    "scripts/ci/test/verify-vendored-guard.test.mjs",
  ]) {
    assert.ok(files.includes(f), `${f} is not in the scanned files`);
  }
});

test("the pattern matches every local directory prefix it names", () => {
  for (const p of ["t" + "mp", "h" + "ome", "r" + "oot", "U" + "sers"]) {
    assert.match(`-Dx=/${p}/a.conf`, LOCAL_PATH);
  }
  assert.match("out/s" + "cratchpad/x", LOCAL_PATH);
  for (const ok of ["mountPath: /" + "tmp", "optional:file:./override.yml", "@jvm.args", "/etc/fintechbankx/rds-ca/global-bundle.pem"]) {
    assert.doesNotMatch(ok, LOCAL_PATH);
  }
});

test("chart tests, CI scripts and compose tests name no local filesystem path", () => {
  const hits = [];
  for (const f of trackedInScope()) {
    const text = fs.readFileSync(path.join(repo, f), "utf8");
    text.split(/\r?\n/).forEach((line, i) => {
      if (LOCAL_PATH.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, [], `${hits.length} line(s) name a local filesystem path; use a relative file name`);
});
