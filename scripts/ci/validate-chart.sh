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

# must_fail <why> [--expect <ERE>] <helm args...>: the render must fail and,
# with --expect, its error output must match the pattern, so a case cannot
# pass because the render failed for another reason.
expect_reason() {
  local why="$1" expect="$2" err="$3"
  if [ -n "$expect" ] && ! grep -qE -- "$expect" <<<"$err"; then
    echo "rejected, but not for the expected reason /$expect/: $why"
    head -n 5 <<<"$err"
    exit 1
  fi
}
must_fail() {
  local why="$1"; shift
  local expect="" err
  if [ "${1:-}" = "--expect" ]; then expect="$2"; shift 2; fi
  if err="$("$helm" template neg "$chart" --kube-version "$kube_version" -f "$chart/ci/dev-minimal-values.yaml" "$@" 2>&1 >/dev/null)"; then
    echo "expected failure did not happen: $why"; exit 1
  fi
  expect_reason "$why" "$expect" "$err"
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
must_fail "DB_URL materialised from the ExternalSecret" --expect 'externalSecret.data must not materialise DB_URL' --set-string environment=dev \
  --set-string 'externalSecret.remoteSecretName=dev/customer-profile-kyc-service/db-app' \
  --set-string 'externalSecret.data[0].secretKey=DB_URL' --set-string 'externalSecret.data[0].property=jdbc_url'
must_fail "DB_URL with a second sslmode" --expect 'config.DB_URL must set sslmode exactly once' \
  --set-string 'config.DB_URL=jdbc:postgresql://db.example.internal:5432/db?sslmode=verify-full&sslrootcert=/etc/fintechbankx/rds-ca/global-bundle.pem&sslmode=require'
must_fail "config.DB_URL that is not a PostgreSQL JDBC URL (skips the sslmode parse)" --expect 'config.DB_URL must be a jdbc:' \
  --set-string 'config.DB_URL=postgresql://db.example.internal:5432/db?sslmode=disable'
must_fail "config db.url (DB_URL in another spelling)" --expect 'config.db.url is DB_URL in another spelling' \
  --set-string 'config.db\.url=jdbc:postgresql://db.example.internal:5432/db?sslmode=verify-full&sslrootcert=/etc/fintechbankx/rds-ca/global-bundle.pem'
must_fail "extraEnv SPRING_DATASOURCE_URL" --expect 'extraEnv must not set SPRING_DATASOURCE_URL' \
  --set 'extraEnv[0].name=SPRING_DATASOURCE_URL' --set-string 'extraEnv[0].value=jdbc:postgresql://db.example.internal:5432/db?sslmode=require'
must_fail "extraEnv SPRING_R2DBC_URL from valueFrom" --expect 'extraEnv must not set SPRING_R2DBC_URL' \
  --set 'extraEnv[0].name=SPRING_R2DBC_URL' --set-string 'extraEnv[0].valueFrom.secretKeyRef.name=other' \
  --set-string 'extraEnv[0].valueFrom.secretKeyRef.key=url'
must_fail "javaToolOptions with -Dspring.datasource.url" --expect 'javaToolOptions must not mention' \
  --set-string 'javaToolOptions=-Dspring.datasource.url=jdbc:postgresql://db.example.internal:5432/db'
must_fail "extraEnv SPRING_PROFILES_ACTIVE" --expect 'extraEnv must not set SPRING_PROFILES_ACTIVE' \
  --set 'extraEnv[0].name=SPRING_PROFILES_ACTIVE' --set-string 'extraEnv[0].value=local'
must_fail "config SPRING_CONFIG_IMPORT" --expect 'config.SPRING_CONFIG_IMPORT is not allowed' \
  --set-string 'config.SPRING_CONFIG_IMPORT=optional:file:/tmp/override.yml'
must_fail "config spring.config.activate.on-profile (every spring.config.* name)" --expect 'config.spring.config.activate.on-profile is not allowed' \
  --set-string 'config.spring\.config\.activate\.on-profile=local'
must_fail "extraEnv SPRING_CONFIG_IMPORT_0_ (indexed spring.config.import)" --expect 'extraEnv must not set SPRING_CONFIG_IMPORT_0_' \
  --set 'extraEnv[0].name=SPRING_CONFIG_IMPORT_0_' --set-string 'extraEnv[0].value=optional:file:/tmp/override.yml'
must_fail "config SPRING_SSL_BUNDLE_PEM_DOCUMENTDB_TRUSTSTORE_CERTIFICATE (trust anchor override)" --expect 'config.SPRING_SSL_BUNDLE_PEM_DOCUMENTDB_TRUSTSTORE_CERTIFICATE is not allowed' \
  --set-string 'config.SPRING_SSL_BUNDLE_PEM_DOCUMENTDB_TRUSTSTORE_CERTIFICATE=file:/tmp/any-ca.pem'
must_fail "extraEnv DB_SSL_ROOT_CERT empty (replaces the chart's entry; TLS guard off switch)" --expect 'extraEnv must not set DB_SSL_ROOT_CERT' \
  --set 'extraEnv[0].name=DB_SSL_ROOT_CERT' --set-string 'extraEnv[0].value='
must_fail "config PGJDBC_SSL_FACTORY (sslfactory with a separator)" --expect 'config.PGJDBC_SSL_FACTORY is not allowed' \
  --set-string 'config.PGJDBC_SSL_FACTORY=org.postgresql.ssl.NonValidatingFactory'
must_fail "extraEnvFrom ConfigMap (keys the guard never sees)" --expect 'extraEnvFrom is not supported' \
  --set-string 'extraEnvFrom[0].configMapRef.name=other'
must_fail "javaToolOptions reading an argument file" --expect 'javaToolOptions must not mention' \
  --set-string 'javaToolOptions=@/tmp/jvm.args'
must_fail "javaToolOptions with -Dspring..config.import (empty element binds like spring.config.import)" --expect 'javaToolOptions must not mention' \
  --set-string 'javaToolOptions=-Dspring..config.import=optional:file:/tmp/override.yml'
must_fail "extraEnv JDK_JAVA_OPTIONS reading another variable through \$(VAR)" --expect 'extraEnv.JDK_JAVA_OPTIONS must not contain .[$][(]' \
  --set 'extraEnv[0].name=FBX_Y' --set-string 'extraEnv[0].valueFrom.secretKeyRef.name=other' \
  --set-string 'extraEnv[0].valueFrom.secretKeyRef.key=flags' \
  --set 'extraEnv[1].name=JDK_JAVA_OPTIONS' --set-string 'extraEnv[1].value=$(FBX_Y)'
must_fail "config.DB_URL with a Spring placeholder (\${...} can append sslmode=disable)" --expect 'config.DB_URL must not contain' \
  --set-string 'config.DB_URL=jdbc:postgresql://db.example.internal:5432/db?sslmode=verify-full&sslrootcert=/etc/fintechbankx/rds-ca/global-bundle.pem&x=${FBX_TAIL}'
must_fail "javaToolOptions with -Djava.security.properties (security properties file)" --expect 'javaToolOptions must not mention' \
  --set-string 'javaToolOptions=-Djava.security.properties==/tmp/override.security'
must_fail "config FINTECHBANKX_TLS_ENFORCE (service TLS assertion off switch)" --expect 'config.FINTECHBANKX_TLS_ENFORCE is not allowed' \
  --set-string 'config.FINTECHBANKX_TLS_ENFORCE=false'
must_fail "config SPRING_PROFILES_DEFAULT=local (every spring.profiles.* name)" --expect 'config.SPRING_PROFILES_DEFAULT is not allowed' \
  --set-string 'config.SPRING_PROFILES_DEFAULT=local'
must_fail "kafka.runtime outside the enum" --expect 'kafka.runtime' --set-string 'kafka.runtime=local'
must_fail "config KAFKA_SECURITY_PROTOCOL=PLAINTEXT (kafka.runtime msk)" --expect 'config.KAFKA_SECURITY_PROTOCOL must be SASL_SSL or SSL' \
  --set-string 'kafka.runtime=msk' --set-string 'config.KAFKA_SECURITY_PROTOCOL=PLAINTEXT'
must_fail "kafka.runtime strimzi with KAFKA_SECURITY_PROTOCOL=SASL_SSL" --expect 'must be SSL with kafka.runtime strimzi' \
  --set-string 'kafka.runtime=strimzi' --set-string 'config.KAFKA_SECURITY_PROTOCOL=SASL_SSL'
must_fail "config SPRING_KAFKA_SSL_TRUST_STORE_LOCATION (Kafka trust store)" --expect 'config.SPRING_KAFKA_SSL_TRUST_STORE_LOCATION is not allowed: a Kafka client TLS setting' \
  --set-string 'kafka.runtime=msk' --set-string 'config.SPRING_KAFKA_SSL_TRUST_STORE_LOCATION=file:/etc/other/any.jks'
must_fail "extraEnv SPRING_KAFKA_PRODUCER_PROPERTIES_SSL_TRUSTSTORE_CERTIFICATES from valueFrom" --expect 'extraEnv must not set SPRING_KAFKA_PRODUCER_PROPERTIES_SSL_TRUSTSTORE_CERTIFICATES' \
  --set 'extraEnv[0].name=SPRING_KAFKA_PRODUCER_PROPERTIES_SSL_TRUSTSTORE_CERTIFICATES' \
  --set-string 'extraEnv[0].valueFrom.configMapKeyRef.name=other' --set-string 'extraEnv[0].valueFrom.configMapKeyRef.key=ca'
must_fail "extraEnv KAFKA_TLS_CA as a literal (kafka.runtime strimzi)" --expect 'extraEnv KAFKA_TLS_CA must come from valueFrom.secretKeyRef' \
  --set-string 'kafka.runtime=strimzi' --set 'extraEnv[0].name=KAFKA_TLS_CA' --set-string 'extraEnv[0].value=-----BEGIN CERTIFICATE-----'
must_fail "config KAFKA_TLS_CERT (kafka.runtime strimzi)" --expect 'config.KAFKA_TLS_CERT is not allowed' \
  --set-string 'kafka.runtime=strimzi' --set-string 'config.KAFKA_TLS_CERT=-----BEGIN CERTIFICATE-----'
must_fail "config SPRING_DATA_MONGODB_URI (DocumentDB URI override)" --expect 'config.SPRING_DATA_MONGODB_URI is not allowed: a spring.data.mongodb.\* property' \
  --set-string 'config.SPRING_DATA_MONGODB_URI=mongodb://docdb.example.internal:27017/db?tls=false'
must_fail "extraEnv MONGODB_URI as a literal" --expect 'extraEnv MONGODB_URI must come from valueFrom.secretKeyRef' \
  --set 'extraEnv[0].name=MONGODB_URI' --set-string 'extraEnv[0].value=mongodb://docdb.example.internal:27017/db?tls=false'
must_fail "javaToolOptions with -Dspring.kafka.bootstrap-servers (kafka mention)" --expect 'javaToolOptions must not mention .*kafka' \
  --set-string 'javaToolOptions=-Dspring.kafka.bootstrap-servers=other.example.internal:9092'
must_fail "KAFKA_SECURITY_PROTOCOL=SSL without kafka.runtime (no auth profile)" --expect 'is set but kafka.runtime is empty' \
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
  local expect="" err
  if [ "${1:-}" = "--expect" ]; then expect="$2"; shift 2; fi
  if err="$("$helm" template vg "$vendored" "$@" 2>&1 >/dev/null)"; then
    echo "expected failure did not happen (vendored guard): $why"; exit 1
  fi
  expect_reason "$why" "$expect" "$err"
  echo "[vendored guard] rejected as expected: $why"
}
vendored_must_fail "SPRING_CONFIG_IMPORT_0_" --expect 'config.SPRING_CONFIG_IMPORT_0_ is not allowed' --set-string 'env.SPRING_CONFIG_IMPORT_0_=optional:file:/tmp/x.yml'
vendored_must_fail "DB_URL with sslmode=require" --expect 'config.DB_URL must use sslmode=verify-full' \
  --set-string 'env.DB_URL=jdbc:postgresql://db.example.internal:5432/db?sslmode=require'
