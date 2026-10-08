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
  compliance_officer: "compliance_officer", auditor: "auditor", customer: "customer", other_customer: "customer",
  customer_owner: "customer" };
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
  // Second customer for ownership-denial scenarios.
  const other = fx.users.find((u) => u.username === "parity-other-customer");
  assert.deepEqual(other.attributes, { customer_id: ["CUST-99999999"] });
  for (const u of fx.users.filter((x) => x !== customer && x !== other)) assert.ok(!u.attributes?.customer_id, `${u.username} has no customer_id`);
  // Customers are members of /customers (the customer service's admin permission
  // covers that group only); staff actors never are.
  const owner = fx.users.find((u) => u.username === "parity-customer-owner");
  const customers = [customer, other, owner];
  for (const u of customers) assert.deepEqual(u.groups, ["/customers"], u.username);
  for (const u of fx.users.filter((x) => !customers.includes(x))) {
    assert.ok(!(u.groups ?? []).some((g) => g === "/customers" || g.startsWith("/customers/")), `${u.username} must not be in /customers`);
  }

  assert.equal(fx.clients.length, 4);
  const c = fx.clients.find((x) => x.clientId === "parity-suite");
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

test("parity fixtures need an identity realm that declares every fixture group", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbx-realm-"));
  const realm = JSON.parse(fs.readFileSync(realmFixture, "utf8"));
  realm.groups = realm.groups.filter((g) => g.path !== "/customers");
  const old = path.join(dir, "realm-without-customers-group.json");
  fs.writeFileSync(old, JSON.stringify(realm));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "fbx-env-"));
  const res = run("bash", [initEnv, "--out-dir", out, "--realm", old, "--cache-dir", path.join(out, ".cache"), "--parity-fixtures"]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /\/customers/);
});

// --- parity TPP (Keycloak-mode open-finance actor) ---------------------------------

const b64url = (b) => Buffer.from(b).toString("base64url");

test("init-env --parity-fixtures creates the TPP-001 client (formerly parity-tpp) with a runtime keypair", async () => {
  const { out, cache, res } = generate(["--parity-fixtures"]);
  assert.equal(res.status, 0, res.stderr);
  const env = parseEnv(path.join(out, ".env"));
  assert.equal(env.PARITY_TPP_CLIENT_ID, "TPP-001");
  const priv = JSON.parse(env.PARITY_TPP_PRIVATE_JWK);
  assert.equal(priv.kty, "RSA");
  assert.equal(priv.alg, "PS256");
  assert.equal(priv.use, "sig");
  assert.ok(priv.kid && priv.d && priv.n && priv.e, "private JWK with kid");
  const fx = JSON.parse(fs.readFileSync(path.join(cache, "parity", "parity-fixtures.json"), "utf8"));
  const tpp = fx.clients.find((x) => x.clientId === "TPP-001");
  assert.ok(tpp, "TPP-001 client missing");
  assert.equal(tpp.publicClient, false);
  assert.equal(tpp.clientAuthenticatorType, "client-jwt");
  assert.equal(tpp.directAccessGrantsEnabled, false, "no password grant");
  assert.equal(tpp.standardFlowEnabled, false);
  assert.equal(tpp.implicitFlowEnabled, false);
  assert.equal(tpp.serviceAccountsEnabled, true);
  assert.ok(!("secret" in tpp), "no client secret");
  assert.equal(tpp.attributes["fbx.client-type"], "open-finance-tpp");
  assert.equal(tpp.attributes["dpop.bound.access.tokens"], "true");
  assert.equal(tpp.attributes["token.endpoint.auth.signing.alg"], "PS256");
  assert.equal(tpp.attributes["use.jwks.url"], "false");
  assert.equal(tpp.attributes["use.jwks.string"], "true");
  const jwks = JSON.parse(tpp.attributes["jwks.string"]);
  assert.equal(jwks.keys.length, 1);
  const pub = jwks.keys[0];
  assert.deepEqual([pub.kid, pub.n, pub.e, pub.alg], [priv.kid, priv.n, priv.e, "PS256"]);
  for (const k of ["d", "p", "q", "dp", "dq", "qi"]) assert.ok(!(k in pub), `public JWK must not carry ${k}`);
  // the public key really belongs to the private key
  const { createPrivateKey, createPublicKey, sign, verify, constants } = await import("node:crypto");
  const msg = Buffer.from("parity-tpp");
  const opts = { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 };
  const sig = sign("sha256", msg, { key: createPrivateKey({ key: priv, format: "jwk" }), ...opts });
  assert.ok(verify("sha256", msg, { key: createPublicKey({ key: pub, format: "jwk" }), ...opts }, sig));
  // audiences exactly as the realm's TPP template gives them
  const realm = JSON.parse(fs.readFileSync(realmFixture, "utf8"));
  const template = realm.clients.find((x) => x.clientId === "of-tpp-conformance-template");
  const auds = (cl) => cl.protocolMappers.filter((m) => m.protocolMapper === "oidc-audience-mapper")
    .map((m) => m.config["included.client.audience"]).sort();
  assert.deepEqual(auds(tpp), auds(template));
  for (const sc of template.defaultClientScopes) assert.ok(tpp.defaultClientScopes.includes(sc), sc);
  // no private material in the rendered fixture
  const text = fs.readFileSync(path.join(cache, "parity", "parity-fixtures.json"), "utf8");
  assert.ok(!text.includes(priv.d));
  // a re-run keeps the keypair (the running Keycloak already has the public key)
  const again = run("bash", [initEnv, "--out-dir", out, "--realm", realmFixture, "--cache-dir", cache, "--parity-fixtures"]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(parseEnv(path.join(out, ".env")).PARITY_TPP_PRIVATE_JWK, env.PARITY_TPP_PRIVATE_JWK);
  assert.equal(fs.readFileSync(path.join(cache, "parity", "parity-fixtures.json"), "utf8"), text);
  // and a fresh environment gets a different key
  const other = parseEnv(path.join(generate(["--parity-fixtures"]).out, ".env"));
  assert.notEqual(JSON.parse(other.PARITY_TPP_PRIVATE_JWK).n, priv.n);
});

test("the TPP clients need the realm's TPP template", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbx-realm-"));
  const realm = JSON.parse(fs.readFileSync(realmFixture, "utf8"));
  realm.clients = realm.clients.filter((x) => x.clientId !== "of-tpp-conformance-template");
  const file = path.join(dir, "realm-without-tpp-template.json");
  fs.writeFileSync(file, JSON.stringify(realm));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "fbx-env-"));
  const res = run("bash", [initEnv, "--out-dir", out, "--realm", file, "--cache-dir", path.join(out, ".cache"), "--parity-fixtures"]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /of-tpp-conformance-template/);
});

