# Consuming the delivery workflows (Proposed)

Status: Proposed. Validated locally with actionlint, helm lint/template and
kubeconform only; no workflow here has run against AWS yet.

## 1. Pipeline shape

```
pull_request:  java-service-ci + contract-checks + db-migration-verify + security
push to main:  same gates -> container-image (once) -> helm-deploy dev -> staging -> prod
deploy/terraform changes: terraform.yml per environment (plan on PR, apply on main after approval)
```

The image is built once per commit, tagged with the full git SHA and promoted
**by digest**; staging and prod never rebuild.

Start from [templates/github/workflows/service-pipeline.yml](../../templates/github/workflows/service-pipeline.yml)
and [service-infra.yml](../../templates/github/workflows/service-infra.yml).

## 2. Permissions per reusable workflow

GitHub checks a called workflow's requested permissions statically against
what the caller job grants, whether or not a job inside it runs. Grant exactly:

| Workflow | Caller job `permissions` |
|---|---|
| java-service-ci.yml | `contents: read` |
| contract-checks.yml | `contents: read` |
| db-migration-verify.yml | `contents: read` |
| security.yml | `contents: read`, `actions: read`, `security-events: write` |
| container-image.yml | `contents: read`, `id-token: write` |
| helm-deploy.yml | `contents: read`, `id-token: write` |
| terraform.yml | `contents: read`, `id-token: write`, `pull-requests: write` |

Inside each workflow `id-token: write` is requested only by the jobs that use
OIDC (image push/sign, deploy, plan, apply).

## 3. Inputs worth knowing

- `java-service-ci`: `gradle-tasks` defaults to `check` (jacoco gate). Use
  `test` only with a recorded reason; `.ci/allow-gradle-fail` is ignored.
  `postgres-enabled: true` exports `TEST_DB_URL`, `TEST_DB_USERNAME`,
  `TEST_DB_PASSWORD` for a job-scoped container (throwaway credential = role name).
- `container-image`: `boot-jar-task` for Dockerfiles that copy `build/libs`;
  leave empty for multi-stage Dockerfiles (all five extracted services).
  `trivy-severity` defaults to `CRITICAL,HIGH` with `ignore-unfixed`; reviewed
  exceptions go in `.trivyignore` with an expiry comment.
- `helm-deploy`: empty `chart-path` = platform chart at `platform-ref`;
  `values-files` are applied in order; `image-digest` must be `sha256:...`.
- `terraform`: backend from `environments/<env>.backend.hcl` or
  `state-bucket`/`state-key`/`lock-table`; apply runs the saved plan only.
- `contract-checks`: allowlist file `<spec>.accepted-breaking.txt` next to the
  spec, one oasdiff error line per accepted break, each with a comment saying
  who accepted it and when it can be deleted.
- `db-migration-verify`: `schema` = `sc_<ctx>_<cap>`; migrations are
  discovered from `*/db/migration/V*.sql`.

## 4. AWS and GitHub setup per service (owned by terraform-modules / service squads)

1. GitHub OIDC provider `token.actions.githubusercontent.com` in each account.
2. Roles, each trusting only `repo:COPUR/<service-repo>:...`:
   - ECR push: `sub` = `repo:COPUR/<repo>:ref:refs/heads/main`; ECR push/pull on
     `fintechbankx/<serviceName>` only. ECR repository with tag immutability and scan on push.
   - EKS deploy per environment: `sub` = `repo:COPUR/<repo>:environment:<env>`;
     `eks:DescribeCluster` plus an EKS access entry bound to a namespaced
     Role in the service's context namespace (no cluster-admin).
   - Terraform plan (read-mostly) and apply per environment, apply trusted only
     from `environment:<env>`; state bucket/lock table access scoped to the service key.
3. GitHub environments `dev`, `staging`, `prod`; staging and prod with required
   reviewers and a `main`-only deployment branch rule.
4. Repository variables listed in the header of `service-pipeline.yml`.

## 5. Generic chart vs per-service charts

The five extracted services ship their own charts under `deploy/helm/<service>`
(same shape). `helm-deploy.yml` supports them via `chart-path`. Moving to
[charts/fintechbankx-service](../../charts/fintechbankx-service/README.md)
removes duplicated templates; see the chart README for the value mapping.

## 6. Known limits

- Not run end to end against AWS; first real run must be watched.
- Flyway rehearsal and image steps were not executed locally (no Docker
  daemon in the authoring environment).
- The chart's `ServiceMonitor` needs the Prometheus Operator CRDs from
  platform-observability; disable it where they are missing.
