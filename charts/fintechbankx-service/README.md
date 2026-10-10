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
| Kafka TLS and profile | `kafka.runtime` (`""`, `msk` or `strimzi`; default `""`) renders the only Spring profile: `msk` sets `SPRING_PROFILES_ACTIVE=kafka-msk` (Amazon MSK IAM over `SASL_SSL`), `strimzi` sets `kafka-strimzi` (Strimzi mutual TLS over `SSL`), `""` sets none and is for services without Kafka; the profile names follow the Kafka repo's client guide. A `config` key or `extraEnv` name matching `(?i)(^\|[._-])security[._-]?protocol$` (`KAFKA_SECURITY_PROTOCOL`, `SPRING_KAFKA_SECURITY_PROTOCOL`, `SPRING_KAFKA_PRODUCER_SECURITY_PROTOCOL`, `SPRING_KAFKA_PROPERTIES_SECURITY_PROTOCOL`, `spring.kafka.streams.security.protocol`, ...) must hold `SASL_SSL` or `SSL` (case-insensitive, trimmed; `PLAINTEXT`, `SASL_PLAINTEXT` and empty are rejected), one matching `(?i)endpoint[._-]?identification[._-]?algorithm` must hold `https`; both name rules are also checked against the Spring relaxed-binding form of the name (lower case, `-` inside an element ignored, `foo[bar]` read as `foo.bar`), so `spring.kafka.secu-rity.protocol` and `spring.kafka.properties[security.protocol]` are covered too (`fbx.kafkaTlsName`); a protocol name needs `kafka.runtime` `msk` or `strimzi` (with `""` the service would get no auth profile); with `kafka.runtime: msk` every such protocol must be `SASL_SSL`, with `strimzi` `SSL`; these names need a literal `extraEnv` `value` (no `valueFrom`) and may not come from the ExternalSecret (`fbx.validateKafkaTls`) |
| Identity | ServiceAccount annotated with the IRSA role (`serviceAccount.roleArn`) |
| Observability | pod label `fintechbankx.io/service-id` and `prometheus.io/scrape|port|path` annotations, so the observability repo's PodMonitor `fintechbankx-services` (`fintechbankx-platform-observability-sre-operations`, `deploy/kustomize/base/monitors/podmonitor-fintechbankx-services.yaml`) is the single scrape path (Istio merged metrics on 15020); OTLP env to the platform collector. `observability.serviceMonitor.enabled: true` is an opt-in for clusters without that PodMonitor and drops the annotations to avoid double scraping |
| Network | none by default: `NetworkPolicy` is owned by the service-mesh platform repo (`fintechbankx-platform-mesh-security-service-mesh`, `k8s/istio/security/network-policies.yaml`), like AuthorizationPolicy. `networkPolicy.enabled: true` renders an opt-in policy (own namespace, ingress gateway, observability, DNS, istiod, `egressCidrs`) for clusters the mesh repo does not cover; `egressCidrs` defaults to `[]` and the schema accepts only IPv4 prefixes `/8`-`/32` and IPv6 prefixes `/32`-`/128` (so `0.0.0.0/0`, `::/0` and halves such as `0.0.0.0/1` + `128.0.0.0/1` are rejected); the template (`fbx.validateEgressCidrs`) narrows this to the "VPC or VPC endpoint subnets" intent: an IPv4 range wider than `/16` only inside RFC1918 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) or `100.64.0.0/10` (an AWS VPC CIDR block is `/16` at most, so a VPC in public space still fits), no IPv6 range that overlaps the IPv4-mapped block `::ffff:0:0/96` or the NAT64 prefixes `64:ff9b::/96` and `64:ff9b:1::/48`, and no IPv6 range broader than `/48` unless it lies fully inside the unique local block `fc00::/7` (an Amazon-provided VPC IPv6 block is `/56`, a subnet `/64`) |
| Mesh | `app`/`version` labels, `sidecar.istio.io/inject: "true"`, Service ports named `http` (8080) and `http-management` (8081); no AuthorizationPolicy, PeerAuthentication, DestinationRule or `excludeInboundPorts` (owned by the mesh repo / forbidden by the contract) |
| Migration Job | not rendered by this chart; a service that runs Flyway as a Job labels its pods `app.kubernetes.io/name=<sa>` (the mesh grants Aurora egress on that label; the Job may run with or without a sidecar) and `app.kubernetes.io/component=db-migration`. The chart's selectors include `app.kubernetes.io/component=service`, so the Service, PDB and topology spread never select Job pods |

