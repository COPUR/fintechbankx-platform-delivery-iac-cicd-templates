#!/usr/bin/env bash
# Entry point for the shared local / ephemeral runtime.
#
#   compose/fbx-local.sh fetch                 platform assets -> compose/.cache (realm, topic catalog)
#   compose/fbx-local.sh init                  generate compose/.env and compose/realm.env (git-ignored)
#   compose/fbx-local.sh up [profile ...]      fetch (if missing) + init + docker compose up -d --wait
#   compose/fbx-local.sh down                  stop and delete containers and volumes
#   compose/fbx-local.sh config [profile ...]  docker compose config -q
#   compose/fbx-local.sh compose [args ...]    any docker compose command with the right files
#
# Profiles: lending, payments, customer, riskcompliance, services, monolith, observability.
# Service images default to fintechbankx/<service>:local; override with the
# FBX_IMAGE_* / FBX_MONOLITH_IMAGE variables (see compose/services.tsv).
set -euo pipefail

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cmd="${1:-help}"; shift || true

dc() {
  local args=(compose --project-directory "$dir" --env-file "$dir/.env" -f "$dir/docker-compose.yml")
  local p
  for p in ${FBX_PROFILES:-}; do args+=(--profile "$p"); done
  docker "${args[@]}" "$@"
}
ensure_assets() { [ -f "$dir/.cache/identity/fintechbankx-realm.json" ] && [ -f "$dir/.cache/kafka/topics/generated/topics.tsv" ] || bash "$dir/scripts/fetch-platform-assets.sh"; }
ensure_env() { bash "$dir/scripts/init-env.sh"; }

case "$cmd" in
  fetch) bash "$dir/scripts/fetch-platform-assets.sh" "$@" ;;
  init) ensure_assets; ensure_env ;;
  up) ensure_assets; ensure_env; FBX_PROFILES="$*" dc up -d --wait --wait-timeout "${FBX_WAIT_TIMEOUT:-600}" ;;
  down) FBX_PROFILES="lending payments customer riskcompliance services monolith observability" dc down -v --remove-orphans ;;
  config) ensure_assets; ensure_env; FBX_PROFILES="$*" dc config -q ;;
  compose) dc "$@" ;;
  *) sed -n '2,15p' "$0"; [ "$cmd" = help ] ;;
esac
