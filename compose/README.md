# Shared local / ephemeral runtime (Proposed)

One Docker Compose stack for laptops and CI ephemeral environments, replacing the
monolith's `docker-compose.yml`, `docker-compose.open-finance-eventing.yml` and
`docker/init-scripts` with the split-world shape:

| Part | What runs | Source of truth |
|---|---|---|
| PostgreSQL 16 | one database, schema and LOGIN role per service; no role can connect to another service's database | [services.tsv](services.tsv) (matches each service repo's `application.yml`), [postgres/init](postgres/init/10-service-databases.sh) |
| Kafka | single-broker KRaft (no ZooKeeper), auto-create off, catalog topics at RF 1 | topic catalog and `create-topics.sh` fetched from fintechbankx-platform-event-streaming-kafka |
| Keycloak 26 + realm import | dev-mode Keycloak, realm `fintechbankx` applied by keycloak-config-cli | `realm/fintechbankx-realm.json` fetched from fintechbankx-platform-identity-iam-keycloak-ldap |
| `observability` profile | OTel collector + Jaeger (UI on 127.0.0.1:16686) | [otel/collector.yaml](otel/collector.yaml) |
| service profiles | `lending` (loan + customer), `payments` (initiation-settlement + risk + compliance), `customer`, `riskcompliance`, `services` (all five) | images `fintechbankx/<service>:local` or `FBX_IMAGE_*` |
| `monolith` profile | ELMS monolith side by side (+ Redis) for regression comparison | `FBX_MONOLITH_IMAGE` |

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
realm (LDAP and channel URLs get fixed dev values). Nothing secret is
committed; the compose file uses `${VAR:?...}` so it refuses to start without
the generated file. A new realm placeholder without a dev value fails the
script on purpose.

Pin asset versions with `FBX_IDENTITY_REF` / `FBX_KAFKA_REF`, or read local
checkouts with `FBX_IDENTITY_SOURCE` / `FBX_KAFKA_SOURCE`.

## Tests

`node --test compose/test/*.test.mjs` (part of `npm test`): secret generation,
asset fetching, compose wiring and credential hygiene, `docker compose config -q`
for every profile, and the PostgreSQL init against a real server (local
PostgreSQL 16 binaries or `FBX_TEST_PGHOST`).

## Known gaps

- Not started end to end here (no Docker daemon in the authoring environment);
  `docker compose config` and the database init were exercised.
- LDAP federation in the realm points at `ldap://openldap:389`, which this stack
  does not run; staff logins need the identity repo's OpenLDAP component.
- The monolith expects its own realm and profiles; set `FBX_MONOLITH_SPRING_PROFILES`
  for the image you compare against.
