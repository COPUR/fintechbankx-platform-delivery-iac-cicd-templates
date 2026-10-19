package com.fintechbankx.platform.archunit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.core.importer.ClassFileImporter;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ArchUnitGateTest {

    private static final String MULTIROOT = "fixtures.multiroot.of";
    private static final String PINNED = "fixtures.multiroot.of.recurring";

    private static JavaClasses classesOf(String... pkgs) {
        return new ClassFileImporter().importPackages(pkgs);
    }

    private static Path testClassesDir() {
        return Path.of(System.getProperty("fbx.testClassesDir", "build/classes/java/test"));
    }

    /** Copies the compiled classes of the given packages into a fresh --classes directory. */
    private static Path classesDirWith(Path target, String... pkgs) {
        for (String pkg : pkgs) {
            Path from = testClassesDir().resolve(pkg.replace('.', '/'));
            try (Stream<Path> files = Files.walk(from)) {
                for (Path f : files.filter(Files::isRegularFile).toList()) {
                    Path to = target.resolve(testClassesDir().relativize(f));
                    Files.createDirectories(to.getParent());
                    Files.copy(f, to);
                }
            } catch (IOException e) {
                throw new UncheckedIOException(e);
            }
        }
        return target;
    }

    private static boolean mentions(List<String> violations, String text) {
        return violations.stream().anyMatch(v -> v.contains(text));
    }

    @Test
    void cleanMultiModuleLayoutPassesAllFiveRules() {
        GateResult result = ArchUnitGate.check(classesOf("fixtures.clean.bank.loan"), List.of("fixtures.clean.bank.loan"));
        assertTrue(result.passed(), result.report());
        assertEquals(Set.of(Rule.values()), result.evaluatedRules());
        assertTrue(result.evaluatedRules().contains(Rule.ONE_PACKAGE_ROOT));
    }

    @Test
    void cleanSingleModuleLayoutPasses() {
        GateResult result = ArchUnitGate.check(
                classesOf("fixtures.clean.openfinance.consent"), List.of("fixtures.clean.openfinance.consent"));
        assertTrue(result.passed(), result.report());
    }

    @Test
    void violatingFixtureBreaksEachRuleOnce() {
        GateResult result = ArchUnitGate.check(classesOf("fixtures.violating.bank.pay"), List.of("fixtures.violating.bank.pay"));
        Map<Rule, List<String>> v = result.violations();
        assertTrue(!result.passed());
        assertTrue(v.get(Rule.DOMAIN_IS_FRAMEWORK_FREE).stream().anyMatch(s -> s.contains("Payment") && s.contains("jakarta.persistence")), result.report());
        assertTrue(v.get(Rule.DOMAIN_IS_FRAMEWORK_FREE).stream().anyMatch(s -> s.contains("PaymentPolicy") && s.contains("org.springframework")), result.report());
        assertTrue(v.get(Rule.APPLICATION_IS_INFRASTRUCTURE_FREE).stream().anyMatch(s -> s.contains("InitiatePaymentService")), result.report());
        assertTrue(v.get(Rule.INBOUND_ADAPTERS_USE_PORTS_IN).stream().anyMatch(s -> s.contains("PaymentController")), result.report());
        assertTrue(v.get(Rule.PORT_OUT_IMPLEMENTATIONS_IN_INFRASTRUCTURE).stream().anyMatch(s -> s.contains("LoggingPaymentGateway")), result.report());
        assertTrue(v.get(Rule.ONE_PACKAGE_ROOT).isEmpty(), result.report());
    }

    @Test
    void detectsRootsFromDomainPackages() {
        assertEquals(List.of("fixtures.clean.bank.loan", "fixtures.clean.openfinance.consent", "fixtures.gen.avro",
                        MULTIROOT, "fixtures.violating.bank.pay"),
                ArchUnitGate.detectRoots(classesOf("fixtures")));
    }

    @Test
    void detectsEveryDomainPrefixIncludingNestedOnes() {
        assertEquals(List.of(MULTIROOT, PINNED, PINNED + ".jwt"),
                ArchUnitGate.detectDomainPrefixes(classesOf("fixtures.multiroot")));
    }

    // Rule 5 without package-root: a second root fails and tells the repository to pin one.

    @Test
    void withoutPackageRootASecondRootFailsRuleFive() {
        JavaClasses classes = classesOf("fixtures.multiroot");
        GateResult result = ArchUnitGate.check(classes, ArchUnitGate.detectRoots(classes));
        List<String> rule5 = result.violations().get(Rule.ONE_PACKAGE_ROOT);
        assertFalse(result.passed(), result.report());
        assertTrue(mentions(rule5, MULTIROOT + ","), result.report());
        assertTrue(mentions(rule5, PINNED + ","), result.report());
        assertTrue(mentions(rule5, PINNED + ".jwt"), result.report());
        assertTrue(mentions(rule5, "package-root"), result.report());
    }

    @Test
    void anExplicitRootDoesNotHideASecondRoot() {
        GateResult result = ArchUnitGate.check(classesOf("fixtures.multiroot"), List.of(PINNED));
        assertFalse(result.violations().get(Rule.ONE_PACKAGE_ROOT).isEmpty(), result.report());
    }

    @Test
    void sharedKernelIsNotASecondRoot() {
        GateResult result = ArchUnitGate.check(
                classesOf("fixtures.clean.bank.loan", "com.bank.shared.kernel"), List.of("fixtures.clean.bank.loan"));
        assertTrue(result.violations().get(Rule.ONE_PACKAGE_ROOT).isEmpty(), result.report());
    }

    // Rule 5 with package-root pinned.

    @Test
    void pinnedRootFailsRuleFiveNamingEveryOffendingPackage() {
        GateResult result = ArchUnitGate.checkPackageRoot(classesOf("fixtures.multiroot"), PINNED);
        List<String> rule5 = result.violations().get(Rule.ONE_PACKAGE_ROOT);
        assertFalse(result.passed(), result.report());
        assertTrue(mentions(rule5, MULTIROOT + ".domain.service"), result.report());
        assertTrue(mentions(rule5, MULTIROOT + ".infrastructure.cache"), result.report());
        assertTrue(mentions(rule5, "second root " + MULTIROOT + " "), result.report());
        assertTrue(mentions(rule5, "second root " + PINNED + ".jwt"), result.report());
        assertFalse(mentions(rule5, "second root " + PINNED + " "), result.report());
    }

    @Test
    void pinnedRootEvaluatesRulesOneToFourOnThatRootOnly() {
        GateResult result = ArchUnitGate.checkPackageRoot(classesOf("fixtures.multiroot"), PINNED);
        assertEquals(List.of(PINNED), result.roots());
        for (Rule rule : List.of(Rule.DOMAIN_IS_FRAMEWORK_FREE, Rule.APPLICATION_IS_INFRASTRUCTURE_FREE,
                Rule.INBOUND_ADAPTERS_USE_PORTS_IN, Rule.PORT_OUT_IMPLEMENTATIONS_IN_INFRASTRUCTURE)) {
            assertTrue(result.violations().get(rule).isEmpty(), rule + "\n" + result.report());
        }
    }

    @Test
    void pinnedRootStillAppliesRulesOneToFour() {
        GateResult result = ArchUnitGate.checkPackageRoot(classesOf("fixtures.violating.bank.pay"), "fixtures.violating.bank.pay");
        assertTrue(result.violations().get(Rule.ONE_PACKAGE_ROOT).isEmpty(), result.report());
        assertFalse(result.violations().get(Rule.DOMAIN_IS_FRAMEWORK_FREE).isEmpty(), result.report());
    }

    @Test
    void pinnedRootPassesForASingleRootRepositoryWithItsSharedKernel() {
        GateResult result = ArchUnitGate.checkPackageRoot(
                classesOf("fixtures.clean.bank.loan", "com.bank.shared.kernel"), "fixtures.clean.bank.loan");
        assertTrue(result.passed(), result.report());
    }

    @Test
    void reportNamesThePinnedRoot() {
        String report = ArchUnitGate.checkPackageRoot(classesOf("fixtures.clean.bank.loan"), "fixtures.clean.bank.loan").report();
        assertTrue(report.contains("package root fixtures.clean.bank.loan"), report);
        assertTrue(report.contains(Rule.ONE_PACKAGE_ROOT.description()), report);
    }

    // CLI

    @Test
    void cliExitsNonZeroOnViolationsAndZeroWhenClean(@TempDir Path tmp) {
        String clean = classesDirWith(tmp.resolve("clean"), "fixtures.clean.bank.loan").toString();
        String violating = classesDirWith(tmp.resolve("violating"), "fixtures.violating.bank.pay").toString();
        assertEquals(1, ArchUnitGate.run(new String[] {"--classes", violating, "--root", "fixtures.violating.bank.pay"}));
        assertEquals(0, ArchUnitGate.run(new String[] {"--classes", clean, "--root", "fixtures.clean.bank.loan"}));
        assertEquals(0, ArchUnitGate.run(new String[] {"--classes", clean}));
        assertEquals(2, ArchUnitGate.run(new String[] {"--classes", clean, "--root", "fixtures.nothing.here"}));
    }

    @Test
    void cliFailsRuleFiveWhenTheClassesHoldSeveralRoots(@TempDir Path tmp) {
        // The whole test-classes directory holds several roots; --root alone no longer hides the others.
        assertEquals(1, ArchUnitGate.run(new String[] {"--classes", testClassesDir().toString(), "--root", "fixtures.clean.bank.loan"}));
        String multi = classesDirWith(tmp.resolve("multi"), "fixtures.multiroot").toString();
        assertEquals(1, ArchUnitGate.run(new String[] {"--classes", multi}));
        assertEquals(1, ArchUnitGate.run(new String[] {"--classes", multi, "--package-root", PINNED}));
    }

    @Test
    void cliPackageRootPassesForOneRootAndItsSharedKernel(@TempDir Path tmp) {
        String dir = classesDirWith(tmp.resolve("loan"), "fixtures.clean.bank.loan", "com.bank.shared.kernel").toString();
        assertEquals(0, ArchUnitGate.run(new String[] {"--classes", dir, "--package-root", "fixtures.clean.bank.loan"}));
        assertEquals(0, ArchUnitGate.run(new String[] {"--classes", dir, "--package-root", "fixtures.clean.bank.loan",
                "--root", "fixtures.clean.bank.loan"}));
    }

    @Test
    void cliRejectsUnusablePackageRootArguments(@TempDir Path tmp) {
        String dir = classesDirWith(tmp.resolve("loan"), "fixtures.clean.bank.loan").toString();
        assertEquals(2, ArchUnitGate.run(new String[] {"--classes", dir, "--package-root", "fixtures.nothing.here"}));
        assertEquals(2, ArchUnitGate.run(new String[] {"--classes", dir, "--package-root", "fixtures.clean.bank.loan",
                "--root", "fixtures.clean.bank"}));
        assertEquals(2, ArchUnitGate.run(new String[] {"--classes", dir, "--package-root", "fixtures.clean.bank.loan",
                "--package-root", "fixtures.clean.bank.loan"}));
        assertEquals(2, ArchUnitGate.run(new String[] {"--classes", dir, "--package-root"}));
    }

    // --- generated packages (--generated-packages) ------------------------------------------

    private static final String LOAN = "fixtures.clean.bank.loan";
    private static final String GEN = "fixtures.gen";

    @Test
    void generatedCodeOutsideTheRootFailsRuleFiveWhenNotDeclared() {
        GateResult result = ArchUnitGate.checkPackageRoot(classesOf(LOAN, GEN), LOAN);
        List<String> rule5 = result.violations().get(Rule.ONE_PACKAGE_ROOT);
        assertTrue(mentions(rule5, "package fixtures.gen.openapi.model"), rule5.toString());
        assertTrue(mentions(rule5, "second root fixtures.gen.avro"), rule5.toString());
    }

    @Test
    void declaredGeneratedPackagesAreExcludedFromRuleFiveButListedInTheReport() {
        GateResult result = ArchUnitGate.checkPackageRoot(classesOf(LOAN, GEN), LOAN, List.of(GEN));
        assertTrue(result.passed(), result.report());
        assertEquals(List.of("fixtures.gen.avro.domain (1 class)", "fixtures.gen.openapi.model (1 class)"),
                result.generatedExcluded());
        String report = result.report();
        assertTrue(report.contains("generated packages excluded from rule 5: [fixtures.gen]"), report);
        assertTrue(report.contains("fixtures.gen.openapi.model (1 class)"), report);
        assertTrue(report.contains("fixtures.gen.avro.domain (1 class)"), report);
    }

    @Test
    void generatedPackagesStillLeaveOtherOutsidersInRuleFive() {
        GateResult result = ArchUnitGate.checkPackageRoot(classesOf(LOAN, GEN, "fixtures.clean.openfinance.consent"),
                LOAN, List.of("fixtures.gen.openapi"));
        List<String> rule5 = result.violations().get(Rule.ONE_PACKAGE_ROOT);
        assertFalse(mentions(rule5, "fixtures.gen.openapi.model"), rule5.toString());
        assertTrue(mentions(rule5, "second root fixtures.gen.avro"), rule5.toString());
        assertTrue(mentions(rule5, "fixtures.clean.openfinance.consent"), rule5.toString());
    }

    @Test
    void withoutPackageRootAGeneratedDomainPackageIsNotASecondRoot() {
        assertFalse(ArchUnitGate.check(classesOf(LOAN, GEN), List.of(LOAN)).passed());
        GateResult result = ArchUnitGate.check(classesOf(LOAN, GEN), List.of(LOAN), List.of(GEN));
        assertTrue(result.passed(), result.report());
        assertEquals(List.of("fixtures.gen.avro.domain (1 class)", "fixtures.gen.openapi.model (1 class)"),
                result.generatedExcluded());
    }

    @Test
    void generatedCodeUnderTheRootNeedsNoDeclaration() {
        // the preferred location, <package-root>.infrastructure.generated, is inside the root
        assertTrue(ArchUnitGate.checkPackageRoot(classesOf(LOAN), LOAN).generatedExcluded().isEmpty());
    }

    @Test
    void cliGeneratedPackagesTakesACommaListAndRejectsBadValues(@TempDir Path tmp) {
        String dir = classesDirWith(tmp.resolve("gen"), LOAN, GEN).toString();
        assertEquals(1, ArchUnitGate.run(new String[] {"--classes", dir, "--package-root", LOAN}));
        assertEquals(0, ArchUnitGate.run(new String[] {"--classes", dir, "--package-root", LOAN,
                "--generated-packages", "fixtures.gen.openapi, fixtures.gen.avro"}));
        assertEquals(1, ArchUnitGate.run(new String[] {"--classes", dir, "--package-root", LOAN,
                "--generated-packages", "fixtures.gen.openapi"}));
        // a generated package may not swallow the package root, nor be malformed
        assertEquals(2, ArchUnitGate.run(new String[] {"--classes", dir, "--package-root", LOAN,
                "--generated-packages", "fixtures.clean"}));
        assertEquals(2, ArchUnitGate.run(new String[] {"--classes", dir, "--package-root", LOAN,
                "--generated-packages", "fixtures..gen"}));
    }
}
