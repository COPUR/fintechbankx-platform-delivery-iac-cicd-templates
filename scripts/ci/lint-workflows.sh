#!/usr/bin/env bash
# Lints every GitHub Actions workflow in this repository with actionlint:
#   1. the reusable and repo workflows in .github/workflows
#   2. the sample callers, re-pointed at the local reusable workflows so that
#      actionlint checks their inputs, outputs and permissions against them
#   3. the remaining GitHub templates as standalone files
# Usage: scripts/ci/lint-workflows.sh   (needs actionlint on PATH or ACTIONLINT=...)
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
actionlint="${ACTIONLINT:-actionlint}"

echo "[actionlint] .github/workflows"
"$actionlint" .github/workflows/*.yml

callers=(templates/github/workflows/*.yml templates/ci/github/workflows/*.yml templates/microservice/.github/workflows/*.yml)
generated=()
cleanup() { rm -f "${generated[@]}"; }
trap cleanup EXIT
for f in "${callers[@]}"; do
  out=".github/workflows/zz-lint-$(echo "$f" | tr '/' '-')"
  sed -E 's#COPUR/fintechbankx-platform-delivery-iac-cicd-templates/(\.github/workflows/[a-z0-9-]+\.yml)@[A-Za-z0-9._/-]+#./\1#' "$f" > "$out"
  generated+=("$out")
done
echo "[actionlint] sample callers against local reusable workflows: ${callers[*]}"
"$actionlint" "${generated[@]}"

echo "[actionlint] legacy reference copy (informational, not a gate)"
"$actionlint" templates/legacy/monorepo/github-ci.yml || echo "legacy copy has findings; it is not used as a gate"

echo "workflow lint passed"
