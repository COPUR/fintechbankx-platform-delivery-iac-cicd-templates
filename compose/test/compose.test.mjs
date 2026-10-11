// Tests for the shared local/ephemeral runtime under compose/ and for the
// ephemeral-env reusable workflow. Docker-dependent and PostgreSQL-dependent
// cases skip (with a reason) when the tool is not available.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const here = path.dirname(fileURLToPath(import.meta.url));
const composeDir = path.resolve(here, "..");
const repo = path.resolve(composeDir, "..");
const fixtures = path.join(here, "fixtures");
const initEnv = path.join(composeDir, "scripts", "init-env.sh");
const fetchAssets = path.join(composeDir, "scripts", "fetch-platform-assets.sh");
const composeFile = path.join(composeDir, "docker-compose.yml");
const servicesTsv = path.join(composeDir, "services.tsv");
const pgInit = path.join(composeDir, "postgres", "init", "10-service-databases.sh");
const sqlFixtures = path.join(composeDir, "scripts", "apply-sql-fixtures.sh");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fbx-compose-"));
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const parseEnv = (file) => Object.fromEntries(
  fs.readFileSync(file, "utf8").split("\n").filter((l) => l && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const parseServices = (text) => text.split("\n")
  .filter((l) => l && !l.startsWith("#"))
  .map((l) => {
    const cols = l.split("\t");
    const [key, serviceId, profiles, database, schema, role, credVar, imageVar, hostPort, store] = cols;
    return { key, serviceId, profiles: profiles.split(","), database, schema, role, credVar, imageVar, hostPort, store, columns: cols.length };
  });
const services = () => parseServices(fs.readFileSync(servicesTsv, "utf8"));
const postgresRows = () => services().filter((s) => s.store === "postgresql");
// A services.tsv with the real rows plus MongoDB rows (none is in the real
// registry yet), for the scripts that must tell the two stores apart.
const MONGO_FIXTURE_ROWS = [
  ["fixture-docs-service", "svc-of-fixture-docs", "openfinance,services", "db_of_fixture_docs_local", "-",
    "fixture_docs_app", "FBX_DB_CRED_OF_FIXTURE_DOCS", "FBX_IMAGE_OF_FIXTURE_DOCS", "18990", "mongodb"],
  ["fixture-ledger-service", "svc-of-fixture-ledger", "openfinance,services", "db_of_fixture_ledger_local", "-",
    "fixture_ledger_app", "FBX_DB_CRED_OF_FIXTURE_LEDGER", "FBX_IMAGE_OF_FIXTURE_LEDGER", "18991", "mongodb"]
];
function servicesWithMongo() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fbx-services-")), "services.tsv");
  fs.writeFileSync(file, fs.readFileSync(servicesTsv, "utf8") + MONGO_FIXTURE_ROWS.map((r) => r.join("\t")).join("\n") + "\n");
  return file;
}
// A stand-in for psql / mongosh on PATH that records each call (arguments and
// the named environment variables) as one JSON line, so the init scripts can
// be tested without a database server.
function recordingStub(name, envNames = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fbx-stub-${name}-`));
  const log = path.join(dir, "calls.jsonl");
  fs.writeFileSync(path.join(dir, name), [
    "#!/usr/bin/env node",
    "const fs = require('fs');",
    `const env = Object.fromEntries(${JSON.stringify(envNames)}.map((n) => [n, process.env[n] ?? null]));`,
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), env }) + "\\n");`,
    ""
  ].join("\n"), { mode: 0o755 });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { dir, calls };
}
const SERVICE_KEYS = ["loan-lifecycle-service", "payment-initiation-settlement-service", "customer-profile-kyc-service",
  "risk-decisioning-service", "compliance-evidence-service"];
const MEM_LIMIT = "${FBX_SERVICE_MEM_LIMIT:-768m}";
const required = (name) => `\${${name}:?run compose/fbx-local.sh init}`;
const oidcSecretVar = (serviceId) => `FBX_OIDC_SECRET_${serviceId.toUpperCase().replaceAll("-", "_")}`;
const placeholders = (realmFile) => [...new Set(
  [...fs.readFileSync(realmFile, "utf8").matchAll(/\$\(env:([A-Z0-9_]+)\)/g)].map((m) => m[1]))];
const dockerCompose = run("docker", ["compose", "version"]).status === 0;

function generate(realm = path.join(fixtures, "realm-minimal.json")) {
  const out = tmp();
  const res = run("bash", [initEnv, "--out-dir", out, "--realm", realm]);
  return { out, res };
}

// --- secrets generation ---------------------------------------------------

test("init-env generates every credential, all random, mode 600", () => {
  const { out, res } = generate();
  assert.equal(res.status, 0, res.stderr);
  const env = parseEnv(path.join(out, ".env"));
  for (const key of ["POSTGRES_SUPERUSER_CRED", "KC_ADMIN_USER", "KC_ADMIN_CRED", "REDIS_CRED", "MONGO_ROOT_CRED"]) {
    assert.ok(env[key], `${key} missing`);
  }
  for (const s of services()) assert.ok(env[s.credVar], `${s.credVar} missing for ${s.key}`);
  const secrets = Object.entries(env).filter(([k]) => /CRED|SECRET/.test(k)).map(([, v]) => v);
  for (const v of secrets) assert.match(v, /^[A-Za-z0-9]{32,}$/);
  assert.equal(new Set(secrets).size, secrets.length, "secret values must be unique");
  for (const f of [".env", "realm.env"]) {
    assert.equal(fs.statSync(path.join(out, f)).mode & 0o777, 0o600, `${f} must be mode 600`);
  }
});

test("init-env supplies every realm placeholder with dev-only values", () => {
  const realm = path.join(fixtures, "realm-minimal.json");
  const { out, res } = generate(realm);
  assert.equal(res.status, 0, res.stderr);
  const env = parseEnv(path.join(out, "realm.env"));
  for (const name of placeholders(realm)) assert.ok(name in env, `${name} not supplied`);
  assert.match(env.FBX_OIDC_SECRET_SVC_LN_LOAN_LIFECYCLE, /^[A-Za-z0-9]{32,}$/);
  assert.match(env.FBX_WEB_REDIRECT_URI, /^http:\/\/localhost/);
  // Staff channel (identity client fintechbankx-staff-web): its own localhost origin.
  assert.equal(env.FBX_STAFF_WEB_REDIRECT_URI, "http://localhost:3002/auth/callback");
  assert.equal(env.FBX_STAFF_WEB_ORIGIN, "http://localhost:3002");
  assert.equal(env.FBX_STAFF_WEB_POST_LOGOUT_REDIRECT_URI, "http://localhost:3002/");
  assert.notEqual(env.FBX_STAFF_WEB_ORIGIN, env.FBX_WEB_ORIGIN, "staff and customer web apps are separate origins");
  assert.equal(env.LDAP_START_TLS, "false");
  assert.equal(env.KEYCLOAK_URL, "http://keycloak:8080");
  assert.equal(env.IMPORT_VARSUBSTITUTION_ENABLED, "true");
});

