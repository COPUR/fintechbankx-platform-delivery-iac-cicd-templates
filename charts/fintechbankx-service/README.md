# fintechbankx-service Helm chart (Proposed)

Generic chart for a FinTechBankX Spring Boot service on EKS. It generalises the
monolith chart `services/helm/open-finance-service` and the per-service charts
introduced in `fintechbankx-lendingpayments-loan-lifecycle-core` (PR #14), and
follows the platform contract (ports, labels, ExternalSecret store, IRSA).

| Concern | What the chart renders |
| --- | --- |
| Ports | `http` 8080 (API), `management` 8081 (actuator health and `/actuator/prometheus`) |
| Probes | startup/liveness/readiness on the management port |
| Scale and HA | HPA (CPU + memory), PDB (fails rendering if `minAvailable` >= min replicas), zone spread `DoNotSchedule`, host spread `ScheduleAnyway`, `maxUnavailable: 0` |
| Security | non-root UID 10001, read-only root FS, all capabilities dropped, `RuntimeDefault` seccomp, image by digest, `latest` rejected |
| Secrets | `ExternalSecret` against `ClusterSecretStore/aws-secrets-manager` |
| Database TLS | ConfigMap `rds-ca-bundle` (key `global-bundle.pem`, published in every service namespace by the mesh repo's trust-manager Bundle) mounted read-only at `/etc/fintechbankx/rds-ca` and exported as `DB_SSL_ROOT_CERT`; not optional, so a missing bundle stops the pod instead of connecting unverified. `config.DB_URL` is the one JDBC URL route and must pass the strict parse (exactly one `sslmode=verify-full`, exactly one `sslrootcert=<mountPath>/<key>`); every name and value the pod's environment can get from values goes through `fbx.guard`, see [Datasource and TLS guard](#datasource-and-tls-guard). A datasource set by a profile or config file inside the image is the service's own startup check (see [Service-side TLS assertion](#service-side-tls-assertion)); `databaseCa.enabled: false` for services without a relational database |
| Kafka TLS and profile | `kafka.runtime` (`""`, `msk` or `strimzi`; default `""`) renders the only Spring profile: `msk` sets `SPRING_PROFILES_ACTIVE=kafka-msk` (Amazon MSK IAM over `SASL_SSL`), `strimzi` sets `kafka-strimzi` (Strimzi mutual TLS over `SSL`), `""` sets none and is for services without Kafka; the profile names follow the Kafka repo's client guide. A `config` key or `extraEnv` name matching `(?i)(^\|[._-])security[._-]?protocol$` (`KAFKA_SECURITY_PROTOCOL`, `SPRING_KAFKA_SECURITY_PROTOCOL`, `SPRING_KAFKA_PRODUCER_SECURITY_PROTOCOL`, `SPRING_KAFKA_PROPERTIES_SECURITY_PROTOCOL`, `spring.kafka.streams.security.protocol`, ...) must hold `SASL_SSL` or `SSL` (case-insensitive, trimmed; `PLAINTEXT`, `SASL_PLAINTEXT` and empty are rejected), one matching `(?i)endpoint[._-]?identification[._-]?algorithm` must hold `https`; both name rules are also checked against the Spring relaxed-binding form of the name (lower case, characters other than `[a-z0-9]` inside an element ignored, `foo[bar]` read as `foo.bar`), so `spring.kafka.secu-rity.protocol` and `spring.kafka.properties[security.protocol]` are covered too (`fbx.kafkaTlsName`); a protocol name needs `kafka.runtime` `msk` or `strimzi` (with `""` the service would get no auth profile); with `kafka.runtime: msk` every such protocol must be `SASL_SSL`, with `strimzi` `SSL`; these names need a literal `extraEnv` `value` (no `valueFrom`) and may not come from the ExternalSecret (`fbx.validateKafkaTls`). The client's TLS material is not a values setting: every `spring.kafka[.<client>].ssl.*` and `spring.kafka[.<client>].properties.ssl.*` name other than `ssl.endpoint.identification.algorithm` is refused on every route whatever `kafka.runtime` is, and `KAFKA_TLS_CERT`, `KAFKA_TLS_KEY` and `KAFKA_TLS_CA` (read by the `kafka-strimzi` profile) come only from a Secret (name rule 7) |
| Identity | ServiceAccount annotated with the IRSA role (`serviceAccount.roleArn`) |
| Observability | pod label `fintechbankx.io/service-id` and `prometheus.io/scrape|port|path` annotations, so the observability repo's PodMonitor `fintechbankx-services` (`fintechbankx-platform-observability-sre-operations`, `deploy/kustomize/base/monitors/podmonitor-fintechbankx-services.yaml`) is the single scrape path (Istio merged metrics on 15020); OTLP env to the platform collector. `observability.serviceMonitor.enabled: true` is an opt-in for clusters without that PodMonitor and drops the annotations to avoid double scraping |
| Network | none by default: `NetworkPolicy` is owned by the service-mesh platform repo (`fintechbankx-platform-mesh-security-service-mesh`, `k8s/istio/security/network-policies.yaml`), like AuthorizationPolicy. `networkPolicy.enabled: true` renders an opt-in policy (own namespace, ingress gateway, observability, DNS, istiod, `egressCidrs`) for clusters the mesh repo does not cover; `egressCidrs` defaults to `[]` and the schema accepts only IPv4 prefixes `/8`-`/32` and IPv6 prefixes `/32`-`/128` (so `0.0.0.0/0`, `::/0` and halves such as `0.0.0.0/1` + `128.0.0.0/1` are rejected); the template (`fbx.validateEgressCidrs`) narrows this to the "VPC or VPC endpoint subnets" intent: an IPv4 range wider than `/16` only inside RFC1918 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) or `100.64.0.0/10` (an AWS VPC CIDR block is `/16` at most, so a VPC in public space still fits), no IPv6 range that overlaps the IPv4-mapped block `::ffff:0:0/96` or the NAT64 prefixes `64:ff9b::/96` and `64:ff9b:1::/48`, and no IPv6 range broader than `/48` unless it lies fully inside the unique local block `fc00::/7` (an Amazon-provided VPC IPv6 block is `/56`, a subnet `/64`) |
| Mesh | `app`/`version` labels, `sidecar.istio.io/inject: "true"`, Service ports named `http` (8080) and `http-management` (8081); no AuthorizationPolicy, PeerAuthentication, DestinationRule or `excludeInboundPorts` (owned by the mesh repo / forbidden by the contract) |
| Migration Job | not rendered by this chart; a service that runs Flyway as a Job labels its pods `app.kubernetes.io/name=<sa>` (the mesh grants Aurora egress on that label; the Job may run with or without a sidecar) and `app.kubernetes.io/component=db-migration`. The chart's selectors include `app.kubernetes.io/component=service`, so the Service, PDB and topology spread never select Job pods |

## Datasource and TLS guard

`fbx.guard` (`templates/_helpers.tpl`, called at the top of
`templates/deployment.yaml`) checks every route by which values reach the
pod's environment. Rendering fails with the reason; nothing is rewritten.
The key and name shape checks (`fbx.validateKeyNames`) run last, so a name
that a name rule refuses gets that rule's message. The templates quote every
key and value they interpolate (ConfigMap keys, ExternalSecret `secretKey`,
`property` and `key`), so a newline in a key cannot open further keys.

| Input route | What the guard checks |
| --- | --- |
| `config` keys (rendered into the ConfigMap, loaded with `envFrom`) | name rules below; the key must be a ConfigMap key (`[-._a-zA-Z0-9]+`); values of `security.protocol` / `endpoint.identification.algorithm` names; every `jdbc:[<wrapper>:]postgresql:` value is parsed; JVM option names have their value checked; Secret-only names (`KAFKA_TLS_*`, rule 7; `MONGODB_URI`, rule 8) are refused |
| `extraEnv` with `value` | the same as `config`, except that `DB_URL` is refused in every spelling, the name must be printable ASCII other than `=` and white space, and no value may contain `$(` (Kubernetes expands `$(VAR)` from earlier env entries and `envFrom` keys after the guard has read the text; use `valueFrom`, e.g. `fieldRef`, instead) |
| `extraEnv` with `valueFrom` | name rules below; JVM option, `security.protocol` and `endpoint.identification.algorithm` names are refused (the value cannot be seen), also next to an empty `value`; Secret-only names (`KAFKA_TLS_*`, rule 7; `MONGODB_URI`, rule 8) only with `valueFrom.secretKeyRef` alone, never with a literal `value`, `configMapKeyRef`, `fieldRef` or `resourceFieldRef` |
| `externalSecret.data` / `extraData` `secretKey` | name rules below; `DB_URL`, JVM option and Kafka `security.protocol` / `endpoint.identification.algorithm` names are refused (the secret keeps only credentials and Secret-only names such as `KAFKA_TLS_CA` and `MONGODB_URI`, in their exact spelling); the key must be a Secret key (`[-._a-zA-Z0-9]+`), and `property` / `remoteSecretName` must not contain a control character |
| `javaToolOptions` (rendered as `JAVA_TOOL_OPTIONS`) | JVM option rules below |
| `envFrom`, `extraEnvFrom`, `externalSecret.dataFrom` values | refused (`fbx.validateEnvSources`): they load names the guard never sees; the chart renders only its own `configMapRef` and `secretRef` |
| Other values written into the pod spec (`preStopSleepSeconds`, `probes.*`, `priorityClassName`, `terminationGracePeriodSeconds`, `revisionHistoryLimit`, `serviceAccount.name`, ...) | not part of the guard: `values.schema.json` types them and the templates render every number with `int` and every string with `quote`, so no value can close its line and add fields such as `args: ["--spring.config.import=..."]` |

Name rules (`fbx.datasourceOverrideName`, `fbx.overrideNameReason`), checked
against the name as given (case-insensitive) and against its Spring
relaxed-binding form (`fbx.canonicalName`: lower case, `[`, `]` and `_` read
as `.`, every other character outside `[a-z0-9.]` removed, repeated dots
collapsed). Spring Boot 3.3 skips every character other than `[a-z0-9]`
inside a name element, so `spring.pro-files.active`, `spring.pro:files.active`
(an env name Kubernetes 1.32+ accepts), `spring.config.import[0]`,
`SPRING_CONFIG_IMPORT_0_` and `fintechbankx.tls[enforce]` are all caught:

1. `spring.config.*` by prefix, `(?i)^spring[._-]?config([._-]|$)` (import,
   location, additional-location, name, `activate.*`, `on-not-found`, indexed
   forms), and `spring.profiles.*` by prefix, `(?i)^spring[._-]?profiles([._-]|$)`
   (active, include, default, `group.*`, indexed forms). The chart renders no
   config import, and `SPRING_PROFILES_ACTIVE` from `kafka.runtime` is the only
   profile.
2. JVM options (`fbx.isJvmOptionsName`: `JAVA_TOOL_OPTIONS`, `JDK_JAVA_OPTIONS`,
   `_JAVA_OPTIONS`, and the chart's `javaToolOptions`; `fbx.validateJvmOptions`):
   the value must not mention `datasource`, `flyway`, `liquibase`, `r2dbc`,
   `jdbc`, `ssl`, `application.json`, `spring.config`, `spring.profiles`,
   `fintechbankx.tls`, `security.protocol`, `endpoint.identification`,
   `kafka` (`-Dspring.kafka.*` sets any Kafka client property, and
   `-DKAFKA_TLS_CA` would resolve the `kafka-strimzi` profile's
   `${KAFKA_TLS_CA}` before the environment does), `mongodb`
   (`-Dspring.data.mongodb.*`, and `-DMONGODB_URI` would resolve the
   DocumentDB services' `${MONGODB_URI}` before the Secret does),
   `java.security.properties`, `jdk.tls` or `hostname verification`, also
   once every character other than `[a-z0-9]` is removed (with and without
   white space), so `-Dspring..config.import`, `-Dspring.[profiles].active`,
   `-Dspring.pro_files.active`, a quoted `"-Dspring.pro files.active"` and JSON
   nested in `-Dspring.application..json` are caught; it must be printable
   ASCII (Spring lower-cases `İ`, U+0130, to `i`), must not contain `$(` or
   `${` (the options would be assembled after the check from a config key, a
   secret or other literals), and must not read options from a file (an
   option starting with `@`, also after a quote, `-XX:VMOptionsFile`,
   `-XX:Flags`). These names need a literal `extraEnv` `value` and may not come
   from the ExternalSecret. `JAVA_OPTS` reaches no JVM in the template image
   (see the JVM options paragraph under
   [Service-side TLS assertion](#service-side-tls-assertion)).
3. The startup assertion off switch `(?i)^fintechbankx[._-]?tls([._-]|$)`
   (`FINTECHBANKX_TLS_ENFORCE` in any spelling) and `spring.application.json`
   in any spelling (`SPRING_APPLICATION_JSON`), whatever they carry.
4. `(?i)^spring[._-]?ssl([._-]|$)` and any name containing `ssl[._-]?bundle`:
   `SPRING_SSL_BUNDLE_*`, `spring.ssl.bundle.pem.*` / `jks.*` can replace the
   trust anchor of a DocumentDB, PostgreSQL or Kafka client, and
   `spring.data.mongodb.ssl.bundle` and the like can point a client at another
   bundle. `javax.net.ssl.*` and other trust-store system properties are
   refused in JVM options by the `ssl` mention (rule 2).
5. Datasource overrides: `(?i)^spring[._-]?(datasource|flyway|liquibase|r2dbc)[._-]`
   except `SPRING_DATASOURCE_USERNAME` and `SPRING_DATASOURCE_PASSWORD`, and any
   name containing `jdbc[._-]?url`, `ssl[._-]?factory` (also `sslfactoryarg`),
   `ssl[._-]?host[._-]?name[._-]?verifier`, `ssl[._-]?password[._-]?callback`,
   `ssl[._-]?root[._-]?cert` or `ssl[._-]?mode` (`spring.datasource.hikari.jdbc-url`,
   `spring.datasource.hikari.data-source-properties.*`, `REPORTING_JDBCURL`,
   `PGJDBC_SSL_FACTORY`, `PGSSLROOTCERT`, `OPF_DB_SSL_MODE`). `DB_SSL_ROOT_CERT`
   is rendered by the chart from `databaseCa`; an `extraEnv` entry of that name
   comes later in the env list and would replace it (an empty value turns the
   customer, risk and compliance guards off).
6. `DB_URL` (`fbx.isDbUrlName`: `dburl` once lower-cased and stripped of every
   character other than `[a-z0-9]`) only as the `config` key `DB_URL`; a
   non-empty `config.DB_URL` must be a `jdbc:[<wrapper>:]postgresql:` URL, and
   every such value in `config` or `extraEnv` is parsed the way PgJDBC reads it
   (`fbx.validateJdbcUrl`; split after the first `?`, then on `&`, `key=value`
   on the first `=`): exactly one `sslmode`, equal to `verify-full` (PgJDBC
   keeps the last one); with `databaseCa.enabled` exactly one `sslrootcert`,
   equal to `<mountPath>/<key>`; no `sslfactory`, `sslfactoryarg`,
   `sslhostnameverifier`, `sslpasswordcallback` or `service`; plain
   `[A-Za-z0-9_.-]` parameter names, no percent-encoded `=` or `&`, TLS keys in
   lower case, no TLS key before the `?`, and no `${` or `$(` anywhere (a
   Spring placeholder or a Kubernetes variable reference is resolved after
   the check and could append `&sslmode=disable`; the terraform-modules
   `aurora-postgresql` `jdbc_url` passes). `sslfactory` cannot come in by
   another route: rule 5 refuses it as a name and under
   `spring.datasource.*`, rule 2 in JVM options.
7. Kafka. Value-checked names (`fbx.validateKafkaTls`, see the Kafka row
   above): a `security.protocol` name must hold `SASL_SSL` or `SSL` (as a
   literal value), an `endpoint.identification.algorithm` name `https`.
   Client TLS names (`fbx.overrideNameReason`), refused on every route
   whatever `kafka.runtime` is (`msk`, `strimzi` or `""`):
   `(?i)^spring[._-]?kafka[._-](<client>[._-])?(properties[._-])?ssl([._-]|$)`,
   that is `spring.kafka.ssl.*` and `spring.kafka.<client>.ssl.*` (trust
   store, key store, PEM certificates, key password, TLS protocol; `<client>`
   is `producer`, `consumer`, `admin`, `streams` or any other one element)
   and `spring.kafka[.<client>].properties.ssl.*` (the raw client properties
   `ssl.truststore.location`, `ssl.keystore.type`, ...). The one name under
   these prefixes that stays allowed is `ssl.endpoint.identification.algorithm`
   (value-checked above); `security.protocol` is not under `ssl`, and other
   `spring.kafka[.<client>].properties.*` names (`sasl.*` for MSK IAM) are
   not refused. With Spring Boot 3.3.6, `SPRING_KAFKA_SSL_TRUST_STORE_LOCATION`,
   `SPRING_KAFKA_SSL_TRUSTSTORELOCATION`, `spring.kafka.s-sl.trust-store-location`
   and `SPRING_KAFKA_PROPERTIES_SSL_TRUSTSTORE_LOCATION` all reach the
   client's `ssl.truststore.location` (`SPRING_KAFKA_SSL_TRUSTSTORE_LOCATION`
   binds nothing; it is refused with the rest).
   Secret-only names (`fbx.validateSecretNames`, `fbx.secretOnlyName`):
   `KAFKA_TLS_CERT`, `KAFKA_TLS_KEY` and `KAFKA_TLS_CA` hold the PEM client
   certificate, key and cluster CA that the `kafka-strimzi` profile reads as
   `${KAFKA_TLS_*}`. The Kafka repo's client guide
   (`docs/guides/SERVICE_CLIENT_CONFIGURATION.md`, "Strimzi") says to copy
   the KafkaUser and cluster CA certificates into the service namespace "as
   Secret `kafka-client-tls` and map `KAFKA_TLS_CERT`, `KAFKA_TLS_KEY`,
   `KAFKA_TLS_CA` from it with `secretKeyRef`", so the guard allows them only
   as an `extraEnv` entry with `valueFrom.secretKeyRef` alone or as an
   ExternalSecret `secretKey`, and refuses them under `config`, with a literal
   `value` (also an empty one next to `valueFrom`), from a `configMapKeyRef`,
   `fieldRef` or `resourceFieldRef`, whatever `kafka.runtime` is (no other
   profile reads them). Only these exact names are allowed: Spring Boot 3.3.6
   resolves `${KAFKA_TLS_CA}` from the env name `KAFKA_TLS_CA`, not from
   `kafka.tls.ca` or `Kafka_Tls_Ca`, so every other spelling of
   `(?i)^kafka[._-]?tls([._-]|$)` is refused on every route.
8. DocumentDB. `(?i)^spring[._-]?data[._-]?mongodb([._-]|$)`
   (`fbx.overrideNameReason`) on every route: `spring.data.mongodb.uri`,
   `host`, `port`, `database`, `replica-set-name`, `ssl.enabled`,
   `ssl.bundle` and the rest can point the DocumentDB client at another
   server or switch its TLS off. The exceptions are the credentials
   `SPRING_DATA_MONGODB_USERNAME` and `SPRING_DATA_MONGODB_PASSWORD`, in this
   env spelling (any case), allowed on the same routes as
   `SPRING_DATASOURCE_USERNAME` and `_PASSWORD`; `spring.data.mongodb.password`
   is refused like `spring.datasource.password`. With Spring Boot 3.3.6,
   `SPRING_DATA_MONGODB_URI`, `spring.data.mongo-db.uri` and
   `spring.data[mongodb].uri` all bind `spring.data.mongodb.uri`
   (`SPRING_DATA_MONGO_DB_URI` binds nothing). Secret-only name
   (`fbx.validateSecretNames`, `fbx.secretOnlyName`, `fbx.secretOnlyReason`):
   `MONGODB_URI` is the connection string, credentials and TLS options
   included, that the open-finance DocumentDB services read as
   `${MONGODB_URI}`; it is allowed only as an `extraEnv` entry with
   `valueFrom.secretKeyRef` alone or as an ExternalSecret `secretKey`, and
   refused under `config`, as a literal `value`, from a `configMapKeyRef`,
   `fieldRef` or `resourceFieldRef`. Spring Boot 3.3.6 resolves
   `${MONGODB_URI}` from the env name `MONGODB_URI` only (not from
   `mongodb.uri`, `mongodb_uri` or `Mongodb_Uri`), so every other spelling of
   `(?i)^mongodb[._-]?uri$` is refused on every route.

## Vendoring the guard

A service chart (`deploy/helm/<service>` in the customer, risk, compliance,
open-finance, lending and payment repositories) adopts the guard without
editing it:

1. Copy `charts/fintechbankx-service/templates/_helpers.tpl` whole and
   unchanged, without a header, into the service chart, e.g. as
   `templates/_fbx_helpers.tpl` (any name starting with `_`), and have the
   service's CI run `scripts/ci/verify-vendored-guard.sh <chart-dir>
   <sha256>` (copied from this repository at the same commit) with the
   file's sha256 pinned in the CI step, and the copy's provenance (source
   repository `fintechbankx-platform-delivery-iac-cicd-templates`, path
   `charts/fintechbankx-service/templates/_helpers.tpl`, commit) recorded
   next to the pinned digest:

   ```yaml
   - name: Vendored platform guard
     run: |
       # fintechbankx-platform-delivery-iac-cicd-templates
       # charts/fintechbankx-service/templates/_helpers.tpl at <commit>
       bash scripts/ci/verify-vendored-guard.sh deploy/helm/<service> <sha256>
   ```

   This is the one vendoring convention (the lending charts' header-less
   whole-file copy): a header inside the file changes its digest, and the
   script refuses it. The script prints the file it found and its sha256 and
   checks (a) that exactly one file under `templates/` defines `fbx.guard`
   and that the sha256 of that whole file is the pinned one, (b) that no
   other file of the chart, subchart directories and `.tgz` archives
   included, defines an `fbx.*` template in any spelling (`{{define`,
   `{{- define`, extra white space, a `"..."` or `` `...` `` name, `block`),
   since a later definition replaces the vendored one, and (c) that every
   workload template (Deployment, StatefulSet, DaemonSet, Job, CronJob,
   also one rendered through an included define) runs the guard before it
   writes anything (step 2). The guard is `fbx.guard` with the helpers it calls:
   `fbx.validateEnvSources`, `fbx.validateDatabaseTls`, `fbx.validateKafkaTls`,
   `fbx.validateKafkaTlsValue`, `fbx.validateSecretNames`, `fbx.secretOnlyName`,
   `fbx.secretOnlyReason`, `fbx.validateKeyNames`, `fbx.validateJdbcUrl`,
   `fbx.validateJvmOptions`,
   `fbx.datasourceOverrideName`, `fbx.overrideNameReason`, `fbx.canonicalName`,
   `fbx.isDbUrlName`, `fbx.isJvmOptionsName`, `fbx.kafkaTlsName`, plus
   `fbx.kafkaProfile` to render the profile. The file's other `fbx.*` helpers
   do nothing unless included; service charts use their own prefix
   (`products.*`, ...), so nothing collides. Whenever this chart's guard
   changes, re-copy the file and re-pin its sha256 and commit in the CI step.
2. Call it as the first action of every template that renders a workload
   (the Deployment, a migration Job, a CronJob, ...), directly or through an
   adapter define of the chart (e.g. `<chart>.guard`, the simplest way to
   share one adapter dict between several workload templates) that calls it
   unconditionally before any output of its own. Only comments, variable
   assignments, `fail` and `if`/`range`/`with` blocks that write nothing may
   come before the call; an `{{ if }}` without `{{ else }}` may enclose the
   whole template (an optional Job). With this chart's value
   names it is `{{- include "fbx.guard" . -}}`. With other names, pass an
   adapter dict; the guard reads only `.Values`, and every key is optional
   except `databaseCa.mountPath` and `key` while `databaseCa.enabled`. The
   keys are `config`, `extraEnv`, `envFrom`, `extraEnvFrom`,
   `javaToolOptions`, `databaseCa`, `kafka.runtime` and `externalSecret`
   (`enabled`, `data`, `extraData`, `dataFrom`). A key left out is never
   checked, so map every value of the chart that feeds one of these routes,
   including an `envFrom`-like list and an ExternalSecret `dataFrom` (the
   guard refuses them when non-empty):

   ```yaml
   {{- /* templates/_adapter.tpl */ -}}
   {{- define "example.guard" -}}
   {{- include "fbx.guard" (dict "Values" (dict
         "config" .Values.env
         "extraEnv" .Values.additionalEnv
         "extraEnvFrom" .Values.additionalEnvFrom
         "javaToolOptions" .Values.jvmOptions
         "databaseCa" .Values.databaseCaBundle
         "kafka" (dict "runtime" .Values.kafkaRuntime)
         "externalSecret" (dict "enabled" .Values.secrets.enabled "data" .Values.secrets.keys
           "dataFrom" .Values.secrets.dataFrom))) -}}
   {{- end -}}

   {{- /* first line of templates/deployment.yaml and of every other workload template */ -}}
   {{- include "example.guard" . -}}
   ```

   Every env list the chart renders from values goes in: a migration Job's or
   an init container's extra env is concatenated into `extraEnv` (or the guard
   is called a second time with it), and a second secret's keys into
   `externalSecret.extraData`. Error messages name this chart's routes
   (`config.<key>`, `extraEnv`, `externalSecret.data`).
3. Render only what the guard has seen: the ConfigMap from the `config` map,
   `env` from the chart's own entries (`DB_SSL_ROOT_CERT`, `JAVA_TOOL_OPTIONS`
   from `javaToolOptions`, `SPRING_PROFILES_ACTIVE` from `fbx.kafkaProfile`)
   followed by `extraEnv` (the guard refuses `extraEnv` names that would
   replace the first and third, and checks the value of the second),
   `envFrom` only for the
   chart's own ConfigMap and Secret, the ExternalSecret only with
   `data`/`extraData` (no `dataFrom`), and no `command`/`args` that expand a
   launcher variable. Quote every key and value a template interpolates
   (`{{ $key | quote }}: {{ $value | quote }}`, `secretKey`, `property`,
   `remoteRef.key`) and render numbers with `int`, so no value can close its
   line and add a key or a container field such as `args`. Remove any
   `envFrom`/`extraEnvFrom`/`dataFrom` value.
4. Copy the tests, replacing the fixtures `../ci/loan-lifecycle-values.yaml`
   and `../ci/dev-minimal-values.yaml` (`kafka_runtime_required_test.yaml`
   uses the second) with the service's own and, if its value names differ,
   the `set:` paths: helm-unittest suites `database_ca_test.yaml`,
   `database_override_names_test.yaml`, `datasource_tls_names_test.yaml`,
   `db_url_test.yaml`, `spring_config_profiles_test.yaml`,
   `relaxed_binding_names_test.yaml`, `ssl_bundle_names_test.yaml`,
   `tls_enforce_switch_test.yaml`, `jvm_options_test.yaml`,
   `env_sources_test.yaml`, `key_injection_test.yaml`,
   `variable_references_test.yaml`, `kafka_protocol_test.yaml`,
   `kafka_client_tls_names_test.yaml`, `kafka_runtime_profiles_test.yaml`,
   `kafka_runtime_required_test.yaml` and `documentdb_names_test.yaml`
   (`template_interpolation_test.yaml` covers this chart's own templates; a
   service chart writes the same cases for its templates); and the
   `must_fail` cases of `scripts/ci/validate-chart.sh` from "DB_URL
   materialised from the ExternalSecret" to "KAFKA_SECURITY_PROTOCOL=SSL
   without kafka.runtime" (DB_URL, datasource, config and profile names, SSL
   bundle, `DB_SSL_ROOT_CERT`, JVM options, `$(VAR)` and `${...}`,
   `extraEnvFrom`, the off switch, Kafka protocol and Kafka client TLS
   names, DocumentDB names), keeping each case's `--expect`
   pattern so that a case cannot pass because the render failed for another
   reason. The digest and the checks of step 1 prove the copy and the call
   sites, not the adapter's mapping: only these negative render cases show
   that every value route reaches the guard. `scripts/ci/fixtures/vendored-guard-chart`
   is a worked example: `validate-chart.sh` copies `_helpers.tpl` into it
   unchanged, runs `verify-vendored-guard.sh` on it, and checks that it
   renders and refuses every `vendored_must_fail` case through its adapter
   define, each for its expected reason.

## Required values

`serviceName`, `serviceId`, `boundedContext`, `image.repository` and either
`image.tag` or `image.digest`. Rendering with the bare `values.yaml` fails on
purpose; see the fixtures in `ci/` for complete examples.

## Service-side TLS assertion

The chart checks only what it renders: `config`, `extraEnv`, the ExternalSecret
keys and the JVM options. It cannot see a datasource or Kafka client built in
code, a profile or `application-*.yml` baked into the image, or a value read at
runtime. Guardrail 4a therefore requires every service to assert its own
connections at startup, on by default: a failed assertion stops the
application context, so the pod never becomes ready.

What guardrail 4a asks the assertion to cover:

- JDBC: every PostgreSQL URL the context uses (application datasource, Flyway,
  Liquibase, reporting) carries exactly one `sslmode=verify-full` and no
  `sslfactory`, `sslhostnameverifier`, `sslpasswordcallback` or `service`.
- Kafka: the clients use `security.protocol` `SASL_SSL` (Amazon MSK IAM,
  profile `kafka-msk`) or `SSL` (Strimzi mutual TLS, profile `kafka-strimzi`);
  `PLAINTEXT`, `SASL_PLAINTEXT` and an unset protocol stop startup, and
  `ssl.endpoint.identification.algorithm` stays `https` (the Kafka client
  default; no service turns it off, none checks it explicitly yet).
- A test starts the context, or runs the check, with a non-verifying value
  (`sslmode=require`, `security.protocol=PLAINTEXT`) and expects the failure,
  so the assertion itself is proven red first.

**Status**, as checked against the services' open pull request branches in
October 2026 (what each one checks in detail is in its own repository):

| Service repositories | Assertion | Off switch | Kafka profiles |
|---|---|---|---|
| `fintechbankx-lendingpayments-loan-lifecycle-core`, `fintechbankx-lendingpayments-payment-orchestration-initiation-settlement`, `-bulk-orchestration`, `-recurring-mandates`, `-request-to-pay` | startup check before any datasource or Kafka bean, on by default (`fintechbankx.tls.enforce: true` in `application.yml`): datasource `sslmode=verify-full` and, with Kafka configured, `SASL_SSL` or `SSL` | `fintechbankx.tls.enforce: false`, set only by `application-local.yml` (profile `local`) and the test resources | `application-kafka-msk.yml`, `application-kafka-strimzi.yml` |
| `fintechbankx-customer-profile-kyc-core`, `fintechbankx-riskcompliance-risk-decisioning-core`, `fintechbankx-riskcompliance-compliance-evidence-core` | `DatabaseTlsGuard` and `KafkaTlsGuard`, both registered whenever `DB_SSL_ROOT_CERT` is set (this chart always sets it while `databaseCa.enabled`), whether the outbox relay is on or off: the relay flag gates publishing, not the checks. `KafkaTlsGuard` reads the producer's effective `security.protocol` and accepts `SASL_SSL` or `SSL` in all three services, so `kafka.runtime: msk` and `strimzi` both start them | none: the guards skip when `DB_SSL_ROOT_CERT` is unset (local runs, tests); no `fintechbankx.tls.enforce`, no `local` profile file | `kafka-msk`, `kafka-strimzi` (profile files in customer, profile documents in `application.yml` in risk and compliance) |
| `fintechbankx-openfinance-*` (consent-auth-service, corporate-data-business-financial, open-data-atm-directory, open-data-products-catalog, payee-metadata-banking-metadata, payee-metadata-payee-verification, retail-data-personal-financial) | `AwsTransportSecurityConfiguration` (products-catalog: `DatabaseTlsEnvironmentPostProcessor`), active under the `aws` profile that the services' own charts render (corporate-data, banking-metadata and retail-data also under `kafka-msk` / `kafka-strimzi`); `SASL_SSL` or `SSL` | none: not activating `aws` (local runs, tests) | `application-kafka-msk.yml`, `application-kafka-strimzi.yml` where the service uses Kafka |

Every other service, and every new one, is to add the assertion in the first
shape (`fintechbankx.tls.enforce`, `application-local.yml`,
`application-kafka-msk.yml`, `application-kafka-strimzi.yml`). Moving the services
in the second and third rows to it is proposed, not started: none of their
branches has it, so for them the off switch is the absence of
`DB_SSL_ROOT_CERT` or of the `aws` profile. Consequences on this chart today:

- It renders only the `kafka-*` profile, never `aws`, so an open-finance
  assertion gated on `aws` alone does not run here.
- It sets `DB_SSL_ROOT_CERT` only while `databaseCa.enabled`; with
  `databaseCa.enabled: false` customer, risk and compliance register neither
  guard. Those three keep the default `true`.

The assertion's off switch is the property `fintechbankx.tls.enforce` (env
`FINTECHBANKX_TLS_ENFORCE`), set by the `local` profile and test resources
only. This chart refuses it, and every other `fintechbankx.tls.*` name
in any spelling, as a `config` key, an `extraEnv` name (`value` or
`valueFrom`), an ExternalSecret key or inside JVM options; `SPRING_APPLICATION_JSON`
is refused by name, whatever it carries. The chart also refuses every
`spring.profiles.*` name it does not render itself, so `local` (or a
`spring.profiles.default` / `spring.profiles.group.*` that leads to it) cannot
be switched on through the chart. For customer, risk and compliance, whose
guards run while `DB_SSL_ROOT_CERT` is set, the chart refuses that name (and
every `ssl[._-]?root[._-]?cert` name) on every route, so an `extraEnv` entry
cannot replace the chart's own value with an empty one.

That covers this chart and every service chart that vendors its guard. As
checked in October 2026, all 15 service charts (customer, risk, compliance,
the seven open-finance services, loan-lifecycle and the four payment services)
vendor `fbx.guard` from commit `a4f0072` of this repository byte for byte
(sha256 `1fd684735383301baf3052c5d8978dd86edee1ac1c66ebfb944a8a6a166f4c92`; in
the customer, risk, compliance and open-finance charts below a provenance
header) and run it through an adapter, an inline dict or a define of the chart,
before their Deployment renders. A service chart that does not vendor the guard
depends on its own chart's checks. Each service's CI is to run
[`scripts/ci/verify-vendored-guard.sh`](../../scripts/ci/verify-vendored-guard.sh)
with its pinned digest ([Vendoring the guard](#vendoring-the-guard), step 1):
with the `a4f0072` digest the loan-lifecycle and payment charts pass every
check; the ten others fail check (a) until the header moves out of the file
into the CI step, and the consent migration Job and the products history guard
CronJob and Job do not call the guard yet (check (c)). When this chart's guard
changes, as it has since `a4f0072` (Kafka client TLS names, `KAFKA_TLS_*` and
`MONGODB_URI` only from a Secret, `spring.data.mongodb.*`, `kafka` and
`mongodb` in JVM options), every service re-vendors the file and re-pins its
digest and commit; until then it runs the `a4f0072` rules.

JVM options: the chart checks `JAVA_TOOL_OPTIONS`, `JDK_JAVA_OPTIONS` and
`_JAVA_OPTIONS`, the variables the JVM reads itself (`fbx.isJvmOptionsName`).
`JAVA_OPTS` and similar launcher variables reach the JVM only through a shell
launcher that expands them; the template image
(`templates/microservice/Dockerfile`) and the service images start the JVM in
exec form (`ENTRYPOINT ["java", "org.springframework.boot.loader.launch.JarLauncher"]`),
and the chart sets no `command` or `args` on the application container, so no
such variable reaches the command line. An image that adds a launcher must have
every variable it expands into the java command line added to
`fbx.isJvmOptionsName`; `scripts/ci/test/microservice-launcher.test.mjs` fails
when the template image's start (last `ENTRYPOINT` plus `CMD`, as Docker joins
them) runs a shell that expands a variable not in that list, runs a launcher
script (with or without `.sh`) whose java line does, or runs anything else it
cannot read.

### Selecting the Kafka profile

Set `kafka.runtime` instead of `SPRING_PROFILES_ACTIVE`:

```yaml
kafka:
  runtime: msk        # renders SPRING_PROFILES_ACTIVE=kafka-msk
config:
  KAFKA_SECURITY_PROTOCOL: SASL_SSL   # must be SASL_SSL with msk, SSL with strimzi
```

`strimzi` renders `kafka-strimzi` and requires `SSL`; `""` (the default)
renders no profile and is meant for services without Kafka: rendering fails
when a `security.protocol` name is set while `kafka.runtime` is `""`, so a
Kafka service has to choose `msk` or `strimzi`. Any other value, or a profile list such as
`kafka-msk,local`, is rejected by the schema and the template.

## Validate locally

```bash
helm lint charts/fintechbankx-service -f charts/fintechbankx-service/ci/loan-lifecycle-values.yaml --strict
helm template ci charts/fintechbankx-service --kube-version 1.30.0 \
  -f charts/fintechbankx-service/ci/loan-lifecycle-values.yaml \
  | kubeconform -strict -summary -kubernetes-version 1.30.0 \
      -schema-location default \
      -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'
```

## Consuming it from a service repo

Until the chart is published to an OCI registry, `helm-deploy.yml` checks out
this repository at a ref and installs `charts/fintechbankx-service` with the
service's own values files (`deploy/helm/values.yaml`, `deploy/helm/values-<env>.yaml`).
Service-specific charts (`deploy/helm/<service>`) keep working through the
`chart-path` input.

Migration notes from the per-service charts:
- `podLabels.app.kubernetes.io/part-of` is derived from `boundedContext`
  (`fintechbankx-<ctx>`); drop it from service values.
- The rendered secret is `<serviceName>-secrets` (the per-service charts used `<chart>-db`).
- `externalSecret.data` lists the env var to JSON property mapping; the default
  keeps `SPRING_DATASOURCE_PASSWORD <- password`.
- `externalSecret.remoteSecretName` and every `externalSecret.extraData`
  `remoteSecretName` may only read the release's own secrets: they must start
  with `<environment>/<serviceName>/` (e.g. `staging/loan-lifecycle-service/db-app`,
  `staging/loan-lifecycle-service/oidc-client`). The schema checks the
  `<env>/<slug>/...` shape, the template fails on any other service, environment
  or platform secret, and `environment` is required once the ExternalSecret
  has any key. With `data: []` the main `remoteSecretName` may stay empty.
