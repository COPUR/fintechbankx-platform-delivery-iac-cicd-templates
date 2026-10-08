# Shared local / ephemeral runtime (Proposed)

One Docker Compose stack for laptops and CI ephemeral environments, replacing the
monolith's `docker-compose.yml`, `docker-compose.open-finance-eventing.yml` and
`docker/init-scripts` with the split-world shape:

| Part | What runs | Source of truth |
|---|---|---|
| PostgreSQL 16 | one database, schema and LOGIN role per service; no role can connect to another service's database | [services.tsv](services.tsv) (matches each service repo's `application.yml`), [postgres/init](postgres/init/10-service-databases.sh) |
| Kafka | single-broker KRaft (no ZooKeeper), auto-create off, catalog topics at RF 1 | topic catalog and `create-topics.sh` fetched from fintechbankx-platform-event-streaming-kafka |
| Keycloak 26 + realm import | dev-mode Keycloak, realm `fintechbankx` applied by keycloak-config-cli, then `admin-permissions` (the identity repo's second import step: fine-grained admin permissions, e.g. the customer service's view/manage-members on `/customers`, and scope-mapping narrowing); the customer service waits for it | `realm/fintechbankx-realm.json`, `realm/admin-permissions.json` and `scripts/realm/apply-admin-permissions.mjs` fetched from fintechbankx-platform-identity-iam-keycloak-ldap |
| `observability` profile | OTel collector + Jaeger (UI on 127.0.0.1:16686) | [otel/collector.yaml](otel/collector.yaml) |
| service profiles | `lending` (loan + customer), `payments` (initiation-settlement + risk + compliance), `customer`, `riskcompliance`, `services` (all five) | images `fintechbankx/<service>:local` or `FBX_IMAGE_*` |
| `monolith` profile | comparison target side by side (+ Redis): the monolith-oracle app by default, or the full ELMS image | `FBX_MONOLITH_IMAGE` |
| `parity-fixtures` profile | regression parity test actors layered onto the realm (local/ephemeral only) | [keycloak/parity-fixtures.template.json](keycloak/parity-fixtures.template.json) |

## Use

```bash
compose/fbx-local.sh up lending observability   # fetch assets, generate secrets, start, wait for health
compose/fbx-local.sh compose ps
compose/fbx-local.sh down                        # removes containers and volumes
```

Issuer for tokens: `http://localhost:8180/realms/fintechbankx`. Service ports on
127.0.0.1: loan 18010, payment 18020, customer 18030, risk 18040, compliance 18050, monolith 18000.

## Secrets

`compose/scripts/init-env.sh` writes `compose/.env` and `compose/realm.env`
(mode 600, git-ignored) with random values from `openssl rand`: the PostgreSQL
superuser, one credential per service database, the Keycloak admin, Redis, one
OIDC client credential per service and every `$(env:NAME)` placeholder of the
realm (LDAP and channel URLs get fixed dev values: customer web
`http://localhost:3000`, staff web (`fintechbankx-staff-web`)
`http://localhost:3002`, Grafana `http://localhost:3001`). Nothing secret is
committed; the compose file uses `${VAR:?...}` so it refuses to start without
the generated file. A new realm placeholder without a dev value fails the
script on purpose.

Pin asset versions with `FBX_IDENTITY_REF` / `FBX_KAFKA_REF`, or read local
checkouts with `FBX_IDENTITY_SOURCE` / `FBX_KAFKA_SOURCE`.

When the realm sets `adminPermissionsEnabled`, `fetch` also copies the
admin-permissions spec and script into `.cache/identity-admin/` (outside the
directory realm-import reads) and fails if the identity ref lacks them. The
`admin-permissions` service (Node 22, same pinned image as the identity Job)
logs in as the local bootstrap admin (`KEYCLOAK_GRANTTYPE=password`, `admin-cli`,
master realm) and gets only that login.

## Regression parity support

Used by the parity suite through `.github/workflows/ephemeral-env.yml`
(inputs in brackets); everything also works locally.

**Test actors** (`parity-fixtures: true`; locally
`fbx-local.sh init --parity-fixtures` then `up <profiles> parity-fixtures`).
`init-env.sh` renders `.cache/parity/parity-fixtures.json` from
[keycloak/parity-fixtures.template.json](keycloak/parity-fixtures.template.json)
and the `parity-fixtures-import` service (same keycloak-config-cli image,
remote state off, every managed type `no-delete`) layers it onto the realm
after `realm-import`; services and the monolith wait for it when the profile
is on (`required: false` otherwise). It adds:

- users `parity-banker`, `parity-admin`, `parity-loan-officer`,
  `parity-compliance-officer`, `parity-auditor`, `parity-customer`, each with the
  realm role of the same name; `parity-customer` has the user attribute
  `customer_id=CUST-12345678`, which the realm's `customer-id` client scope puts
  in the access token as `customer_id`. `sub` stays the Keycloak UUID.
  `parity-customer` and `parity-other-customer` are members of `/customers`
  (the group the customer service's admin permission covers); staff actors are
  not. The realm at `identity-ref` must declare every group the fixture uses,
  otherwise init fails.
- the confidential client `parity-suite`: client credentials and password
  grant (this fixture only, not tagged as a service client, so the realm's
  ROPC rejection does not apply), audiences `svc-ln-loan-lifecycle`,
  `svc-pay-initiation-settlement`, `svc-cus-profile-kyc`, `svc-rsk-decisioning`,
  `svc-cmp-evidence`, default scopes `basic roles profile email customer-id`.
- the realm's LDAP federation, disabled (compose runs no OpenLDAP; an
  unreachable directory must not break local-user lookups).

