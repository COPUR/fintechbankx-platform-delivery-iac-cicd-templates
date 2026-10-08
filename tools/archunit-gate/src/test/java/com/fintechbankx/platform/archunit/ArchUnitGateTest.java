package com.fintechbankx.platform.archunit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.core.importer.ClassFileImporter;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

class ArchUnitGateTest {

    private static JavaClasses classesOf(String pkg) {
        return new ClassFileImporter().importPackages(pkg);
    }

    @Test
    void cleanMultiModuleLayoutPassesAllFourRules() {
        GateResult result = ArchUnitGate.check(classesOf("fixtures.clean.bank.loan"), List.of("fixtures.clean.bank.loan"));
        assertTrue(result.passed(), result.report());
        assertEquals(Set.of(Rule.values()), result.evaluatedRules());
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
    }

    @Test
    void detectsRootsFromDomainPackages() {
        assertEquals(List.of("fixtures.clean.bank.loan", "fixtures.clean.openfinance.consent", "fixtures.violating.bank.pay"),
                ArchUnitGate.detectRoots(classesOf("fixtures")));
    }

    @Test
    void cliExitsNonZeroOnViolationsAndZeroWhenClean() {
        String testClasses = System.getProperty("fbx.testClassesDir", "build/classes/java/test");
        assertEquals(1, ArchUnitGate.run(new String[] {"--classes", testClasses, "--root", "fixtures.violating.bank.pay"}));
        assertEquals(0, ArchUnitGate.run(new String[] {"--classes", testClasses, "--root", "fixtures.clean.bank.loan"}));
        assertEquals(2, ArchUnitGate.run(new String[] {"--classes", testClasses, "--root", "fixtures.nothing.here"}));
    }
}