test("init-env keeps existing values and a fresh run differs", () => {
  const { out } = generate();
  const before = fs.readFileSync(path.join(out, ".env"), "utf8");
  const again = run("bash", [initEnv, "--out-dir", out, "--realm", path.join(fixtures, "realm-minimal.json")]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(fs.readFileSync(path.join(out, ".env"), "utf8"), before);
  const other = generate().out;
  assert.notEqual(parseEnv(path.join(other, ".env")).KC_ADMIN_CRED, parseEnv(path.join(out, ".env")).KC_ADMIN_CRED);
});

test("init-env generates a credential for the rows of either store and one Mongo root credential", () => {
  const out = tmp();
  const res = run("bash", [initEnv, "--out-dir", out, "--realm", path.join(fixtures, "realm-minimal.json"), "--services", servicesWithMongo()]);
  assert.equal(res.status, 0, res.stderr);
  const env = parseEnv(path.join(out, ".env"));
  for (const row of MONGO_FIXTURE_ROWS) {
    assert.match(env[row[6]], /^[A-Za-z0-9]{32,}$/, `${row[6]} for the mongodb row ${row[0]}`);
    assert.match(env[oidcSecretVar(row[1])], /^[A-Za-z0-9]{32,}$/, `OIDC client credential of ${row[1]}`);
  }
  assert.match(env.MONGO_ROOT_CRED, /^[A-Za-z0-9]{32,}$/);
});

test("init-env refuses a realm placeholder it does not know", () => {
  const { res } = generate(path.join(fixtures, "realm-unknown-placeholder.json"));
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /FBX_UNKNOWN_PLACEHOLDER/);
});

// --- platform assets --------------------------------------------------------

function fakeRepos(realmFixture = "realm-minimal.json", { adminPermissions = true } = {}) {
  const root = tmp();
  fs.mkdirSync(path.join(root, "identity", "realm"), { recursive: true });
  fs.copyFileSync(path.join(fixtures, realmFixture), path.join(root, "identity", "realm", "fintechbankx-realm.json"));
  if (adminPermissions) {
    fs.copyFileSync(path.join(fixtures, "admin-permissions.json"), path.join(root, "identity", "realm", "admin-permissions.json"));
    fs.mkdirSync(path.join(root, "identity", "scripts", "realm"), { recursive: true });
    fs.writeFileSync(path.join(root, "identity", "scripts", "realm", "apply-admin-permissions.mjs"), "#!/usr/bin/env node\nconsole.log('ok');\n");
  }
  fs.mkdirSync(path.join(root, "kafka", "topics", "generated"), { recursive: true });
  fs.mkdirSync(path.join(root, "kafka", "scripts", "kafka"), { recursive: true });
  fs.copyFileSync(path.join(fixtures, "topics.tsv"), path.join(root, "kafka", "topics", "generated", "topics.tsv"));
  fs.writeFileSync(path.join(root, "kafka", "scripts", "kafka", "create-topics.sh"), "#!/usr/bin/env bash\necho ok\n");
  return root;
}

test("fetch-platform-assets copies realm and topic catalog from local checkouts", () => {
  const root = fakeRepos();
  const cache = tmp();
  const res = run("bash", [fetchAssets, "--cache-dir", cache], {
    env: { ...process.env, FBX_IDENTITY_SOURCE: path.join(root, "identity"), FBX_KAFKA_SOURCE: path.join(root, "kafka") }
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cache, "identity", "fintechbankx-realm.json"), "utf8")).realm, "fintechbankx");
  assert.match(fs.readFileSync(path.join(cache, "kafka", "topics", "generated", "topics.tsv"), "utf8"), /^evt\./m);
  assert.ok(fs.existsSync(path.join(cache, "kafka", "scripts", "kafka", "create-topics.sh")));
});

const fetchFrom = (root, cache) => run("bash", [fetchAssets, "--cache-dir", cache], {
  env: { ...process.env, FBX_IDENTITY_SOURCE: path.join(root, "identity"), FBX_KAFKA_SOURCE: path.join(root, "kafka") }
});

test("fetch-platform-assets copies the admin-permissions step outside the config-cli import glob", () => {
  const cache = tmp();
  const res = fetchFrom(fakeRepos(), cache);
  assert.equal(res.status, 0, res.stderr);
  const admin = path.join(cache, "identity-admin");
  assert.equal(JSON.parse(fs.readFileSync(path.join(admin, "admin-permissions.json"), "utf8")).realm, "fintechbankx");
  assert.ok(fs.existsSync(path.join(admin, "apply-admin-permissions.mjs")));
  // realm-import reads file:/config/*.json from .cache/identity: only the realm may be there.
  assert.deepEqual(fs.readdirSync(path.join(cache, "identity")).filter((f) => f.endsWith(".json")), ["fintechbankx-realm.json"]);
});

test("fetch-platform-assets fails when the realm enables admin permissions but the step is missing", () => {
  const res = fetchFrom(fakeRepos("realm-minimal.json", { adminPermissions: false }), tmp());
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /admin-permissions/);
});

test("fetch-platform-assets skips the admin-permissions step for a realm without adminPermissionsEnabled", () => {
  const root = fakeRepos("realm-minimal.json", { adminPermissions: false });
  const realmFile = path.join(root, "identity", "realm", "fintechbankx-realm.json");
  const realm = JSON.parse(fs.readFileSync(realmFile, "utf8"));
  delete realm.adminPermissionsEnabled;
  fs.writeFileSync(realmFile, JSON.stringify(realm));
  const cache = tmp();
  fs.mkdirSync(path.join(cache, "identity-admin"), { recursive: true });
  fs.writeFileSync(path.join(cache, "identity-admin", "admin-permissions.json"), "{}");
  const res = fetchFrom(root, cache);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(!fs.existsSync(path.join(cache, "identity-admin", "admin-permissions.json")), "a stale spec from an earlier ref is removed");
});

test("fetch-platform-assets rejects a realm that is not fintechbankx", () => {
  const root = fakeRepos("realm-wrong-name.json");
  const res = run("bash", [fetchAssets, "--cache-dir", tmp()], {
    env: { ...process.env, FBX_IDENTITY_SOURCE: path.join(root, "identity"), FBX_KAFKA_SOURCE: path.join(root, "kafka") }
  });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /expected realm "fintechbankx"/);
});

