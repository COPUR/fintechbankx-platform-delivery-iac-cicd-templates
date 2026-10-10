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
must_fail "extraData secret of another service" \
  --set 'externalSecret.extraData[0].secretKey=X' \
  --set-string 'externalSecret.extraData[0].remoteSecretName=dev/other-service/oidc-client' \
  --set-string 'externalSecret.extraData[0].property=client_secret'
must_fail "remoteSecretName of another service" \
  --set-string 'externalSecret.remoteSecretName=dev/other-service/db-app'
must_fail "any-address egress CIDR" --set networkPolicy.enabled=true \
  --set-string 'networkPolicy.egressCidrs[0].cidr=0.0.0.0/0' --set 'networkPolicy.egressCidrs[0].ports[0]=443'
must_fail "egress CIDR split into halves (0.0.0.0/1, shorter than /8)" --set networkPolicy.enabled=true \
  --set-string 'networkPolicy.egressCidrs[0].cidr=0.0.0.0/1' --set 'networkPolicy.egressCidrs[0].ports[0]=443' \
  --set-string 'networkPolicy.egressCidrs[1].cidr=128.0.0.0/1' --set 'networkPolicy.egressCidrs[1].ports[0]=443'
must_fail "public IPv4 egress CIDR broader than /16 (11.0.0.0/8)" --set networkPolicy.enabled=true \
  --set-string 'networkPolicy.egressCidrs[0].cidr=11.0.0.0/8' --set 'networkPolicy.egressCidrs[0].ports[0]=443'
must_fail "IPv4-mapped IPv6 egress CIDR (::ffff:0:0/96)" --set networkPolicy.enabled=true \
  --set-string 'networkPolicy.egressCidrs[0].cidr=::ffff:0:0/96' --set 'networkPolicy.egressCidrs[0].ports[0]=443'
must_fail "NAT64 egress CIDR (64:ff9b::/96)" --set networkPolicy.enabled=true \
  --set-string 'networkPolicy.egressCidrs[0].cidr=64:ff9b::/96' --set 'networkPolicy.egressCidrs[0].ports[0]=443'
must_fail "DB_URL materialised from the ExternalSecret" --set-string environment=dev \
  --set-string 'externalSecret.remoteSecretName=dev/customer-profile-kyc-service/db-app' \
  --set-string 'externalSecret.data[0].secretKey=DB_URL' --set-string 'externalSecret.data[0].property=jdbc_url'
must_fail "DB_URL with a second sslmode" \
  --set-string 'config.DB_URL=jdbc:postgresql://db.example.internal:5432/db?sslmode=verify-full&sslrootcert=/etc/fintechbankx/rds-ca/global-bundle.pem&sslmode=require'
must_fail "extraEnv SPRING_DATASOURCE_URL" \
  --set 'extraEnv[0].name=SPRING_DATASOURCE_URL' --set-string 'extraEnv[0].value=jdbc:postgresql://db.example.internal:5432/db?sslmode=require'
must_fail "extraEnv SPRING_R2DBC_URL from valueFrom" \
  --set 'extraEnv[0].name=SPRING_R2DBC_URL' --set-string 'extraEnv[0].valueFrom.secretKeyRef.name=other' \
  --set-string 'extraEnv[0].valueFrom.secretKeyRef.key=url'
must_fail "javaToolOptions with -Dspring.datasource.url" \
  --set-string 'javaToolOptions=-Dspring.datasource.url=jdbc:postgresql://db.example.internal:5432/db'
must_fail "public IPv6 egress CIDR broader than /48 (2001:db8::/32)" --set networkPolicy.enabled=true \
  --set-string 'networkPolicy.egressCidrs[0].cidr=2001:db8::/32' --set 'networkPolicy.egressCidrs[0].ports[0]=443'
if "$helm" lint "$chart" >/dev/null 2>&1; then
  echo "expected bare values.yaml to fail lint (required identity values)"; exit 1
fi
echo "[negative] bare values.yaml rejected as expected"

echo "[helm-unittest] $chart/tests"
"$helm" unittest "$chart"

echo "[strict-mtls] rendered manifests"
node scripts/validation/validate-strict-mtls.mjs --path "$out"

echo "chart validation passed"
