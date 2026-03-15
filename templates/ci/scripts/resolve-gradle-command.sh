#!/usr/bin/env bash
set -euo pipefail

if [[ -x "./gradlew" ]]; then
  echo "./gradlew"
elif command -v gradle >/dev/null 2>&1; then
  echo "gradle"
else
  echo "No Gradle executable found (expected ./gradlew or gradle in PATH)." >&2
  exit 1
fi
