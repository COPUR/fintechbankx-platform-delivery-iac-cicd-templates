# fintechbankx-platform-delivery-iac-cicd-templates

Bu repository, FinTechBankX DDD/EDA dönüşümünde **svc-dly-templates** servis yetkinliğinin kaynak kodunu, kontratlarını ve operasyonel guardrail'lerini içerir.

## Sorumluluk ve Sahiplik
| Alan | Değer |
|---|---|
| Organizasyon Modeli | Spotify Model (Tribe/Squad) |
| Tribe | Platform & Enablement Tribe |
| Squad | DevSecOps Enablement Squad |
| Repo Kümesi (Capability) | platform |
| Service ID | svc-dly-templates |
| Bounded Context | delivery_templates |
| Wave | 0 |
| Mimari Yaklaşım | Platform (paylaşılan teslimat altyapısı; domain mantığı içermez) |

## What this repository provides (Proposed)

The delivery platform every FinTechBankX service consumes. Nothing here is
deployed or released yet. Callers pin every reusable workflow to a release
commit SHA (`@<sha> # v1.0.0`; the sample callers name the tag `v1.0.0`, which
is cut on merge) and pass the same release as `platform-ref`; Renovate or
Dependabot bumps them. `@main` is for dev experiments only; `helm-deploy`
rejects a branch `platform-ref` for prod. Actions in jobs that hold OIDC
credentials are pinned to commit SHAs (checked by
`scripts/ci/test/workflow-supply-chain.test.mjs`).

