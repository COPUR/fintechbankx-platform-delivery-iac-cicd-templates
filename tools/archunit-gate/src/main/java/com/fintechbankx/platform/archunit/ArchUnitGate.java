package com.fintechbankx.platform.archunit;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.classes;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;

import com.tngtech.archunit.base.DescribedPredicate;
import com.tngtech.archunit.core.domain.Dependency;
import com.tngtech.archunit.core.domain.JavaClass;
import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.core.importer.ClassFileImporter;
import com.tngtech.archunit.lang.ArchCondition;
import com.tngtech.archunit.lang.ArchRule;
import com.tngtech.archunit.lang.ConditionEvents;
import com.tngtech.archunit.lang.EvaluationResult;
import com.tngtech.archunit.lang.SimpleConditionEvent;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/**
 * Runs the four ADR-028 hexagonal rules against compiled classes.
 *
 * <pre>
 * archunit-gate --classes &lt;dir&gt; [--classes &lt;dir&gt; ...] [--root &lt;package&gt; ...]
 * </pre>
 *
 * Without --root, every package prefix that has a {@code .domain} sub-package is a root
 * (layout A {@code com.bank.<context>}, layout B {@code com.enterprise.openfinance.<capability>}).
 * Exit codes: 0 all rules pass, 1 violations, 2 usage error or nothing to check.
 */
public final class ArchUnitGate {

    static final List<String> FRAMEWORK_PACKAGES = List.of(
            "org.springframework..",
            "jakarta.persistence..",
            "javax.persistence..",
            "org.hibernate..",
            "org.apache.kafka..",
            "com.mongodb..",
            "org.bson..");

    static final Set<String> CONTROLLER_ANNOTATIONS = Set.of(
            "org.springframework.stereotype.Controller",
            "org.springframework.web.bind.annotation.RestController");

    static final Set<String> LISTENER_ANNOTATIONS = Set.of(
            "org.springframework.kafka.annotation.KafkaListener",
            "org.springframework.kafka.annotation.KafkaHandler",
            "org.springframework.amqp.rabbit.annotation.RabbitListener",
            "org.springframework.jms.annotation.JmsListener",
            "io.awspring.cloud.sqs.annotation.SqsListener");

    private ArchUnitGate() {}

    public static GateResult check(JavaClasses classes, List<String> roots) {
        Map<Rule, List<String>> violations = new EnumMap<>(Rule.class);
        for (Rule rule : Rule.values()) {
            violations.put(rule, new ArrayList<>());
        }
        for (String root : roots) {
            evaluate(violations, Rule.DOMAIN_IS_FRAMEWORK_FREE, domainIsFrameworkFree(root), classes);
            evaluate(violations, Rule.APPLICATION_IS_INFRASTRUCTURE_FREE, applicationIsInfrastructureFree(root), classes);
            evaluate(violations, Rule.INBOUND_ADAPTERS_USE_PORTS_IN, inboundAdaptersUsePortsIn(root), classes);
            evaluate(violations, Rule.PORT_OUT_IMPLEMENTATIONS_IN_INFRASTRUCTURE, portOutImplementationsInInfrastructure(root), classes);
        }
        return new GateResult(roots, violations);
    }

    private static void evaluate(Map<Rule, List<String>> into, Rule rule, ArchRule archRule, JavaClasses classes) {
        EvaluationResult result = archRule.allowEmptyShould(true).evaluate(classes);
        into.get(rule).addAll(result.getFailureReport().getDetails());
    }

    static ArchRule domainIsFrameworkFree(String root) {
        List<String> forbidden = new ArrayList<>(List.of(root + ".application..", root + ".infrastructure.."));
        forbidden.addAll(FRAMEWORK_PACKAGES);
        return noClasses().that().resideInAPackage(root + ".domain..")
                .should().dependOnClassesThat().resideInAnyPackage(forbidden.toArray(String[]::new))
                .as(Rule.DOMAIN_IS_FRAMEWORK_FREE.description());
    }

    static ArchRule applicationIsInfrastructureFree(String root) {
        return noClasses().that().resideInAPackage(root + ".application..")
                .should().dependOnClassesThat().resideInAPackage(root + ".infrastructure..")
                .as(Rule.APPLICATION_IS_INFRASTRUCTURE_FREE.description());
    }

    static ArchRule inboundAdaptersUsePortsIn(String root) {
        DescribedPredicate<JavaClass> inboundAdapter = new DescribedPredicate<>("controllers and listeners") {
            @Override
            public boolean test(JavaClass c) {
                return isController(c) || isListener(c);
            }
        };
        return classes().that().resideInAPackage(root + ".infrastructure..").and(inboundAdapter)
                .should(useInPortsNotApplicationImplementations(root))
                .as(Rule.INBOUND_ADAPTERS_USE_PORTS_IN.description());
    }

