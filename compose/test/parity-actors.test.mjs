// Tests for the Keycloak-mode parity actors the regression harness needs beyond
// the staff/customer users: the customer owner, parity-suite's FGAP v2 grant on
// /customers, the open-finance TPP clients TPP-001 and TPP-002, their PSU and
// API client scopes, the first-party channel client, and the lighter reset.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import YAML from "yaml";

const here = path.dirname(fileURLToPath(import.meta.url));
const composeDir = path.resolve(here, "..");
const initEnv = path.join(composeDir, "scripts", "init-env.sh");
const realmFixture = path.join(here, "fixtures", "realm-minimal.json");
const composeFile = path.join(composeDir, "docker-compose.yml");
const paritySpecFile = path.join(composeDir, "keycloak", "parity-admin-permissions.json");

const tmp = (p = "fbx-actors-") => fs.mkdtempSync(path.join(os.tmpdir(), p));
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const parseEnv = (file) => Object.fromEntries(
  fs.readFileSync(file, "utf8").split("\n").filter((l) => l && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const readRealm = () => JSON.parse(fs.readFileSync(realmFixture, "utf8"));
const meetsPolicy = (v) => v.length >= 14 && /[A-Z]/.test(v) && /[a-z]/.test(v) && /\d/.test(v) && /[^A-Za-z0-9]/.test(v);

function generate({ realm, out = tmp() } = {}) {
  let realmFile = realmFixture;
  if (realm) {
    realmFile = path.join(tmp("fbx-realm-"), "realm.json");
    fs.writeFileSync(realmFile, JSON.stringify(realm));
  }
  const cache = path.join(out, ".cache");
  const res = run("bash", [initEnv, "--out-dir", out, "--realm", realmFile, "--cache-dir", cache, "--parity-fixtures"]);
  const layerFile = path.join(cache, "parity", "parity-fixtures.json");
  const layer = res.status === 0 ? JSON.parse(fs.readFileSync(layerFile, "utf8")) : undefined;
  const env = res.status === 0 ? parseEnv(path.join(out, ".env")) : undefined;
  const realmEnv = res.status === 0 ? parseEnv(path.join(out, "realm.env")) : undefined;
  return { out, cache, res, layer, layerFile, env, realmEnv };
}

// The current identity realm: payments and the fbx_client_type scope exist.
function currentRealm() {
  const realm = readRealm();
  realm.clientScopes = [...(realm.clientScopes ?? []),
    { name: "payments", protocol: "openid-connect", attributes: { "include.in.token.scope": "true" }, protocolMappers: [] },
    { name: "read_accounts", protocol: "openid-connect", attributes: { "include.in.token.scope": "true" }, protocolMappers: [] },
    { name: "fbx-client-type-open-finance-tpp", protocol: "openid-connect", attributes: { "include.in.token.scope": "false" },
      protocolMappers: [{ name: "fbx_client_type", protocol: "openid-connect", protocolMapper: "oidc-hardcoded-claim-mapper",
        config: { "claim.name": "fbx_client_type", "claim.value": "open-finance-tpp", "access.token.claim": "true" } }] }];
  const t = realm.clients.find((c) => c.clientId === "of-tpp-conformance-template");
  t.defaultClientScopes = [...t.defaultClientScopes, "fbx-client-type-open-finance-tpp"];
  t.optionalClientScopes = ["payments"];
  return realm;
}

const client = (layer, id) => layer.clients.find((c) => c.clientId === id);
const scope = (layer, name) => (layer.clientScopes ?? []).find((s) => s.name === name);
const audiences = (c) => (c.protocolMappers ?? []).filter((m) => m.protocolMapper === "oidc-audience-mapper")
  .map((m) => m.config["included.client.audience"]).sort();
const hardcoded = (mappers = []) => Object.fromEntries(mappers.filter((m) => m.protocolMapper === "oidc-hardcoded-claim-mapper")
  .map((m) => [m.config["claim.name"], m.config["claim.value"]]));

const API_SCOPES = ["read_accounts", "read_balances", "read_transactions", "read_parties", "read_metadata",
  "read_standing_orders", "payments"];
const PSU_SCOPES = { "parity-psu-PSU-001": "PSU-001", "parity-psu-CORP-001": "CORP-001",
  "parity-psu-PSU-PARITY-LIST": "PSU-PARITY-LIST" };

function assertPrivateJwk(jwkText, name) {
  const k = JSON.parse(jwkText);
  assert.equal(k.kty, "RSA", name);
  assert.equal(k.alg, "PS256", name);
  assert.equal(k.use, "sig", name);
  const thumb = crypto.createHash("sha256").update(JSON.stringify({ e: k.e, kty: k.kty, n: k.n })).digest("base64url");
  assert.equal(k.kid, thumb, `${name}: kid is the RFC 7638 thumbprint`);
  assert.ok(k.d && k.p && k.q, `${name}: private members present`);
  return k;
}

function assertJwksMatches(c, priv) {
  const jwks = JSON.parse(c.attributes["jwks.string"]);
  assert.equal(jwks.keys.length, 1);
  const pub = jwks.keys[0];
  for (const m of ["d", "p", "q", "dp", "dq", "qi"]) assert.ok(!(m in pub), `${c.clientId}: public JWK carries ${m}`);
  assert.deepEqual([pub.kid, pub.n, pub.e, pub.alg], [priv.kid, priv.n, priv.e, "PS256"]);
  const msg = Buffer.from(c.clientId);
  const opts = { padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 };
  const sig = crypto.sign("sha256", msg, { key: crypto.createPrivateKey({ key: priv, format: "jwk" }), ...opts });
  assert.ok(crypto.verify("sha256", msg, { key: crypto.createPublicKey({ key: pub, format: "jwk" }), ...opts }, sig));
}

function assertKeyBoundConfidential(c) {
  assert.equal(c.publicClient, false, c.clientId);
  assert.equal(c.clientAuthenticatorType, "client-jwt", c.clientId);
  assert.ok(!("secret" in c), `${c.clientId}: no client secret`);
  assert.equal(c.serviceAccountsEnabled, true, c.clientId);
  assert.equal(c.directAccessGrantsEnabled, false, `${c.clientId}: no password grant`);
  assert.equal(c.standardFlowEnabled, false, c.clientId);
  assert.equal(c.implicitFlowEnabled, false, c.clientId);
  assert.equal(c.fullScopeAllowed, false, c.clientId);
  assert.equal(c.attributes["dpop.bound.access.tokens"], "true", c.clientId);
  assert.equal(c.attributes["token.endpoint.auth.signing.alg"], "PS256", c.clientId);
  assert.equal(c.attributes["use.jwks.url"], "false", c.clientId);
  assert.equal(c.attributes["use.jwks.string"], "true", c.clientId);
}

// Mirror of the request-to-pay TppClientPolicy client check (azp, deny list,
// svc- prefix, fbx_client_type claim when present).
function rtpAcceptsAsTpp(claims) {
  const azp = claims.azp;
  if (!azp || ["fintechbankx-web", "fintechbankx-mobile"].includes(azp) || azp.startsWith("svc-")) return false;
  if ("fbx_client_type" in claims) return claims.fbx_client_type === "open-finance-tpp";
  return true;
}
// Claims Keycloak's hardcoded-claim mappers put into a client-credentials token
// (client mappers plus every default scope, plus requested optional scopes).
function tokenClaims(layer, realm, c, requested = []) {
  const scopes = [...(realm.clientScopes ?? []), ...(layer.clientScopes ?? [])];
  const byName = (n) => scopes.find((s) => s.name === n);
  const names = [...c.defaultClientScopes, ...requested.filter((r) => c.optionalClientScopes.includes(r))];
  return Object.assign({ azp: c.clientId }, hardcoded(c.protocolMappers),
    ...names.map((n) => hardcoded(byName(n)?.protocolMappers)));
}

// --- (a) customer owner ---------------------------------------------------------

test("parity-customer-owner: customer role, /customers member, generated password, no fixed customer_id", () => {
  const { res, layer, env, realmEnv } = generate();
  assert.equal(res.status, 0, res.stderr);
  assert.equal(env.PARITY_USERNAME_CUSTOMER_OWNER, "parity-customer-owner");
  assert.ok(meetsPolicy(env.PARITY_PASSWORD_CUSTOMER_OWNER), "realm password policy");
  assert.equal(realmEnv.PARITY_PASSWORD_CUSTOMER_OWNER, env.PARITY_PASSWORD_CUSTOMER_OWNER);
  const u = layer.users.find((x) => x.username === "parity-customer-owner");
  assert.ok(u, "user missing");
  assert.deepEqual(u.realmRoles, ["customer"]);
  assert.deepEqual(u.groups, ["/customers"]);
  assert.deepEqual(u.credentials, [{ type: "password", value: "$(env:PARITY_PASSWORD_CUSTOMER_OWNER)", temporary: false }]);
  assert.ok(!u.attributes?.customer_id, "customer_id is set by the identity link, not by the fixture");
  assert.ok(u.firstName && u.lastName && u.email && u.emailVerified && u.enabled);
});

// --- (b) parity-suite FGAP v2 on /customers ---------------------------------------

test("parity admin permissions: parity-suite gets view-members and manage-members on /customers only", () => {
  const spec = JSON.parse(fs.readFileSync(paritySpecFile, "utf8"));
  assert.equal(spec.realm, "fintechbankx");
  assert.equal(spec.permissions.length, 1);
  const [p] = spec.permissions;
  assert.equal(p.resourceType, "Groups");
  assert.deepEqual(p.groupPaths, ["/customers"]);
  assert.deepEqual([...p.scopes].sort(), ["manage-members", "view-members"]);
  assert.equal(p.decisionStrategy, "UNANIMOUS");
  assert.equal(p.policy.type, "client");
  assert.equal(p.policy.logic, "POSITIVE");
  assert.deepEqual(p.policy.clients, ["parity-suite"]);
  // Own names: the identity repo's permission and policy are upserted by name and must stay untouched.
  const identitySpec = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "admin-permissions.json"), "utf8"));
  for (const q of identitySpec.permissions) {
    assert.notEqual(p.name, q.name);
    assert.notEqual(p.policy.name, q.policy.name);
  }
  assert.match(p.name, /^parity-/);
  assert.match(p.policy.name, /^parity-/);
  const template = JSON.parse(fs.readFileSync(path.join(composeDir, "keycloak", "parity-fixtures.template.json"), "utf8"));
  assert.ok(template.clients.some((c) => c.clientId === "parity-suite"));
});