| Capability | Path | How a service uses it |
|---|---|---|
| Java 23 CI (gradle `check` with jacoco gate, optional PostgreSQL + `TEST_DB_URL`, controller guardrail) | [.github/workflows/java-service-ci.yml](.github/workflows/java-service-ci.yml) | `uses: COPUR/fintechbankx-platform-delivery-iac-cicd-templates/.github/workflows/java-service-ci.yml@<release-sha>` |
| ArchUnit gate (ADR-028: the four hexagonal rules on the service's compiled classes, both package layouts, plus rule 5: one package root per repository) | [tools/archunit-gate](tools/archunit-gate/README.md) | runs inside `java-service-ci.yml` after `check`; set `package-root` |
| TDD gate (ADR-029: `src/main` changes need test changes in `src/test`, `src/<name>Test` or `src/testFixtures`, opt-out label `no-behaviour-change`) | [.github/workflows/tdd-gate.yml](.github/workflows/tdd-gate.yml) | PR gate |
| Ephemeral environment (compose runtime + service images + optional monolith image or build, parity test actors, SQL fixtures, seed and test commands, always torn down) | [.github/workflows/ephemeral-env.yml](.github/workflows/ephemeral-env.yml) | regression / parity runs |
| Shared local runtime (PostgreSQL per service, KRaft Kafka, Keycloak realm, OTel, service and monolith profiles) | [compose](compose/README.md) | `compose/fbx-local.sh up <profiles>` |
| Container image (Buildx, Trivy, Syft SBOM, ECR via OIDC, SHA tag, cosign keyless) | [.github/workflows/container-image.yml](.github/workflows/container-image.yml) | outputs `image-digest`, `image-repository`, `image-tag` |
| Helm deploy to EKS (lint, template, kubeconform on one packaged chart+values bundle, cosign signature check of the digest, environment-gated `helm upgrade --install --atomic --wait` of that same bundle) | [.github/workflows/helm-deploy.yml](.github/workflows/helm-deploy.yml) | one call per environment |
| Terraform (fmt/validate, OIDC plan on S3 backend, plan artifact, optional PR comment, environment-gated apply) | [.github/workflows/terraform.yml](.github/workflows/terraform.yml) | for `deploy/terraform` |
| Contracts (Redocly, oasdiff with `<spec>.accepted-breaking.txt`, FAPI guard, AsyncAPI) | [.github/workflows/contract-checks.yml](.github/workflows/contract-checks.yml) | PR gate |
| Database migration rehearsal (Flyway migrate twice + validate, `scripts/migration/verify-backfill.sh`) | [.github/workflows/db-migration-verify.yml](.github/workflows/db-migration-verify.yml) | PR gate |
| Security (gitleaks, dependency review, CodeQL) | [.github/workflows/security.yml](.github/workflows/security.yml) | PR gate |
| Generic service Helm chart (8080/8081, HPA, PDB, zone spread, ExternalSecret, IRSA, ServiceMonitor, opt-in NetworkPolicy (the mesh repo owns NetworkPolicy), Istio labels) | [charts/fintechbankx-service](charts/fintechbankx-service/README.md) | via `helm-deploy.yml` or `chart-path` |
| Sample caller pipelines | [templates/github/workflows](templates/github/workflows/service-pipeline.yml) | copy into the service repo |
| Service skeleton | [templates/microservice](templates/microservice/README.md) | starting point for a new service |
| Secondary CI templates (GitLab, Jenkins) | [templates/ci](templates/ci/gitlab/java23-quality-gates.yml), [ci/templates](ci/templates/microservice/gitlab-ci.yml) | only where GitHub Actions is not available |

GitHub Actions is the primary CI/CD path. Details, permissions per workflow and
the AWS/GitHub setup each service needs: [docs/delivery/CONSUMING_DELIVERY_WORKFLOWS.md](docs/delivery/CONSUMING_DELIVERY_WORKFLOWS.md).

Validate this repository locally:

```bash
npm ci
npm test && npm run validate:strict-mtls   # includes compose and tdd-gate tests
npm run test:archunit-gate                 # JDK 21+
npm run lint:workflows     # needs actionlint (and shellcheck for script checks)
npm run validate:chart     # needs helm and kubeconform
```

## Sorumluluk Sınırları
- Bu repo kendi bounded context domain modelinin tek yetkili sahibidir.
- Domain kuralları altyapıdan bağımsız tutulur; entegrasyonlar port/adapter katmanında yönetilir.
- API/Event kontratları geriye dönük uyumluluk kontrolleri ile korunur.
- Güvenlik guardrail'leri (mTLS, token doğrulama, idempotency, log hijyeni) CI/CD ile zorlanır.

## Kapsam
### In Scope
- delivery_templates bağlamına ait uygulama kodu, testler ve otomasyon.
- Bu servise ait OpenAPI/AsyncAPI veya şema artefaktları.
- Bu servisin çalışma zamanı operasyonları (gözlemlenebilirlik, release, rollback).

### Out of Scope
- Diğer bounded context'lerin iş kuralları ve veri sahipliği.
- Paylaşımlı DB anti-pattern'i; cross-context doğrudan tablo erişimi.
- Platform dışı gizli bilgi/anahtar yönetimi (merkezi policy dışında local hardcode).

## Mühendislik Standartları
- **TDD öncelikli** geliştirme, birim test + entegrasyon testi.
- **Clean Architecture**: Domain katmanı framework bağımsız.
- **12-Factor** ve environment-driven configuration.
- **FAPI odaklı güvenlik** (OIDC/OAuth2, mTLS, DPoP gereksinimleri ilgili servislerde).
- **PII güvenliği**: loglarda maskeleme, secret'ların source/env içine yazılmaması.

## Branching ve Release Akışı
- Uzun ömürlü branch'ler: `main`, `dev`, `staging`, `local`.
- Feature branch kuralı: `codex/<kisa-aciklama>` (agent çalışmaları `claude/<kisa-aciklama>`).
- Release yaklaşımı: PR + required status checks + tag tabanlı sürümleme.

## Dokümantasyon ve Referanslar
- [Enterprise Architecture Hub](https://github.com/COPUR/fintechbankx-governance-architecture-enablement-enterprise-architecture)
- [Secure Microservices Architecture](https://github.com/COPUR/fintechbankx-governance-architecture-enablement-enterprise-architecture/blob/main/docs/architecture/overview/SECURE_MICROSERVICES_ARCHITECTURE.md)
- [Service Data Ownership Matrix](https://github.com/COPUR/fintechbankx-governance-architecture-enablement-enterprise-architecture/blob/main/docs/enterprisearchitecture/implementation-development/SERVICE_DATA_OWNERSHIP_MATRIX.md)
- [Service API Contracts Index](https://github.com/COPUR/fintechbankx-governance-architecture-enablement-enterprise-architecture/blob/main/docs/enterprisearchitecture/implementation-development/SERVICE_API_CONTRACTS_INDEX.md)
- [Transformation Plan](https://github.com/COPUR/fintechbankx-governance-architecture-enablement-enterprise-architecture/blob/main/docs/enterprisearchitecture/implementation-development/MICROSERVICES_TRANSFORMATION_PLAN.md)
- [Capability Map (PUML)](https://github.com/COPUR/fintechbankx-governance-architecture-enablement-enterprise-architecture/blob/main/docs/puml/service-mesh/enterprise-capability-map.puml)
- Repo dokümanları: [docs/README.md](docs/README.md)

## Güvenlik ve Uyumluluk Notları
- Gerçek secret değerleri repo veya `.env` içinde tutulmaz.
- Secret üretim/rotasyon olayları merkezi log/SIEM'e taşınır.
- CI pipeline, anonimlik ve local-path sızıntısı kontrollerini bloklayıcı olarak çalıştırır.

## Katkı
- Katkı süreci için `CONTRIBUTING.md` ve squad runbook'ları izlenmelidir.
- PR'larda mimari kararlar ADR veya backlog referansı ile ilişkilendirilmelidir.

<!-- cell-architecture-start -->
## Cell-Based Architecture

This repository participates in the FinTechBankX cell-based resilience program.

- Plan: docs/architecture/CELL_BASED_ARCHITECTURE_IMPLEMENTATION_PLAN.md
- Backlog: docs/project-management/CELL_ARCHITECTURE_BACKLOG_BOARD.md
<!-- cell-architecture-end -->
