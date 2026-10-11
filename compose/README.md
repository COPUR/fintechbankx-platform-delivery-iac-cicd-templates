# Shared local / ephemeral runtime (Proposed)

One Docker Compose stack for laptops and CI ephemeral environments, replacing the
monolith's `docker-compose.yml`, `docker-compose.open-finance-eventing.yml` and
`docker/init-scripts` with the split-world shape:

| Part | What runs | Source of truth |
|---|---|---|
| PostgreSQL 16 | one database, schema and LOGIN role per `postgresql` row of services.tsv; no role can connect to another service's database | [services.tsv](services.tsv) (matches each service repo's `application.yml`), [postgres/init](postgres/init/10-service-databases.sh) |
| MongoDB 7.0 (`openfinance`, `services`) | `mongo` plus the `mongo-init` one-shot: one user per `mongodb` row of services.tsv, readWrite on its own database only; no `mongodb` row yet | [mongo/init](mongo/init/10-service-databases.sh) |
| Kafka | single-broker KRaft (no ZooKeeper), auto-create off, catalog topics at RF 1 | topic catalog and `create-topics.sh` fetched from fintechbankx-platform-event-streaming-kafka |
| Keycloak 26 + realm import | dev-mode Keycloak, realm `fintechbankx` applied by keycloak-config-cli, then `admin-permissions` (the identity repo's second import step: fine-grained admin permissions, e.g. the customer service's view/manage-members on `/customers`, and scope-mapping narrowing); the customer service waits for it | `realm/fintechbankx-realm.json`, `realm/admin-permissions.json` and `scripts/realm/apply-admin-permissions.mjs` fetched from fintechbankx-platform-identity-iam-keycloak-ldap |
| `observability` profile | OTel collector + Jaeger (UI on 127.0.0.1:16686) | [otel/collector.yaml](otel/collector.yaml) |
| service profiles | `lending` (loan + customer), `payments` (initiation-settlement + risk + compliance + customer), `customer`, `riskcompliance`, `openfinance` (MongoDB so far), `services` (all five + MongoDB); customer, risk and compliance each with a `<service>-migrate` one-shot | images `fintechbankx/<service>:local` or `FBX_IMAGE_*` |
| `monolith` profile | comparison target side by side (+ Redis): the monolith-oracle app by default, or the full ELMS image | `FBX_MONOLITH_IMAGE` |
| `parity-fixtures` profile | regression parity test actors layered onto the realm, and parity-suite's admin permission on `/customers` (local/ephemeral only) | [keycloak/parity-fixtures.template.json](keycloak/parity-fixtures.template.json), [keycloak/parity-admin-permissions.json](keycloak/parity-admin-permissions.json) |

## Use

```bash
compose/fbx-local.sh up lending observability   # fetch assets, generate secrets, start, wait for health
compose/fbx-local.sh compose ps
compose/fbx-local.sh down                        # removes containers and volumes
compose/fbx-local.sh reset                       # lighter reset between parity runs (see below)
```

Issuer for tokens: `http://localhost:8180/realms/fintechbankx`. Service ports on
127.0.0.1 (services.tsv `host_port`): loan 18010, payment 18020, customer 18030,
risk 18040, compliance 18050, monolith 18000; PostgreSQL 15432, MongoDB 37017.

## Secrets

`compose/scripts/init-env.sh` writes `compose/.env` and `compose/realm.env`
(mode 600, git-ignored) with random values from `openssl rand`: the PostgreSQL
superuser, the MongoDB root (`MONGO_ROOT_CRED`, user `fbx-local-root`, used by
`mongo-init` only), one credential per service database (either store), the
Keycloak admin, Redis, one OIDC client credential per service and every
`$(env:NAME)` placeholder of the
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

## Service registry and wiring

