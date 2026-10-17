#!/usr/bin/env bash
# Validates charts/fintechbankx-service: helm lint (strict) and helm template
# for every CI fixture and for the microservice skeleton values, kubeconform on
# the rendered manifests (core + CRD schemas), negative cases that must fail,
# the vendored-guard smoke chart (scripts/ci/fixtures/vendored-guard-chart, also
# checked with scripts/ci/verify-vendored-guard.sh),
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
  --set-string 'config.SPRING_CONFIG_IMPORT=optional:file:./override.yml'
must_fail "config spring.config.activate.on-profile (every spring.config.* name)" --expect 'config.spring.config.activate.on-profile is not allowed' \
  --set-string 'config.spring\.config\.activate\.on-profile=local'
must_fail "extraEnv SPRING_CONFIG_IMPORT_0_ (indexed spring.config.import)" --expect 'extraEnv must not set SPRING_CONFIG_IMPORT_0_' \
  --set 'extraEnv[0].name=SPRING_CONFIG_IMPORT_0_' --set-string 'extraEnv[0].value=optional:file:./override.yml'
must_fail "config SPRING_SSL_BUNDLE_PEM_DOCUMENTDB_TRUSTSTORE_CERTIFICATE (trust anchor override)" --expect 'config.SPRING_SSL_BUNDLE_PEM_DOCUMENTDB_TRUSTSTORE_CERTIFICATE is not allowed' \
  --set-string 'config.SPRING_SSL_BUNDLE_PEM_DOCUMENTDB_TRUSTSTORE_CERTIFICATE=file:./any-ca.pem'
must_fail "extraEnv DB_SSL_ROOT_CERT empty (replaces the chart's entry; TLS guard off switch)" --expect 'extraEnv must not set DB_SSL_ROOT_CERT' \
  --set 'extraEnv[0].name=DB_SSL_ROOT_CERT' --set-string 'extraEnv[0].value='
must_fail "config PGJDBC_SSL_FACTORY (sslfactory with a separator)" --expect 'config.PGJDBC_SSL_FACTORY is not allowed' \
  --set-string 'config.PGJDBC_SSL_FACTORY=org.postgresql.ssl.NonValidatingFactory'
must_fail "extraEnvFrom ConfigMap (keys the guard never sees)" --expect 'extraEnvFrom is not supported' \
  --set-string 'extraEnvFrom[0].configMapRef.name=other'
must_fail "javaToolOptions reading an argument file" --expect 'javaToolOptions must not mention' \
  --set-string 'javaToolOptions=@./jvm.args'
must_fail "javaToolOptions with -Dspring..config.import (empty element binds like spring.config.import)" --expect 'javaToolOptions must not mention' \
  --set-string 'javaToolOptions=-Dspring..config.import=optional:file:./override.yml'
must_fail "extraEnv JDK_JAVA_OPTIONS reading another variable through \$(VAR)" --expect 'extraEnv.JDK_JAVA_OPTIONS must not contain .[$][(]' \
  --set 'extraEnv[0].name=FBX_Y' --set-string 'extraEnv[0].valueFrom.secretKeyRef.name=other' \
  --set-string 'extraEnv[0].valueFrom.secretKeyRef.key=flags' \
  --set 'extraEnv[1].name=JDK_JAVA_OPTIONS' --set-string 'extraEnv[1].value=$(FBX_Y)'
must_fail "config.DB_URL with a Spring placeholder (\${...} can append sslmode=disable)" --expect 'config.DB_URL must not contain' \
  --set-string 'config.DB_URL=jdbc:postgresql://db.example.internal:5432/db?sslmode=verify-full&sslrootcert=/etc/fintechbankx/rds-ca/global-bundle.pem&x=${FBX_TAIL}'
