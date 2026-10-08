// Tests for the regression-parity additions to the local/ephemeral runtime:
// opt-in parity test actors (users + suite client layered onto the realm),
// per-service extra environment, caller allow-lists and the monolith-oracle wiring.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const here = path.dirname(fileURLToPath(import.meta.url));
const composeDir = path.resolve(here, "..");
const fixtures = path.join(here, "fixtures");
const initEnv = path.join(composeDir, "scripts", "init-env.sh");
const serviceEnv = path.join(composeDir, "scripts", "service-env.mjs");
const composeFile = path.join(composeDir, "docker-compose.yml");
const realmFixture = path.join(fixtures, "realm-minimal.json");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fbx-parity-"));
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const parseEnv = (file) => Object.fromEntries(
  fs.readFileSync(file, "utf8").split("\n").filter((l) => l && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const composeDoc = () => YAML.parse(fs.readFileSync(composeFile, "utf8"));
const dockerCompose = run("docker", ["compose", "version"]).status === 0;

const ACTORS = { banker: "banker", admin: "admin", loan_officer: "loan_officer",
  compliance_officer: "compliance_officer", auditor: "auditor", customer: "customer" };
const AUDIENCES = ["svc-ln-loan-lifecycle", "svc-pay-initiation-settlement", "svc-cus-profile-kyc",
  "svc-rsk-decisioning", "svc-cmp-evidence"];
// Keycloak password policy of the identity realm: length(14), upper, lower, digit, special.
const meetsPolicy = (v) => v.length >= 14 && /[A-Z]/.test(v) && /[a-z]/.test(v) && /\d/.test(v) && /[^A-Za-z0-9]/.test(v);

function generate(extra = []) {
  const out = tmp();
  const cache = path.join(out, ".cache");
  const res = run("bash", [initEnv, "--out-dir", out, "--realm", realmFixture, "--cache-dir", cache, ...extra]);
  return { out, cache, res };
}

// --- parity actors ------------------------------------------------------------

test("init-env without --parity-fixtures adds no parity actors", () => {
  const { out, cache, res } = generate();
  assert.equal(res.status, 0, res.stderr);
  const env = parseEnv(path.join(out, ".env"));
  assert.deepEqual(Object.keys(env).filter((k) => k.startsWith("PARITY_")), []);
  assert.ok(!fs.existsSync(path.join(cache, "parity")), "no parity fixture rendered");
});

test("init-env --parity-fixtures generates actor passwords and client secrets in the env file", () => {
  const { out, res } = generate(["--parity-fixtures"]);
  assert.equal(res.status, 0, res.stderr);
  const env = parseEnv(path.join(out, ".env"));
  const realmEnv = parseEnv(path.join(out, "realm.env"));
  for (const actor of Object.keys(ACTORS)) {
    const name = `PARITY_PASSWORD_${actor.toUpperCase()}`;
    assert.ok(env[name], `${name} missing`);
    assert.ok(meetsPolicy(env[name]), `${name} must satisfy the realm password policy`);
    assert.equal(realmEnv[name], env[name], `${name} must match the realm import value`);
    assert.equal(env[`PARITY_USERNAME_${actor.toUpperCase()}`], `parity-${actor.replaceAll("_", "-")}`);
  }
  assert.match(env.PARITY_SECRET_PARITY_SUITE, /^[A-Za-z0-9]{32,}$/);
  assert.equal(realmEnv.PARITY_SECRET_PARITY_SUITE, env.PARITY_SECRET_PARITY_SUITE);
  assert.equal(env.PARITY_SECRET_SVC_LN_LOAN_LIFECYCLE, env.FBX_OIDC_SECRET_SVC_LN_LOAN_LIFECYCLE);
  assert.equal(env.PARITY_SECRET_SVC_PAY_INITIATION_SETTLEMENT, env.FBX_OIDC_SECRET_SVC_PAY_INITIATION_SETTLEMENT);
  assert.equal(env.PARITY_SECRET_SVC_LN_LOAN_LIFECYCLE, realmEnv.FBX_OIDC_SECRET_SVC_LN_LOAN_LIFECYCLE);
  const passwords = Object.keys(ACTORS).map((a) => env[`PARITY_PASSWORD_${a.toUpperCase()}`]);
  assert.equal(new Set(passwords).size, passwords.length, "passwords must be unique");
  assert.equal(fs.statSync(path.join(out, ".env")).mode & 0o777, 0o600);
  // Re-running keeps the values (the running Keycloak already has them).
  const again = run("bash", [initEnv, "--out-dir", out, "--realm", realmFixture, "--cache-dir", path.join(out, ".cache"), "--parity-fixtures"]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(parseEnv(path.join(out, ".env")).PARITY_PASSWORD_BANKER, env.PARITY_PASSWORD_BANKER);
});

test("rendered parity fixture: actors, customer_id attribute, suite client, every placeholder supplied", () => {
  const { out, cache, res } = generate(["--parity-fixtures"]);
  assert.equal(res.status, 0, res.stderr);
  const file = path.join(cache, "parity", "parity-fixtures.json");
  const text = fs.readFileSync(file, "utf8");
  const fx = JSON.parse(text);
  assert.equal(fx.realm, "fintechbankx");
  const realmEnv = parseEnv(path.join(out, "realm.env"));
  for (const m of text.matchAll(/\$\(env:([A-Z0-9_]+)\)/g)) assert.ok(m[1] in realmEnv, `${m[1]} not in realm.env`);
  const env = parseEnv(path.join(out, ".env"));
  for (const v of Object.values(env).filter((v) => v.length >= 32)) assert.ok(!text.includes(v), "no secret value inlined");

  for (const [actor, role] of Object.entries(ACTORS)) {
    const user = fx.users.find((u) => u.username === `parity-${actor.replaceAll("_", "-")}`);
    assert.ok(user, `user for ${actor} missing`);
    assert.deepEqual(user.realmRoles, [role]);
    assert.equal(user.enabled, true);
    assert.equal(user.emailVerified, true);
    assert.ok(user.firstName && user.lastName && user.email, "complete profile (no VERIFY_PROFILE action)");
    assert.deepEqual(user.credentials, [{ type: "password", value: `$(env:PARITY_PASSWORD_${actor.toUpperCase()})`, temporary: false }]);
    assert.ok(!("id" in user), "sub stays a generated UUID");
  }
  const customer = fx.users.find((u) => u.username === "parity-customer");
  assert.deepEqual(customer.attributes, { customer_id: ["CUST-12345678"] });
  for (const u of fx.users.filter((x) => x !== customer)) assert.ok(!u.attributes?.customer_id, `${u.username} has no customer_id`);

  assert.equal(fx.clients.length, 1);
  const c = fx.clients[0];
  assert.equal(c.clientId, "parity-suite");
  assert.equal(c.publicClient, false);
  assert.equal(c.secret, "$(env:PARITY_SECRET_PARITY_SUITE)");
  assert.equal(c.serviceAccountsEnabled, true);
  assert.equal(c.directAccessGrantsEnabled, true);
  assert.equal(c.standardFlowEnabled, false);
  assert.equal(c.implicitFlowEnabled, false);
  assert.notEqual(c.attributes["fbx.client-type"], "service", "must not fall under the service-client policy (rejects ROPC)");
  const auds = c.protocolMappers.filter((m) => m.protocolMapper === "oidc-audience-mapper")
    .map((m) => m.config["included.client.audience"]).sort();
  assert.deepEqual(auds, [...AUDIENCES].sort());
  assert.ok(c.defaultClientScopes.includes("customer-id"));
  assert.ok(c.defaultClientScopes.includes("roles"));
  // The production realm clients are never redefined by the fixture.
  assert.ok(!fx.clients.some((x) => x.clientId.startsWith("svc-")));
  // No OpenLDAP in compose: the realm's LDAP federation is disabled in the fixture layer only.
  const ldap = fx.components["org.keycloak.storage.UserStorageProvider"];
  assert.ok(ldap.length >= 1);
  for (const comp of ldap) assert.deepEqual(comp.config.enabled, ["false"]);
});

test("compose: parity-fixtures-import is opt-in, layered after the realm import and never deletes", () => {
  const s = composeDoc().services;
  const imp = s["parity-fixtures-import"];
  assert.ok(imp, "parity-fixtures-import service missing");
  assert.deepEqual(imp.profiles, ["parity-fixtures"]);
  assert.equal(imp.image, s["realm-import"].image);
  assert.deepEqual(imp.depends_on, { "realm-import": { condition: "service_completed_successfully" } });
  assert.ok(imp.volumes.some((v) => v.startsWith("./.cache/parity:")), "mounts the rendered fixture");
  assert.equal(imp.environment.IMPORT_REMOTESTATE_ENABLED, "false");
  for (const k of ["IMPORT_MANAGED_CLIENT", "IMPORT_MANAGED_ROLE", "IMPORT_MANAGED_GROUP", "IMPORT_MANAGED_COMPONENT",
    "IMPORT_MANAGED_SUBCOMPONENT", "IMPORT_MANAGED_CLIENTSCOPE", "IMPORT_MANAGED_SCOPEMAPPING",
    "IMPORT_MANAGED_REQUIREDACTION", "IMPORT_MANAGED_AUTHENTICATIONFLOW", "IMPORT_MANAGED_IDENTITYPROVIDER"]) {
    assert.equal(imp.environment[k], "no-delete", `${k}`);
  }
  for (const name of ["loan-lifecycle-service", "payment-initiation-settlement-service", "customer-profile-kyc-service",
    "risk-decisioning-service", "compliance-evidence-service", "monolith"]) {
    assert.deepEqual(s[name].depends_on["parity-fixtures-import"],
      { condition: "service_completed_successfully", required: false }, `${name} waits for the fixture when enabled`);
  }
});

// --- caller allow-lists ---------------------------------------------------------

test("compose: SERVICE_CALLERS allow-lists of customer, risk and compliance", () => {
  const s = composeDoc().services;
  const callers = (name) => String(s[name].environment.SERVICE_CALLERS).split(",").map((x) => x.trim());
  assert.ok(callers("customer-profile-kyc-service").includes("svc-ln-loan-lifecycle"));
  assert.ok(callers("risk-decisioning-service").includes("svc-pay-initiation-settlement"));
  assert.ok(callers("compliance-evidence-service").includes("svc-pay-initiation-settlement"));
});

// --- monolith-oracle ------------------------------------------------------------

test("compose: monolith service is wired for the monolith-oracle app", () => {
  const m = composeDoc().services.monolith;
  assert.equal(m.environment.ORACLE_PORT, "8080");
  assert.equal(m.environment.OIDC_ISSUER_URI, "http://localhost:8180/realms/fintechbankx");
  assert.equal(m.environment.OIDC_JWK_SET_URI, "http://keycloak:8080/realms/fintechbankx/protocol/openid-connect/certs");
  assert.equal(m.environment.SPRING_PROFILES_ACTIVE, "${FBX_MONOLITH_SPRING_PROFILES:-local}");
  assert.deepEqual(m.ports, ["127.0.0.1:18000:8080"]);
  const hc = m.healthcheck.test.join(" ");
  assert.ok(hc.includes("${FBX_MONOLITH_HEALTH_PATH:-/actuator/health}"), hc);
  assert.match(hc, /127\.0\.0\.1:8080|localhost:8080/);
  assert.deepEqual(m.depends_on["realm-import"], { condition: "service_completed_successfully" });
});

// --- per-service extra environment ----------------------------------------------------

function renderServiceEnv(lines) {
  const dir = tmp();
  const input = path.join(dir, "service-env.txt");
  const out = path.join(dir, "override.json");
  fs.writeFileSync(input, lines.join("\n") + "\n");
  const res = run("node", [serviceEnv, "--in", input, "--out", out, "--services", path.join(composeDir, "services.tsv")]);
  return { res, out };
}

test("service-env renders a compose override for listed services", () => {
  const { res, out } = renderServiceEnv([
    "# comment",
    "payment-initiation-settlement-service__ACCOUNTS_ADAPTER=in-memory",
    "svc-cus-profile-kyc__FEATURE_X=a=b $HOME",
    ""
  ]);
  assert.equal(res.status, 0, res.stderr);
  const doc = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.deepEqual(doc, { services: {
    "payment-initiation-settlement-service": { environment: { ACCOUNTS_ADAPTER: "in-memory" } },
    "customer-profile-kyc-service": { environment: { FEATURE_X: "a=b $$HOME" } }
  } });
});

test("service-env rejects unknown services, bad names and credential overrides", () => {
  for (const [line, why] of [
    ["unknown-service__X=1", /not in services\.tsv/],
    ["payment-initiation-settlement-service__lower=1", /variable name/],
    ["payment-initiation-settlement-service_ACCOUNTS_ADAPTER=1", /SERVICE__VAR=value/],
    ["payment-initiation-settlement-service__SPRING_DATASOURCE_PASSWORD=x", /credential/],
    ["payment-initiation-settlement-service__OIDC_CLIENT_SECRET=x", /credential/],
    ["payment-initiation-settlement-service__OIDC_ISSUER_URI=http://evil", /credential/],
    ["customer-profile-kyc-service__DB_USERNAME=postgres", /credential/],
    ["risk-decisioning-service__API_TOKEN=x", /credential/],
    ["risk-decisioning-service__SIGNING_KEY=x", /credential/]
  ]) {
    const { res } = renderServiceEnv([line]);
    assert.notEqual(res.status, 0, `${line} must be rejected`);
    assert.match(res.stderr, why, line);
  }
});

test("docker compose config applies the service-env override and the parity profile", { skip: !dockerCompose && "docker compose not available" }, () => {
  const { out } = generate(["--parity-fixtures"]);
  const { res: r, out: override } = renderServiceEnv(["payment-initiation-settlement-service__ACCOUNTS_ADAPTER=in-memory"]);
  assert.equal(r.status, 0, r.stderr);
  const base = ["compose", "--project-directory", composeDir, "--env-file", path.join(out, ".env"), "-f", composeFile];
  const env = { ...process.env, FBX_REALM_ENV_FILE: path.join(out, "realm.env") };
  let res = run("docker", [...base, "-f", override, "--profile", "payments", "--profile", "parity-fixtures", "config", "--format", "json"], { env });
  assert.equal(res.status, 0, res.stderr);
  const cfg = JSON.parse(res.stdout);
  assert.equal(cfg.services["payment-initiation-settlement-service"].environment.ACCOUNTS_ADAPTER, "in-memory");
  assert.ok(cfg.services["parity-fixtures-import"]);
  // Without the profile the optional dependency is dropped and config still validates.
  res = run("docker", [...base, "--profile", "services", "--profile", "monolith", "config", "-q"], { env });
  assert.equal(res.status, 0, res.stderr);
});