[services.tsv](services.tsv) has one row per service: key (the compose
service), service id, profiles, database, schema, app role, credential
variable, image variable, host port and **store** (`postgresql` or
`mongodb`; decision D1: an explicit column rather than reading Mongo from a
`-` schema). Every reader takes the column it needs and ends its `read` with
`_`, so a column appended later never lands in another one:
`postgres/init` creates `postgresql` rows only, `mongo/init` `mongodb` rows
only (both stop on any other store value), `init-env.sh` generates a
credential for every row, `apply-sql-fixtures.sh` refuses a `mongodb`
service, and the `ephemeral-env.yml` export step reads `host_port` as column 9.

**MongoDB** (decision D10): `mongo:7.0.41`, the 7.0 line the open-finance
services' own CI runs (`mongo:7` and `mongo:7.0` there, no digest pinned), so
pinned here by full version tag. It is healthy only once it answers on the
compose network (`mongosh --host mongo`): the image's first start runs a
temporary `mongod` on 127.0.0.1 that must not count. `mongo-init` (same image,
re-runnable like `topic-init`) then creates or updates, for each `mongodb`
row, the user `<app_role>` in `<database>` with `readWrite` on that database
only; a service connects with
`mongodb://<app_role>:${<credential_var>}@mongo:27017/<database>`. Root
login and user credentials reach `mongosh` through the environment, never its
command line. Its data has no named volume: `down` and `reset` drop it with
the container.

**Migrations.** Loan and initiation run Flyway in-process. Customer, risk and
compliance only validate their Flyway history at start-up and refuse an
empty database; their image migrates when its first argument is `migrate`
(datasource and Flyway only, the `db-migrate` profile added to `local`, then
exit). Compose runs that as `<service>-migrate`, a one-shot of the same image
with the same database settings, and the service waits for it
(`service_completed_successfully`). The app role owns its schema here, so it
is also the role Flyway migrates as (no `DB_MIGRATION_*`).

What each service gets beyond the common database, Kafka (`kafka:9092`,
`PLAINTEXT`, after `topic-init`) and JWT settings, checked against its
`application.yml`:

| Service | Settings | Why |
|---|---|---|
| loan | `CUSTOMER_CREDIT_ADAPTER=http`, `CUSTOMER_CREDIT_LEDGER_CURRENCY=USD`, `CUSTOMER_SERVICE_BASE_URL=http://customer-profile-kyc-service:8080` | the adapter has an empty default that creates no adapter bean, so the service does not start; the ledger currency has none and is the currency of the customer service's parity seed |
| initiation | `PAYMENT_DEFAULT_CURRENCY=USD`, `ACCOUNTS_ADAPTER=in-memory` (decision D3), `RISK_SERVICE_BASE_URL`, `COMPLIANCE_SERVICE_BASE_URL`, `CUSTOMER_SERVICE_BASE_URL` on the compose service names | the currency is required; the http accounts adapter needs a URL no service provides and fails at start-up; the URLs default to cluster DNS names. The in-memory demo accounts hold the default currency |
| loan, initiation | `SERVICE_CLIENT_SECRET` (the secret realm-import gives `svc-ln-loan-lifecycle` / `svc-pay-initiation-settlement`), `OIDC_TOKEN_URI=http://keycloak:8080/realms/fintechbankx/protocol/openid-connect/token` | their outbound client-credentials registration; the token URI defaults to `localhost:8180`, which a container cannot reach. The client id keeps its default (the service id) |
| customer | `IDENTITY_ADMIN_ENABLED=true`, `KEYCLOAK_BASE_URL=http://keycloak:8080`, `IDENTITY_ADMIN_CLIENT_SECRET` (the secret of `svc-cus-profile-kyc`) | identity link (`PUT /api/v1/customers/{id}/identity-link`) through the Keycloak admin API; off it answers 503. The realm's `svc-cus-profile-kyc` client has a service account, and `admin-permissions` gives it view and manage members of `/customers` before customer starts |
| risk, compliance | Kafka settings like the others | their outbox relay (`OUTBOX_RELAY_ENABLED`, off by default) would otherwise publish to `localhost:9092` |

