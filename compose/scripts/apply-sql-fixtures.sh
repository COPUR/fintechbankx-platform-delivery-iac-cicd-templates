#!/usr/bin/env bash
# Applies post-boot SQL fixtures (e.g. a service repo's
# db/fixtures/parity_seed_customers.sql) to the local/ephemeral stack. Each
# fixture runs against its service's own database, with its own role and
# credential (from the generated .env) and its schema as search_path, in one
# transaction with ON_ERROR_STOP (psql -X -1). Run it after the stack is
# healthy, so Flyway in the service has created the schema's tables.
#
# Fixture list lines: <service>=<path>; <service> is a services.tsv key or
# service id, <path> is relative to --base-dir (the caller workspace) and must
# stay inside it. Blank lines and # comments are ignored. Lines are applied in
# order. --check validates the list without connecting.
#
# Connection: FBX_PG_HOST (default 127.0.0.1) / FBX_PG_PORT (default 15432,
# the compose port). Without a psql client on PATH, it runs psql inside the
# compose postgres container instead.
#
# usage: apply-sql-fixtures.sh --fixtures FILE [--base-dir DIR] [--env-file FILE]
#                              [--services FILE] [--check]
set -euo pipefail

compose_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$compose_dir/.env"
services="$compose_dir/services.tsv"
base_dir="$PWD"
fixtures=""
check=false
while [ $# -gt 0 ]; do
  case "$1" in
    --fixtures) fixtures="$2"; shift 2 ;;
    --base-dir) base_dir="$2"; shift 2 ;;
    --env-file) env_file="$2"; shift 2 ;;
    --services) services="$2"; shift 2 ;;
    --check) check=true; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
die() { echo "[sql-fixtures] ERROR: $*" >&2; exit 1; }
[ -r "$fixtures" ] || die "fixture list not found: $fixtures"
[ -r "$services" ] || die "services registry not found: $services"
base_real="$(cd "$base_dir" && pwd -P)" || die "base dir not found: $base_dir"

declare -A row=()
while IFS=$'\t' read -r key service_id _ database schema role cred_var _ _; do
  [[ -z "$key" || "$key" == \#* ]] && continue
  row["$key"]="$key"$'\t'"$database"$'\t'"$schema"$'\t'"$role"$'\t'"$cred_var"
  row["$service_id"]="${row[$key]}"
done < "$services"

plan=()
n=0
while IFS= read -r line || [ -n "$line" ]; do
  n=$((n + 1))
  line="${line%$'\r'}"
  [[ -z "${line//[[:space:]]/}" || "$line" =~ ^[[:space:]]*# ]] && continue
  [[ "$line" =~ ^([a-z0-9-]+)=(.+)$ ]] || die "line $n: expected <service>=<path>: $line"
  svc="${BASH_REMATCH[1]}"; rel="${BASH_REMATCH[2]}"
  [ -n "${row[$svc]+set}" ] || die "line $n: service $svc is not in services.tsv"
  [[ "$rel" != /* ]] || die "line $n: path must be relative to the caller workspace: $rel"
  [[ "/$rel/" != */../* ]] || die "line $n: fixture must stay inside the caller workspace: $rel"
  [ -f "$base_real/$rel" ] || die "line $n: fixture not found: $rel"
  real="$(cd "$(dirname "$base_real/$rel")" && pwd -P)/$(basename "$rel")"
  [[ "$real" == "$base_real"/* ]] || die "line $n: fixture must stay inside the caller workspace: $rel"
  plan+=("${row[$svc]}"$'\t'"$real")
done < "$fixtures"
echo "[sql-fixtures] ${#plan[@]} fixture(s) valid"
[ "$check" = true ] && exit 0
[ "${#plan[@]}" -gt 0 ] || exit 0

[ -r "$env_file" ] || die "generated env file not found: $env_file (run compose/fbx-local.sh init)"
cred_of() { # value of KEY in the env file
  local line
  while IFS= read -r line; do
    [[ "$line" == "$1="* ]] && { printf '%s' "${line#*=}"; return 0; }
  done < "$env_file"
  return 1
}

host="${FBX_PG_HOST:-127.0.0.1}"
port="${FBX_PG_PORT:-15432}"
for entry in "${plan[@]}"; do
  IFS=$'\t' read -r key database schema role cred_var file <<< "$entry"
  cred="$(cred_of "$cred_var")" || die "$cred_var missing in $env_file"
  echo "[sql-fixtures] $key: $file -> $database (schema $schema, role $role)"
  if command -v psql >/dev/null; then
    PGPASSWORD="$cred" PGOPTIONS="-c search_path=$schema" \
      psql -X -q -1 -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$role" -d "$database" -f "$file"
  else
    bash "$compose_dir/fbx-local.sh" compose exec -T -e PGPASSWORD="$cred" -e PGOPTIONS="-c search_path=$schema" postgres \
      psql -X -q -1 -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 5432 -U "$role" -d "$database" -f - < "$file"
  fi
done
echo "[sql-fixtures] done"