test("compose: parity-admin-permissions runs the identity script with the parity spec after both imports", () => {
  const s = YAML.parse(fs.readFileSync(composeFile, "utf8")).services;
  const pa = s["parity-admin-permissions"];
  assert.ok(pa, "parity-admin-permissions service missing");
  assert.deepEqual(pa.profiles, ["parity-fixtures"]);
  assert.equal(pa.image, s["admin-permissions"].image);
  assert.deepEqual(pa.depends_on, {
    "admin-permissions": { condition: "service_completed_successfully" },
    "parity-fixtures-import": { condition: "service_completed_successfully" }
  });
  assert.ok(pa.volumes.includes("./.cache/identity-admin:/opt/fbx:ro"), "the identity repo's script, not a copy");
  assert.ok(pa.volumes.some((v) => v.startsWith("./keycloak/parity-admin-permissions.json:") && v.endsWith(":ro")));
  assert.deepEqual(Object.keys(pa.environment).sort(),
    ["KEYCLOAK_GRANTTYPE", "KEYCLOAK_LOGINREALM", "KEYCLOAK_PASSWORD", "KEYCLOAK_URL", "KEYCLOAK_USER"]);
  assert.ok(!("env_file" in pa), "gets only the admin login");
  const cmd = [].concat(pa.command).join(" ");
  assert.match(cmd, /apply-admin-permissions\.mjs --spec \/opt\/parity\/admin-permissions\.json/);
  assert.doesNotMatch(cmd, /--realm/, "scope-mapping reconciliation stays with the identity step");
  assert.deepEqual(s["customer-profile-kyc-service"].depends_on["parity-admin-permissions"],
    { condition: "service_completed_successfully", required: false });
  assert.deepEqual(s.monolith.depends_on["parity-admin-permissions"],
    { condition: "service_completed_successfully", required: false });
});