Credentials are random and land in `compose/.env` (mode 600, git-ignored;
`FBX_ENV_FILE` in the workflow) and `realm.env`; nothing secret is committed:

| Variable | Value |
|---|---|
| `PARITY_USERNAME_<ACTOR>` | `parity-<actor>` (`BANKER`, `ADMIN`, `LOAN_OFFICER`, `COMPLIANCE_OFFICER`, `AUDITOR`, `CUSTOMER` with `customer_id` CUST-12345678, `OTHER_CUSTOMER` with CUST-99999999 for ownership-denial cases). The identity realm at `identity-ref` must declare `customer_id` (identity PR #11 or later), otherwise init fails |
| `PARITY_PASSWORD_<ACTOR>` | password satisfying the realm policy |
| `PARITY_SECRET_PARITY_SUITE` | `parity-suite` client secret |
| `PARITY_SECRET_SVC_LN_LOAN_LIFECYCLE`, `PARITY_SECRET_SVC_PAY_INITIATION_SETTLEMENT` | the same secrets the realm import gives those service clients |

Tokens: `POST http://localhost:8180/realms/fintechbankx/protocol/openid-connect/token`
(`grant_type=password` with `client_id=parity-suite` for an actor,
`grant_type=client_credentials` for a service client). Re-importing into a
running Keycloak may trip the realm's password history; use `down` first.

**SQL fixtures** (`sql-fixtures`, lines `<service>=<path>` relative to the
caller workspace; locally `scripts/apply-sql-fixtures.sh --fixtures FILE`).
After the stack is healthy (Flyway has run), each file runs with
`psql -X -1 -v ON_ERROR_STOP=1` as that service's own role, in its own
database, with its schema as `search_path`. Unknown services and paths outside
the workspace are rejected before anything starts.

**Seed hook** (`seed-command`): runs after the SQL fixtures and before
`test-command`, in the caller checkout, with the same `FBX_*` variables. The
data and any service seed endpoint belong to the service and regression
repositories.

**Extra service environment** (`service-env`, lines
`<service>__<VAR>=<value>`, service as services.tsv key or service id; locally
`fbx-local.sh service-env FILE`). Rendered by
[scripts/service-env.mjs](scripts/service-env.mjs) into
`.cache/service-env.override.json`, which `fbx-local.sh` merges after the
compose file, so a line can also replace a default. Names must be
`UPPER_SNAKE_CASE`; anything credential-like (`PASS`, `SECRET`, `CRED`,
`TOKEN`, `KEY`, `CERT`, `USER`, `AUTH`, ...) or identity/database wiring
(`OIDC_*`, `DB_*`, `SPRING_DATASOURCE_*`, `SPRING_SECURITY_*`, `KEYCLOAK*`,
`KC_*`) is rejected. Example: `payment-initiation-settlement-service__ACCOUNTS_ADAPTER=in-memory`.

**Caller allow-lists**: customer `SERVICE_CALLERS=svc-ln-loan-lifecycle`; risk
and compliance `SERVICE_CALLERS=svc-pay-initiation-settlement` (comma separated
`azp` values, the variable the three services read).

**Comparison target** (`monolith` profile). Defaults are for the
monolith-oracle app (enterprise-loan-management-system
`regression-parity/monolith-oracle`): `ORACLE_PORT=8080`,
`OIDC_ISSUER_URI=http://localhost:8180/realms/fintechbankx` (the issuer tokens
carry), `OIDC_JWK_SET_URI` on the compose network, `SPRING_PROFILES_ACTIVE=local`
(`FBX_MONOLITH_SPRING_PROFILES`), health at `/actuator/health`
(`FBX_MONOLITH_HEALTH_PATH`) checked with curl, wget or bash, published on
127.0.0.1:18000 (`FBX_MONOLITH_BASE_URL`). In the workflow pass either a
pinned `monolith-image` or `monolith-build-context`
(`regression-parity/monolith-oracle`) with `monolith-build-command`
(`./gradlew :regression-parity:monolith-oracle:installDist`) and
`java-version`; the build gets a local tag that is never pushed. For the full
ELMS image set `docker` and `/api/actuator/health`.

## Tests

`node --test compose/test/*.test.mjs` (part of `npm test`): secret generation,
asset fetching, compose wiring and credential hygiene, `docker compose config -q`
for every profile, parity actors and their rendered realm layer, service-env
validation, the workflow structure, and the PostgreSQL init and SQL fixtures
against a real server (local PostgreSQL 16 binaries or `FBX_TEST_PGHOST`).

## Known gaps

- Not started end to end here (no Docker daemon in the authoring environment);
  `docker compose config` and the database init were exercised.
- LDAP federation in the realm points at `ldap://openldap:389`, which this stack
  does not run; interactive staff logins (client `fintechbankx-staff-web`; the
  customer clients `fintechbankx-web` and `fintechbankx-mobile` map only the
  `customer` role) need the identity repo's OpenLDAP component. Staff parity
  actors log in through `parity-suite` instead.
- The full ELMS monolith expects its own realm and profiles; set
  `FBX_MONOLITH_SPRING_PROFILES` and `FBX_MONOLITH_HEALTH_PATH` for that image.
- The parity layer (keycloak-config-cli no-delete import, disabled LDAP,
  password grant), the admin-permissions step and the monolith-oracle wiring
  are validated by the tests above, not by a live Keycloak run here.
