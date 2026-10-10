// The microservice skeleton routes contract waivers (<spec>.accepted-breaking.txt,
// read by contract-checks.yml) to the data-contracts owners in CODEOWNERS, so a
// provider squad cannot approve its own breaking change. CODEOWNERS is
// last-match-wins: the waiver rule must be the last rule that matches a waiver
// file anywhere in the tree (OpenAPI and AsyncAPI locations).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const codeowners = path.join(repo, "templates/microservice/.github/CODEOWNERS");
const DATA_CONTRACTS_OWNER = "@<org>/<data-contracts-owners>";

// gitignore-style pattern -> RegExp, enough for CODEOWNERS rules (*, **, ?, anchoring).
const toRegExp = (pattern) => {
  let p = pattern;
  const anchored = p.startsWith("/") || p.replace(/\/$/, "").includes("/");
  p = p.replace(/^\//, "");
  const dirOnly = p.endsWith("/");
  p = p.replace(/\/$/, "");
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*" && p[i + 1] === "*") {
      if (p[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } else { re += ".*"; i += 1; }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const prefix = anchored ? "^" : "^(?:.*/)?";
  return new RegExp(`${prefix}${re}${dirOnly ? "/.*" : "(?:/.*)?"}$`);
};

const rules = () =>
  fs
    .readFileSync(codeowners, "utf8")
    .split("\n")
    .map((l) => l.replace(/(^|\s)#.*$/, "").trim())
    .filter(Boolean)
    .map((l) => {
      const [pattern, ...owners] = l.split(/\s+/);
      return { pattern, owners, re: toRegExp(pattern) };
    });

const ownersOf = (file) => {
  const hit = rules().filter((r) => r.re.test(file)).at(-1);
  return hit ? hit.owners : [];
};

test("skeleton ships a CODEOWNERS file", () => {
  assert.ok(fs.existsSync(codeowners), "templates/microservice/.github/CODEOWNERS is missing");
});

test("every waiver location is owned by the data-contracts owners only (last match wins)", () => {
  for (const file of [
    "src/main/resources/openapi/example-service.accepted-breaking.txt",
    "api/openapi/example-service.accepted-breaking.txt",
    "openapi/example-service.accepted-breaking.txt",
    "asyncapi/example-service-events.accepted-breaking.txt",
    "example-service.accepted-breaking.txt",
  ]) {
    assert.deepEqual(ownersOf(file), [DATA_CONTRACTS_OWNER], `${file} must be owned by ${DATA_CONTRACTS_OWNER}`);
  }
});

test("the waiver rule does not capture ordinary spec or source files (control)", () => {
  for (const file of ["api/openapi/example-service.yaml", "asyncapi/example-service-events.yaml", "build.gradle"]) {
    assert.notDeepEqual(ownersOf(file), [DATA_CONTRACTS_OWNER], `${file} must not be routed to the data-contracts owners`);
  }
});