// --- compose definition -----------------------------------------------------

const composeDoc = () => YAML.parse(fs.readFileSync(composeFile, "utf8"));

test("services.tsv follows the database-per-service conventions of the service repos", () => {
  // Values taken from each service repo's application.yml (spring.flyway.schemas, datasource).
  const expected = {
    "loan-lifecycle-service": ["svc-ln-loan-lifecycle", "db_ln_loan_lifecycle_local", "sc_ln_loan_lifecycle", "loan_lifecycle_app"],
    "payment-initiation-settlement-service": ["svc-pay-initiation-settlement", "db_pay_initiation_settlement_local", "sc_pay_initiation_settlement", "payment_initiation_app"],
    "customer-profile-kyc-service": ["svc-cus-profile-kyc", "db_cus_profile_kyc_local", "sc_cus_profile_kyc", "customer_profile_app"],
    "risk-decisioning-service": ["svc-rsk-decisioning", "db_rsk_decisioning_local", "sc_rsk_decisioning", "risk_decisioning_app"],
    "compliance-evidence-service": ["svc-cmp-evidence", "db_cmp_evidence_local", "sc_cmp_evidence", "compliance_evidence_app"]
  };
  const rows = Object.fromEntries(services().map((s) => [s.key, s]));
  for (const [key, [id, db, schema, role]] of Object.entries(expected)) {
    assert.ok(rows[key], `${key} missing from services.tsv`);
    assert.deepEqual([rows[key].serviceId, rows[key].database, rows[key].schema, rows[key].role], [id, db, schema, role]);
  }
  const dbs = services().map((s) => s.database);
  assert.equal(new Set(dbs).size, dbs.length, "one database per service");
});

test("services.tsv: ten columns, a store per row (postgresql or mongodb) and a unique host port", () => {
  const header = fs.readFileSync(servicesTsv, "utf8").split("\n").find((l) => l.startsWith("# key\t"));
  assert.ok(header, "column header line missing");
  assert.deepEqual(header.slice(2).split("\t"),
    ["key", "service_id", "profiles", "database", "schema", "app_role", "credential_var", "image_var", "host_port", "store"]);
  for (const s of services()) {
    assert.equal(s.columns, 10, `${s.key}: ${s.columns} columns`);
    assert.ok(["postgresql", "mongodb"].includes(s.store), `${s.key}: store ${s.store}`);
    if (s.store === "mongodb") assert.equal(s.schema, "-", `${s.key}: a MongoDB row has no schema`);
    assert.match(s.hostPort, /^\d{4,5}$/, `${s.key}: host port ${s.hostPort}`);
  }
  // Every row of the registry today is a PostgreSQL service.
  for (const key of [...SERVICE_KEYS, "monolith"]) assert.equal(services().find((s) => s.key === key).store, "postgresql", key);
  const ports = services().map((s) => s.hostPort);
  assert.equal(new Set(ports).size, ports.length, `host ports must be unique: ${ports}`);
});

test("every service in services.tsv is wired in compose with its own database, role, credential, image, profiles and port", () => {
  const doc = composeDoc();
  for (const s of services()) {
    const svc = doc.services[s.key];
    assert.ok(svc, `compose service ${s.key} missing`);
    assert.deepEqual([...svc.profiles].sort(), [...s.profiles].sort(), `${s.key} profiles`);
    const env = svc.environment;
    if (s.store === "postgresql") {
      const url = env.DB_URL ?? env.SPRING_DATASOURCE_URL;
      assert.equal(url, `jdbc:postgresql://postgres:5432/${s.database}`, `${s.key} database`);
      assert.equal(env.DB_USERNAME ?? env.SPRING_DATASOURCE_USERNAME, s.role, `${s.key} role`);
      assert.equal(env.SPRING_DATASOURCE_PASSWORD, required(s.credVar), `${s.key} credential`);
      assert.equal(env.MONGODB_URI, undefined, `${s.key} is not a MongoDB service`);
    } else {
      assert.equal(env.MONGODB_URI, `mongodb://${s.role}:${required(s.credVar)}@mongo:27017/${s.database}`, `${s.key} MongoDB`);
      for (const k of ["DB_URL", "SPRING_DATASOURCE_URL", "SPRING_DATASOURCE_PASSWORD"]) assert.equal(env[k], undefined, `${s.key}.${k}`);
    }
    assert.match(svc.image, new RegExp(`^\\$\\{${s.imageVar}:-[^}]+\\}$`));
    assert.deepEqual(svc.ports, [`127.0.0.1:${s.hostPort}:8080`], `${s.key} port`);
  }
});

test("every service in services.tsv runs only the local profile and sets neither a TLS off switch nor DB_SSL_ROOT_CERT", () => {
  // The stack runs Kafka on PLAINTEXT and PostgreSQL without sslmode=verify-full.
  // The service-side TLS assertion (Kafka repo SERVICE_CLIENT_CONFIGURATION.md,
  // chart README "Service-side TLS assertion") refuses both unless the Spring
  // profile local is active. Loan and payment initiation-settlement switch it
  // off in application-local.yml (fintechbankx.tls.enforce: false); customer,
  // risk and compliance ship no local profile file and turn their guards off
  // by the profile name (StartupAssertions), compliance its runtime role guard
  // too. Never through an environment variable. DB_SSL_ROOT_CERT is what those
  // guards require while they are on; the stack never sets it.
  const doc = composeDoc();
  for (const s of services().filter((x) => x.key !== "monolith")) {
    const env = doc.services[s.key].environment;
    assert.equal(env.SPRING_PROFILES_ACTIVE, "local", `${s.key} must set SPRING_PROFILES_ACTIVE=local and no other profile`);
    for (const k of Object.keys(env)) {
      assert.doesNotMatch(k, /^FINTECHBANKX[._-]?TLS/i, `${s.key}.${k}: the off switch comes from the local profile only`);
      assert.doesNotMatch(
        k,
        /^DB[._-]?SSL[._-]?ROOT[._-]?CERT$/i,
        `${s.key}.${k}: the stack has no database CA bundle to point DB_SSL_ROOT_CERT at`,
      );
    }
  }
});

test("postgres gets the credential of every postgresql row and mongo-init that of every mongodb row, nothing else", () => {
  const s = composeDoc().services;
  const credKeys = (env) => Object.keys(env ?? {}).filter((k) => k.startsWith("FBX_DB_CRED_")).sort();
  const pg = services().filter((r) => r.store === "postgresql");
  const mongo = services().filter((r) => r.store === "mongodb");
  assert.deepEqual(credKeys(s.postgres.environment), pg.map((r) => r.credVar).sort());
  for (const r of pg) assert.equal(s.postgres.environment[r.credVar], required(r.credVar));
  assert.ok(s["mongo-init"], "mongo-init service missing");
  assert.deepEqual(credKeys(s["mongo-init"].environment), mongo.map((r) => r.credVar).sort());
  for (const r of mongo) assert.equal(s["mongo-init"].environment[r.credVar], required(r.credVar));
});

