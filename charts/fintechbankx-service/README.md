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
| Database TLS | ConfigMap `rds-ca-bundle` (key `global-bundle.pem`, published in every service namespace by the mesh repo's trust-manager Bundle) mounted read-only at `/etc/fintechbankx/rds-ca` and exported as `DB_SSL_ROOT_CERT`; not optional, so a missing bundle stops the pod instead of connecting unverified. A PostgreSQL `config.DB_URL` must use `sslmode=verify-full` (the terraform-modules `aurora-postgresql` `jdbc_url` does); `databaseCa.enabled: false` for services without a relational database |
| Identity | ServiceAccount annotated with the IRSA role (`serviceAccount.roleArn`) |
| Observability | pod label `fintechbankx.io/service-id` and `prometheus.io/scrape|port|path` annotations, so the observability repo's PodMonitor `fintechbankx-services` (`fintechbankx-platform-observability-sre-operations`, `deploy/kustomize/base/monitors/podmonitor-fintechbankx-services.yaml`) is the single scrape path (Istio merged metrics on 15020); OTLP env to the platform collector. `observability.serviceMonitor.enabled: true` is an opt-in for clusters without that PodMonitor and drops the annotations to avoid double scraping |
| Network | none by default: `NetworkPolicy` is owned by the service-mesh platform repo (`fintechbankx-platform-mesh-security-service-mesh`, `k8s/istio/security/network-policies.yaml`), like AuthorizationPolicy. `networkPolicy.enabled: true` renders an opt-in policy (own namespace, ingress gateway, observability, DNS, istiod, `egressCidrs`) for clusters the mesh repo does not cover; `egressCidrs` defaults to `[]` and the schema accepts only IPv4 prefixes `/8`-`/32` and IPv6 prefixes `/32`-`/128` (so `0.0.0.0/0`, `::/0` and halves such as `0.0.0.0/1` + `128.0.0.0/1` are rejected) |
| Mesh | `app`/`version` labels, `sidecar.istio.io/inject: "true"`, Service ports named `http` (8080) and `http-management` (8081); no AuthorizationPolicy, PeerAuthentication, DestinationRule or `excludeInboundPorts` (owned by the mesh repo / forbidden by the contract) |
| Migration Job | not rendered by this chart; a service that runs Flyway as a Job labels its pods `app.kubernetes.io/name=<sa>` (the mesh grants Aurora egress on that label; the Job may run with or without a sidecar) and `app.kubernetes.io/component=db-migration`. The chart's selectors include `app.kubernetes.io/component=service`, so the Service, PDB and topology spread never select Job pods |

## Required values

`serviceName`, `serviceId`, `boundedContext`, `image.repository` and either
`image.tag` or `image.digest`. Rendering with the bare `values.yaml` fails on
purpose; see the fixtures in `ci/` for complete examples.

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
