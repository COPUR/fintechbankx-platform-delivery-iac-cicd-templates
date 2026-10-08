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
const services = () => fs.readFileSync(servicesTsv, "utf8").split("\n")
  .filter((l) => l && !l.startsWith("#"))
  .map((l) => {
    const [key, serviceId, profiles, database, schema, role, credVar, imageVar, hostPort] = l.split("\t");
    return { key, serviceId, profiles: profiles.split(","), database, schema, role, credVar, imageVar, hostPort };
  });
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
  for (const key of ["POSTGRES_SUPERUSER_CRED", "KC_ADMIN_USER", "KC_ADMIN_CRED", "REDIS_CRED"]) {
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

test("every service in services.tsv is wired in compose with its own database and profiles", () => {
  const doc = composeDoc();
  for (const s of services()) {
    const svc = doc.services[s.key];
    assert.ok(svc, `compose service ${s.key} missing`);
    assert.deepEqual([...svc.profiles].sort(), [...s.profiles].sort(), `${s.key} profiles`);
    const env = svc.environment;
    const url = env.DB_URL ?? env.SPRING_DATASOURCE_URL;
    assert.equal(url, `jdbc:postgresql://postgres:5432/${s.database}`);
    assert.match(String(env.SPRING_DATASOURCE_PASSWORD), new RegExp(`^\\$\\{${s.credVar}:\\?`));
    assert.match(svc.image, new RegExp(`^\\$\\{${s.imageVar}:-[^}]+\\}$`));
  }
});

test("compose commits no credentials and pins every image", () => {
  const doc = composeDoc();
  for (const [name, svc] of Object.entries(doc.services)) {
    const image = svc.image.replace(/^\$\{[A-Z0-9_]+:-([^}]+)\}$/, "$1");
    assert.match(image, /(:[\w.-]+|@sha256:[a-f0-9]{64})$/, `${name} image must be pinned: ${svc.image}`);
    assert.doesNotMatch(image, /:latest$/, `${name} uses latest`);
    for (const [k, v] of Object.entries(svc.environment ?? {})) {
      if (/PASSWORD|SECRET|CRED/i.test(k)) {
        assert.match(String(v), /^\$\{[A-Z0-9_]+:\?[^}]*\}$/, `${name}.${k} must come from the generated .env without a default`);
      }
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
  for (const profile of ["", "lending", "payments", "customer", "riskcompliance", "services", "observability", "monolith"]) {
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

test("postgres init creates one database and schema per service and isolates the roles", { skip: !pg && "no PostgreSQL available" }, () => {
  {
    const { out } = generate();
    const env = parseEnv(path.join(out, ".env"));
    const pgEnv = { ...process.env, ...env, FBX_SERVICES_TSV: servicesTsv,
      PGHOST: pg.host, PGPORT: pg.port, PGUSER: pg.user, PGPASSWORD: pg.cred, PGDATABASE: "postgres" };
    let res = run("bash", [pgInit], { env: pgEnv });
    assert.equal(res.status, 0, res.stderr);
    res = run("bash", [pgInit], { env: pgEnv });
    assert.equal(res.status, 0, `init must be re-runnable: ${res.stderr}`);
    const q = (sql, extra = {}) => run("psql", ["-X", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { env: { ...pgEnv, ...extra } });
    const rows = services();
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
  }
});

// --- SQL fixtures (post-boot seed per service) ----------------------------------

function sqlFixtureRun(lines, { env, baseDir, check = false }) {
  const list = path.join(tmp(), "sql-fixtures.txt");
  fs.writeFileSync(list, lines.join("\n") + "\n");
  const args = [sqlFixtures, "--env-file", env, "--services", servicesTsv, "--base-dir", baseDir, "--fixtures", list];
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