test("mongo: MongoDB 7.0 pinned by full version tag, root credential from init-env, users from the re-runnable mongo-init one-shot", () => {
  const s = composeDoc().services;
  const m = s.mongo;
  assert.ok(m, "mongo service missing");
  assert.match(m.image, /^mongo:7\.0\.\d+$/, "the 7.0 line the open-finance services' CI uses, full version tag");
  assert.deepEqual([...m.profiles].sort(), ["openfinance", "services"]);
  assert.equal(m.environment.MONGO_INITDB_ROOT_PASSWORD, required("MONGO_ROOT_CRED"));
  assert.match(String(m.environment.MONGO_INITDB_ROOT_USERNAME), /^[a-z][a-z0-9-]+$/);
  for (const p of m.ports ?? []) assert.match(String(p), /^127\.0\.0\.1:\d+:27017$/);
  // Healthy only once mongod listens on the network: the image's first-start
  // init runs a temporary mongod on 127.0.0.1 only, which must not count.
  const hc = [].concat(m.healthcheck.test).join(" ");
  assert.match(hc, /mongosh/);
  assert.match(hc, /--host mongo\b/);
  assert.match(hc, /ping/);
  const init = s["mongo-init"];
  assert.equal(init.image, m.image);
  assert.deepEqual([...init.profiles].sort(), ["openfinance", "services"]);
  assert.deepEqual(init.depends_on, { mongo: { condition: "service_healthy" } });
  assert.equal(init.restart, "no");
  assert.equal(init.ports, undefined);
  assert.equal(init.environment.MONGO_ROOT_USER, m.environment.MONGO_INITDB_ROOT_USERNAME);
  assert.equal(init.environment.MONGO_ROOT_CRED, required("MONGO_ROOT_CRED"));
  assert.equal(init.environment.FBX_SERVICES_TSV, "/fbx/services.tsv");
  assert.ok(init.volumes.includes("./services.tsv:/fbx/services.tsv:ro"));
  assert.ok(init.volumes.includes("./mongo/init:/fbx/mongo-init:ro"));
  assert.match([].concat(init.entrypoint ?? [], init.command ?? []).join(" "), /^bash \/fbx\/mongo-init\/10-service-databases\.sh$/);
  // No PostgreSQL service waits for MongoDB.
  for (const key of SERVICE_KEYS) assert.equal(s[key].depends_on.mongo, undefined, key);
});

// --- the five services: what they read at the r8 heads ------------------------

test("customer, risk and compliance migrate in a one-shot of their own image before they start; loan and initiation migrate in-process", () => {
  // At the r8 heads customer, risk and compliance only validate the Flyway
  // history (<context>.database.flyway=validate) and refuse an empty database;
  // the image migrates when its first argument is "migrate" (DatabaseMigration,
  // which adds the db-migrate profile to the active local one).
  const s = composeDoc().services;
  const migrating = Object.keys(s).filter((k) => k.endsWith("-migrate")).sort();
  assert.deepEqual(migrating, ["compliance-evidence-service-migrate", "customer-profile-kyc-service-migrate",
    "risk-decisioning-service-migrate"]);
  for (const key of ["customer-profile-kyc-service", "risk-decisioning-service", "compliance-evidence-service"]) {
    const svc = s[key];
    const job = s[`${key}-migrate`];
    assert.equal(job.image, svc.image, `${key}-migrate runs the service image`);
    assert.deepEqual(job.command, ["migrate"], `${key}-migrate`);
    assert.equal(job.entrypoint, undefined, `${key}-migrate keeps the image entrypoint`);
    assert.deepEqual([...job.profiles].sort(), [...svc.profiles].sort(), `${key}-migrate profiles`);
    assert.equal(job.restart, "no");
    assert.equal(job.ports, undefined);
    assert.equal(job.healthcheck, undefined);
    assert.deepEqual(job.depends_on, { postgres: { condition: "service_healthy" } });
    for (const k of ["SPRING_PROFILES_ACTIVE", "DB_URL", "DB_USERNAME", "SPRING_DATASOURCE_PASSWORD"]) {
      assert.equal(job.environment[k], svc.environment[k], `${key}-migrate ${k}`);
    }
    assert.equal(job.mem_limit, MEM_LIMIT, `${key}-migrate memory limit`);
    assert.deepEqual(svc.depends_on[`${key}-migrate`], { condition: "service_completed_successfully" }, `${key} waits for its migration`);
  }
});

test("loan and initiation get outbound client-credentials tokens from keycloak:8080; no service gets names it does not read", () => {
  const s = composeDoc().services;
  for (const key of ["loan-lifecycle-service", "payment-initiation-settlement-service"]) {
    const env = s[key].environment;
    assert.equal(env.SERVICE_CLIENT_SECRET, required(oidcSecretVar(env.FINTECHBANKX_SERVICE_ID)), `${key} SERVICE_CLIENT_SECRET`);
    assert.equal(env.OIDC_TOKEN_URI, "http://keycloak:8080/realms/fintechbankx/protocol/openid-connect/token", `${key} OIDC_TOKEN_URI`);
  }
  for (const key of SERVICE_KEYS) {
    const env = s[key].environment;
    for (const k of Object.keys(env)) {
      assert.ok(!["OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"].includes(k), `${key}.${k}: no service reads it (SERVICE_CLIENT_* is the client-credentials input)`);
      assert.doesNotMatch(k, /^OTEL_/, `${key}.${k}: Spring Boot 3.3.6 reads no OTEL_* variable and no service maps one`);
    }
    assert.equal(env.OIDC_ISSUER_URI, "http://localhost:8180/realms/fintechbankx");
    assert.equal(env.OIDC_JWK_SET_URI, "http://keycloak:8080/realms/fintechbankx/protocol/openid-connect/certs");
  }
});

test("loan starts with the http customer-credit adapter and a ledger currency", () => {
  // application.yml: loan.customer-credit.adapter has an empty default, which
  // matches neither adapter bean, and ledger-currency has none (required by http).
  const env = composeDoc().services["loan-lifecycle-service"].environment;
  assert.equal(env.CUSTOMER_CREDIT_ADAPTER, "http");
  assert.equal(env.CUSTOMER_CREDIT_LEDGER_CURRENCY, "USD", "the currency of the customer service's parity seed");
  assert.equal(env.CUSTOMER_SERVICE_BASE_URL, "http://customer-profile-kyc-service:8080");
});