vendored_must_fail "additionalEnv SPRING_SSL_BUNDLE_* from valueFrom" --expect 'extraEnv must not set SPRING_SSL_BUNDLE_PEM_DB_TRUSTSTORE_CERTIFICATE' \
  --set 'additionalEnv[0].name=SPRING_SSL_BUNDLE_PEM_DB_TRUSTSTORE_CERTIFICATE' \
  --set-string 'additionalEnv[0].valueFrom.configMapKeyRef.name=other' --set-string 'additionalEnv[0].valueFrom.configMapKeyRef.key=ca'
vendored_must_fail "secret key FINTECHBANKX_TLS_ENFORCE" --expect 'externalSecret.data must not materialise FINTECHBANKX_TLS_ENFORCE' \
  --set 'secrets.keys[0].secretKey=SPRING_DATASOURCE_PASSWORD' --set-string 'secrets.keys[0].property=password' \
  --set 'secrets.keys[1].secretKey=FINTECHBANKX_TLS_ENFORCE' --set-string 'secrets.keys[1].property=enforce'
cat > "$work/vg-config-key-newline.yaml" <<'VALUES'
env:
  "LOG_LEVEL: \"INFO\"\n  SPRING_CONFIG_IMPORT": "optional:file:/tmp/x.yml"
VALUES
vendored_must_fail "env key with a newline (injects SPRING_CONFIG_IMPORT)" --expect 'is not a ConfigMap key' -f "$work/vg-config-key-newline.yaml"
cat > "$work/vg-secret-key-newline.yaml" <<'VALUES'
secrets:
  enabled: true
  keys:
    - secretKey: "DB_PASSWORD\n      remoteRef: {key: x, property: password}\n    - secretKey: SPRING_DATASOURCE_URL"
      property: url
