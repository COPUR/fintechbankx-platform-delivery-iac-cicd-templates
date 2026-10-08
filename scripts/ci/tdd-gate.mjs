#!/usr/bin/env node
// "Tests travel with code" (ADR-029 decision 1.2, FINTECHBANKX_SERVICE_GUARDRAILS.md section 5):
// a pull request that changes anything under a src/main/ directory must also
// change something under a src/test/ directory, unless it carries the label
// `no-behaviour-change` (refactors, renames, generated code; reviewers check it).
//
// usage: tdd-gate.mjs --base <sha> --head <sha> --labels '<json array>'
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const OPT_OUT_LABEL = "no-behaviour-change";

const isMain = (f) => /(^|\/)src\/main\//.test(f);
const isTest = (f) => /(^|\/)src\/test\//.test(f);

export function evaluate({ changedFiles, labels }) {
  const mainFiles = changedFiles.filter(isMain);
  const testFiles = changedFiles.filter(isTest);
  const optedOut = labels.includes(OPT_OUT_LABEL);
  if (mainFiles.length === 0) {
    return { ok: true, mainFiles, testFiles, optedOut, reason: "no src/main changes" };
  }
  if (testFiles.length > 0) {
    return { ok: true, mainFiles, testFiles, optedOut, reason: `src/main changes come with ${testFiles.length} src/test change(s)` };
  }
  if (optedOut) {
    return { ok: true, mainFiles, testFiles, optedOut, reason: `label ${OPT_OUT_LABEL}: reviewers confirm no behaviour changed` };
  }
  return {
    ok: false, mainFiles, testFiles, optedOut,
    reason: `${mainFiles.length} src/main file(s) changed without any src/test change. Add the failing-first test ` +
      `(ADR-029), or label the PR ${OPT_OUT_LABEL} if behaviour is unchanged.`
  };
}

function arg(name, argv) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(argv) {
  const base = arg("--base", argv);
  const head = arg("--head", argv) ?? "HEAD";
  if (!base) {
    console.error("tdd-gate: --base is required");
    return 2;
  }
  let labels = [];
  try {
    labels = JSON.parse(arg("--labels", argv) ?? "[]");
  } catch {
    console.error("tdd-gate: --labels must be a JSON array of label names");
    return 2;
  }
  const changedFiles = execFileSync("git", ["diff", "--name-only", `${base}...${head}`], { encoding: "utf8" })
    .split("\n").filter(Boolean);
  const r = evaluate({ changedFiles, labels });
  const lines = [`tdd-gate: ${r.ok ? "PASS" : "FAIL"} - ${r.reason}`];
  for (const f of r.mainFiles) lines.push(`  main: ${f}`);
  for (const f of r.testFiles) lines.push(`  test: ${f}`);
  (r.ok ? console.log : console.error)(lines.join("\n"));
  return r.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