must_fail "javaToolOptions with -Djava.security.properties (security properties file)" --expect 'javaToolOptions must not mention' \
  --set-string 'javaToolOptions=-Djava.security.properties==./override.security'
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
# Spring Boot's property mapper splits an env name on '.' only and drops '_'
# inside an element, so these bind spring.kafka.ssl.*, spring.data.mongodb.*
# and spring.profiles.active (fbx.propertyName).
must_fail "config spring.kafka.s_sl.trust-store-type ('_' inside an element binds as ssl)" \
  --expect 'config.spring.kafka.s_sl.trust-store-type is not allowed: a Kafka client TLS setting' \
  --set-string 'kafka.runtime=strimzi' --set-string 'config.KAFKA_SECURITY_PROTOCOL=SSL' \
  --set-string 'config.spring\.kafka\.s_sl\.trust-store-type=PKCS12'
must_fail "externalSecret.extraData spring.data.mongo_db.host ('_' inside an element binds as mongodb)" \
  --expect 'externalSecret.extraData must not materialise spring.data.mongo_db.host' \
  --set-string 'externalSecret.extraData[0].secretKey=spring.data.mongo_db.host' \
  --set-string 'externalSecret.extraData[0].remoteSecretName=dev/customer-profile-kyc-service/docdb' \
  --set-string 'externalSecret.extraData[0].property=host'
must_fail "config spring.pro_files.active ('_' inside an element binds as profiles)" \
  --expect 'config.spring.pro_files.active is not allowed' --set-string 'config.spring\.pro_files\.active=local'
# spring.main.* is bound onto the SpringApplication (lazy-initialization moves
# a check made when a bean is created from startup to first use, sources and
# allow-bean-definition-overriding load and replace beans), and Kafka SASL /
# JAAS names replace the client's login module; both families are refused by
# prefix on every route, -Djava.security.auth.login.config in JVM options.
must_fail "config SPRING_MAIN_LAZY_INITIALIZATION (spring.main.* by prefix)" \
  --expect 'config.SPRING_MAIN_LAZY_INITIALIZATION is not allowed: a spring.main.\* property' \
  --set-string 'config.SPRING_MAIN_LAZY_INITIALIZATION=true'
must_fail "extraEnv spring.main.sources from valueFrom" --expect 'extraEnv must not set spring.main.sources' \
  --set 'extraEnv[0].name=spring.main.sources' --set-string 'extraEnv[0].valueFrom.configMapKeyRef.name=other' \
  --set-string 'extraEnv[0].valueFrom.configMapKeyRef.key=sources'
must_fail "javaToolOptions with -Dspring.main.lazy-initialization" --expect 'javaToolOptions must not mention .*spring.main' \
  --set-string 'javaToolOptions=-Dspring.main.lazy-initialization=true'
must_fail "config SPRING_KAFKA_PROPERTIES_SASL_JAAS_CONFIG (Kafka SASL login module)" \
  --expect 'config.SPRING_KAFKA_PROPERTIES_SASL_JAAS_CONFIG is not allowed: a Kafka SASL or JAAS setting' \
  --set-string 'config.SPRING_KAFKA_PROPERTIES_SASL_JAAS_CONFIG=x.LoginModule required;'
must_fail "externalSecret.data SPRING_KAFKA_JAAS_ENABLED (JVM-wide JAAS login module)" \
  --expect 'externalSecret.data must not materialise SPRING_KAFKA_JAAS_ENABLED' \
  --set-string 'externalSecret.data[0].secretKey=SPRING_KAFKA_JAAS_ENABLED' --set-string 'externalSecret.data[0].property=jaas'
must_fail "javaToolOptions with -Djava.security.auth.login.config (JVM-wide JAAS file)" \
  --expect 'javaToolOptions must not mention .*java.security.auth' \
  --set-string 'javaToolOptions=-Djava.security.auth.login.config=./client.conf'
# Schema management (spring.jpa.*, spring.sql.init.*, hibernate.*,
# jakarta/javax.persistence.*) would let the service create, change or drop its
# schema at startup with its runtime role; refused by prefix on every route and
# in JVM options.
must_fail "config SPRING_JPA_HIBERNATE_DDL_AUTO (schema management)" \
  --expect 'config.SPRING_JPA_HIBERNATE_DDL_AUTO is not allowed: a schema-management setting' \
  --set-string 'config.SPRING_JPA_HIBERNATE_DDL_AUTO=create-drop'
