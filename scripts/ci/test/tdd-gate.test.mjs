// Tests for the "tests travel with code" gate (ADR-029 decision 1.2).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { evaluate, OPT_OUT_LABEL } from "../tdd-gate.mjs";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "tdd-gate.mjs");

test("the opt-out label is exactly no-behaviour-change", () => {
  assert.equal(OPT_OUT_LABEL, "no-behaviour-change");
});

test("main code without any test change fails", () => {
  const r = evaluate({ changedFiles: ["loan-domain/src/main/java/com/bank/loan/domain/Loan.java", "README.md"], labels: [] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.mainFiles, ["loan-domain/src/main/java/com/bank/loan/domain/Loan.java"]);
  assert.match(r.reason, /src\/test/);
});

test("main code with a test change in any module passes", () => {
  const r = evaluate({
    changedFiles: ["loan-domain/src/main/java/com/bank/loan/domain/Loan.java", "loan-application/src/test/java/com/bank/loan/application/LoanServiceTest.java"],
    labels: []
  });
  assert.equal(r.ok, true);
});

test("single-module layout is recognised", () => {
  assert.equal(evaluate({ changedFiles: ["src/main/java/com/enterprise/openfinance/x/A.java"], labels: [] }).ok, false);
  assert.equal(evaluate({ changedFiles: ["src/main/java/A.java", "src/test/java/ATest.java"], labels: [] }).ok, true);
});

test("main resources count as main code", () => {
  assert.equal(evaluate({ changedFiles: ["loan-infrastructure/src/main/resources/db/migration/V7__x.sql"], labels: [] }).ok, false);
});

test("the opt-out label lets a main-only change pass and is reported", () => {
  const r = evaluate({ changedFiles: ["src/main/java/A.java"], labels: ["dependencies", "no-behaviour-change"] });
  assert.equal(r.ok, true);
  assert.equal(r.optedOut, true);
});

test("similar labels do not opt out", () => {
  for (const label of ["no-behavior-change", "No-Behaviour-Change", "no-behaviour-changes"]) {
    assert.equal(evaluate({ changedFiles: ["src/main/java/A.java"], labels: [label] }).ok, false, label);
  }
});

test("changes outside src/main pass (docs, build, CI, tests only)", () => {
  assert.equal(evaluate({ changedFiles: ["README.md", "build.gradle", ".github/workflows/ci.yml"], labels: [] }).ok, true);
  assert.equal(evaluate({ changedFiles: ["src/test/java/ATest.java"], labels: [] }).ok, true);
  assert.equal(evaluate({ changedFiles: [], labels: [] }).ok, true);
});

test("a path merely containing main is not main code", () => {
  assert.equal(evaluate({ changedFiles: ["docs/src/mainframe/notes.md", "tools/src/main-old/x.txt"], labels: [] }).ok, true);
});

test("CLI reads the diff between two refs of a git repo and the labels", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tdd-gate-"));
  const git = (...a) => {
    const r = spawnSync("git", a, { cwd: repo, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "ci@example.invalid");
  git("config", "user.name", "ci");
  fs.writeFileSync(path.join(repo, "README.md"), "x\n");
  git("add", "."); git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");
  fs.mkdirSync(path.join(repo, "src/main/java"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src/main/java/A.java"), "class A {}\n");
  git("add", "."); git("commit", "-q", "-m", "main only");
  const head = git("rev-parse", "HEAD");

  const runCli = (labels) => spawnSync("node", [script, "--base", base, "--head", head, "--labels", labels], { cwd: repo, encoding: "utf8" });
  let r = runCli("[]");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /src\/main\/java\/A\.java/);
  r = runCli(JSON.stringify(["no-behaviour-change"]));
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
