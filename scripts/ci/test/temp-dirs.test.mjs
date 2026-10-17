// The test suites must not leave directories in the system temp directory: a run used to leave a few
// hundred, and a 114 MB PostgreSQL data directory each time compose tests ran.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const suites = ["compose/test", "scripts/ci/test", "scripts/validation/test"];

const testFiles = () =>
  suites.flatMap((dir) =>
    fs.readdirSync(path.join(repo, dir))
      .filter((f) => f.endsWith(".test.mjs"))
      .map((f) => path.join(dir, f)));

// A directory made directly in os.tmpdir() must be assigned to a name that is removed with
// fs.rmSync within the next 15 lines (a try/finally, t.after or a cleanup helper), or be the file's
// tmpRoot, removed in a top-level after(). Everything else is made under tmpRoot.
function leaks(file) {
  const lines = fs.readFileSync(path.join(repo, file), "utf8").split("\n");
  const found = [];
  lines.forEach((line, i) => {
    if (!/mkdtempSync\(\s*path\.join\(\s*os\.tmpdir\(\)/.test(line)) return;
    const name = line.match(/(?:const|let)\s+(\w+)\s*=\s*fs\.mkdtempSync\(/)?.[1];
    if (!name) {
      found.push(`${file}:${i + 1}: temp directory not held in a name that is removed`);
      return;
    }
    const removal = new RegExp(`rmSync\\(\\s*${name}\\s*,\\s*\\{[^}]*recursive:\\s*true`);
    if (name === "tmpRoot") {
      if (!lines.some((l) => /^after\(/.test(l) && removal.test(l))) {
        found.push(`${file}:${i + 1}: tmpRoot is not removed in a top-level after()`);
      }
      return;
    }
    if (!lines.slice(i + 1, i + 16).some((l) => removal.test(l))) {
      found.push(`${file}:${i + 1}: ${name} is not removed within 15 lines`);
    }
  });
  return found;
}

test("temp dirs: every test file removes the directories it makes in the system temp directory", () => {
  const found = testFiles().flatMap(leaks);
  assert.deepEqual(found, []);
});

test("temp dirs: the check flags a directory that is never removed", () => {
  const dir = fs.mkdtempSync(path.join(repo, ".temp-dirs-check-"));
  try {
    const rel = path.relative(repo, path.join(dir, "x.test.mjs"));
    fs.writeFileSync(path.join(dir, "x.test.mjs"), [
      'const a = fs.mkdtempSync(path.join(TMP, "x-"));',
      'const b = path.join(fs.mkdtempSync(path.join(TMP, "y-")), "f");',
      'const c = fs.mkdtempSync(path.join(TMP, "z-"));',
      'fs.rmSync(c, { recursive: true, force: true });',
      'const tmpRoot = fs.mkdtempSync(path.join(TMP, "r-"));'
    ].map((l) => l.replace("TMP", "os.tmpdir()")).join("\n"));
    assert.deepEqual(leaks(rel), [
      `${rel}:1: a is not removed within 15 lines`,
      `${rel}:2: temp directory not held in a name that is removed`,
      `${rel}:5: tmpRoot is not removed in a top-level after()`
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