test("initiation starts with a default currency, in-memory accounts and its callees on the compose network", () => {
  const s = composeDoc().services;
  const env = s["payment-initiation-settlement-service"].environment;
  assert.equal(env.PAYMENT_DEFAULT_CURRENCY, s["loan-lifecycle-service"].environment.CUSTOMER_CREDIT_LEDGER_CURRENCY,
    "one currency for the stack");
  assert.equal(env.ACCOUNTS_ADAPTER, "in-memory", "no accounts service exists (decision D3)");
  assert.equal(env.RISK_SERVICE_BASE_URL, "http://risk-decisioning-service:8080");
  assert.equal(env.COMPLIANCE_SERVICE_BASE_URL, "http://compliance-evidence-service:8080");
  assert.equal(env.CUSTOMER_SERVICE_BASE_URL, "http://customer-profile-kyc-service:8080");
});

test("every compose-network URL a service gets names a service that each of the caller's profiles also starts", () => {
  const s = composeDoc().services;
  for (const key of SERVICE_KEYS) {
    for (const [k, v] of Object.entries(s[key].environment)) {
      const m = /^https?:\/\/([a-z0-9-]+):8080(\/|$)/.exec(String(v));
      if (!m || m[1] === "keycloak") continue;
      const callee = s[m[1]];
      assert.ok(callee, `${key}.${k}: ${m[1]} is not a compose service`);
      for (const p of s[key].profiles) {
        assert.ok(callee.profiles.includes(p), `${key}.${k}: profile ${p} starts ${key} but not ${m[1]}`);
      }
    }
  }
});

test("customer links identities through the Keycloak admin API as its own realm client", () => {
  const env = composeDoc().services["customer-profile-kyc-service"].environment;
  assert.equal(env.IDENTITY_ADMIN_ENABLED, "true");
  assert.equal(env.KEYCLOAK_BASE_URL, "http://keycloak:8080");
  // The client id and realm keep their defaults (svc-cus-profile-kyc, fintechbankx);
  // its FGAP permission on /customers comes from admin-permissions, which customer waits for.
  for (const k of ["IDENTITY_ADMIN_CLIENT_ID", "KEYCLOAK_REALM"]) assert.equal(env[k], undefined, k);
  assert.deepEqual(composeDoc().services["customer-profile-kyc-service"].depends_on["admin-permissions"],
    { condition: "service_completed_successfully" });
});

test("every service uses the stack's Kafka and waits for the catalog topics", () => {
  const s = composeDoc().services;
  for (const key of SERVICE_KEYS) {
    const env = s[key].environment;
    assert.equal(env.KAFKA_BOOTSTRAP_SERVERS, "kafka:9092", key);
    assert.equal(env.KAFKA_SECURITY_PROTOCOL, "PLAINTEXT", key);
    assert.deepEqual(s[key].depends_on["topic-init"], { condition: "service_completed_successfully" }, key);
  }
});

test("fbx-local.sh down and reset cover every compose profile", () => {
  const script = fs.readFileSync(path.join(composeDir, "fbx-local.sh"), "utf8");
  const listed = /^all_profiles="([^"]*)"$/m.exec(script)?.[1].split(/\s+/).filter(Boolean).sort();
  const used = [...new Set(Object.values(composeDoc().services).flatMap((x) => x.profiles ?? []))].sort();
  assert.deepEqual(listed, used);
});

test("every service container has a memory limit (decision D11)", () => {
  const s = composeDoc().services;
  for (const r of services().filter((x) => x.key !== "monolith")) assert.equal(s[r.key].mem_limit, MEM_LIMIT, r.key);
});

test("compose commits no credentials and pins every image", () => {
  const doc = composeDoc();
  for (const [name, svc] of Object.entries(doc.services)) {
    const image = svc.image.replace(/^\$\{[A-Z0-9_]+:-([^}]+)\}$/, "$1");
    assert.match(image, /(:[\w.-]+|@sha256:[a-f0-9]{64})$/, `${name} image must be pinned: ${svc.image}`);
    assert.doesNotMatch(image, /:latest$/, `${name} uses latest`);
    for (const [k, v] of Object.entries(svc.environment ?? {})) {
      // CRED but not CREDIT (loan's CUSTOMER_CREDIT_* settings are not credentials).
      if (/PASSWORD|SECRET|CRED(?!IT)/i.test(k)) {
        assert.match(String(v), /^\$\{[A-Z0-9_]+:\?[^}]*\}$/, `${name}.${k} must come from the generated .env without a default`);
      }
      // A credential inside a URL (MONGODB_URI) also comes only from the generated .env.
      const userinfo = /:\/\/[^/@\s]+:([^@\s]+)@/.exec(String(v));
      if (userinfo) assert.match(userinfo[1], /^\$\{[A-Z0-9_]+:\?[^}]*\}$/, `${name}.${k}: URL credential must come from the generated .env`);
    }
    for (const p of svc.ports ?? []) assert.match(String(p), /^127\.0\.0\.1:/, `${name} port ${p} must bind to localhost`);
  }
  const ignored = fs.readFileSync(path.join(repo, ".gitignore"), "utf8");
  for (const p of ["compose/.env", "compose/realm.env", "compose/.cache/"]) assert.ok(ignored.includes(p), `${p} not git-ignored`);
  const tracked = execFileSync("git", ["ls-files", "compose"], { cwd: repo, encoding: "utf8" });
  assert.doesNotMatch(tracked, /(^|\/)(\.env|realm\.env)$/m);
});

test("core stack: postgres 16, single-broker KRaft kafka with catalog topics, keycloak + realm import", () => {
  const s = composeDoc().services;
  assert.match(s.postgres.image, /^postgres:16\./);
  assert.equal(s.kafka.environment.KAFKA_PROCESS_ROLES, "broker,controller");
  assert.equal(s.kafka.environment.KAFKA_AUTO_CREATE_TOPICS_ENABLE, "false");
  assert.ok(!("zookeeper" in s), "no ZooKeeper");
  assert.equal(s["topic-init"].environment.REPLICATION_FACTOR, "1");
  assert.ok(s["topic-init"].volumes.some((v) => v.includes(".cache/kafka")));
  assert.match(s.keycloak.image, /^quay\.io\/keycloak\/keycloak:26\./);
  assert.match(s["realm-import"].image, /keycloak-config-cli:.+@sha256:/);
  assert.ok(s["realm-import"].env_file.includes("realm.env"));
  assert.ok(s["realm-import"].volumes.some((v) => v.includes(".cache/identity")));
  for (const o of ["otel-collector", "jaeger"]) assert.deepEqual(s[o].profiles, ["observability"]);
  assert.ok(s.monolith.profiles.includes("monolith"));
});

