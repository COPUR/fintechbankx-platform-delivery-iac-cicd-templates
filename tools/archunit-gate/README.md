# ArchUnit gate (Proposed)

Command-line runner for the four hexagonal rules of ADR-028
(`docs/architecture/guardrails/FINTECHBANKX_SERVICE_GUARDRAILS.md`, section 3, in
the enterprise-architecture repository) and rule 5, one package root per
repository (same document, section 2). `java-service-ci.yml` runs it against
every service's compiled main classes after `./gradlew check`, so the rules hold
whatever ArchUnit tests a service repository has itself.

| # | Rule |
|---|---|
| 1 | `<root>.domain..` depends on nothing in `<root>.application..`, `<root>.infrastructure..`, `org.springframework..`, `jakarta.persistence..`/`javax.persistence..`, `org.hibernate..`, `org.apache.kafka..`, `com.mongodb..`, `org.bson..` |
| 2 | `<root>.application..` depends on nothing in `<root>.infrastructure..` |
| 3 | controllers (`@Controller`/`@RestController`) and listeners (`@KafkaListener`, `@RabbitListener`, `@JmsListener`, `@SqsListener`) in `<root>.infrastructure..` depend on `<root>.domain.port.in..` and not on application classes that implement those ports |
| 4 | classes implementing a `<root>.domain.port.out..` interface live in `<root>.infrastructure..` |
| 5 | one package root per repository: with `--package-root <root>`, every class lives under `<root>` and no other package prefix owns a `.domain` package (nested ones such as `<root>.jwt.domain` included, since rules 1-4 would not see them); without it, the classes hold at most one such prefix |

Roots: `com.bank.<context>` (multi-module cores) or `com.enterprise.openfinance.<capability>`
(single-module services); new repositories `com.fintechbankx.<context>.<capability>`.

- `--package-root <root>` (workflow input `package-root`): rules 1-4 run on `<root>`
  only; rule 5 names every package outside it and every second root. A `--root`
  next to it must equal it (otherwise exit 2).
- Without `--package-root`: rules 1-4 run on the `--root` packages, or on every
  outermost package that owns a `.domain` package. Rule 5 fails when the classes
  hold more than one package prefix owning a `.domain` package, whatever `--root`
  says, and tells the repository to set `package-root`. Single-root repositories
  pass without configuration.
- The shared kernel `com.bank.shared.kernel` (kept where it already is,
  guardrails section 2) is allowed next to the root and is never a second root.
- The gate sees compiled main classes only: sources a build excludes from its
  source sets are not checked. There is no generated-code exclusion; generated
  classes outside the root fail rule 5.

```bash
tools/archunit-gate/gradlew -p tools/archunit-gate test installDist
tools/archunit-gate/build/install/archunit-gate/bin/archunit-gate \
  --classes <service>/loan-domain/build/classes/java/main \
  --classes <service>/loan-application/build/classes/java/main \
  --classes <service>/loan-infrastructure/build/classes/java/main \
  --classes <service>/shared-kernel/build/classes/java/main \
  --package-root com.bank.loan
```

Exit codes: 0 pass, 1 violations (report lists each one), 2 usage error or
nothing to check. `archunit-report-only: true` in the workflow turns exit 1 into
a warning for all five rules.

Tests (`src/test`): a clean multi-module fixture and a clean single-module fixture
pass; a violating fixture breaks rules 1-4; a multi-root fixture
(`fixtures.multiroot.of` with a capability root, a copied outer root, a stray
package and a nested second root) fails rule 5 with and without a pinned root;
the shared kernel is not a second root; root detection; CLI exit codes.
ArchUnit 1.4.1; built for Java 21 bytecode, reads service classes up to Java 24.