must_fail "externalSecret.data hibernate.hbm2ddl.auto" \
  --expect 'externalSecret.data must not materialise hibernate.hbm2ddl.auto' \
  --set-string 'externalSecret.data[0].secretKey=hibernate.hbm2ddl.auto' --set-string 'externalSecret.data[0].property=ddl'
must_fail "javaToolOptions with -Djakarta.persistence.schema-generation.database.action" \
  --expect 'javaToolOptions must not mention .*jakarta.persistence' \
  --set-string 'javaToolOptions=-Djakarta.persistence.schema-generation.database.action=drop-and-create'
# The database CA mount is pinned (fbx.validateDatabaseCa): /app is the image
# WORKDIR and Spring Boot loads optional:file:./config/application.yml, and
# another ConfigMap or key replaces the database trust anchor.
must_fail "databaseCa.mountPath /app/config (a ConfigMap where Spring Boot reads config files)" \
  --expect 'databaseCa.mountPath must be /etc/fintechbankx/rds-ca' --set-string 'databaseCa.mountPath=/app/config'
must_fail "databaseCa.key other than global-bundle.pem" \
  --expect 'databaseCa.key must be global-bundle.pem' --set-string 'databaseCa.key=other-bundle.pem'
must_fail "databaseCa.configMapName other than rds-ca-bundle (replaces the trust anchor)" \
  --expect 'databaseCa.configMapName must be rds-ca-bundle' --set-string 'databaseCa.configMapName=any-config'
must_fail "databaseCa.configMapName null (Helm deletes the key; the volume would name no ConfigMap)" \
  --expect 'databaseCa.configMapName is required while databaseCa.enabled' --set 'databaseCa.configMapName=null'
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
# The check a service chart's CI runs on its vendored copy (README step 1):
# one header-less copy with the pinned digest, no other fbx.* definition, and
# the guard first in every workload template.
echo "[vendored guard] verify-vendored-guard.sh"
bash scripts/ci/verify-vendored-guard.sh "$vendored" "$(sha256sum "$chart/templates/_helpers.tpl" | cut -d' ' -f1)"
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
vendored_must_fail "SPRING_CONFIG_IMPORT_0_" --expect 'config.SPRING_CONFIG_IMPORT_0_ is not allowed' --set-string 'env.SPRING_CONFIG_IMPORT_0_=optional:file:./x.yml'
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
  "LOG_LEVEL: \"INFO\"\n  SPRING_CONFIG_IMPORT": "optional:file:./x.yml"
VALUES
vendored_must_fail "env key with a newline (injects SPRING_CONFIG_IMPORT)" --expect 'is not a ConfigMap key' -f "$work/vg-config-key-newline.yaml"
cat > "$work/vg-es-key-newline.yaml" <<'VALUES'
secrets:
  enabled: true
  keys:
    - secretKey: "DB_PASSWORD\n      remoteRef: {key: x, property: password}\n    - secretKey: SPRING_DATASOURCE_URL"
      property: url
VALUES
vendored_must_fail "secret key with a newline (injects SPRING_DATASOURCE_URL)" --expect 'is not a Secret key' -f "$work/vg-es-key-newline.yaml"
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
vendored_must_fail "env spring.data.mongo_db.uri ('_' inside an element)" --expect 'config.spring.data.mongo_db.uri is not allowed: a spring.data.mongodb.\* property' \
  --set-string 'env.spring\.data\.mongo_db\.uri=mongodb://docdb.example.internal:27017/db?tls=false'
vendored_must_fail "additionalEnv spring.kafka.consumer.s_sl.trust-store-type from valueFrom ('_' inside an element)" \
  --expect 'extraEnv must not set spring.kafka.consumer.s_sl.trust-store-type' \
  --set 'additionalEnv[0].name=spring.kafka.consumer.s_sl.trust-store-type' \
  --set-string 'additionalEnv[0].valueFrom.secretKeyRef.name=other' --set-string 'additionalEnv[0].valueFrom.secretKeyRef.key=type'