test("admin-permissions runs the identity repo's FGAP step after realm-import; the customer service waits for it", () => {
  const s = composeDoc().services;
  const ap = s["admin-permissions"];
  assert.ok(ap, "admin-permissions service missing");
  assert.equal(ap.profiles, undefined, "core stack, every profile");
  assert.match(ap.image, /^docker\.io\/library\/node:22\.[\w.-]+@sha256:[a-f0-9]{64}$/);
  assert.deepEqual(ap.depends_on, { "realm-import": { condition: "service_completed_successfully" } });
  assert.equal(ap.restart, "no");
  const env = ap.environment;
  assert.equal(env.KEYCLOAK_URL, "http://keycloak:8080");
  assert.equal(env.KEYCLOAK_LOGINREALM, "master");
  assert.equal(env.KEYCLOAK_GRANTTYPE, "password");
  assert.equal(env.KEYCLOAK_USER, "${KC_ADMIN_USER:?run compose/fbx-local.sh init}");
  assert.equal(env.KEYCLOAK_PASSWORD, "${KC_ADMIN_CRED:?run compose/fbx-local.sh init}");
  assert.equal(ap.env_file, undefined, "only the admin login, not every realm secret");
  assert.ok(ap.volumes.includes("./.cache/identity:/config:ro"));
  assert.ok(ap.volumes.includes("./.cache/identity-admin:/opt/fbx:ro"));
  const cmd = [].concat(ap.command ?? [], ap.entrypoint ?? []).join(" ");
  assert.match(cmd, /node \/opt\/fbx\/apply-admin-permissions\.mjs --spec \/opt\/fbx\/admin-permissions\.json --realm \/config\/fintechbankx-realm\.json/);
  assert.deepEqual(s["customer-profile-kyc-service"].depends_on["admin-permissions"], { condition: "service_completed_successfully" });
});

test("docker compose config validates every profile with a generated env", { skip: !dockerCompose && "docker compose not available" }, () => {
  const { out } = generate();
  for (const profile of ["", "lending", "payments", "customer", "riskcompliance", "openfinance", "services", "observability", "monolith"]) {
    const args = ["compose", "--project-directory", composeDir, "--env-file", path.join(out, ".env"), "-f", composeFile];
    if (profile) args.push("--profile", profile);
    const res = run("docker", [...args, "config", "-q"], { env: { ...process.env, FBX_REALM_ENV_FILE: path.join(out, "realm.env") } });
    assert.equal(res.status, 0, `profile ${profile || "core"}: ${res.stderr}`);
  }
});

test("docker compose config fails without the generated env", { skip: !dockerCompose && "docker compose not available" }, () => {
  const empty = path.join(tmp(), "empty.env");
  fs.writeFileSync(empty, "");
  const res = run("docker", ["compose", "--project-directory", composeDir, "--env-file", empty, "-f", composeFile, "config", "-q"]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /fbx-local\.sh init/);
});

// --- postgres init ------------------------------------------------------------

function localPostgres() {
  // Uses FBX_TEST_PGHOST/PGPORT/PGUSER/PGPASSWORD (CI service container) or
  // local PostgreSQL 16 binaries run as the postgres OS user.
  if (process.env.FBX_TEST_PGHOST) {
    return { host: process.env.FBX_TEST_PGHOST, port: process.env.FBX_TEST_PGPORT ?? "5432",
      user: process.env.FBX_TEST_PGUSER ?? "postgres", cred: process.env.FBX_TEST_PGPASSWORD ?? "", stop() {} };
  }
  const bin = "/usr/lib/postgresql/16/bin";
  if (!fs.existsSync(`${bin}/initdb`)) return null;
  const asUser = process.getuid && process.getuid() === 0 ? ["runuser", "-u", "postgres", "--"] : [];
  if (asUser.length && run("id", ["postgres"]).status !== 0) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbx-pg-"));
  fs.chmodSync(dir, 0o777);
  const data = path.join(dir, "data");
  const port = String(20000 + Math.floor(Math.random() * 20000));
  const sh = (args) => run(asUser[0] ?? args[0], asUser.length ? [...asUser.slice(1), ...args] : args.slice(1));
  if (sh([`${bin}/initdb`, "-D", data, "-U", "postgres", "-A", "trust"]).status !== 0) return null;
  if (sh([`${bin}/pg_ctl`, "-D", data, "-l", path.join(dir, "server.log"), "-o", `-p ${port} -k ${dir} -c listen_addresses=''`, "-w", "start"]).status !== 0) return null;
  return {
    host: dir, port, user: "postgres", cred: "",
    stop: () => sh([`${bin}/pg_ctl`, "-D", data, "-m", "immediate", "stop"])
  };
}

const pg = localPostgres();
after(() => pg?.stop());

test("postgres init skips mongodb rows and fails on a row of unknown store (no server needed)", () => {
  const psql = recordingStub("psql");
  const file = servicesWithMongo();
  const creds = Object.fromEntries(postgresRows().map((r) => [r.credVar, "x"]));
  // The MongoDB rows' credentials are deliberately not set: postgres never gets them.
  let res = run("bash", [pgInit], { env: { ...process.env, ...creds, FBX_SERVICES_TSV: file, PATH: `${psql.dir}:${process.env.PATH}` } });
  assert.equal(res.status, 0, res.stderr);
  const touched = psql.calls().map((c) => c.args.join(" "));
  for (const r of MONGO_FIXTURE_ROWS) assert.ok(!touched.some((a) => a.includes(r[3]) || a.includes(r[5])), `${r[0]} reached psql`);
  for (const r of postgresRows()) assert.ok(touched.some((a) => a.includes(`db=${r.database}`)), `${r.key} not created`);
  const bad = path.join(tmp(), "services.tsv");
  fs.writeFileSync(bad, fs.readFileSync(file, "utf8").replace(/\tmongodb$/m, "\tcassandra"));
  res = run("bash", [pgInit], { env: { ...process.env, ...creds, FBX_SERVICES_TSV: bad, PATH: `${psql.dir}:${process.env.PATH}` } });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /unknown store 'cassandra'/);
});

