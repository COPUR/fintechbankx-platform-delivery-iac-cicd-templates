#!/usr/bin/env node
// Renders extra per-service environment for the local/ephemeral runtime into a
// compose override file (JSON is valid compose YAML), merged after
// docker-compose.yml by fbx-local.sh so a line can also replace a default such
// as SERVICE_CALLERS.
//
// Input lines: <service>__<VAR>=<value>; <service> is a services.tsv key
// (payment-initiation-settlement-service) or service id (svc-pay-initiation-settlement).
// Blank lines and # comments are ignored. Rejected: unknown services, names
// that are not UPPER_SNAKE_CASE, and anything that looks like it overrides a
// credential or the identity/database wiring (passwords, secrets, tokens, keys,
// usernames, OIDC_*, DB_*, SPRING_DATASOURCE_*, SPRING_SECURITY_*, KEYCLOAK*).
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
const WIRING = /^(OIDC_|DB_|SPRING_DATASOURCE_|SPRING_SECURITY_|KEYCLOAK|KC_|FINTECHBANKX_SERVICE_ID$)/;

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
  if (CREDENTIAL.test(name) || WIRING.test(name)) {
    errors.push(`${where}: ${name} looks like a credential or identity/database wiring override; not allowed`);
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
