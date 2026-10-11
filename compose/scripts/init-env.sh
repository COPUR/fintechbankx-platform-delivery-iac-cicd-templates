#!/usr/bin/env bash
# Generates the git-ignored env files for the local/ephemeral runtime:
#   <out-dir>/.env       compose interpolation: superuser, Keycloak admin, Redis,
#                        one database credential per service (services.tsv) and
#                        the OIDC client credentials
#   <out-dir>/realm.env  keycloak-config-cli settings plus every $(env:NAME)
#                        placeholder of the identity repo's realm
# With --parity-fixtures (regression parity runs, local/ephemeral only) also:
#   PARITY_USERNAME_<ACTOR> / PARITY_PASSWORD_<ACTOR> for the actors banker,
#   admin, loan_officer, compliance_officer, auditor, customer, other_customer
#   and customer_owner,
#   PARITY_SECRET_PARITY_SUITE (parity-suite client) and
#   PARITY_SECRET_SVC_LN_LOAN_LIFECYCLE / PARITY_SECRET_SVC_PAY_INITIATION_SETTLEMENT
#   (the same values the realm import gives those service clients),
#   PARITY_TPP_CLIENT_ID / PARITY_TPP_PRIVATE_JWK (TPP-001, formerly parity-tpp),
#   PARITY_TPP_OTHER_CLIENT_ID / PARITY_TPP_OTHER_PRIVATE_JWK (TPP-002) and
#   PARITY_CHANNEL_CLIENT_ID / PARITY_CHANNEL_PRIVATE_JWK (parity-channel): one
#   private JWK (RSA PS256) per key-bound client, generated here, never
#   committed; and renders <cache-dir>/parity/parity-fixtures.json from
#   compose/keycloak/ for the parity-fixtures-import service.
# Every credential is random (openssl), dev-only and never committed. Existing
# values are kept, so re-running is safe; delete the files to rotate.
# An unknown realm placeholder is an error: add it to dev_value() below.
#
# usage: init-env.sh [--out-dir DIR] [--realm FILE] [--services FILE]
#                    [--cache-dir DIR] [--parity-fixtures]
set -euo pipefail

compose_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out_dir="$compose_dir"
realm="$compose_dir/.cache/identity/fintechbankx-realm.json"
services="$compose_dir/services.tsv"
cache_dir="$compose_dir/.cache"
parity=false

while [ $# -gt 0 ]; do
  case "$1" in
    --out-dir) out_dir="$2"; shift 2 ;;
    --realm) realm="$2"; shift 2 ;;
    --services) services="$2"; shift 2 ;;
    --cache-dir) cache_dir="$2"; shift 2 ;;
    --parity-fixtures) parity=true; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

die() { echo "[init-env] ERROR: $*" >&2; exit 1; }
[ -r "$realm" ] || die "realm not found: $realm (run compose/fbx-local.sh fetch first)"
[ -r "$services" ] || die "services registry not found: $services"
command -v openssl >/dev/null || die "openssl is required"
mkdir -p "$out_dir"
umask 077

random_value() {
  local v=""
  while [ "${#v}" -lt 40 ]; do
    v="$v$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9')"
  done
  printf '%s' "${v:0:40}"
}

# Non-secret dev values for realm placeholders (dev/staging OpenLDAP shape from
# the identity repo, plain LDAP inside the compose network, localhost channels).
dev_value() {
  case "$1" in
    FBX_WEB_REDIRECT_URI) echo "http://localhost:3000/auth/callback" ;;
    FBX_WEB_ORIGIN) echo "http://localhost:3000" ;;
    FBX_WEB_POST_LOGOUT_REDIRECT_URI) echo "http://localhost:3000/" ;;
    FBX_STAFF_WEB_REDIRECT_URI) echo "http://localhost:3002/auth/callback" ;;
    FBX_STAFF_WEB_ORIGIN) echo "http://localhost:3002" ;;
    FBX_STAFF_WEB_POST_LOGOUT_REDIRECT_URI) echo "http://localhost:3002/" ;;
    FBX_MOBILE_REDIRECT_URI) echo "com.fintechbankx.mobile:/oauth2redirect" ;;
    FBX_GRAFANA_ROOT_URL) echo "http://localhost:3001" ;;
    LDAP_VENDOR) echo "other" ;;
    LDAP_CONNECTION_URL) echo "ldap://openldap:389" ;;
    LDAP_START_TLS) echo "false" ;;
    LDAP_BIND_DN) echo "cn=readonly,dc=fintechbankx,dc=internal" ;;
    LDAP_USERS_DN) echo "ou=people,dc=fintechbankx,dc=internal" ;;
    LDAP_GROUPS_DN) echo "ou=groups,dc=fintechbankx,dc=internal" ;;
    LDAP_USERNAME_ATTRIBUTE|LDAP_RDN_ATTRIBUTE) echo "uid" ;;
    LDAP_UUID_ATTRIBUTE) echo "entryUUID" ;;
    LDAP_USER_OBJECT_CLASSES) echo "inetOrgPerson, organizationalPerson" ;;
    LDAP_GROUP_OBJECT_CLASSES) echo "groupOfNames" ;;
    LDAP_USER_SEARCH_FILTER) echo "" ;;
    *) return 1 ;;
  esac
}
is_secret_placeholder() { [[ "$1" == FBX_OIDC_SECRET_* || "$1" == LDAP_BIND_CREDENTIAL ]]; }