test("parity fixtures need a realm with fine-grained admin permissions (parity-suite grant)", () => {
  const realm = readRealm();
  delete realm.adminPermissionsEnabled;
  const { res } = generate({ realm });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /adminPermissionsEnabled/);
});

// --- (c) TPP-001 and TPP-002 ----------------------------------------------------------

test("TPP-001 and TPP-002: private_key_jwt, DPoP-bound, TPP-typed, own runtime keys; PARITY_TPP_* kept", () => {
  const realm = currentRealm();
  const { res, layer, env, layerFile } = generate({ realm });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(env.PARITY_TPP_CLIENT_ID, "TPP-001");
  assert.equal(env.PARITY_TPP_OTHER_CLIENT_ID, "TPP-002");
  const k1 = assertPrivateJwk(env.PARITY_TPP_PRIVATE_JWK, "PARITY_TPP_PRIVATE_JWK");
  const k2 = assertPrivateJwk(env.PARITY_TPP_OTHER_PRIVATE_JWK, "PARITY_TPP_OTHER_PRIVATE_JWK");
  assert.notEqual(k1.n, k2.n, "one key per TPP");
  assert.ok(!client(layer, "parity-tpp"), "parity-tpp is now TPP-001");
  const template = realm.clients.find((c) => c.clientId === "of-tpp-conformance-template");
  for (const [id, key] of [["TPP-001", k1], ["TPP-002", k2]]) {
    const c = client(layer, id);
    assert.ok(c, `${id} missing`);
    assertKeyBoundConfidential(c);
    assert.equal(c.attributes["fbx.client-type"], "open-finance-tpp", "falls under the FAPI 2.0 + DPoP client policy");
    assertJwksMatches(c, key);
    assert.deepEqual(audiences(c), audiences(template));
    for (const sc of template.defaultClientScopes) assert.ok(c.defaultClientScopes.includes(sc), `${id} default ${sc}`);
    assert.ok(c.defaultClientScopes.includes("fbx-client-type-open-finance-tpp"), "fbx_client_type in every TPP token");
    assert.ok(rtpAcceptsAsTpp(tokenClaims(layer, realm, c, ["payments"])), `${id} is a TPP for request-to-pay`);
  }
  const text = fs.readFileSync(layerFile, "utf8");
  for (const k of [k1, k2]) assert.ok(!text.includes(k.d), "no private key in the rendered layer");
});