## Datasource and TLS guard

`fbx.guard` (`templates/_helpers.tpl`, called at the top of
`templates/deployment.yaml`) checks every route by which values reach the
pod's environment. Rendering fails with the reason; nothing is rewritten.

| Input route | What the guard checks |
| --- | --- |
| `config` keys (rendered into the ConfigMap, loaded with `envFrom`) | name rules below; values of `security.protocol` / `endpoint.identification.algorithm` names; every `jdbc:[<wrapper>:]postgresql:` value is parsed; JVM option names have their value checked |
| `extraEnv` with `value` | the same as `config`, except that `DB_URL` is refused in every spelling |
| `extraEnv` with `valueFrom` | name rules below; JVM option, `security.protocol` and `endpoint.identification.algorithm` names are refused (the value cannot be seen), also next to an empty `value` |
| `externalSecret.data` / `extraData` `secretKey` | name rules below; `DB_URL`, JVM option and Kafka TLS names are refused (the secret keeps only credentials) |
| `javaToolOptions` (rendered as `JAVA_TOOL_OPTIONS`) | JVM option rules below |
| `envFrom`, `extraEnvFrom`, `externalSecret.dataFrom` values | refused (`fbx.validateEnvSources`): they load names the guard never sees; the chart renders only its own `configMapRef` and `secretRef` |

