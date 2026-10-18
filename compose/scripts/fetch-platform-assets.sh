#!/usr/bin/env bash
# Fetches the platform assets the local runtime consumes, into a git-ignored
# cache (never vendored, so the owning repos stay the single source):
#   identity: realm/fintechbankx-realm.json
#             (COPUR/fintechbankx-platform-identity-iam-keycloak-ldap), and when
#             the realm sets adminPermissionsEnabled also realm/admin-permissions.json
#             and scripts/realm/apply-admin-permissions.mjs (the import's second
#             step, run by the admin-permissions service) into identity-admin/,
#             outside the directory keycloak-config-cli imports (*.json)
#   kafka:    topics/generated/topics.tsv and scripts/kafka/create-topics.sh
#             (COPUR/fintechbankx-platform-event-streaming-kafka)
#
# Source per repo, first match wins:
#   FBX_IDENTITY_SOURCE / FBX_KAFKA_SOURCE  local checkout directory; with
#       FBX_IDENTITY_REF / FBX_KAFKA_REF set, files are read from that git ref
#   otherwise GitHub at FBX_IDENTITY_REF / FBX_KAFKA_REF (default main):
#     with a token, the contents API (the identity repo is private): the first of
#       FBX_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN, else `gh auth token`, needing
#       contents: read on both repos. The token reaches curl as a config line on
#       stdin (-K -), never in its arguments, a file or the output, and curl
#       follows no redirect with it.
#     without one, public raw content (fails for the private identity repo).
#
# usage: fetch-platform-assets.sh [--cache-dir DIR]
set -euo pipefail

compose_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cache="$compose_dir/.cache"
while [ $# -gt 0 ]; do
  case "$1" in
    --cache-dir) cache="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

die() { echo "[fetch-assets] ERROR: $*" >&2; exit 1; }

# The token for the first download from GitHub (none is needed for local checkouts).
token="" token_resolved=""
resolve_token() {
  [ -n "$token_resolved" ] && return 0
  token_resolved=1
  token="${FBX_GITHUB_TOKEN:-${GH_TOKEN:-${GITHUB_TOKEN:-}}}"
  if [ -z "$token" ] && command -v gh >/dev/null 2>&1; then
    token="$(gh auth token 2>/dev/null || true)"
  fi
  # GitHub tokens are [A-Za-z0-9_]; anything else could rewrite curl's config line.
  if [ -n "$token" ] && [[ ! "$token" =~ ^[A-Za-z0-9_]+$ ]]; then
    die "the GitHub token holds characters a GitHub token never has (value not shown)"
  fi
}

fetch() { # fetch <local-source> <ref> <github-repo> <path> <dest>
  local src="$1" ref="$2" gh_repo="$3" file="$4" dest="$5"
  [ -n "$src" ] || resolve_token
  mkdir -p "$(dirname "$dest")"
  if [ -n "$src" ]; then
    if [ -n "$ref" ]; then
      git -C "$src" show "$ref:$file" > "$dest" || die "cannot read $file at $ref in $src"
    else
      [ -f "$src/$file" ] || die "missing $src/$file"
      cp "$src/$file" "$dest"
    fi
  elif [ -n "$token" ]; then
    local code
    code="$(printf 'header = "Authorization: Bearer %s"\n' "$token" \
      | curl -sS --proto =https --max-redirs 0 --retry 3 -K - \
          -H 'Accept: application/vnd.github.raw' -H 'X-GitHub-Api-Version: 2022-11-28' \
          -o "$dest" -w '%{http_code}' "https://api.github.com/repos/$gh_repo/contents/$file?ref=${ref:-main}")" || code=000
    if [ "$code" != 200 ]; then
      rm -f "$dest"
      die "cannot download $file from $gh_repo@${ref:-main} (HTTP $code); the token needs contents: read on $gh_repo"
    fi
  else
    curl -sSfL --proto =https --proto-redir =https --retry 3 -o "$dest" "https://raw.githubusercontent.com/$gh_repo/${ref:-main}/$file" \
      || { rm -f "$dest"; die "cannot download $file from $gh_repo@${ref:-main} without a token; the identity repository is private: set FBX_GITHUB_TOKEN (contents: read), or point FBX_IDENTITY_SOURCE / FBX_KAFKA_SOURCE at a checkout"; }
  fi
  echo "[fetch-assets] $gh_repo:$file -> $dest"
}

# A ref goes into a URL and to git show: plain git ref characters only, starting
# with a letter or digit, no "..".
for name in FBX_IDENTITY_REF FBX_KAFKA_REF; do
  value="${!name:-}"
  if [ -n "$value" ] && { [[ ! "$value" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || [[ "$value" == *..* ]]; }; then
    die "$name must be a branch, tag or commit (letters, digits, . _ / -, starting with a letter or digit)"
  fi
done

identity_repo=COPUR/fintechbankx-platform-identity-iam-keycloak-ldap
kafka_repo=COPUR/fintechbankx-platform-event-streaming-kafka

realm="$cache/identity/fintechbankx-realm.json"
fetch "${FBX_IDENTITY_SOURCE:-}" "${FBX_IDENTITY_REF:-}" "$identity_repo" realm/fintechbankx-realm.json "$realm"
name="$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(r.realm))' "$realm" 2>/dev/null)" \
  || die "realm file is not valid JSON: $realm"
[ "$name" = "fintechbankx" ] || die "expected realm \"fintechbankx\" (platform contract), got \"$name\""

# Fine-grained admin permissions (Keycloak 26 FGAP v2): keycloak-config-cli
# cannot import them, so the identity repo applies them in a second step.
admin="$cache/identity-admin"
rm -rf "$admin"
fgap="$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(r.adminPermissionsEnabled===true))' "$realm")"
if [ "$fgap" = true ]; then
  # Both files are required once the realm enables admin permissions (fetch dies otherwise).
  echo "[fetch-assets] realm sets adminPermissionsEnabled: fetching the admin-permissions step"
  fetch "${FBX_IDENTITY_SOURCE:-}" "${FBX_IDENTITY_REF:-}" "$identity_repo" realm/admin-permissions.json "$admin/admin-permissions.json"
  fetch "${FBX_IDENTITY_SOURCE:-}" "${FBX_IDENTITY_REF:-}" "$identity_repo" scripts/realm/apply-admin-permissions.mjs "$admin/apply-admin-permissions.mjs"
  spec_realm="$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(r.realm))' "$admin/admin-permissions.json" 2>/dev/null)" \
    || die "admin-permissions.json is not valid JSON"
  [ "$spec_realm" = "$name" ] || die "admin-permissions.json targets realm \"$spec_realm\", expected \"$name\""
else
  echo "[fetch-assets] realm does not set adminPermissionsEnabled; no admin-permissions step"
fi

topics="$cache/kafka/topics/generated/topics.tsv"
fetch "${FBX_KAFKA_SOURCE:-}" "${FBX_KAFKA_REF:-}" "$kafka_repo" topics/generated/topics.tsv "$topics"
grep -qE '^evt\.[a-z]+\.' "$topics" || die "topic catalog has no evt.<ctx>.* topics: $topics"
script="$cache/kafka/scripts/kafka/create-topics.sh"
fetch "${FBX_KAFKA_SOURCE:-}" "${FBX_KAFKA_REF:-}" "$kafka_repo" scripts/kafka/create-topics.sh "$script"
head -1 "$script" | grep -q '^#!' || die "create-topics.sh does not look like a script"