`payments` starts customer too: initiation reads the KYC status before every
payment and refuses the payment when it cannot. A test checks that every
compose-network URL a service gets names a service that each of the caller's
profiles also starts.

No service gets `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` (none reads them) or
`OTEL_*` variables: Spring Boot 3.3.6 reads none, none of the five services
maps one, and none ships an OTLP exporter. `MANAGEMENT_TRACING_ENABLED`
(`FBX_TRACING_ENABLED`, default false) stays; it only switches in-process
tracing.

**Memory** (decision D11): every service container and migrate one-shot has
`mem_limit: ${FBX_SERVICE_MEM_LIMIT:-768m}`, the smallest memory limit in the
fifteen services' Helm values (atm and products; the others have 896Mi or
1Gi). The images size the heap at 75 % of the container limit
(`MaxRAMPercentage=75`) instead of 75 % of the runner's memory, so fifteen
JVMs fit on one runner. Raise it per run with `FBX_SERVICE_MEM_LIMIT`.

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
  `parity-other-customer` and `parity-customer-owner` have the realm role
  `customer` too. `parity-customer-owner` has no `customer_id`: the suite
  creates a customer and links this user to it (identity link), which sets the
  attribute. `parity-customer`, `parity-other-customer` and
  `parity-customer-owner` are members of `/customers` (the group the customer
  service's admin permission covers); staff actors are not. The realm at `identity-ref` must declare every group the fixture uses,
  otherwise init fails.
- the confidential client `parity-suite`: client credentials and password
  grant (this fixture only, not tagged as a service client, so the realm's
  ROPC rejection does not apply), audiences `svc-ln-loan-lifecycle`,
  `svc-pay-initiation-settlement`, `svc-cus-profile-kyc`, `svc-rsk-decisioning`,
  `svc-cmp-evidence`, default scopes `basic roles profile email customer-id`.
- parity-suite's fine-grained admin permission (FGAP v2): the
  `parity-admin-permissions` service applies
  [keycloak/parity-admin-permissions.json](keycloak/parity-admin-permissions.json)
  (permission `parity-customers-parity-suite`, client policy
  `parity-suite-client`: `view-members` and `manage-members` on `/customers`,
  the same grant the customer service has) with the identity repo's
  `apply-admin-permissions.mjs`, after `admin-permissions` and
  `parity-fixtures-import`. Its own names leave the identity repo's permission
  untouched. The realm must set `adminPermissionsEnabled`, otherwise init fails.
- the open-finance TPP clients `TPP-001` and `TPP-002` (Keycloak mode;
  `TPP-001` replaces the earlier `parity-tpp`, see the table below):
  `fbx.client-type=open-finance-tpp`, so the realm's FAPI 2.0 + DPoP client
  policy applies; `private_key_jwt` client authentication signed PS256,
  DPoP-bound access tokens, client credentials only (no password grant, no
  browser flow). Each has its own RSA key pair, generated by `init-env.sh` per
  environment: the private JWK goes only into `.env`, the public JWKS is
  registered on the client (`jwks.string`). Audience mappers and client scopes
  are copied from the realm's `of-tpp-conformance-template`, so the token
  carries the same audiences as an onboarded TPP (consent, data, payee,
  metadata and the other TPP APIs the template lists). When the realm has the
  client scope `fbx-client-type-open-finance-tpp` it is a default scope, so
  every TPP token carries `fbx_client_type=open-finance-tpp`.
  - optional scopes on both TPPs: `read_accounts`, `read_balances`,
    `read_transactions`, `read_parties`, `read_metadata`,
    `read_standing_orders`, `payments`. The realm's own scopes are reused
    (the current identity realm defines `payments`); the layer defines
    only the ones the realm lacks, as scope values without mappers.
  - optional PSU scopes on `TPP-001` only, each a hardcoded `customer_id`
    claim: `parity-psu-PSU-001` (`PSU-001`), `parity-psu-CORP-001`
    (`CORP-001`), `parity-psu-PSU-PARITY-LIST` (`PSU-PARITY-LIST`). Request
    one with `scope=parity-psu-PSU-001 read_accounts`; the scope value itself
    is not echoed in the token, the `customer_id` claim is. Without one the
    token has no `customer_id`.
- the first-party channel client `parity-channel`. The realm's
  `fintechbankx-mobile` is a public PKCE client (authorization code only, no
  client credential), which a headless suite cannot drive without a browser,
  so this is a parity-only confidential stand-in with the same key-bound
  set-up as the TPPs (`private_key_jwt` PS256, DPoP-bound, client credentials
  only, own runtime key) and `fintechbankx-mobile` semantics: the same
  audience mappers (including `svc-pay-request-to-pay`) and default scopes,
  and a hardcoded claim `fbx_client_type` with the mobile client's
  `fbx.client-type` (`first-party-public`). Its own `fbx.client-type`
  attribute is `parity-channel`, so no realm client policy matches it.
  Optional scopes: `parity-psu-CUST-12345678` (hardcoded `customer_id`
  `CUST-12345678`, the customer `parity-customer` stands for) and `payments`.
  **Its tokens carry `azp=parity-channel`, not `fintechbankx-mobile`.**
  request-to-pay refuses it as a channel through its `fbx_client_type` check
  (a token that carries the claim must say `open-finance-tpp`), not through its
  `fintechbankx-web,fintechbankx-mobile` deny list. Request `payments` too, so
  the refusal (403) is about the client and not a missing scope; the token is
  DPoP-bound so it gets past the DPoP check (a 401 there would prove nothing).
  A scenario that needs the literal `azp=fintechbankx-mobile` cannot be
  produced without a browser login and stays out of reach here.
- the realm's LDAP federation, disabled (compose runs no OpenLDAP; an
  unreachable directory must not break local-user lookups).

