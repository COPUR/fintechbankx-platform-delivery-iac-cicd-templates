#!/usr/bin/env bash
# Validates charts/fintechbankx-service: helm lint (strict) and helm template
# for every CI fixture and for the microservice skeleton values, kubeconform on
# the rendered manifests (core + CRD schemas), negative cases that must fail,
# the vendored-guard smoke chart (scripts/ci/fixtures/vendored-guard-chart),
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
work="$(mktemp -d)"
trap 'rm -rf "$out" "$work"' EXIT

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
must_fail "config.DB_URL that is not a PostgreSQL JDBC URL (skips the sslmode parse)" \
  --set-string 'config.DB_URL=postgresql://db.example.internal:5432/db?sslmode=disable'
must_fail "config db.url (DB_URL in another spelling)" \
  --set-string 'config.db\.url=jdbc:postgresql://db.example.internal:5432/db?sslmode=disable'
must_fail "extraEnv SPRING_DATASOURCE_URL" \
  --set 'extraEnv[0].name=SPRING_DATASOURCE_URL' --set-string 'extraEnv[0].value=jdbc:postgresql://db.example.internal:5432/db?sslmode=require'
must_fail "extraEnv SPRING_R2DBC_URL from valueFrom" \
  --set 'extraEnv[0].name=SPRING_R2DBC_URL' --set-string 'extraEnv[0].valueFrom.secretKeyRef.name=other' \
  --set-string 'extraEnv[0].valueFrom.secretKeyRef.key=url'
must_fail "javaToolOptions with -Dspring.datasource.url" \
  --set-string 'javaToolOptions=-Dspring.datasource.url=jdbc:postgresql://db.example.internal:5432/db'
must_fail "extraEnv SPRING_PROFILES_ACTIVE" \
  --set 'extraEnv[0].name=SPRING_PROFILES_ACTIVE' --set-string 'extraEnv[0].value=local'
must_fail "config SPRING_CONFIG_IMPORT" \
  --set-string 'config.SPRING_CONFIG_IMPORT=optional:file:/tmp/override.yml'
must_fail "config spring.config.activate.on-profile (every spring.config.* name)" \
  --set-string 'config.spring\.config\.activate\.on-profile=local'
must_fail "extraEnv SPRING_CONFIG_IMPORT_0_ (indexed spring.config.import)" \
  --set 'extraEnv[0].name=SPRING_CONFIG_IMPORT_0_' --set-string 'extraEnv[0].value=optional:file:/tmp/override.yml'
must_fail "config SPRING_SSL_BUNDLE_PEM_DOCUMENTDB_TRUSTSTORE_CERTIFICATE (trust anchor override)" \
  --set-string 'config.SPRING_SSL_BUNDLE_PEM_DOCUMENTDB_TRUSTSTORE_CERTIFICATE=file:/tmp/any-ca.pem'
must_fail "extraEnv DB_SSL_ROOT_CERT empty (replaces the chart's entry; TLS guard off switch)" \
  --set 'extraEnv[0].name=DB_SSL_ROOT_CERT' --set-string 'extraEnv[0].value='
must_fail "config PGJDBC_SSL_FACTORY (sslfactory with a separator)" \
  --set-string 'config.PGJDBC_SSL_FACTORY=org.postgresql.ssl.NonValidatingFactory'
must_fail "extraEnvFrom ConfigMap (keys the guard never sees)" \
  --set-string 'extraEnvFrom[0].configMapRef.name=other'
must_fail "javaToolOptions reading an argument file" \
  --set-string 'javaToolOptions=@/tmp/jvm.args'
must_fail "javaToolOptions with -Djava.security.properties (security properties file)" \
  --set-string 'javaToolOptions=-Djava.security.properties==/tmp/override.security'
must_fail "config FINTECHBANKX_TLS_ENFORCE (service TLS assertion off switch)" \
  --set-string 'config.FINTECHBANKX_TLS_ENFORCE=false'
must_fail "config SPRING_PROFILES_DEFAULT=local (every spring.profiles.* name)" \
  --set-string 'config.SPRING_PROFILES_DEFAULT=local'
must_fail "kafka.runtime outside the enum" --set-string 'kafka.runtime=local'
must_fail "config KAFKA_SECURITY_PROTOCOL=PLAINTEXT" \
  --set-string 'config.KAFKA_SECURITY_PROTOCOL=PLAINTEXT'
must_fail "kafka.runtime strimzi with KAFKA_SECURITY_PROTOCOL=SASL_SSL" \
  --set-string 'kafka.runtime=strimzi' --set-string 'config.KAFKA_SECURITY_PROTOCOL=SASL_SSL'
must_fail "KAFKA_SECURITY_PROTOCOL=SSL without kafka.runtime (no auth profile)" \
  --set-string 'config.KAFKA_SECURITY_PROTOCOL=SSL'
must_fail "public IPv6 egress CIDR broader than /48 (2001:db8::/32)" --set networkPolicy.enabled=true \
  --set-string 'networkPolicy.egressCidrs[0].cidr=2001:db8::/32' --set 'networkPolicy.egressCidrs[0].ports[0]=443'
if "$helm" lint "$chart" >/dev/null 2>&1; then
  echo "expected bare values.yaml to fail lint (required identity values)"; exit 1
fi
echo "[negative] bare values.yaml rejected as expected"

# The guard is meant to be vendored: copy _helpers.tpl unchanged into a chart
# with other value names and call fbx.guard through an adapter dict
# (README "Vendoring the guard").
vendored="$work/vendored-guard-chart"
cp -R scripts/ci/fixtures/vendored-guard-chart "$vendored"
cp "$chart/templates/_helpers.tpl" "$vendored/templates/_helpers.tpl"
echo "[vendored guard] renders with the adapter dict"
"$helm" template vg "$vendored" > /dev/null
vendored_must_fail() {
  local why="$1"; shift
  if "$helm" template vg "$vendored" "$@" >/dev/null 2>&1; then
    echo "expected failure did not happen (vendored guard): $why"; exit 1
  fi
  echo "[vendored guard] rejected as expected: $why"
}
vendored_must_fail "SPRING_CONFIG_IMPORT_0_" --set-string 'env.SPRING_CONFIG_IMPORT_0_=optional:file:/tmp/x.yml'
vendored_must_fail "DB_URL with sslmode=require" \
  --set-string 'env.DB_URL=jdbc:postgresql://db.example.internal:5432/db?sslmode=require'
vendored_must_fail "additionalEnv SPRING_SSL_BUNDLE_* from valueFrom" \
  --set 'additionalEnv[0].name=SPRING_SSL_BUNDLE_PEM_DB_TRUSTSTORE_CERTIFICATE' \
  --set-string 'additionalEnv[0].valueFrom.configMapKeyRef.name=other' --set-string 'additionalEnv[0].valueFrom.configMapKeyRef.key=ca'
vendored_must_fail "secret key FINTECHBANKX_TLS_ENFORCE" \
  --set 'secrets.keys[1].secretKey=FINTECHBANKX_TLS_ENFORCE' --set-string 'secrets.keys[1].property=enforce'
vendored_must_fail "jvmOptions with -Dspring.profiles.active" --set-string 'jvmOptions=-Dspring.profiles.active=local'
vendored_must_fail "KAFKA_SECURITY_PROTOCOL PLAINTEXT" --set-string 'env.KAFKA_SECURITY_PROTOCOL=PLAINTEXT'

echo "[helm-unittest] $chart/tests"
"$helm" unittest "$chart"

echo "[strict-mtls] rendered manifests"
node scripts/validation/validate-strict-mtls.mjs --path "$out"

echo "chart validation passed"
