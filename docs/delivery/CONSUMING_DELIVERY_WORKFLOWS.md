# Consuming the delivery workflows (Proposed)

Status: Proposed. Validated locally with actionlint, helm lint/template and
kubeconform only; no workflow here has run against AWS yet.

## 1. Pipeline shape

```
pull_request:  java-service-ci (check + ArchUnit gate) + tdd-gate + contract-checks + db-migration-verify + security
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
| tdd-gate.yml | `contents: read` |
| ephemeral-env.yml | `contents: read`, `id-token: write` |
| db-migration-verify.yml | `contents: read` |
| security.yml | `contents: read`, `actions: read`, `security-events: write` |
| container-image.yml | `contents: read`, `id-token: write` |
| helm-deploy.yml | `contents: read`, `id-token: write` |
| terraform.yml | `contents: read`, `id-token: write`, `pull-requests: write` |

Inside each workflow `id-token: write` is requested only by the jobs that use
OIDC (image push/sign, deploy, plan, apply).

Pinning (supply chain):
- Callers pin each reusable workflow to a platform release commit SHA with the
  tag as a comment (`.../helm-deploy.yml@<40-hex sha> # v1.0.0`) and pass the
  same release as `platform-ref` to `helm-deploy`, `java-service-ci` and
  `tdd-gate`. Renovate or Dependabot (`github-actions` ecosystem) bumps them
  together. The sample callers use the tag `v1.0.0`, to be cut when this
  version merges. `@main` is only for dev experiments.
- Inside this repository every action used by a job with `id-token: write` is
  pinned to a full commit SHA with its version as a trailing comment;
  `scripts/ci/test/workflow-supply-chain.test.mjs` fails otherwise. Resolve a
  new pin with `git ls-remote https://github.com/<owner>/<repo> refs/tags/<tag> 'refs/tags/<tag>^{}'`
  (use the `^{}` line for annotated tags).

## 3. Inputs worth knowing

- `java-service-ci`: `gradle-tasks` defaults to `check` (jacoco gate). Use
  `test` only with a recorded reason; `.ci/allow-gradle-fail` is ignored.
  `postgres-enabled: true` exports `TEST_DB_URL`, `TEST_DB_USERNAME`,
  `TEST_DB_PASSWORD` for a job-scoped container (throwaway credential = role name).
  `mongo-enabled: true` starts MongoDB (`mongo-image`, default `mongo:5.0`
  for the DocumentDB 5.0 API) and exports `TEST_MONGO_URI`
  (`mongodb://localhost:27017/<mongo-db>`, no auth, job-scoped).
- Required status checks: branch protection on the service repositories
  requires `ci/build`, `ci/test` and `ci/security`. A check from a reusable
  workflow is always named `<caller job> / <called job>`, so it can never carry
  those names. The sample callers
  ([java23-quality-gates.yml](../../templates/ci/github/workflows/java23-quality-gates.yml),
  [service-pipeline.yml](../../templates/microservice/.github/workflows/service-pipeline.yml))
  end with three local jobs named exactly `ci/build` (needs `ci`), `ci/test`
  (needs `ci`, `tdd`, `contracts` and, in the pipeline, `migrations`) and
  `ci/security` (needs `security`). Each passes only when every job it needs
  succeeded or was skipped. Keep them when adopting a caller and branch
  protection needs no change.
- `java-service-ci` ArchUnit gate (ADR-028): always runs after `check` using
  `tools/archunit-gate` from this repository at `platform-ref`. `package-root`
  is required (the gate fails with an error when it is empty, a warning under
  `archunit-report-only`): set it to the repository's one package root (`com.bank.<context>`,
  `com.enterprise.openfinance.<capability>`, new repositories
  `com.fintechbankx.<context>.<capability>`) and `archunit-layout`
  (`multi-module`, `single-module` or `auto`). The four rules: domain free of
  application, infrastructure, Spring, JPA, Kafka and Mongo; application free of
  infrastructure; controllers and listeners use `domain.port.in`, not
  application implementations; `domain.port.out` implementations live in
  infrastructure. Rule 5, one package root per repository (guardrails section
  2): with `package-root` set, rules 1-4 run on that root only and every
  compiled main class outside it, and every other package owning a `.domain`
  package (also one nested under the root), fails rule 5 by name; the shared
  kernel `com.bank.shared.kernel` is allowed. (Only under
  `archunit-report-only` can the gate run without `package-root`; rule 5 then
  reports more than one detected root.) `archunit-base-packages`
  (space separated, empty = every package owning a `.domain` package) only
  matters without `package-root`; with it, leave it empty or equal.
  `archunit-generated-packages` (comma separated) declares generated code
  outside the root: excluded from rule 5 and listed in the gate report.
  Prefer generating into `<package-root>.infrastructure.generated`, which is
  inside the root and needs no declaration.
  `archunit-report-only: true` is a visible, temporary escape hatch (all five
  rules) for repositories still fixing their conformance row.
