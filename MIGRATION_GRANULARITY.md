# Migration Granularity Notes

- Repository: `fintechbankx-platform-delivery-templates`
- Source monorepo: `enterprise-loan-management-system`
- Sync date: `2026-03-15`
- Sync branch: `chore/granular-source-sync-20260313`

## Applied Rules

- dir: `templates/microservice` -> `templates/microservice`
- dir: `ci/templates` -> `ci/templates`
- file: `.github/workflows/ci.yml` -> `templates/legacy/monorepo/github-ci.yml` (moved 2026-10-08: legacy reference only, monorepo paths)
- file: `CONTRIBUTING.md` -> `CONTRIBUTING.md`
- file: `CODE_OF_CONDUCT.md` -> `CODE_OF_CONDUCT.md`

## Notes

- This is an extraction seed for bounded-context split migration.
- Follow-up refactoring may be needed to remove residual cross-context coupling.
- Build artifacts and local machine files are excluded by policy.


## Follow-up extraction (2026-10-08, Proposed)

- dir: `services/helm/open-finance-service` (monorepo) + `deploy/helm/loan-lifecycle-service` (loan-lifecycle-core PR #14) -> `charts/fintechbankx-service` (generalised, not copied verbatim)
- files: `.github/workflows/release.yml`, `codeql.yml` (monorepo) and the service repos' `required-gates.yml` / `deployability.yml` -> reusable workflows in `.github/workflows/*.yml`
- `tools/validation*` (monorepo) not copied: those validators target the monorepo layout; the equivalent split-repo checks live in the reusable workflows and `scripts/ci/`.