    static ArchRule portOutImplementationsInInfrastructure(String root) {
        DescribedPredicate<JavaClass> implementsPortOut = new DescribedPredicate<>("implement a domain.port.out interface") {
            @Override
            public boolean test(JavaClass c) {
                return !c.isInterface() && c.getAllRawInterfaces().stream()
                        .anyMatch(i -> i.getPackageName().startsWith(root + ".domain.port.out"));
            }
        };
        return classes().that(implementsPortOut).and().resideInAPackage(root + "..")
                .should().resideInAPackage(root + ".infrastructure..")
                .as(Rule.PORT_OUT_IMPLEMENTATIONS_IN_INFRASTRUCTURE.description());
    }

    private static ArchCondition<JavaClass> useInPortsNotApplicationImplementations(String root) {
        return new ArchCondition<>("depend on domain.port.in and not on application implementations") {
            @Override
            public void check(JavaClass adapter, ConditionEvents events) {
                boolean usesPortIn = false;
                for (Dependency d : adapter.getDirectDependenciesFromSelf()) {
                    JavaClass target = d.getTargetClass();
                    if (target.getPackageName().startsWith(root + ".domain.port.in")) {
                        usesPortIn = true;
                    }
                    if (target.getPackageName().startsWith(root + ".application") && implementsPortIn(target, root)) {
                        events.add(SimpleConditionEvent.violated(adapter, adapter.getName()
                                + " depends on application implementation " + target.getName()
                                + " instead of its domain.port.in use case (" + d.getDescription() + ")"));
                    }
                }
                if (!usesPortIn) {
                    events.add(SimpleConditionEvent.violated(adapter, adapter.getName()
                            + " does not depend on any " + root + ".domain.port.in use case"));
                }
            }
        };
    }

    private static boolean implementsPortIn(JavaClass c, String root) {
        return c.getAllRawInterfaces().stream().anyMatch(i -> i.getPackageName().startsWith(root + ".domain.port.in"));
    }

    static boolean isController(JavaClass c) {
        return CONTROLLER_ANNOTATIONS.stream().anyMatch(c::isAnnotatedWith)
                || CONTROLLER_ANNOTATIONS.stream().anyMatch(c::isMetaAnnotatedWith);
    }

    static boolean isListener(JavaClass c) {
        return LISTENER_ANNOTATIONS.stream().anyMatch(c::isAnnotatedWith)
                || c.getMethods().stream().anyMatch(m -> LISTENER_ANNOTATIONS.stream().anyMatch(m::isAnnotatedWith));
    }

    /** Package prefixes that own a {@code .domain} package, outermost first. */
    public static List<String> detectRoots(JavaClasses classes) {
        Set<String> roots = new TreeSet<>();
        for (JavaClass c : classes) {
            String pkg = c.getPackageName();
            int i = (pkg + ".").indexOf(".domain.");
            if (i > 0) {
                roots.add(pkg.substring(0, i));
            }
        }
        List<String> outermost = new ArrayList<>();
        for (String r : roots) {
            if (outermost.stream().noneMatch(o -> r.startsWith(o + "."))) {
                outermost.add(r);
            }
        }
        return outermost;
    }

    public static int run(String[] args) {
        List<Path> dirs = new ArrayList<>();
        List<String> roots = new ArrayList<>();
        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--classes" -> dirs.add(Path.of(args[++i]));
                case "--root" -> roots.add(args[++i]);
                default -> {
                    System.err.println("unknown argument: " + args[i]);
                    return 2;
                }
            }
        }
        List<Path> existing = dirs.stream().filter(Files::isDirectory).toList();
        if (existing.isEmpty()) {
            System.err.println("archunit-gate: no compiled class directories given (--classes); run the build first");
            return 2;
        }
        JavaClasses classes = new ClassFileImporter().importPaths(existing);
        if (roots.isEmpty()) {
            roots = detectRoots(classes);
        }
        final List<String> checkedRoots = roots;
        boolean anyClass = checkedRoots.stream()
                .anyMatch(r -> classes.stream().anyMatch(c -> c.getPackageName().startsWith(r)));
        if (checkedRoots.isEmpty() || !anyClass) {
            System.err.println("archunit-gate: no classes under roots " + checkedRoots + " in " + existing);
            return 2;
        }
        GateResult result = check(classes, checkedRoots);
        (result.passed() ? System.out : System.err).print(result.report());
        return result.passed() ? 0 : 1;
    }

    public static void main(String[] args) {
        System.exit(run(args));
    }
}