test("TPP clients get the fbx_client_type scope even when the realm's template does not list it", () => {
  const realm = currentRealm();
  const t = realm.clients.find((c) => c.clientId === "of-tpp-conformance-template");
  t.defaultClientScopes = t.defaultClientScopes.filter((x) => x !== "fbx-client-type-open-finance-tpp");
  const { res, layer } = generate({ realm });
  assert.equal(res.status, 0, res.stderr);
  for (const id of ["TPP-001", "TPP-002"]) assert.ok(client(layer, id).defaultClientScopes.includes("fbx-client-type-open-finance-tpp"));
  // An older realm without that scope: nothing to reference.
  const old = generate();
  assert.equal(old.res.status, 0, old.res.stderr);
  for (const id of ["TPP-001", "TPP-002"]) assert.ok(!client(old.layer, id).defaultClientScopes.includes("fbx-client-type-open-finance-tpp"));
});

test("an env generated with parity-tpp moves to TPP-001 and keeps its key", () => {
  const first = generate();
  assert.equal(first.res.status, 0, first.res.stderr);
  // Simulate the previous generator's output.
  const envFile = path.join(first.out, ".env");
  const old = fs.readFileSync(envFile, "utf8").split("\n")
    .filter((l) => !/^PARITY_(TPP_OTHER|CHANNEL)_/.test(l))
    .map((l) => (l.startsWith("PARITY_TPP_CLIENT_ID=") ? "PARITY_TPP_CLIENT_ID=parity-tpp" : l)).join("\n");
  fs.writeFileSync(envFile, old);
  const again = generate({ out: first.out });
  assert.equal(again.res.status, 0, again.res.stderr);
  assert.equal(again.env.PARITY_TPP_CLIENT_ID, "TPP-001");
  assert.equal(again.env.PARITY_TPP_PRIVATE_JWK, first.env.PARITY_TPP_PRIVATE_JWK);
  assert.ok(again.env.PARITY_TPP_OTHER_PRIVATE_JWK && again.env.PARITY_CHANNEL_PRIVATE_JWK);
});