Name rules (`fbx.datasourceOverrideName`, `fbx.overrideNameReason`), checked
against the name as given (case-insensitive) and against its Spring
relaxed-binding form (`fbx.canonicalName`: lower case, `-` and white space
removed, `[`, `]` and `_` read as `.`), so `spring.pro-files.active`,
`spring.config.import[0]`, `SPRING_CONFIG_IMPORT_0_` and
`fintechbankx.tls[enforce]` are all caught:

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
   `java.security.properties`, `jdk.tls` or `hostname verification` (also once
   `-` is removed and brackets read as `.`), nor read options from a file (an
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
   lower case, and no TLS key before the `?` (the terraform-modules
   `aurora-postgresql` `jdbc_url` passes). `sslfactory` cannot come in by
   another route: rule 5 refuses it as a name and under
   `spring.datasource.*`, rule 2 in JVM options.
7. Kafka (`fbx.validateKafkaTls`): see the Kafka row above; a
   `security.protocol` name must hold `SASL_SSL` or `SSL` (as a literal
   value), an `endpoint.identification.algorithm` name `https`.

## Vendoring the guard

A service chart (`deploy/helm/<service>` in the customer, risk, compliance,
open-finance, lending and payment repositories) adopts the guard without
editing it:

1. Copy `charts/fintechbankx-service/templates/_helpers.tpl` unchanged into
   the service chart, e.g. as `templates/_fbx_helpers.tpl` (any name starting
   with `_`). The guard is `fbx.guard` with the helpers it calls:
   `fbx.validateEnvSources`, `fbx.validateDatabaseTls`, `fbx.validateKafkaTls`,
   `fbx.validateKafkaTlsValue`, `fbx.validateJdbcUrl`, `fbx.validateJvmOptions`,
   `fbx.datasourceOverrideName`, `fbx.overrideNameReason`, `fbx.canonicalName`,
   `fbx.isDbUrlName`, `fbx.isJvmOptionsName`, `fbx.kafkaTlsName`, plus
   `fbx.kafkaProfile` to render the profile. The file's other `fbx.*` helpers
   do nothing unless included; service charts use their own prefix
   (`products.*`, ...), so nothing collides. Re-copy the file whenever this
   chart's guard changes.
2. Call it once, at the top of the template that renders the workload (a
   failure in any template stops the whole render). With this chart's value
   names it is `{{- include "fbx.guard" . -}}`. With other names, pass an
   adapter dict; the guard reads only `.Values`, and every key is optional
   except `databaseCa.mountPath` and `key` while `databaseCa.enabled`:

   ```yaml
   {{- include "fbx.guard" (dict "Values" (dict
         "config" .Values.env
         "extraEnv" .Values.additionalEnv
         "javaToolOptions" .Values.jvmOptions
         "databaseCa" .Values.databaseCaBundle
         "kafka" (dict "runtime" .Values.kafkaRuntime)
         "externalSecret" (dict "enabled" .Values.secrets.enabled "data" .Values.secrets.keys))) -}}
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
   launcher variable. Remove any `envFrom`/`extraEnvFrom`/`dataFrom` value.
4. Copy the tests, replacing `../ci/loan-lifecycle-values.yaml` with the
   service's own fixture and, if its value names differ, the `set:` paths:
   helm-unittest suites `database_ca_test.yaml`, `database_override_names_test.yaml`,
   `datasource_tls_names_test.yaml`, `db_url_test.yaml`,
   `spring_config_profiles_test.yaml`, `relaxed_binding_names_test.yaml`,
   `ssl_bundle_names_test.yaml`, `tls_enforce_switch_test.yaml`,
   `jvm_options_test.yaml`, `env_sources_test.yaml`, `kafka_protocol_test.yaml`,
   `kafka_runtime_profiles_test.yaml` and `kafka_runtime_required_test.yaml`;
   and the `must_fail` cases of `scripts/ci/validate-chart.sh` from
   "DB_URL materialised from the ExternalSecret" to "KAFKA_SECURITY_PROTOCOL=SSL
   without kafka.runtime" (DB_URL, datasource, config and profile names, SSL
   bundle, `DB_SSL_ROOT_CERT`, JVM options, `extraEnvFrom`, the off switch and
   Kafka). `scripts/ci/fixtures/vendored-guard-chart` is a worked example:
   `validate-chart.sh` copies `_helpers.tpl` into it unchanged and checks that
   it renders and refuses six cases through the adapter dict.

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
| `fintechbankx-customer-profile-kyc-core`, `fintechbankx-riskcompliance-risk-decisioning-core`, `fintechbankx-riskcompliance-compliance-evidence-core` | `DatabaseTlsGuard` and `KafkaTlsGuard`, active whenever `DB_SSL_ROOT_CERT` is set (this chart always sets it while `databaseCa.enabled`); the Kafka guard only while the outbox relay is on. Risk and compliance accept only `SASL_SSL` (`kafka.runtime: msk`), customer `SASL_SSL` or `SSL` | none: the guards skip when `DB_SSL_ROOT_CERT` is unset (local runs, tests); no `fintechbankx.tls.enforce`, no `local` profile file | `kafka-msk`, `kafka-strimzi` (profile files in customer, profile documents in `application.yml` in risk and compliance) |
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
- `kafka.runtime: strimzi` stops risk and compliance at startup while their
  outbox relay is on.

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

That covers this chart only. A service deployed with its own chart (`deploy/helm`
in the lending and payment repositories) depends on that chart's own name check
until it vendors this guard (see [Vendoring the guard](#vendoring-the-guard)),
and in October 2026 none matches every spelling: the loan-lifecycle-core chart
compares the upper-cased `config` key with `FINTECHBANKX_TLS_ENFORCE`, so a
`config` key `fintechbankx.tls.enforce` renders into the ConfigMap the pod loads
through `envFrom`; the four payment charts also read `.` and `-` as `_`, but not
the bracket form `fintechbankx.tls[enforce]`. The customer, risk, compliance and
open-finance charts do not check the name, which their code does not read.

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