Credentials are random and land in `compose/.env` (mode 600, git-ignored;
`FBX_ENV_FILE` in the workflow) and `realm.env`; nothing secret is committed:

| Variable | Value |
|---|---|
| `PARITY_USERNAME_<ACTOR>` | `parity-<actor>` (`BANKER`, `ADMIN`, `LOAN_OFFICER`, `COMPLIANCE_OFFICER`, `AUDITOR`, `CUSTOMER` with `customer_id` CUST-12345678, `OTHER_CUSTOMER` with CUST-99999999 for ownership-denial cases, `CUSTOMER_OWNER` (`PARITY_USERNAME_CUSTOMER_OWNER=parity-customer-owner`, `PARITY_PASSWORD_CUSTOMER_OWNER`) without `customer_id`, for the identity link). The identity realm at `identity-ref` must declare `customer_id` (identity PR #11 or later), otherwise init fails |
| `PARITY_PASSWORD_<ACTOR>` | password satisfying the realm policy |
| `PARITY_SECRET_PARITY_SUITE` | `parity-suite` client secret |
| `PARITY_TPP_CLIENT_ID` | `TPP-001` (was `parity-tpp`; an existing env file is moved to `TPP-001` on the next `init` and keeps its key) |
| `PARITY_TPP_PRIVATE_JWK` | private RSA JWK (one line of JSON, `alg` PS256, `kid` = its RFC 7638 thumbprint) of `TPP-001`; kept across re-runs, a fresh environment gets a new key |
| `PARITY_TPP_OTHER_CLIENT_ID`, `PARITY_TPP_OTHER_PRIVATE_JWK` | `TPP-002` and its private JWK (same format), the other TPP for cross-TPP denial cases |
| `PARITY_CHANNEL_CLIENT_ID`, `PARITY_CHANNEL_PRIVATE_JWK` | `parity-channel` and its private JWK (same format), the first-party channel stand-in (`azp=parity-channel`) |
| `PARITY_SECRET_SVC_LN_LOAN_LIFECYCLE`, `PARITY_SECRET_SVC_PAY_INITIATION_SETTLEMENT` | the same secrets the realm import gives those service clients |

Tokens: `POST http://localhost:8180/realms/fintechbankx/protocol/openid-connect/token`
(`grant_type=password` with `client_id=parity-suite` for an actor,
`grant_type=client_credentials` for a service client). Re-importing into a
running Keycloak may trip the realm's password history; use `down` first.

Token of a key-bound client (`TPP-001`, `TPP-002` or `parity-channel`; client
credentials with `private_key_jwt` and DPoP):

1. Read `<PREFIX>_CLIENT_ID` and `<PREFIX>_PRIVATE_JWK` from `FBX_ENV_FILE`
   (`PARITY_TPP`, `PARITY_TPP_OTHER` or `PARITY_CHANNEL`).
2. Client assertion: a JWT signed PS256 with that key (header `kid`), claims
   `iss` = `sub` = the client id, `aud` = the issuer
   `http://localhost:8180/realms/fintechbankx`, a unique `jti`, `iat` and an
   `exp` at most 60 s later.
3. DPoP proof: a fresh key pair of the suite's own (ES256 or PS256, not the
   client key), JWT header `typ: dpop+jwt`, `alg` and the public `jwk`; claims
   `htm: POST`, `htu` = the token endpoint URL, a unique `jti`, `iat`.