# Existing values (KEY=VALUE lines) survive a re-run.
declare -A existing=()
load_existing() {
  local file="$1" line
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    existing["${line%%=*}"]="${line#*=}"
  done < "$file"
}
load_existing "$out_dir/.env"
load_existing "$out_dir/realm.env"

declare -A value=()
order=()
put() { # put KEY VALUE (keeps an existing value)
  local key="$1" v="$2"
  if [ -n "${existing[$key]+set}" ]; then v="${existing[$key]}"; fi
  value["$key"]="$v"
  order+=("$key")
}
secret() { put "$1" "$(random_value)"; }
# Satisfies the realm password policy (length, upper, lower, digit, special).
policy_password() { printf '%s-Aa1' "$(random_value)"; }

mapfile -t realm_placeholders < <(grep -oE '\$\(env:[A-Z0-9_]+\)' "$realm" | sed -E 's/^\$\(env:(.*)\)$/\1/' | sort -u)
unknown=()
for name in "${realm_placeholders[@]}"; do
  is_secret_placeholder "$name" || dev_value "$name" >/dev/null || unknown+=("$name")
done
[ "${#unknown[@]}" -eq 0 ] || die "realm placeholders without a dev value: ${unknown[*]} (extend dev_value in $0)"

# --- .env --------------------------------------------------------------------
env_keys_start=${#order[@]}
secret POSTGRES_SUPERUSER_CRED
put KC_ADMIN_USER fbx-local-admin
secret KC_ADMIN_CRED
secret REDIS_CRED
oidc_names=()
while IFS=$'\t' read -r key service_id _ _ _ _ cred_var _ _; do
  [[ -z "$key" || "$key" == \#* ]] && continue
  secret "$cred_var"
  # Client credential per service (client id = service id), used by compose
  # even when the realm in use does not define that client yet.
  [[ "$service_id" == svc-* ]] && oidc_names+=("FBX_OIDC_SECRET_$(echo "$service_id" | tr 'a-z-' 'A-Z_')")
done < "$services"
for name in "${realm_placeholders[@]}"; do
  [[ "$name" == FBX_OIDC_SECRET_* ]] && oidc_names+=("$name")
done
mapfile -t oidc_names < <(printf '%s\n' "${oidc_names[@]}" | sort -u)
for name in "${oidc_names[@]}"; do secret "$name"; done

# Parity test actors (ephemeral/local only, never in the identity repo's realm).
parity_actors=(banker admin loan_officer compliance_officer auditor customer other_customer customer_owner)
parity_realm_keys=()
if [ "$parity" = true ]; then
  command -v node >/dev/null || die "node is required for --parity-fixtures"
  # The fixture users carry customer_id; the identity realm must declare it in
  # the user profile and map it to the token (client scope customer-id,
  # identity PR #11), or Keycloak drops the attribute and tokens lack it.
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const scope = (r.clientScopes || []).some((s) => s.name === "customer-id");
    const attr = (r.userProfile?.attributes || []).some((a) => a.name === "customer_id");
    process.exit(scope && attr ? 0 : 1);' "$realm" \
    || die "--parity-fixtures: the identity realm does not declare customer_id (user profile) and client scope customer-id; use an identity ref that has them (identity-ref / FBX_IDENTITY_REF)"
  # parity-suite's view/manage-members grant on /customers is a fine-grained
  # admin permission (FGAP v2), which needs the realm to enable them.
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.exit(r.adminPermissionsEnabled === true ? 0 : 1);' "$realm" \
    || die "--parity-fixtures: the identity realm does not set adminPermissionsEnabled (parity-suite's admin permission on /customers); use an identity ref that has it (identity-ref / FBX_IDENTITY_REF)"
  for actor in "${parity_actors[@]}"; do
    upper="$(echo "$actor" | tr 'a-z' 'A-Z')"
    put "PARITY_USERNAME_$upper" "parity-${actor//_/-}"
    put "PARITY_PASSWORD_$upper" "$(policy_password)"
    parity_realm_keys+=("PARITY_PASSWORD_$upper")
  done
  secret PARITY_SECRET_PARITY_SUITE
  parity_realm_keys+=(PARITY_SECRET_PARITY_SUITE)
  # Key-bound clients (open-finance TPPs TPP-001 and TPP-002, first-party
  # channel stand-in parity-channel): one key pair each, generated here; the
  # private JWK stays in .env (mode 600), only the public JWKS goes into the
  # rendered realm layer. Client ids are fixed (an env from before TPP-001
  # said parity-tpp; its key is kept and now belongs to TPP-001).
  for pair in PARITY_TPP:TPP-001 PARITY_TPP_OTHER:TPP-002 PARITY_CHANNEL:parity-channel; do
    prefix="${pair%%:*}" client_id="${pair#*:}"
    value["${prefix}_CLIENT_ID"]="$client_id"
    order+=("${prefix}_CLIENT_ID")
    if [ -z "${existing[${prefix}_PRIVATE_JWK]+set}" ]; then
      jwk="$(node -e '
        const c = require("crypto");
        const { privateKey } = c.generateKeyPairSync("rsa", { modulusLength: 2048 });
        const jwk = privateKey.export({ format: "jwk" });
        const thumb = c.createHash("sha256").update(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n })).digest("base64url");
        process.stdout.write(JSON.stringify({ kty: jwk.kty, kid: thumb, use: "sig", alg: "PS256", n: jwk.n, e: jwk.e,
          d: jwk.d, p: jwk.p, q: jwk.q, dp: jwk.dp, dq: jwk.dq, qi: jwk.qi }));')" || die "cannot generate the $client_id key pair"
    else
      jwk=""
    fi
    put "${prefix}_PRIVATE_JWK" "$jwk"
  done
  # Same value the realm import gives the service client (never a second secret).
  for svc in SVC_LN_LOAN_LIFECYCLE SVC_PAY_INITIATION_SETTLEMENT; do
    value["PARITY_SECRET_$svc"]="${value[FBX_OIDC_SECRET_$svc]}"
    order+=("PARITY_SECRET_$svc")
  done