test("no private key material in tracked files", () => {
  const { out, res } = generate(["--parity-fixtures"]);
  assert.equal(res.status, 0, res.stderr);
  const priv = JSON.parse(parseEnv(path.join(out, ".env")).PARITY_TPP_PRIVATE_JWK);
  const repo = path.resolve(composeDir, "..");
  const tracked = spawnSync("git", ["ls-files", "-z"], { cwd: repo, encoding: "utf8" }).stdout.split("\0").filter(Boolean);
  const privateJwk = /"(d|dp|dq|qi)"\s*:\s*"[A-Za-z0-9_-]{40,}"/;
  const pemHeader = new RegExp(["-----BEGIN", "(?:RSA |EC )?PRIVATE KEY-----"].join(" "));
  for (const f of tracked) {
    const file = path.join(repo, f);
    if (!fs.existsSync(file) || fs.statSync(file).size > 2_000_000) continue;
    const text = fs.readFileSync(file, "utf8");
    assert.ok(!text.includes(priv.d), `${f} holds the generated private key`);
    assert.doesNotMatch(text, privateJwk, `${f} holds a private JWK member`);
    assert.doesNotMatch(text, pemHeader, `${f} holds a PEM private key`);
  }
});

test("parity fixtures and compose never use the customer web client for staff", () => {
  const template = fs.readFileSync(path.join(composeDir, "keycloak", "parity-fixtures.template.json"), "utf8");
  const compose = fs.readFileSync(composeFile, "utf8");
  for (const text of [template, compose]) assert.doesNotMatch(text, /fintechbankx-web\b/);
});

test("parity fixtures need an identity realm that maps customer_id (identity PR #11 or later)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbx-realm-"));
  const realm = JSON.parse(fs.readFileSync(realmFixture, "utf8"));
  delete realm.clientScopes;
  delete realm.userProfile;
  const old = path.join(dir, "realm-without-customer-id.json");
  fs.writeFileSync(old, JSON.stringify(realm));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "fbx-env-"));
  const res = run("bash", [initEnv, "--out-dir", out, "--realm", old, "--cache-dir", path.join(out, ".cache"), "--parity-fixtures"]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /customer_id/);
});