4. `POST http://localhost:8180/realms/fintechbankx/protocol/openid-connect/token`
   with header `DPoP: <proof>` and form `grant_type=client_credentials`,
   `client_id=<client id>`,
   `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`,
   `client_assertion=<assertion>` and, when the test needs them, `scope`
   (space separated, e.g. `payments parity-psu-PSU-001`).
5. If Keycloak answers `400` with `error=use_dpop_nonce` and a `DPoP-Nonce`
   header, build a new proof (new `jti`) with claim `nonce` = that value and
   repeat the request once; use the newest nonce for later proofs too.
6. The response has `token_type: DPoP`. Call the TPP APIs with
   `Authorization: DPoP <access_token>` and a new DPoP proof per request
   (`htm`, `htu` of that request, `ath` = base64url SHA-256 of the access
   token), again answering `use_dpop_nonce` from the resource server once.

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
`TOKEN`, `KEY`, `CERT`, `USER`, `AUTH`, ...) or identity/datastore wiring
(`OIDC_*`, `DB_*`, `SPRING_DATASOURCE_*`, `SPRING_SECURITY_*`, `KEYCLOAK*`,
`KC_*`, `MONGODB_*`, `SPRING_DATA_MONGODB_*`, `FLYWAY_*`, `SPRING_FLYWAY_*`,
`SERVICE_CLIENT_*`, `REDIS_URL`, `SPRING_DATA_REDIS_*`, `DATABASE_CA_BUNDLE`)
is rejected. `CRED` also matches loan's `CUSTOMER_CREDIT_*`: change those in
the compose file. Example: `payment-initiation-settlement-service__OUTBOX_RELAY_ENABLED=true`
(initiation already runs with `ACCOUNTS_ADAPTER=in-memory`).

**Spring profile**: the five services and the migrate one-shots run with
`SPRING_PROFILES_ACTIVE=local` and no other profile. The stack uses Kafka over
`PLAINTEXT` on `kafka:9092` and PostgreSQL without TLS, which the service-side
TLS assertion refuses unless that profile is active
(fintechbankx-platform-event-streaming-kafka
`docs/guides/SERVICE_CLIENT_CONFIGURATION.md`, and the chart README section
"Service-side TLS assertion"). Loan and payment initiation-settlement switch it
off in their `application-local.yml` (`fintechbankx.tls.enforce: false`);
customer, risk and compliance ship no local profile file and turn their TLS
guards off by the profile name (compliance its runtime role guard too, since
one role owns and uses the schema here). Compose sets no `FINTECHBANKX_TLS_*`
variable and no `DB_SSL_ROOT_CERT` (the database CA bundle those guards
require while they are on; there is none here).

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

