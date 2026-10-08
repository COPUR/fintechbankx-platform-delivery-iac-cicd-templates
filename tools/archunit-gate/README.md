# ArchUnit gate (Proposed)

Command-line runner for the four hexagonal rules of ADR-028
(`docs/architecture/guardrails/FINTECHBANKX_SERVICE_GUARDRAILS.md`, section 3, in
the enterprise-architecture repository). `java-service-ci.yml` runs it against
every service's compiled main classes after `./gradlew check`, so the rules hold
whatever ArchUnit tests a service repository has itself.

| # | Rule |
|---|---|
| 1 | `<root>.domain..` depends on nothing in `<root>.application..`, `<root>.infrastructure..`, `org.springframework..`, `jakarta.persistence..`/`javax.persistence..`, `org.hibernate..`, `org.apache.kafka..`, `com.mongodb..`, `org.bson..` |
| 2 | `<root>.application..` depends on nothing in `<root>.infrastructure..` |
| 3 | controllers (`@Controller`/`@RestController`) and listeners (`@KafkaListener`, `@RabbitListener`, `@JmsListener`, `@SqsListener`) in `<root>.infrastructure..` depend on `<root>.domain.port.in..` and not on application classes that implement those ports |
| 4 | classes implementing a `<root>.domain.port.out..` interface live in `<root>.infrastructure..` |

Roots: `com.bank.<context>` (multi-module cores) or `com.enterprise.openfinance.<capability>`
(single-module services); new repositories `com.fintechbankx.<context>.<capability>`.
Without `--root`, every package that owns a `.domain` package is a root.

```bash
tools/archunit-gate/gradlew -p tools/archunit-gate test installDist
tools/archunit-gate/build/install/archunit-gate/bin/archunit-gate \
  --classes <service>/loan-domain/build/classes/java/main \
  --classes <service>/loan-application/build/classes/java/main \
  --classes <service>/loan-infrastructure/build/classes/java/main \
  --root com.bank.loan
```

Exit codes: 0 pass, 1 violations (report lists each one), 2 nothing to check.

Tests (`src/test`): a clean multi-module fixture and a clean single-module fixture
pass; a violating fixture breaks each rule; root detection; CLI exit codes.
ArchUnit 1.4.1; built for Java 21 bytecode, reads service classes up to Java 24.
