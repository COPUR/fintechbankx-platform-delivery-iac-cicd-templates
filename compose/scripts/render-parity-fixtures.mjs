#!/usr/bin/env node
// Renders the parity test-actor layer for the local/ephemeral realm:
// compose/keycloak/parity-fixtures.template.json (users + parity-suite client,
// credentials as $(env:...) placeholders, customers in the realm's /customers
// group, which must exist) plus the realm's LDAP federation
// components copied with enabled=false, because compose runs no OpenLDAP and an
// unreachable directory must not break local-user lookups. The output is read
// by the parity-fixtures-import service (keycloak-config-cli, no-delete mode).
// Client parity-tpp gets the public JWKS (--tpp-jwks, generated at init; no
// private key ever reaches this file) and the audience mappers and client scopes
// of the realm's TPP template (of-tpp-conformance-template).
//
// usage: render-parity-fixtures.mjs --template FILE --realm FILE --out FILE [--tpp-jwks JSON]
import fs from "node:fs";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));
for (const k of ["template", "realm", "out"]) {
  if (!args[k]) { console.error(`[parity-fixtures] --${k} is required`); process.exit(2); }
}

const template = JSON.parse(fs.readFileSync(args.template, "utf8"));
const realm = JSON.parse(fs.readFileSync(args.realm, "utf8"));
if (template.realm !== realm.realm) {
  console.error(`[parity-fixtures] template realm ${template.realm} != realm ${realm.realm}`);
  process.exit(1);
}
const { _comment, ...layer } = template;

// Every group a fixture user joins must already exist in the realm
// (realm-import creates it; this layer never defines groups).
const groupPaths = (groups = [], parent = "") => groups.flatMap((g) => {
  const p = g.path ?? `${parent}/${g.name}`;
  return [p, ...groupPaths(g.subGroups, p)];
});
const known = new Set(groupPaths(realm.groups));
const missing = [...new Set(layer.users.flatMap((u) => u.groups ?? []))].filter((g) => !known.has(g));
if (missing.length) {
  console.error(`[parity-fixtures] the identity realm does not declare group(s) ${missing.join(", ")}; use an identity ref that has them (identity-ref / FBX_IDENTITY_REF)`);
  process.exit(1);
}

const tpp = layer.clients.find((c) => c.clientId === "parity-tpp");
if (tpp) {
  const tppTemplate = (realm.clients ?? []).find((c) => c.clientId === "of-tpp-conformance-template");
  if (!tppTemplate) {
    console.error("[parity-fixtures] the identity realm has no of-tpp-conformance-template client (audiences and scopes of parity-tpp); use an identity ref that has it");
    process.exit(1);
  }
  if (!args["tpp-jwks"]) { console.error("[parity-fixtures] --tpp-jwks is required for parity-tpp"); process.exit(2); }
  const jwks = JSON.parse(args["tpp-jwks"]);
  const privateMembers = ["d", "p", "q", "dp", "dq", "qi", "k"];
  if (!Array.isArray(jwks.keys) || !jwks.keys.length || jwks.keys.some((k) => privateMembers.some((m) => m in k))) {
    console.error("[parity-fixtures] --tpp-jwks must be a public JWKS");
    process.exit(2);
  }
  tpp.attributes["jwks.string"] = JSON.stringify(jwks);
  tpp.protocolMappers = (tppTemplate.protocolMappers ?? []).filter((m) => m.protocolMapper === "oidc-audience-mapper");
  tpp.defaultClientScopes = tppTemplate.defaultClientScopes ?? [];
  tpp.optionalClientScopes = tppTemplate.optionalClientScopes ?? [];
}

const storage = "org.keycloak.storage.UserStorageProvider";
const ldap = (realm.components?.[storage] ?? [])
  .filter((c) => (c.providerId ?? "ldap") === "ldap")
  .map(({ subComponents, id, ...c }) => ({ ...c, providerId: "ldap", config: { ...c.config, enabled: ["false"] } }));
if (ldap.length) layer.components = { [storage]: ldap };

fs.mkdirSync(path.dirname(args.out), { recursive: true });
fs.writeFileSync(args.out, JSON.stringify(layer, null, 2) + "\n");
// No secret inside (placeholders only); the importer container must read it
// whatever umask the caller runs under.
fs.chmodSync(path.dirname(args.out), 0o755);
fs.chmodSync(args.out, 0o644);
console.log(`[parity-fixtures] wrote ${args.out} (${layer.users.length} users, ${layer.clients.length} clients, ${ldap.length} LDAP component(s) disabled)`);