vendored_must_fail "env SPRING_MAIN_LAZYINITIALIZATION (spring.main.*)" \
  --expect 'config.SPRING_MAIN_LAZYINITIALIZATION is not allowed: a spring.main.\* property' \
  --set-string 'env.SPRING_MAIN_LAZYINITIALIZATION=true'
vendored_must_fail "env spring.main.sources (an XML file of bean definitions)" \
  --expect 'config.spring.main.sources is not allowed: a spring.main.\* property' \
  --set-string 'env.spring\.main\.sources=file:./beans.xml'
vendored_must_fail "additionalEnv spring.ma_in.allow-bean-definition-overriding from valueFrom ('_' inside an element)" \
  --expect 'extraEnv must not set spring.ma_in.allow-bean-definition-overriding' \
  --set 'additionalEnv[0].name=spring.ma_in.allow-bean-definition-overriding' \
  --set-string 'additionalEnv[0].valueFrom.secretKeyRef.name=other' --set-string 'additionalEnv[0].valueFrom.secretKeyRef.key=abdo'
vendored_must_fail "secret key SPRING_MAIN_SOURCES_0_ (indexed spring.main.sources)" \
  --expect 'externalSecret.data must not materialise SPRING_MAIN_SOURCES_0_' \
  --set 'secrets.keys[0].secretKey=SPRING_DATASOURCE_PASSWORD' --set-string 'secrets.keys[0].property=password' \
  --set 'secrets.keys[1].secretKey=SPRING_MAIN_SOURCES_0_' --set-string 'secrets.keys[1].property=sources'
vendored_must_fail "jvmOptions with -Dspring[main].lazy-initialization" --expect 'javaToolOptions must not mention .*mongodb, spring.main' \
  --set-string 'jvmOptions=-Dspring[main].lazy-initialization=true'
vendored_must_fail "env SPRING_JPA_GENERATE_DDL (schema management)" \
  --expect 'config.SPRING_JPA_GENERATE_DDL is not allowed: a schema-management setting' \
  --set-string 'env.SPRING_JPA_GENERATE_DDL=true'
vendored_must_fail "additionalEnv spring.sql.init.mode from valueFrom" \
  --expect 'extraEnv must not set spring.sql.init.mode' \
  --set 'additionalEnv[0].name=spring.sql.init.mode' \
  --set-string 'additionalEnv[0].valueFrom.secretKeyRef.name=other' --set-string 'additionalEnv[0].valueFrom.secretKeyRef.key=mode'
vendored_must_fail "jvmOptions with -Dhibernate.hbm2ddl.auto" --expect 'javaToolOptions must not mention .*hibernate' \
  --set-string 'jvmOptions=-Dhibernate.hbm2ddl.auto=update'
# Spring skips a ']' that closes no '[': spring.J]PA.generate-ddl binds spring.jpa.generate-ddl.
vendored_must_fail "additionalEnv spring.J]PA.generate-ddl (unmatched bracket)" \
  --expect 'extraEnv must not set spring.J\]PA.generate-ddl' \
  --set-string 'additionalEnv[0].name=spring.J]PA.generate-ddl' --set-string 'additionalEnv[0].value=true'
vendored_must_fail "env SPRING_KAFKA_PROPERTIES_SASL_MECHANISM (Kafka SASL)" \
  --expect 'config.SPRING_KAFKA_PROPERTIES_SASL_MECHANISM is not allowed: a Kafka SASL or JAAS setting' \
  --set-string 'env.SPRING_KAFKA_PROPERTIES_SASL_MECHANISM=PLAIN'
