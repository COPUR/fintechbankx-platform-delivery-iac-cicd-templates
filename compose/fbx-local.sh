#!/usr/bin/env bash
# Entry point for the shared local / ephemeral runtime.
#
#   compose/fbx-local.sh fetch                 platform assets -> compose/.cache (realm, admin-permissions step,
#                                              topic catalog)
#   compose/fbx-local.sh init [--parity-fixtures]
#                                              generate compose/.env and compose/realm.env (git-ignored);
#                                              --parity-fixtures adds the parity test actors (PARITY_* in .env)
#   compose/fbx-local.sh service-env FILE      render SERVICE__VAR=value lines into a compose override
#                                              (.cache/service-env.override.json); an empty FILE removes it
#   compose/fbx-local.sh up [--lane NAME] [profile ...]
#                                              fetch (if missing) + init + docker compose up -d --wait;
#                                              --lane NAME stands for that lane's profiles (lanes.tsv)
#   compose/fbx-local.sh plan [--lane NAME] [profile ...] [--budget-mib N]
#                                              memory plan of those profiles (scripts/plan-memory.mjs):
#                                              steady and peak MiB from each container's mem_limit; with
#                                              --budget-mib it fails when the peak is larger (needs init)
#   compose/fbx-local.sh down                  stop and delete containers and volumes
#   compose/fbx-local.sh reset                 lighter reset between parity runs: delete every container
#                                              except the Kafka broker, and the PostgreSQL volume (Keycloak
#                                              realm and users, service databases; MongoDB data goes with
#                                              its container); keeps .env, .cache and Kafka topics; then
#                                              run `up` again
#   compose/fbx-local.sh config [profile ...]  docker compose config -q
#   compose/fbx-local.sh compose [args ...]    any docker compose command with the right files
#
# Profiles: lending, payments, customer, riskcompliance, openfinance, services, monolith,
# observability, parity-fixtures (needs `init --parity-fixtures`). openfinance starts the
# seven open-finance services and MongoDB, payments the payment services with consent,
# services starts all 15 services (compose/README.md has the table). Lanes (lanes.tsv):
# lending, payments, openfinance; each fits a 12 GiB machine with the monolith, services does not.
# Service images default to fintechbankx/<service>:local; override with the
# FBX_IMAGE_* / FBX_MONOLITH_IMAGE variables (see compose/services.tsv).
set -euo pipefail

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cmd="${1:-help}"; shift || true
service_env_override="$dir/.cache/service-env.override.json"
all_profiles="lending payments customer riskcompliance openfinance services monolith observability parity-fixtures"

dc() {
  local args=(compose --project-directory "$dir" --env-file "$dir/.env" -f "$dir/docker-compose.yml")
  [ -f "$service_env_override" ] && args+=(-f "$service_env_override")
  local p
  for p in ${FBX_PROFILES:-}; do args+=(--profile "$p"); done
  docker "${args[@]}" "$@"
}
# Re-fetches when an asset is missing, including the admin-permissions step of a
# realm that enables it (a cache from before that step existed).
assets_present() {
  local realm="$dir/.cache/identity/fintechbankx-realm.json"
  [ -f "$realm" ] && [ -f "$dir/.cache/kafka/topics/generated/topics.tsv" ] || return 1
  [ -f "$dir/.cache/identity-admin/admin-permissions.json" ] \
    || ! grep -Eq '"adminPermissionsEnabled"[[:space:]]*:[[:space:]]*true' "$realm"
}
ensure_assets() { assets_present || bash "$dir/scripts/fetch-platform-assets.sh"; }
lane_profiles() {
  local p
  p="$(awk -F '\t' -v lane="$1" '!/^#/ && $1 == lane { print $2 }' "$dir/lanes.tsv")"
  if [ -z "$p" ]; then
    echo "unknown lane '$1'; lanes: $(awk -F '\t' '!/^#/ && NF { printf "%s ", $1 }' "$dir/lanes.tsv")" >&2
    return 1
  fi
  echo "$p"
}
# Sets profiles from the arguments; --lane NAME stands for that lane's profiles.
resolve_profiles() {
  profiles=""
  while [ $# -gt 0 ]; do
    if [ "$1" = --lane ]; then
      [ -n "${2:-}" ] || { echo "--lane needs a lane name (compose/lanes.tsv)" >&2; exit 2; }
      profiles="$profiles $(lane_profiles "$2")"
      shift 2
    else
      profiles="$profiles $1"
      shift
    fi
  done
  profiles="${profiles# }"
}
ensure_env() { bash "$dir/scripts/init-env.sh" "$@"; }

case "$cmd" in
  fetch) bash "$dir/scripts/fetch-platform-assets.sh" "$@" ;;
  init) ensure_assets; ensure_env "$@" ;;
  service-env)
    [ -n "${1:-}" ] || { echo "usage: fbx-local.sh service-env FILE" >&2; exit 2; }
    if grep -qvE '^[[:space:]]*(#.*)?$' "$1"; then
      node "$dir/scripts/service-env.mjs" --in "$1" --out "$service_env_override" --services "$dir/services.tsv"
    else
      rm -f "$service_env_override"
    fi ;;
  up)
    resolve_profiles "$@"
    ensure_assets
    # keep parity actors generated by an earlier `init --parity-fixtures`
    if [[ " $profiles " == *" parity-fixtures "* ]]; then ensure_env --parity-fixtures; else ensure_env; fi
    FBX_PROFILES="$profiles" dc up -d --wait --wait-timeout "${FBX_WAIT_TIMEOUT:-600}" ;;
  plan)
    budget=0; rest=()
    while [ $# -gt 0 ]; do
      if [ "$1" = --budget-mib ]; then
        [ -n "${2:-}" ] || { echo "--budget-mib needs a number of MiB" >&2; exit 2; }
        budget="$2"; shift 2
      else
        rest+=("$1"); shift
      fi
    done
    resolve_profiles ${rest[@]+"${rest[@]}"}
    [ -f "$dir/.env" ] || { echo "plan: no .env yet; run compose/fbx-local.sh init first" >&2; exit 2; }
    FBX_PROFILES="$profiles" dc config --format json \
      | node "$dir/scripts/plan-memory.mjs" --config /dev/stdin --profiles "$profiles" --budget-mib "$budget" ;;
  down) FBX_PROFILES="$all_profiles" dc down -v --remove-orphans ;;
  reset)
    # Keycloak runs in dev mode without a volume: removing its container drops
    # the realm, so the next `up` re-imports it with the same generated values.
    mapfile -t reset_services < <(FBX_PROFILES="$all_profiles" dc config --services | grep -vx kafka)
    [ "${#reset_services[@]}" -gt 0 ] || { echo "reset: no services found" >&2; exit 1; }
    FBX_PROFILES="$all_profiles" dc rm -s -f -v "${reset_services[@]}"
    docker volume rm -f "${COMPOSE_PROJECT_NAME:-fintechbankx-local}_postgres-data" ;;
  config)
    ensure_assets
    if [[ " $* " == *" parity-fixtures "* ]]; then ensure_env --parity-fixtures; else ensure_env; fi
    FBX_PROFILES="$*" dc config -q ;;
  compose) dc "$@" ;;
  *) sed -n '2,33p' "$0"; [ "$cmd" = help ] ;;
esac