// --- (d) PSU scopes on TPP-001 -----------------------------------------------------------

test("TPP-001 has optional PSU scopes, each a hardcoded customer_id; TPP-002 does not", () => {
  const realm = currentRealm();
  const { res, layer } = generate({ realm });
  assert.equal(res.status, 0, res.stderr);
  const tpp1 = client(layer, "TPP-001");
  const tpp2 = client(layer, "TPP-002");
  for (const [name, customerId] of Object.entries(PSU_SCOPES)) {
    const sc = scope(layer, name);
    assert.ok(sc, `${name} missing`);
    assert.equal(sc.protocol, "openid-connect");
    assert.equal(sc.protocolMappers.length, 1);
    const [m] = sc.protocolMappers;
    assert.equal(m.protocolMapper, "oidc-hardcoded-claim-mapper");
    assert.equal(m.config["claim.name"], "customer_id");
    assert.equal(m.config["claim.value"], customerId);
    assert.equal(m.config["access.token.claim"], "true");
    assert.equal(m.config["jsonType.label"], "String");
    assert.ok(tpp1.optionalClientScopes.includes(name), `TPP-001 optional ${name}`);
    assert.ok(!tpp1.defaultClientScopes.includes(name), `${name} only when requested`);
    assert.ok(!tpp2.optionalClientScopes.includes(name) && !tpp2.defaultClientScopes.includes(name), `TPP-002 never ${name}`);
    assert.equal(tokenClaims(layer, realm, tpp1, [name]).customer_id, customerId);
  }
  assert.equal(tokenClaims(layer, realm, tpp1, []).customer_id, undefined, "no PSU unless asked");
});

// --- (e) API scopes on both TPPs --------------------------------------------------------

test("API scopes are optional on both TPPs; the layer defines only the ones the realm lacks", () => {
  const realm = currentRealm();
  const { res, layer } = generate({ realm });
  assert.equal(res.status, 0, res.stderr);
  for (const id of ["TPP-001", "TPP-002"]) {
    const c = client(layer, id);
    for (const sc of API_SCOPES) {
      assert.ok(c.optionalClientScopes.includes(sc), `${id} optional ${sc}`);
      assert.ok(!c.defaultClientScopes.includes(sc), `${id} ${sc} not default`);
    }
  }
  assert.ok(!scope(layer, "payments"), "the realm's payments scope is reused, never redefined");
  assert.ok(!scope(layer, "read_accounts"), "the realm's read_accounts scope is reused");
  for (const sc of API_SCOPES.filter((x) => !["payments", "read_accounts"].includes(x))) {
    const def = scope(layer, sc);
    assert.ok(def, `${sc} defined by the layer`);
    assert.equal(def.attributes["include.in.token.scope"], "true", `${sc} appears in the token scope`);
    assert.deepEqual(def.protocolMappers ?? [], [], `${sc} grants a scope value only`);
  }
  // An older realm without any of them: all seven come from the layer.
  const old = generate();
  assert.equal(old.res.status, 0, old.res.stderr);
  for (const sc of API_SCOPES) assert.ok(scope(old.layer, sc), `${sc} defined for an older realm`);
});