vendored_must_fail "env SPRING_KAFKA_PROPERTIES_SASLJAASCONFIG (no boundary after sasl)" \
  --expect 'config.SPRING_KAFKA_PROPERTIES_SASLJAASCONFIG is not allowed: a Kafka SASL or JAAS setting' \
  --set-string 'env.SPRING_KAFKA_PROPERTIES_SASLJAASCONFIG=x'
vendored_must_fail "additionalEnv spring.kafka.consumer.properties[sasl.jaas.config] (value)" \
  --expect 'extraEnv must not set spring.kafka.consumer.properties\[sasl.jaas.config\]' \
  --set-json 'additionalEnv=[{"name": "spring.kafka.consumer.properties[sasl.jaas.config]", "value": "x.LoginModule required;"}]'
vendored_must_fail "secret key spring.kafka.jaas.options.password (JAAS login module option)" \
  --expect 'externalSecret.data must not materialise spring.kafka.jaas.options.password' \
  --set 'secrets.keys[0].secretKey=SPRING_DATASOURCE_PASSWORD' --set-string 'secrets.keys[0].property=password' \
  --set 'secrets.keys[1].secretKey=spring.kafka.jaas.options.password' --set-string 'secrets.keys[1].property=kafka_password'
vendored_must_fail "jvmOptions with -Djava.security.auth.login.config (JVM-wide JAAS file)" \
  --expect 'javaToolOptions must not mention .*java.security.auth' \
  --set-string 'jvmOptions=-Djava.security.auth.login.config=./client.conf'
vendored_must_fail "databaseCaBundle.mountPath /app/config with key application.yml (a Spring Boot config file)" \
  --expect 'databaseCa.mountPath must be /etc/fintechbankx/rds-ca' \
  --set-string 'databaseCaBundle.mountPath=/app/config' --set-string 'databaseCaBundle.key=application.yml' \
  --set-string 'env.DB_URL=jdbc:postgresql://db.example.internal:5432/db?sslmode=verify-full&sslrootcert=/app/config/application.yml'
vendored_must_fail "databaseCaBundle.key application.yml" --expect 'databaseCa.key must be global-bundle.pem' \
  --set-string 'databaseCaBundle.key=application.yml' \
  --set-string 'env.DB_URL=jdbc:postgresql://db.example.internal:5432/db?sslmode=verify-full&sslrootcert=/etc/fintechbankx/rds-ca/application.yml'
vendored_must_fail "databaseCaBundle.configMapName other than rds-ca-bundle" --expect 'databaseCa.configMapName must be rds-ca-bundle' \
  --set-string 'databaseCaBundle.configMapName=any-config'
vendored_must_fail "databaseCaBundle.configMapName null (the adapter passes the key, so the guard sees it)" \
  --expect 'databaseCa.configMapName is required while databaseCa.enabled' --set 'databaseCaBundle.configMapName=null'
# An adapter that leaves configMapName out would let values choose the
# ConfigMap its templates mount as the database trust anchor.
no_cm="$work/vg-adapter-without-configmapname"
cp -R "$vendored" "$no_cm"
sed -i -e 's|"key" .Values.databaseCaBundle.key$|"key" .Values.databaseCaBundle.key)|' \
  -e '/"configMapName" .Values.databaseCaBundle.configMapName)/d' "$no_cm/templates/_adapter.tpl"
if grep -q configMapName "$no_cm/templates/_adapter.tpl"; then
  echo "fixture edit failed: the adapter still passes configMapName"; exit 1
fi
if err="$("$helm" template vg "$no_cm" 2>&1 >/dev/null)"; then
  echo "expected failure did not happen (vendored guard): adapter without databaseCa.configMapName"; exit 1
fi
expect_reason "adapter without databaseCa.configMapName" 'databaseCa.configMapName is required while databaseCa.enabled' "$err"
echo "[vendored guard] rejected as expected: adapter without databaseCa.configMapName"

echo "[helm-unittest] $chart/tests"
"$helm" unittest "$chart"

echo "[strict-mtls] rendered manifests"
node scripts/validation/validate-strict-mtls.mjs --path "$out"

echo "chart validation passed"
