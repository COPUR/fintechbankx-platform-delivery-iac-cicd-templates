# Platform Delivery Templates

DDD/EDA platform capability (`svc-dly-templates`)  
Owner: DevSecOps Enablement Squad  
Wave: 0

## Phase-2 Deliverables

This repository provides reusable delivery templates for Java 23 microservices:

- GitHub Actions quality gate workflow template
- GitLab CI quality gate template
- Jenkins quality gate pipeline template
- Shared Gradle command resolver script for wrapper/non-wrapper repos

## Delivered Templates

- `templates/ci/github/workflows/java23-quality-gates.yml`
- `templates/ci/gitlab/java23-quality-gates.yml`
- `templates/ci/jenkins/Jenkinsfile.java23-quality-gates`
- `templates/ci/scripts/resolve-gradle-command.sh`
- `templates/microservice/*`

## Adoption

1. Copy the template pipeline file for your CI platform into your service repo.
2. Ensure the service repo includes `templates/ci/scripts/resolve-gradle-command.sh`.
3. Run quality gates:
   - `clean test jacocoTestReport jacocoTestCoverageVerification`
   - OpenAPI lint (`api/openapi/*.yaml`) when present
   - Secret scanning (`gitleaks`)

## Governance Notes

- Coverage gate target is `>= 85%` line coverage.
- OpenAPI lint and secret scanning are intended to be blocking gates for protected branches.

## Strict mTLS Enforcement

This repository includes the Wave 0 strict mTLS policy validator pattern:

- Workflow: `.github/workflows/strict-mtls-enforcement.yml`
- Validator: `scripts/validation/validate-strict-mtls.mjs`

Run locally:

```bash
npm ci
npm test
npm run validate:strict-mtls
```