// --- (f) first-party channel client -------------------------------------------------------

test("parity-channel: confidential key-bound stand-in for fintechbankx-mobile that request-to-pay refuses", () => {
  const realm = currentRealm();
  const { res, layer, env, layerFile } = generate({ realm });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(env.PARITY_CHANNEL_CLIENT_ID, "parity-channel");
  const key = assertPrivateJwk(env.PARITY_CHANNEL_PRIVATE_JWK, "PARITY_CHANNEL_PRIVATE_JWK");
  assert.notEqual(key.n, JSON.parse(env.PARITY_TPP_PRIVATE_JWK).n);
  const c = client(layer, "parity-channel");
  assert.ok(c, "parity-channel missing");
  assertKeyBoundConfidential(c);
  assertJwksMatches(c, key);
  // No realm client policy may match: not a TPP, not a public client, not a service.
  assert.ok(!["open-finance-tpp", "first-party-public", "service", "staff-sso"].includes(c.attributes["fbx.client-type"]));
  // fintechbankx-mobile semantics: its audiences and default scopes, and the client type it carries in the realm.
  const mobile = realm.clients.find((x) => x.clientId === "fintechbankx-mobile");
  assert.deepEqual(audiences(c), audiences(mobile));
  assert.ok(audiences(c).includes("svc-pay-request-to-pay"));
  for (const sc of mobile.defaultClientScopes) assert.ok(c.defaultClientScopes.includes(sc), `default ${sc}`);
  assert.equal(hardcoded(c.protocolMappers).fbx_client_type, mobile.attributes["fbx.client-type"]);
  assert.ok(!c.defaultClientScopes.includes("fbx-client-type-open-finance-tpp"));
  // PSU scope CUST-12345678, and payments so a refusal is about the client, not the scope.
  const psu = scope(layer, "parity-psu-CUST-12345678");
  assert.equal(hardcoded(psu.protocolMappers).customer_id, "CUST-12345678");
  assert.ok(c.optionalClientScopes.includes("parity-psu-CUST-12345678"));
  assert.ok(c.optionalClientScopes.includes("payments"));
  const claims = tokenClaims(layer, realm, c, ["parity-psu-CUST-12345678", "payments"]);
  assert.equal(claims.azp, "parity-channel");
  assert.equal(claims.customer_id, "CUST-12345678");
  assert.equal(rtpAcceptsAsTpp(claims), false, "request-to-pay refuses it as a channel");
  // The real mobile client is never redefined.
  assert.ok(!client(layer, "fintechbankx-mobile"));
  assert.ok(!fs.readFileSync(layerFile, "utf8").includes(key.d));
});

test("parity-channel needs the realm's fintechbankx-mobile client", () => {
  const realm = readRealm();
  realm.clients = realm.clients.filter((c) => c.clientId !== "fintechbankx-mobile");
  const { res } = generate({ realm });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /fintechbankx-mobile/);
});

test("rendered layer: four parity clients, every placeholder supplied, no service client redefined", () => {
  const { res, layer, layerFile, realmEnv } = generate({ realm: currentRealm() });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(layer.clients.map((c) => c.clientId).sort(), ["TPP-001", "TPP-002", "parity-channel", "parity-suite"]);
  for (const m of fs.readFileSync(layerFile, "utf8").matchAll(/\$\(env:([A-Z0-9_]+)\)/g)) assert.ok(m[1] in realmEnv, m[1]);
  for (const k of Object.keys(realmEnv)) assert.doesNotMatch(k, /PRIVATE_JWK/, "private keys never reach realm.env");
});

