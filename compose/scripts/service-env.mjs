#!/usr/bin/env node
// Renders extra per-service environment for the local/ephemeral runtime into a
// compose override file (JSON is valid compose YAML), merged after
// docker-compose.yml by fbx-local.sh so a line can also replace a default such
// as SERVICE_CALLERS.
//
// Input lines: <service>__<VAR>=<value>; <service> is a services.tsv key
// (payment-initiation-settlement-service) or service id (svc-pay-initiation-settlement).
// Blank lines and # comments are ignored. Rejected: unknown services, names
// that are not UPPER_SNAKE_CASE, anything that looks like it overrides a
// credential or the identity/datastore wiring (passwords, secrets, tokens, keys,
// usernames, OIDC_*, DB_*, SPRING_DATASOURCE_*, SPRING_SECURITY_*, KEYCLOAK*,
// MONGODB_*, SPRING_DATA_MONGODB_*, FLYWAY_*, SPRING_FLYWAY_*, SERVICE_CLIENT_*,
// REDIS_URL, SPRING_DATA_REDIS_*, DATABASE_CA_BUNDLE), and anything that changes
// the Spring profiles, where the configuration comes from or the JVM options
// (SPRING_PROFILES_*, SPRING_CONFIG_*, SPRING_APPLICATION_JSON, JAVA_TOOL_OPTIONS,
// JDK_JAVA_OPTIONS): these carry any property, the datastore URIs included, or
// add the aws profile; every service runs with SPRING_PROFILES_ACTIVE=local only.
// Also rejected, as the platform chart's fbx.guard refuses or pins them: Spring
// Boot's startup (SPRING_MAIN_*), Kafka client security (a KAFKA_, SPRING_KAFKA_
// or SPRING_CLOUD_STREAM_KAFKA_ name with SASL, JAAS, SECURITY or SSL; the chart
// pins security.protocol to SASL_SSL or SSL and endpoint identification to https,
// which the local PLAINTEXT Kafka cannot use), SSL bundles (SPRING_SSL_*) and schema management
// (SPRING_JPA_*, SPRING_SQL_INIT_*, HIBERNATE_*, JAKARTA_PERSISTENCE_*,
// JAVAX_PERSISTENCE_*).
// Spring Boot maps an environment name with a run of "_" (or a trailing "_") as
// if it were one "_" (SPRING__DATA__MONGODB__URI binds spring.data.mongodb.uri),
// so names are matched in that form.
// `$` in values is escaped so compose does not interpolate it.
//
// usage: service-env.mjs --in FILE --out FILE [--services services.tsv]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const input = opt("in");
const out = opt("out");
const servicesFile = opt("services", path.join(here, "..", "services.tsv"));
if (!input || !out) { console.error("usage: service-env.mjs --in FILE --out FILE [--services FILE]"); process.exit(2); }

const keyOf = new Map();
for (const line of fs.readFileSync(servicesFile, "utf8").split("\n")) {
  if (!line || line.startsWith("#")) continue;
  const [key, serviceId] = line.split("\t");
  keyOf.set(key, key);
  keyOf.set(serviceId, key);
}

const CREDENTIAL = /(PASS|PWD|SECRET|CRED|TOKEN|PRIVATE|KEY|CERT|USERNAME|(^|_)USER($|_)|(^|_)AUTH($|_))/;
const WIRING = new RegExp("^(" + [
  "OIDC_", "DB_", "SPRING_DATASOURCE_", "SPRING_SECURITY_", "KEYCLOAK", "KC_", "FINTECHBANKX_SERVICE_ID$",
  // datastores, migrations and the outbound client-credentials registration
  "MONGODB_", "SPRING_DATA_MONGODB_", "FLYWAY_", "SPRING_FLYWAY_", "SERVICE_CLIENT_",
  "REDIS_URL$", "SPRING_DATA_REDIS_", "DATABASE_CA_BUNDLE$"
].join("|") + ")");
// Generic property carriers, profile and config-location switches, JVM options.
// The images set JAVA_TOOL_OPTIONS themselves (MaxRAMPercentage, decision D11).
const RUNTIME = /^(SPRING_PROFILES_|SPRING_CONFIG_|SPRING_APPLICATION_JSON$|JAVA_TOOL_OPTIONS$|JDK_JAVA_OPTIONS$)/;
// Settings the platform chart refuses on every route (fbx.guard), or pins: it takes Kafka
// security.protocol and ssl.endpoint.identification.algorithm only as SASL_SSL/SSL and https,
// which the local PLAINTEXT Kafka cannot use. Kafka names are the client's own (KAFKA_,
// SPRING_KAFKA_, SPRING_CLOUD_STREAM_KAFKA_), not an application's APP_KAFKA_* settings.
const PLATFORM = new RegExp("(" + [
  "^SPRING_MAIN(_|$)", "^(SPRING_(CLOUD_STREAM_)?)?KAFKA(_.*)?_(SASL|JAAS|SECURITY|SSL)(_|$)", "^SPRING_SSL(_|$)",
  "^SPRING_JPA(_|$)", "^SPRING_SQL_?INIT(_|$)", "^HIBERNATE(_|$)", "^(JAKARTA|JAVAX)_PERSISTENCE(_|$)"
].join("|") + ")");
// The name as Spring Boot's environment mapping sees it.
const springForm = (name) => name.replace(/_+/g, "_").replace(/_$/, "");

const services = {};
const errors = [];
fs.readFileSync(input, "utf8").split("\n").forEach((raw, i) => {
  const line = raw.replace(/\r$/, "");
  if (!line.trim() || line.trim().startsWith("#")) return;
  const where = `line ${i + 1}`;
  const m = /^([a-z0-9-]+)__([^=]+)=(.*)$/.exec(line);
  if (!m) { errors.push(`${where}: expected SERVICE__VAR=value`); return; }
  const [, service, name, value] = m;
  const key = keyOf.get(service);
  if (!key) { errors.push(`${where}: service ${service} is not in services.tsv`); return; }
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) { errors.push(`${where}: variable name ${name} must be UPPER_SNAKE_CASE`); return; }
  const canonical = springForm(name);
  if (CREDENTIAL.test(canonical) || WIRING.test(canonical)) {
    errors.push(`${where}: ${name} looks like a credential or identity/database wiring override; not allowed`);
    return;
  }
  if (PLATFORM.test(canonical)) {
    errors.push(`${where}: ${name} would change Spring Boot's startup (spring.main), Kafka security, an SSL bundle (spring.ssl) ` +
      "or schema management (spring.jpa, spring.sql.init, hibernate, jakarta/javax.persistence); the platform chart " +
      "refuses these or pins them (Kafka security.protocol to SASL_SSL or SSL, endpoint identification to https), " +
      "which the local PLAINTEXT Kafka cannot use; not allowed");
    return;
  }
  if (RUNTIME.test(canonical)) {
    errors.push(`${where}: ${name} would change a Spring profile, configuration source or JVM option ` +
      "(every service runs with SPRING_PROFILES_ACTIVE=local only); not allowed");
    return;
  }
  ((services[key] ??= { environment: {} }).environment)[name] = value.replaceAll("$", () => "$$");
});
if (errors.length) {
  for (const e of errors) console.error(`[service-env] ERROR: ${e}`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ services }, null, 2) + "\n");
console.log(`[service-env] wrote ${out} (${Object.keys(services).length} service(s))`);
