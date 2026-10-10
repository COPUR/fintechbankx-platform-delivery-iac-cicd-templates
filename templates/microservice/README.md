# Microservice skeleton (Gradle / Java 23) - Proposed

Baseline for a FinTechBankX service repository, aligned with the deployable
shape of `fintechbankx-lendingpayments-loan-lifecycle-core` (PR #14) and the
platform contract.

## Stack
- Gradle (Java 23 toolchain); commit the Gradle wrapper (`gradle wrapper`) before the first build, the Dockerfile and CI use `./gradlew`.
- Spring Boot web, validation, actuator, Micrometer Prometheus.
- JUnit 5 + Mockito; Jacoco 85% line coverage wired into `check`.

## Layout
```
.
├── build.gradle / settings.gradle / gradle.properties
├── Dockerfile                    multi-stage, layered jar, UID 10001, ports 8080/8081
├── src/main/resources/application.yml   API 8080, actuator 8081, probes, prometheus
├── deploy/helm/values*.yaml      values for the platform chart charts/fintechbankx-service
├── .github/workflows/service-pipeline.yml   caller of the reusable workflows
└── .github/CODEOWNERS            owning squad; *.accepted-breaking.txt waivers -> data-contracts owners
```
Add `deploy/terraform/` from the terraform-modules repo examples (microservice-base) for the service's own database, KMS key, secrets and IRSA role.

## Conventions
- Domain layer has zero framework dependencies.
- Application layer orchestrates use cases and depends only on domain ports.
- Infrastructure layer implements adapters (REST, persistence, messaging).
- Database per service: own schema `sc_<ctx>_<cap>`, Flyway migrations under `src/main/resources/db/migration`.

## CI/CD
Primary: GitHub Actions. `.github/workflows/service-pipeline.yml` calls the
reusable workflows of this repository (`java-service-ci`, `contract-checks`,
`db-migration-verify`, `security`, `container-image`, `helm-deploy`).
Secondary (kept for teams on other runners, not the reference path):
`templates/ci/gitlab/java23-quality-gates.yml` and
`templates/ci/jenkins/Jenkinsfile.java23-quality-gates` in this repository.
