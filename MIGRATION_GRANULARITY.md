# Migration Granularity Notes

- Repository: `fintechbankx-platform-delivery-templates`
- Source monorepo: `enterprise-loan-management-system`
- Sync date: `2026-03-15`
- Sync branch: `chore/granular-source-sync-20260313`

## Applied Rules

- dir: `templates/microservice` -> `templates/microservice`
- dir: `ci/templates` -> `ci/templates`
- file: `.github/workflows/ci.yml` -> `templates/github/workflows/ci.yml`
- file: `CONTRIBUTING.md` -> `CONTRIBUTING.md`
- file: `CODE_OF_CONDUCT.md` -> `CODE_OF_CONDUCT.md`

## Notes

- This is an extraction seed for bounded-context split migration.
- Follow-up refactoring may be needed to remove residual cross-context coupling.
- Build artifacts and local machine files are excluded by policy.

