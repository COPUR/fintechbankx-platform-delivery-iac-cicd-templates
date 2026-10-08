#!/usr/bin/env node
// Renders the parity test-actor layer for the local/ephemeral realm:
// compose/keycloak/parity-fixtures.template.json (users, the parity-suite client,
// the key-bound clients TPP-001, TPP-002 and parity-channel, the parity-psu-*
// client scopes; credentials as $(env:...) placeholders, customers in the
// realm's /customers group, which must exist) plus the realm's LDAP federation
// components copied with enabled=false, because compose runs no OpenLDAP and an
// unreachable directory must not break local-user lookups. The output is read
// by the parity-fixtures-import service (keycloak-config-cli, no-delete mode).
//
// Key-bound clients (clientAuthenticatorType client-jwt) get their public JWKS
// from --jwks (a JSON object clientId -> JWKS generated at init; no private key
// ever reaches this file).
// - TPP clients (fbx.client-type=open-finance-tpp) get the audience mappers and
//   client scopes of the realm's TPP template (of-tpp-conformance-template),
//   the realm's fbx_client_type scope when it has one, and the open-finance API
//   scopes as optional scopes; API scopes the realm lacks are defined here.
// - The channel client (attribute fbx.parity.channel-of=<realm client>) gets
//   that client's audience mappers and default scopes, and a hardcoded
//   fbx_client_type claim with that client's fbx.client-type, so services that
//   tell TPPs from channels by that claim treat it as the channel.
//
// usage: render-parity-fixtures.mjs --template FILE --realm FILE --out FILE [--jwks JSON]
import fs from "node:fs";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));
for (const k of ["template", "realm", "out"]) {
  if (!args[k]) { console.error(`[parity-fixtures] --${k} is required`); process.exit(2); }
}
const fail = (msg, code = 1) => { console.error(`[parity-fixtures] ${msg}`); process.exit(code); };

const template = JSON.parse(fs.readFileSync(args.template, "utf8"));
const realm = JSON.parse(fs.readFileSync(args.realm, "utf8"));
if (template.realm !== realm.realm) fail(`template realm ${template.realm} != realm ${realm.realm}`);
const { _comment, ...layer } = template;
layer.clientScopes = [...(layer.clientScopes ?? [])];

// Every group a fixture user joins must already exist in the realm
// (realm-import creates it; this layer never defines groups).
const groupPaths = (groups = [], parent = "") => groups.flatMap((g) => {
  const p = g.path ?? `${parent}/${g.name}`;
  return [p, ...groupPaths(g.subGroups, p)];
});
const known = new Set(groupPaths(realm.groups));
const missing = [...new Set(layer.users.flatMap((u) => u.groups ?? []))].filter((g) => !known.has(g));
if (missing.length) {
  fail(`the identity realm does not declare group(s) ${missing.join(", ")}; use an identity ref that has them (identity-ref / FBX_IDENTITY_REF)`);
}

const realmClient = (id) => (realm.clients ?? []).find((c) => c.clientId === id);
const realmScopes = new Set((realm.clientScopes ?? []).map((s) => s.name));
const union = (...lists) => [...new Set(lists.flat().filter(Boolean))];
const audienceMappers = (c) => (c.protocolMappers ?? []).filter((m) => m.protocolMapper === "oidc-audience-mapper");

// Open-finance API scopes the TPP clients may request (scope value only).
const API_SCOPES = ["read_accounts", "read_balances", "read_transactions", "read_parties", "read_metadata",
  "read_standing_orders", "payments"];
const TPP_CLIENT_TYPE_SCOPE = "fbx-client-type-open-finance-tpp";

let jwksByClient = {};
const keyBound = layer.clients.filter((c) => c.clientAuthenticatorType === "client-jwt");
if (keyBound.length) {
  if (!args.jwks) fail(`--jwks is required for ${keyBound.map((c) => c.clientId).join(", ")}`, 2);
  jwksByClient = JSON.parse(args.jwks);
}
const privateMembers = ["d", "p", "q", "dp", "dq", "qi", "k"];
for (const c of keyBound) {
  const jwks = jwksByClient[c.clientId];
  if (!jwks || !Array.isArray(jwks.keys) || !jwks.keys.length || jwks.keys.some((k) => privateMembers.some((m) => m in k))) {
    fail(`--jwks must hold a public JWKS for ${c.clientId}`, 2);
  }
  c.attributes["jwks.string"] = JSON.stringify(jwks);
}

const tpps = layer.clients.filter((c) => c.attributes?.["fbx.client-type"] === "open-finance-tpp");
if (tpps.length) {
  const tppTemplate = realmClient("of-tpp-conformance-template");
  if (!tppTemplate) fail("the identity realm has no of-tpp-conformance-template client (audiences and scopes of the TPP clients); use an identity ref that has it");
  for (const c of tpps) {
    c.protocolMappers = audienceMappers(tppTemplate);
    c.defaultClientScopes = union(tppTemplate.defaultClientScopes ?? [],
      realmScopes.has(TPP_CLIENT_TYPE_SCOPE) ? [TPP_CLIENT_TYPE_SCOPE] : []);
    c.optionalClientScopes = union(tppTemplate.optionalClientScopes ?? [], API_SCOPES, c.optionalClientScopes ?? []);
  }
  for (const name of API_SCOPES.filter((s) => !realmScopes.has(s))) {
    layer.clientScopes.push({
      name,
      description: `Parity only: open-finance API scope ${name} (scope value only); the identity realm does not define it yet.`,
      protocol: "openid-connect",
      attributes: { "include.in.token.scope": "true", "display.on.consent.screen": "false" },
      protocolMappers: []
    });
  }
}

for (const c of layer.clients.filter((x) => x.attributes?.["fbx.parity.channel-of"])) {
  const channelId = c.attributes["fbx.parity.channel-of"];
  const channel = realmClient(channelId);
  if (!channel) fail(`the identity realm has no ${channelId} client (audiences and scopes of ${c.clientId}); use an identity ref that has it`);
  const channelType = channel.attributes?.["fbx.client-type"];
  if (!channelType || channelType === "open-finance-tpp") fail(`${channelId} has no first-party fbx.client-type in the realm`);
  c.protocolMappers = [...audienceMappers(channel), {
    name: "fbx_client_type",
    protocol: "openid-connect",
    protocolMapper: "oidc-hardcoded-claim-mapper",
    consentRequired: false,
    config: {
      "claim.name": "fbx_client_type", "claim.value": channelType, "jsonType.label": "String",
      "access.token.claim": "true", "id.token.claim": "false", "userinfo.token.claim": "false",
      "introspection.token.claim": "true", "lightweight.claim": "false"
    }
  }];
  c.defaultClientScopes = union(channel.defaultClientScopes ?? []);
  c.optionalClientScopes = union(c.optionalClientScopes ?? []);
}

// Every parity-psu-* scope a client references is defined by this layer.
const layerScopes = new Set(layer.clientScopes.map((s) => s.name));
for (const c of layer.clients) {
  for (const s of union(c.defaultClientScopes ?? [], c.optionalClientScopes ?? [])) {
    if (s.startsWith("parity-") && !layerScopes.has(s)) fail(`${c.clientId} references undefined client scope ${s}`);
  }
}
if (!layer.clientScopes.length) delete layer.clientScopes;

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
console.log(`[parity-fixtures] wrote ${args.out} (${layer.users.length} users, ${layer.clients.length} clients, ${layer.clientScopes?.length ?? 0} client scopes, ${ldap.length} LDAP component(s) disabled)`);