- `tdd-gate` (ADR-029): a PR that changes `src/main/**` without any
  change in a test source set (`src/test/**`, `src/<name>Test/**` such as
  `src/integrationTest/**` or `src/functionalTest/**`, `src/testFixtures/**`)
  fails unless labelled exactly `no-behaviour-change`.
  Trigger the caller on `pull_request` types `labeled` and `unlabeled` too.
- `ephemeral-env`: see [compose/README.md](../../compose/README.md); pass
  service images as `FBX_IMAGE_<SERVICE>=<image@digest>` lines and a
  `test-command`; the stack is always torn down. For regression parity runs:
  - monolith: either `monolith-image` (pinned by digest or immutable tag) or
    `monolith-build-context` (+ optional `monolith-build-command`,
    `java-version`), both relative to the caller workspace; the image is built
    with a local, never-pushed tag. Defaults fit the monolith-oracle app
    (`monolith-spring-profiles: local`, `monolith-health-path: /actuator/health`;
    compose sets `ORACLE_PORT=8080` and `OIDC_ISSUER_URI` to the in-stack issuer).
  - `parity-fixtures: true` adds test users per role (banker, admin,
    loan_officer, compliance_officer, auditor, customer with
    `customer_id=CUST-12345678`) and the `parity-suite` client to the ephemeral
    realm only; usernames, passwords and secrets are in `FBX_ENV_FILE`
    (`PARITY_USERNAME_<ACTOR>`, `PARITY_PASSWORD_<ACTOR>`,
    `PARITY_SECRET_PARITY_SUITE`, `PARITY_SECRET_SVC_LN_LOAN_LIFECYCLE`,
    `PARITY_SECRET_SVC_PAY_INITIATION_SETTLEMENT`).
  - after health, in order: `sql-fixtures` (`<service>=<path>` lines, each run
    with that service's own role in its own database and schema), then
    `seed-command`, then `test-command`, all with the same `FBX_*` variables.
  - `service-env`: `<service>__<VAR>=<value>` lines (e.g.
    `payment-initiation-settlement-service__ACCOUNTS_ADAPTER=in-memory`);
    credential-like and identity/database wiring names are rejected.
- `container-image`: `boot-jar-task` for Dockerfiles that copy `build/libs`;
  leave empty for multi-stage Dockerfiles (all five extracted services).
  `trivy-severity` defaults to `CRITICAL,HIGH` with `ignore-unfixed`; reviewed
  exceptions go in `.trivyignore` with an expiry comment.
- `helm-deploy`: empty `chart-path` = platform chart at `platform-ref`;
  `values-files` (relative paths) are applied in order; `image-digest` must be
  `sha256:...`.
  - Same bytes: the validate job resolves `platform-ref` to a commit, checks the
    chart out once, packages chart + values into a bundle, lints/renders/
    kubeconforms that bundle and publishes its sha256 as a job output. The
    deploy job checks nothing out; it downloads the bundle, re-checks the digest
    and every file, and deploys the packaged chart.
  - `platform-ref` for `prod`/`production` must be a 40-char commit SHA or a
    tag; a branch (or a name that is both a branch and a tag) fails the run.
  - Signature: before `helm upgrade` the deploy job runs `cosign verify` on
    `image-repository@image-digest` (keyless, issuer
    `cosign-certificate-oidc-issuer`, default
    `https://token.actions.githubusercontent.com`; GitHub workflow repository =
    the calling repo or `cosign-source-repository`). Default identity: this
    repo's `.github/workflows/container-image.yml` at a tag or commit SHA (dev
    and staging also accept `refs/heads/main`), because a reusable workflow
    signs with its own identity. `cosign-certificate-identity-regexp` overrides
    it and must be anchored. There is no skip input; a failed verification
    stops the deploy. The EKS deploy role needs ECR read
    (`ecr:GetAuthorizationToken`, `ecr:BatchGetImage`,
    `ecr:GetDownloadUrlForLayer`) on the service repository.
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
- Metrics: the single scrape path is the PodMonitor `fintechbankx-services`
  of the observability platform repo
  (`fintechbankx-platform-observability-sre-operations`), which selects pods
  labelled `fintechbankx.io/service-id` and scrapes Istio's merged metrics.
  The chart's `ServiceMonitor` is off by default; enable it only where that
  PodMonitor does not run (it needs the Prometheus Operator CRDs and drops the
  `prometheus.io` annotations so the app is not scraped twice).
- NetworkPolicy belongs to the service-mesh platform repo
  (`fintechbankx-platform-mesh-security-service-mesh`), like
  AuthorizationPolicy: the chart renders none unless `networkPolicy.enabled:
  true`, and then only with narrowed `egressCidrs` (the chart schema accepts
  IPv4 `/8`-`/32` and IPv6 `/32`-`/128` only, so `0.0.0.0/0`, `::/0` and
  halves such as `0.0.0.0/1` are rejected).