test("postgres init creates one database and schema per service and isolates the roles", { skip: !pg && "no PostgreSQL available" }, () => {
  {
    const { out } = generate();
    const env = parseEnv(path.join(out, ".env"));
    // The registry plus MongoDB rows: those get no database here and need no credential.
    const pgEnv = { ...process.env, ...env, FBX_SERVICES_TSV: servicesWithMongo(),
      PGHOST: pg.host, PGPORT: pg.port, PGUSER: pg.user, PGPASSWORD: pg.cred, PGDATABASE: "postgres" };
    let res = run("bash", [pgInit], { env: pgEnv });
    assert.equal(res.status, 0, res.stderr);
    res = run("bash", [pgInit], { env: pgEnv });
    assert.equal(res.status, 0, `init must be re-runnable: ${res.stderr}`);
    const q = (sql, extra = {}) => run("psql", ["-X", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { env: { ...pgEnv, ...extra } });
    const rows = postgresRows();
    for (const s of rows) {
      const asSvc = { PGUSER: s.role, PGPASSWORD: env[s.credVar], PGDATABASE: s.database };
      // A service owns its schema; the monolith keeps public, owned by pg_database_owner (= its role).
      const sql = s.schema === "public"
        ? "select current_database() || ':' || has_schema_privilege(current_user, 'public', 'CREATE')::int"
        : `select current_database() || ':' || count(*) from information_schema.schemata where schema_name = '${s.schema}' and schema_owner = '${s.role}'`;
      res = q(sql, asSvc);
      assert.equal(res.stdout.trim(), `${s.database}:1`, `${s.key}: ${res.stderr}`);
      const other = rows.find((r) => r.database !== s.database && r.schema !== "public");
      res = q("select 1", { ...asSvc, PGDATABASE: other.database });
      assert.notEqual(res.status, 0, `${s.role} must not connect to ${other.database}`);
    }
    for (const r of MONGO_FIXTURE_ROWS) {
      res = q(`select count(*) from pg_database where datname = '${r[3]}'`);
      assert.equal(res.stdout.trim(), "0", `${r[0]}: no PostgreSQL database for a mongodb row`);
    }
  }
});

// --- SQL fixtures (post-boot seed per service) ----------------------------------

function sqlFixtureRun(lines, { env, baseDir, check = false, servicesFile = servicesTsv }) {
  const list = path.join(tmp(), "sql-fixtures.txt");
  fs.writeFileSync(list, lines.join("\n") + "\n");
  const args = [sqlFixtures, "--env-file", env, "--services", servicesFile, "--base-dir", baseDir, "--fixtures", list];
  if (check) args.push("--check");
  return run("bash", args, { env: { ...process.env, FBX_PG_HOST: pg?.host ?? "", FBX_PG_PORT: pg?.port ?? "" } });
}

test("sql fixtures: unknown service, escaping paths and missing files are rejected before running", () => {
  const { out } = generate();
  const base = tmp();
  fs.mkdirSync(path.join(base, "db", "fixtures"), { recursive: true });
  fs.writeFileSync(path.join(base, "db", "fixtures", "ok.sql"), "select 1;\n");
  for (const [line, why] of [
    ["svc-unknown=db/fixtures/ok.sql", /not in services\.tsv/],
    ["customer-profile-kyc-service=../outside.sql", /inside the caller workspace/],
    ["customer-profile-kyc-service=/etc/passwd", /relative/],
    ["customer-profile-kyc-service=db/fixtures/missing.sql", /not found/],
    ["customer-profile-kyc-service db/fixtures/ok.sql", /<service>=<path>/]
  ]) {
    const res = sqlFixtureRun([line], { env: path.join(out, ".env"), baseDir: base, check: true });
    assert.notEqual(res.status, 0, line);
    assert.match(res.stderr, why, line);
  }
  const ok = sqlFixtureRun(["# seed", "svc-cus-profile-kyc=db/fixtures/ok.sql", "customer-profile-kyc-service=db/fixtures/ok.sql"],
    { env: path.join(out, ".env"), baseDir: base, check: true });
  assert.equal(ok.status, 0, ok.stderr);
});

test("sql fixtures refuse a MongoDB service", () => {
  const { out } = generate();
  const base = tmp();
  fs.mkdirSync(path.join(base, "db"), { recursive: true });
  fs.writeFileSync(path.join(base, "db", "ok.sql"), "select 1;\n");
  const servicesFile = servicesWithMongo();
  for (const name of [MONGO_FIXTURE_ROWS[0][0], MONGO_FIXTURE_ROWS[0][1]]) {
    const res = sqlFixtureRun([`${name}=db/ok.sql`], { env: path.join(out, ".env"), baseDir: base, check: true, servicesFile });
    assert.notEqual(res.status, 0, name);
    assert.match(res.stderr, /MongoDB/, name);
  }
  const ok = sqlFixtureRun(["customer-profile-kyc-service=db/ok.sql"], { env: path.join(out, ".env"), baseDir: base, check: true, servicesFile });
  assert.equal(ok.status, 0, ok.stderr);
});

// --- mongo init (one user per mongodb row) ------------------------------------------

const mongoInit = path.join(composeDir, "mongo", "init", "10-service-databases.sh");
const mongoUserScript = path.join(composeDir, "mongo", "init", "service-user.js");

test("mongo init: one mongosh call per mongodb row with its database and user, credentials only in the environment", () => {
  const mongosh = recordingStub("mongosh", ["FBX_DB", "FBX_USER", "FBX_CRED", "MONGO_ROOT_USER", "MONGO_ROOT_CRED"]);
  const creds = Object.fromEntries(MONGO_FIXTURE_ROWS.map((r, i) => [r[6], `fixture-cred-${i}-abcdefghijklmnop`]));
  const env = { ...process.env, ...creds, FBX_SERVICES_TSV: servicesWithMongo(), MONGO_ROOT_USER: "fbx-root",
    MONGO_ROOT_CRED: "fixture-root-abcdefghijklmnop", PATH: `${mongosh.dir}:${process.env.PATH}` };
  let res = run("bash", [mongoInit], { env });
  assert.equal(res.status, 0, res.stderr);
  const calls = mongosh.calls();
  const userCalls = calls.filter((c) => c.args.includes("--file"));
  assert.deepEqual(userCalls.map((c) => [c.env.FBX_DB, c.env.FBX_USER, c.env.FBX_CRED]),
    MONGO_FIXTURE_ROWS.map((r) => [r[3], r[5], creds[r[6]]]), "one user per mongodb row, in registry order");
  for (const c of userCalls) {
    assert.equal(c.args[c.args.indexOf("--file") + 1], mongoUserScript);
    assert.deepEqual([c.env.MONGO_ROOT_USER, c.env.MONGO_ROOT_CRED], ["fbx-root", "fixture-root-abcdefghijklmnop"]);
  }
  for (const c of calls) {
    const argv = c.args.join(" ");
    for (const secret of [...Object.values(creds), "fixture-root-abcdefghijklmnop"]) assert.ok(!argv.includes(secret), "no credential on the command line");
    for (const r of postgresRows()) assert.ok(!argv.includes(r.database) && c.env.FBX_DB !== r.database, `${r.key} is not a MongoDB service`);
  }
  assert.ok(calls.indexOf(userCalls[0]) > 0, "waits for MongoDB (ping) before creating users");
  // Re-runnable: a second run does the same calls (the script creates or updates).
  res = run("bash", [mongoInit], { env });
  assert.equal(res.status, 0, res.stderr);
  // A missing credential stops it.
  const { [MONGO_FIXTURE_ROWS[1][6]]: _dropped, ...partial } = env;
  res = run("bash", [mongoInit], { env: partial });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, new RegExp(`${MONGO_FIXTURE_ROWS[1][6]} is not set`));
});