VALUES
vendored_must_fail "secret key with a newline (injects SPRING_DATASOURCE_URL)" --expect 'is not a Secret key' -f "$work/vg-secret-key-newline.yaml"
vendored_must_fail "jvmOptions reading a variable through \$(VAR)" --expect 'javaToolOptions must not contain' --set-string 'jvmOptions=-XX:MaxRAMPercentage=75 $(FBX_X)'
vendored_must_fail "secrets.dataFrom (every key of a remote secret)" --expect 'externalSecret.dataFrom is not supported' \
  --set-string 'secrets.dataFrom[0].extract.key=dev/example-service/app'
vendored_must_fail "additionalEnvFrom ConfigMap" --expect 'extraEnvFrom is not supported' \
  --set-string 'additionalEnvFrom[0].configMapRef.name=other'
vendored_must_fail "jvmOptions with -Dspring.profiles.active" --expect 'javaToolOptions must not mention' --set-string 'jvmOptions=-Dspring.profiles.active=local'
vendored_must_fail "KAFKA_SECURITY_PROTOCOL PLAINTEXT" --expect 'config.KAFKA_SECURITY_PROTOCOL must be SASL_SSL or SSL' --set-string 'env.KAFKA_SECURITY_PROTOCOL=PLAINTEXT'
vendored_must_fail "env spring.kafka.properties.ssl.truststore.location" --expect 'config.spring.kafka.properties.ssl.truststore.location is not allowed: a Kafka client TLS setting' \
  --set-string 'env.spring\.kafka\.properties\.ssl\.truststore\.location=/etc/other/any.jks'