## Reset between parity runs

A parity run changes state the next run must not see: rows in every service
database, Keycloak users (the identity link sets `customer_id` on
`parity-customer-owner`, and a second link of the same user is a 409),
sessions, consents and Kafka events.

**Supported reset: recreate the environment.**

```bash
compose/fbx-local.sh down                        # docker compose down -v: drops every service database and the realm
compose/fbx-local.sh up <profiles> parity-fixtures
```

`down` runs `docker compose down -v --remove-orphans` over every profile: all
containers, the PostgreSQL volume (every service database, Flyway re-runs on
start) and Keycloak (dev mode keeps the realm inside its container, so the
next `up` re-imports the realm, the admin permissions and the parity layer).
Kafka topics go with the broker container. `.env`, `realm.env` and `.cache`
stay, so the next run gets the same generated passwords and keys; delete
`compose/.env` and `compose/realm.env` too for fresh credentials. In CI each
`ephemeral-env.yml` job is already a fresh environment.

**Lighter reset (scripted): `compose/fbx-local.sh reset`**, then `up` again.

```bash
compose/fbx-local.sh reset
compose/fbx-local.sh up <profiles> parity-fixtures
```

It deletes every container except the Kafka broker (`docker compose rm -s -f -v`
over all profiles, which also drops MongoDB's anonymous volume) and the
PostgreSQL volume, and skips the asset fetch and
secret generation. It saves the broker start and topic creation; databases,
the realm, the parity layer and both admin-permission steps are rebuilt as
with `down`. What it keeps: Kafka topics with the previous run's events and
the services' consumer-group offsets. Use it only when the suite tells runs
apart by its own ids (correlation, idempotency and interaction ids, created
customers) and never asserts on "no event" or reads topics from the start;
otherwise use `down`. Pulled or locally built images are kept by both.

## Tests

`node --test compose/test/*.test.mjs` (part of `npm test`): secret generation,
asset fetching, the services.tsv columns and compose wiring per row (database,
role, credential, image, profiles, port, `local` profile, memory limit),
the five services' settings above and the migrate one-shots, credential
hygiene, `docker compose config -q` for every profile, parity actors and their
rendered realm layer, service-env validation, the workflow structure and its
exported base URLs, the PostgreSQL init and SQL fixtures against a real server
(local PostgreSQL 16 binaries or `FBX_TEST_PGHOST`), and the store split of
the init scripts with recording stand-ins for `psql` and `mongosh` (the
MongoDB user script runs in a Node VM against a stand-in `db`).

## Known gaps

- Not started end to end here (no Docker daemon in the authoring environment);
  `docker compose config` and the database init were exercised, and the
  services' effective Spring settings under the rendered compose environment
  were read with a Spring Boot 3.3.6 probe over each service's own
  `application*.yml`. `mongo`, its healthcheck and `mongo-init` have not run
  against a live MongoDB; services.tsv has no `mongodb` row until the
  open-finance services join.
- LDAP federation in the realm points at `ldap://openldap:389`, which this stack
  does not run; interactive staff logins (client `fintechbankx-staff-web`; the
  customer clients `fintechbankx-web` and `fintechbankx-mobile` map only the
  `customer` role) need the identity repo's OpenLDAP component. Staff parity
  actors log in through `parity-suite` instead.
- The full ELMS monolith expects its own realm and profiles; set
  `FBX_MONOLITH_SPRING_PROFILES` and `FBX_MONOLITH_HEALTH_PATH` for that image.
- The parity layer (keycloak-config-cli no-delete import of users, clients
  and client scopes, disabled LDAP, password grant, the `TPP-001`, `TPP-002`
  and `parity-channel` clients, the first two under the realm's FAPI 2.0 +
  DPoP client policy with client credentials), both admin-permissions steps
  (including how Keycloak combines parity-suite's permission with the customer
  service's on the same group), the `reset` command and the monolith-oracle
  wiring are validated by the tests above, not by a live Keycloak run here.