test("no generated private key of any parity client is tracked", () => {
  const { res, env } = generate();
  assert.equal(res.status, 0, res.stderr);
  const repo = path.resolve(composeDir, "..");
  const tracked = run("git", ["ls-files", "-z"], { cwd: repo }).stdout.split("\0").filter(Boolean);
  const secrets = ["PARITY_TPP_PRIVATE_JWK", "PARITY_TPP_OTHER_PRIVATE_JWK", "PARITY_CHANNEL_PRIVATE_JWK"]
    .map((n) => JSON.parse(env[n]).d);
  const passwords = Object.entries(env).filter(([k]) => k.startsWith("PARITY_PASSWORD_")).map(([, v]) => v);
  for (const f of tracked) {
    const file = path.join(repo, f);
    if (!fs.existsSync(file) || fs.statSync(file).size > 2_000_000) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const s of [...secrets, ...passwords]) assert.ok(!text.includes(s), `${f} holds a generated credential`);
  }
});

// --- reset between parity runs ----------------------------------------------------------

test("fbx-local.sh reset drops Keycloak state and the service databases but keeps Kafka and the env files", () => {
  const bin = tmp("fbx-stub-");
  const log = path.join(bin, "docker.log");
  fs.writeFileSync(path.join(bin, "docker"), [
    "#!/usr/bin/env bash",
    `printf '%s\\n' "$*" >> "${log}"`,
    'case " $* " in',
    '  *" config --services "*) printf "%s\\n" postgres kafka topic-init keycloak realm-import admin-permissions parity-fixtures-import parity-admin-permissions loan-lifecycle-service monolith redis ;;',
    "esac"
  ].join("\n") + "\n", { mode: 0o755 });
  const envBefore = fs.existsSync(path.join(composeDir, ".env")) ? fs.readFileSync(path.join(composeDir, ".env"), "utf8") : null;
  const res = run("bash", [path.join(composeDir, "fbx-local.sh"), "reset"], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(res.status, 0, res.stderr);
  const calls = fs.readFileSync(log, "utf8").trim().split("\n");
  const rm = calls.find((c) => / rm /.test(` ${c} `));
  assert.ok(rm, calls.join("\n"));
  assert.match(rm, /rm -s -f -v/);
  const removed = rm.slice(rm.indexOf(" -v ") + 4).split(" ");
  for (const svc of ["postgres", "keycloak", "realm-import", "admin-permissions", "parity-fixtures-import",
    "parity-admin-permissions", "topic-init", "loan-lifecycle-service", "monolith", "redis"]) assert.ok(removed.includes(svc), `${svc} removed`);
  assert.ok(!removed.includes("kafka"), "Kafka broker kept");
  assert.ok(calls.some((c) => /^volume rm .*fintechbankx-local_postgres-data/.test(c)), "service databases dropped");
  assert.ok(!calls.some((c) => / down( |$)/.test(c)), "not a full down");
  const envAfter = fs.existsSync(path.join(composeDir, ".env")) ? fs.readFileSync(path.join(composeDir, ".env"), "utf8") : null;
  assert.equal(envAfter, envBefore, "env files untouched");
});

test("README documents resetting between parity runs and the new actors", () => {
  const readme = fs.readFileSync(path.join(composeDir, "README.md"), "utf8");
  const i = readme.indexOf("## Reset between parity runs");
  assert.ok(i > 0, "section missing");
  const section = readme.slice(i, readme.indexOf("\n## ", i + 5) > 0 ? readme.indexOf("\n## ", i + 5) : undefined);
  assert.match(section, /fbx-local\.sh down/);
  assert.match(section, /-v/);
  assert.match(section, /fbx-local\.sh reset/);
  for (const v of ["PARITY_USERNAME_CUSTOMER_OWNER", "PARITY_TPP_OTHER_CLIENT_ID", "PARITY_TPP_OTHER_PRIVATE_JWK",
    "PARITY_CHANNEL_CLIENT_ID", "PARITY_CHANNEL_PRIVATE_JWK", "parity-psu-PSU-001", "parity-psu-CUST-12345678"]) {
    assert.ok(readme.includes(v), `README mentions ${v}`);
  }
  assert.match(readme, /azp/);
});