fi
env_keys_end=${#order[@]}

write() { # write FILE FROM TO
  local file="$1" from="$2" to="$3" i tmp
  tmp="$(mktemp "$file.XXXXXX")"
  {
    echo "# Generated by compose/scripts/init-env.sh. Dev-only values; never commit this file."
    for ((i = from; i < to; i++)); do printf '%s=%s\n' "${order[$i]}" "${value[${order[$i]}]}"; done
  } > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$file"
}
write "$out_dir/.env" "$env_keys_start" "$env_keys_end"

# --- realm.env -----------------------------------------------------------------
realm_start=${#order[@]}
put KEYCLOAK_URL "http://keycloak:8080"
put KEYCLOAK_USER "${value[KC_ADMIN_USER]}"
put KEYCLOAK_PASSWORD "${value[KC_ADMIN_CRED]}"
put KEYCLOAK_AVAILABILITYCHECK_ENABLED true
put KEYCLOAK_AVAILABILITYCHECK_TIMEOUT 300s
put IMPORT_FILES_LOCATIONS "file:/config/*.json"
put IMPORT_VARSUBSTITUTION_ENABLED true
put IMPORT_VALIDATE true
put IMPORT_REMOTESTATE_ENABLED true
for name in "${realm_placeholders[@]}"; do
  if [[ "$name" == FBX_OIDC_SECRET_* ]]; then
    put "$name" "${value[$name]}"
  elif is_secret_placeholder "$name"; then
    secret "$name"
  else
    put "$name" "$(dev_value "$name")"
  fi
done
for name in "${parity_realm_keys[@]}"; do put "$name" "${value[$name]}"; done
write "$out_dir/realm.env" "$realm_start" "${#order[@]}"

if [ "$parity" = true ]; then
  # clientId -> public JWKS of each key-bound client (public members only).
  jwks="$(node -e '
    const out = {};
    for (let i = 1; i < process.argv.length; i += 3) {
      const [client, name, text] = process.argv.slice(i, i + 3);
      let k;
      try { k = JSON.parse(text); } catch { console.error(`${name} is not a JWK`); process.exit(1); }
      out[client] = { keys: [{ kty: k.kty, kid: k.kid, use: k.use, alg: k.alg, n: k.n, e: k.e }] };
    }
    process.stdout.write(JSON.stringify(out));' \
    "${value[PARITY_TPP_CLIENT_ID]}" PARITY_TPP_PRIVATE_JWK "${value[PARITY_TPP_PRIVATE_JWK]}" \
    "${value[PARITY_TPP_OTHER_CLIENT_ID]}" PARITY_TPP_OTHER_PRIVATE_JWK "${value[PARITY_TPP_OTHER_PRIVATE_JWK]}" \
    "${value[PARITY_CHANNEL_CLIENT_ID]}" PARITY_CHANNEL_PRIVATE_JWK "${value[PARITY_CHANNEL_PRIVATE_JWK]}")" \
    || die "a parity private JWK in $out_dir/.env is not a JWK"
  node "$compose_dir/scripts/render-parity-fixtures.mjs" \
    --template "$compose_dir/keycloak/parity-fixtures.template.json" \
    --realm "$realm" --out "$cache_dir/parity/parity-fixtures.json" --jwks "$jwks"
fi

echo "[init-env] wrote $out_dir/.env and $out_dir/realm.env (${#realm_placeholders[@]} realm placeholders)"
