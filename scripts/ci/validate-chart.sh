#!/usr/bin/env bash
# Validates charts/fintechbankx-service: helm lint (strict) and helm template
# for every CI fixture and for the microservice skeleton values, kubeconform on
# the rendered manifests (core + CRD schemas), negative cases that must fail,
# helm-unittest suites (charts/fintechbankx-service/tests) and the strict-mTLS
# validator over the rendered output.
# Usage: scripts/ci/validate-chart.sh
#   needs helm with the helm-unittest plugin, kubeconform and node (HELM=/KUBECONFORM= override)
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
helm="${HELM:-helm}"
kubeconform="${KUBECONFORM:-kubeconform}"
kube_version="${KUBE_VERSION:-1.30.0}"
chart=charts/fintechbankx-service
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

kc() {
  "$kubeconform" -strict -summary -kubernetes-version "$kube_version" \
    -schema-location default \
    -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
    "$@"
}

for values in "$chart"/ci/*.yaml; do
  name="$(basename "$values" .yaml)"
  echo "[helm] lint + template with $values"
  "$helm" lint "$chart" --strict -f "$values"
  "$helm" template ci "$chart" --namespace lending --kube-version "$kube_version" -f "$values" > "$out/$name.yaml"
done

skeleton=templates/microservice/deploy/helm
for env in dev staging prod; do
  echo "[helm] template skeleton values ($env)"
  "$helm" template example-service "$chart" --namespace example --kube-version "$kube_version" \
    -f "$skeleton/values.yaml" -f "$skeleton/values-$env.yaml" \
    --set-string image.repository=example.invalid/fintechbankx/example-service --set-string image.tag=0123abc \
    > "$out/skeleton-$env.yaml"
done

echo "[kubeconform] rendered manifests"
kc "$out"/*.yaml

must_fail() {
  local why="$1"; shift
  if "$helm" template neg "$chart" --kube-version "$kube_version" -f "$chart/ci/dev-minimal-values.yaml" "$@" >/dev/null 2>&1; then
    echo "expected failure did not happen: $why"; exit 1
  fi
  echo "[negative] rejected as expected: $why"
}
must_fail "image tag latest" --set-string image.tag=latest
must_fail "malformed digest" --set-string image.digest=sha256:abc
must_fail "PDB minAvailable >= replicas" --set podDisruptionBudget.minAvailable=2
must_fail "sidecar injection disabled" --set istio.inject=false
must_fail "excludeInboundPorts annotation" --set-string 'podAnnotations.traffic\.sidecar\.istio\.io/excludeInboundPorts=8081'
must_fail "missing serviceId" --set-string serviceId=
if "$helm" lint "$chart" >/dev/null 2>&1; then
  echo "expected bare values.yaml to fail lint (required identity values)"; exit 1
fi
echo "[negative] bare values.yaml rejected as expected"

echo "[helm-unittest] $chart/tests"
"$helm" unittest "$chart"

echo "[strict-mtls] rendered manifests"
node scripts/validation/validate-strict-mtls.mjs --path "$out"

echo "chart validation passed"