test("mongo init: the registry without mongodb rows creates no user", () => {
  const mongosh = recordingStub("mongosh", ["FBX_DB"]);
  const res = run("bash", [mongoInit], { env: { ...process.env, FBX_SERVICES_TSV: servicesTsv, MONGO_ROOT_USER: "fbx-root",
    MONGO_ROOT_CRED: "fixture-root-abcdefghijklmnop", PATH: `${mongosh.dir}:${process.env.PATH}` } });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(mongosh.calls().filter((c) => c.args.includes("--file")), []);
});

// The user script runs inside mongosh; here it runs in a Node VM against a
// recording stand-in for mongosh's db object.
async function runUserScript(existingUsers, envOverrides = {}) {
  const vm = await import("node:vm");
  const ops = [];
  const sibling = (name) => ({
    auth: (user, pwd) => { ops.push(["auth", name, user, pwd]); return { ok: 1 }; },
    getUser: (user) => { ops.push(["getUser", name, user]); return existingUsers.includes(`${name}.${user}`) ? { user, db: name } : null; },
    createUser: (doc) => { ops.push(["createUser", name, doc]); return { ok: 1 }; },
    updateUser: (user, doc) => { ops.push(["updateUser", name, user, doc]); return { ok: 1 }; }
  });
  const env = { MONGO_ROOT_USER: "fbx-root", MONGO_ROOT_CRED: "root-cred", FBX_DB: "db_of_fixture_docs_local",
    FBX_USER: "fixture_docs_app", FBX_CRED: "user-cred", ...envOverrides };
  const context = { db: { getSiblingDB: sibling, ...sibling("admin") }, process: { env }, print: () => {} };
  let error = null;
  try { vm.runInNewContext(fs.readFileSync(mongoUserScript, "utf8"), context); } catch (e) { error = e; }
  // Objects built inside the VM have its prototypes: compare them as plain data.
  return { ops: JSON.parse(JSON.stringify(ops)), error };
}

test("mongo init user script: authenticates as root, creates the user with readWrite on its own database only", async () => {
  const { ops, error } = await runUserScript([]);
  assert.equal(error, null, String(error));
  assert.deepEqual(ops[0], ["auth", "admin", "fbx-root", "root-cred"]);
  const created = ops.filter((o) => o[0] === "createUser");
  assert.deepEqual(created, [["createUser", "db_of_fixture_docs_local",
    { user: "fixture_docs_app", pwd: "user-cred", roles: [{ role: "readWrite", db: "db_of_fixture_docs_local" }] }]]);
  assert.ok(!ops.some((o) => o[0] === "updateUser"));
});

test("mongo init user script: re-run updates the existing user's credential and roles", async () => {
  const { ops, error } = await runUserScript(["db_of_fixture_docs_local.fixture_docs_app"]);
  assert.equal(error, null, String(error));
  assert.deepEqual(ops.filter((o) => o[0] === "updateUser"), [["updateUser", "db_of_fixture_docs_local", "fixture_docs_app",
    { pwd: "user-cred", roles: [{ role: "readWrite", db: "db_of_fixture_docs_local" }] }]]);
  assert.ok(!ops.some((o) => o[0] === "createUser"));
});

test("mongo init user script: refuses to run without every input", async () => {
  for (const name of ["MONGO_ROOT_USER", "MONGO_ROOT_CRED", "FBX_DB", "FBX_USER", "FBX_CRED"]) {
    const { ops, error } = await runUserScript([], { [name]: "" });
    assert.ok(error && String(error.message).includes(name), `${name}: ${error}`);
    assert.deepEqual(ops, [], `${name}: nothing done`);
  }
});

test("sql fixtures run in the service's own database and schema with its own role, atomically", { skip: !pg && "no PostgreSQL available" }, () => {
  const { out } = generate();
  const env = parseEnv(path.join(out, ".env"));
  const pgEnv = { ...process.env, ...env, FBX_SERVICES_TSV: servicesTsv,
    PGHOST: pg.host, PGPORT: pg.port, PGUSER: pg.user, PGPASSWORD: pg.cred, PGDATABASE: "postgres" };
  let res = run("bash", [pgInit], { env: pgEnv });
  assert.equal(res.status, 0, res.stderr);
  const base = tmp();
  fs.mkdirSync(path.join(base, "db"), { recursive: true });
  fs.writeFileSync(path.join(base, "db", "seed.sql"), [
    "create table if not exists parity_seed_customers (customer_id text primary key, applied_by text not null);",
    "insert into parity_seed_customers values ('CUST-12345678', current_user) on conflict do nothing;", ""
  ].join("\n"));
  fs.writeFileSync(path.join(base, "db", "broken.sql"),
    "create table parity_half_applied (id int);\nselect * from no_such_table;\n");
  const envFile = path.join(out, ".env");
  res = sqlFixtureRun(["customer-profile-kyc-service=db/seed.sql"], { env: envFile, baseDir: base });
  assert.equal(res.status, 0, res.stderr);
  res = sqlFixtureRun(["svc-cus-profile-kyc=db/seed.sql"], { env: envFile, baseDir: base });
  assert.equal(res.status, 0, `fixtures must be re-runnable: ${res.stderr}`);
  const q = (sql) => run("psql", ["-X", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { env: { ...pgEnv,
    PGUSER: "customer_profile_app", PGPASSWORD: env.FBX_DB_CRED_CUS_PROFILE_KYC, PGDATABASE: "db_cus_profile_kyc_local" } });
  res = q("select t.schemaname || ':' || t.tableowner || ':' || (select string_agg(applied_by, ',') from sc_cus_profile_kyc.parity_seed_customers) from pg_tables t where t.tablename = 'parity_seed_customers'");
  assert.equal(res.stdout.trim(), "sc_cus_profile_kyc:customer_profile_app:customer_profile_app", res.stderr);
  res = sqlFixtureRun(["customer-profile-kyc-service=db/broken.sql"], { env: envFile, baseDir: base });
  assert.notEqual(res.status, 0, "a failing fixture fails the step");
  res = q("select count(*) from pg_tables where tablename = 'parity_half_applied'");
  assert.equal(res.stdout.trim(), "0", "a failing fixture is rolled back (single transaction)");
});