vendored_must_fail "additionalEnv KAFKA_TLS_KEY from configMapKeyRef (strimzi)" --expect 'extraEnv KAFKA_TLS_KEY must come from valueFrom.secretKeyRef' \
  --set-string kafkaRuntime=strimzi --set-string env.KAFKA_SECURITY_PROTOCOL=SSL --set 'additionalEnv[0].name=KAFKA_TLS_KEY' \
  --set-string 'additionalEnv[0].valueFrom.configMapKeyRef.name=other' --set-string 'additionalEnv[0].valueFrom.configMapKeyRef.key=user.key'
vendored_must_fail "env spring.data.mongodb.uri" --expect 'config.spring.data.mongodb.uri is not allowed: a spring.data.mongodb.\* property' \
  --set-string 'env.spring\.data\.mongodb\.uri=mongodb://docdb.example.internal:27017/db?tls=false'
vendored_must_fail "secret key mongodb.uri (MONGODB_URI in another spelling)" --expect 'externalSecret.data mongodb.uri is not allowed' \
  --set 'secrets.keys[0].secretKey=SPRING_DATASOURCE_PASSWORD' --set-string 'secrets.keys[0].property=password' \
  --set 'secrets.keys[1].secretKey=mongodb.uri' --set-string 'secrets.keys[1].property=uri'
vendored_must_fail "jvmOptions with -DMONGODB_URI (mongodb mention)" --expect 'javaToolOptions must not mention .*mongodb' \
  --set-string 'jvmOptions=-DMONGODB_URI=mongodb://other.example.internal:27017/db'

echo "[helm-unittest] $chart/tests"
"$helm" unittest "$chart"

echo "[strict-mtls] rendered manifests"
node scripts/validation/validate-strict-mtls.mjs --path "$out"

echo "chart validation passed"
