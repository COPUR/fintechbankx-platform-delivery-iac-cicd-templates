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
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * Runs the four ADR-028 hexagonal rules and the one-package-root rule against compiled classes.
 *
 * <pre>
 * archunit-gate --classes &lt;dir&gt; [--classes &lt;dir&gt; ...] [--package-root &lt;package&gt;] [--root &lt;package&gt; ...]
 *               [--generated-packages &lt;package&gt;[,&lt;package&gt;...]]
 * </pre>
 *
 * With --package-root, rules 1-4 run on that root only and rule 5 fails for every class outside it and for every
 * other package prefix that owns a {@code .domain} package. Without it, rules 1-4 run on the --root packages (or,
 * without --root, on every outermost package prefix that has a {@code .domain} sub-package) and rule 5 fails when
 * the classes hold more than one such prefix. The shared kernel ({@link #SHARED_KERNEL_PACKAGES}) is never a
 * second root. Packages given with --generated-packages (code generators' output outside the root) are excluded
 * from rule 5 and listed in the report; rules 1-4 are unchanged. Exit codes: 0 all rules pass, 1 violations, 2
 * usage error or nothing to check.
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

    /**
     * Shared-kernel packages kept where they already are (FINTECHBANKX_SERVICE_GUARDRAILS.md section 2:
     * {@code com.bank.shared.kernel}); allowed next to the package root and never counted as a second root.
     */
    static final List<String> SHARED_KERNEL_PACKAGES = List.of("com.bank.shared.kernel");

    private ArchUnitGate() {}

    /** Package names: dot-separated Java identifiers. */
    static final java.util.regex.Pattern PACKAGE_NAME =
            java.util.regex.Pattern.compile("[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*)*");

    /** Rules 1-4 on {@code roots}; rule 5 fails when the classes hold more than one root (no root pinned). */
    public static GateResult check(JavaClasses classes, List<String> roots) {
        return check(classes, roots, List.of());
    }

    /** As {@link #check(JavaClasses, List)}, with {@code generated} packages excluded from rule 5. */
    public static GateResult check(JavaClasses classes, List<String> roots, List<String> generated) {
        Map<Rule, List<String>> violations = hexagonalRules(classes, roots);
        List<String> prefixes = ownPrefixes(detectDomainPrefixes(classes)).stream()
                .filter(p -> !isGenerated(p, generated)).toList();
        if (prefixes.size() > 1) {
            violations.get(Rule.ONE_PACKAGE_ROOT).add(prefixes.size() + " package roots own a .domain package: "
                    + prefixes + ". A repository has one package root (com.bank.<context>, "
                    + "com.enterprise.openfinance.<capability> or com.fintechbankx.<context>.<capability>): set the "
                    + "package-root workflow input (--package-root) to it and move or delete the other packages");
        }
        return new GateResult(roots, null, violations, generated, generatedExcluded(classes, null, generated));
    }

    /** Rules 1-4 on {@code packageRoot} only; rule 5 fails for every package outside it and every second root. */
    public static GateResult checkPackageRoot(JavaClasses classes, String packageRoot) {
        return checkPackageRoot(classes, packageRoot, List.of());
    }

    /** As {@link #checkPackageRoot(JavaClasses, String)}, with {@code generated} packages excluded from rule 5. */
    public static GateResult checkPackageRoot(JavaClasses classes, String packageRoot, List<String> generated) {
        Map<Rule, List<String>> violations = hexagonalRules(classes, List.of(packageRoot));
        List<String> rule5 = violations.get(Rule.ONE_PACKAGE_ROOT);
        Map<String, List<String>> outside = new TreeMap<>();
        for (JavaClass c : classes) {
            String pkg = c.getPackageName();
            if (!isUnder(pkg, packageRoot) && !isSharedKernel(pkg) && !isGenerated(pkg, generated)) {
                outside.computeIfAbsent(pkg, k -> new ArrayList<>()).add(c.getSimpleName());
            }
        }
        outside.forEach((pkg, names) -> rule5.add("package " + (pkg.isEmpty() ? "<default>" : pkg) + " ("
                + names.size() + (names.size() == 1 ? " class, " : " classes, e.g. ") + names.stream().sorted().findFirst().orElseThrow()
                + ") is outside package root " + packageRoot));
        for (String prefix : ownPrefixes(detectDomainPrefixes(classes))) {
            if (!prefix.equals(packageRoot) && !isGenerated(prefix, generated)) {
                rule5.add("second root " + prefix + " (" + prefix + ".domain..): only " + packageRoot
                        + ".domain.. is checked by rules 1-4; fold it into " + packageRoot
                        + ".domain/application/infrastructure or move it to the repository that owns it");
            }
        }
        return new GateResult(List.of(packageRoot), packageRoot, violations, generated,
                generatedExcluded(classes, packageRoot, generated));
    }

    static boolean isGenerated(String pkg, List<String> generated) {
        return generated.stream().anyMatch(g -> isUnder(pkg, g));
    }

    /** "package (n classes)" for every package that rule 5 skipped because it is declared generated. */
    private static List<String> generatedExcluded(JavaClasses classes, String packageRoot, List<String> generated) {
        Map<String, Integer> counts = new TreeMap<>();
        for (JavaClass c : classes) {
            String pkg = c.getPackageName();
            if (isGenerated(pkg, generated) && (packageRoot == null || !isUnder(pkg, packageRoot))) {
                counts.merge(pkg, 1, Integer::sum);
            }
        }
        List<String> out = new ArrayList<>();
        counts.forEach((pkg, n) -> out.add(pkg + " (" + n + (n == 1 ? " class)" : " classes)")));
        return out;
    }

    private static Map<Rule, List<String>> hexagonalRules(JavaClasses classes, List<String> roots) {
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
        return violations;
    }

    static boolean isUnder(String pkg, String root) {
        return pkg.equals(root) || pkg.startsWith(root + ".");
    }

    static boolean isSharedKernel(String pkg) {
        return SHARED_KERNEL_PACKAGES.stream().anyMatch(k -> isUnder(pkg, k));
    }

    private static List<String> ownPrefixes(List<String> prefixes) {
        return prefixes.stream().filter(p -> !isSharedKernel(p)).toList();
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

    /** Every package prefix that owns a {@code .domain} package, nested ones included, sorted. */
    public static List<String> detectDomainPrefixes(JavaClasses classes) {
        Set<String> prefixes = new TreeSet<>();
        for (JavaClass c : classes) {
            String pkg = c.getPackageName();
            int i = (pkg + ".").indexOf(".domain.");
            if (i > 0) {
                prefixes.add(pkg.substring(0, i));
            }
        }
        return List.copyOf(prefixes);
    }

    /** Package prefixes that own a {@code .domain} package, outermost first. */
    public static List<String> detectRoots(JavaClasses classes) {
        List<String> outermost = new ArrayList<>();
        for (String r : detectDomainPrefixes(classes)) {
            if (outermost.stream().noneMatch(o -> r.startsWith(o + "."))) {
                outermost.add(r);
            }
        }
        return outermost;
    }

    public static int run(String[] args) {
        List<Path> dirs = new ArrayList<>();
        List<String> roots = new ArrayList<>();
        String packageRoot = null;
        List<String> generated = new ArrayList<>();
        for (int i = 0; i < args.length; i++) {
            String option = args[i];
            if (!List.of("--classes", "--root", "--package-root", "--generated-packages").contains(option)) {
                System.err.println("unknown argument: " + option);
                return 2;
            }
            if (i + 1 >= args.length || args[i + 1].isBlank()) {
                System.err.println("archunit-gate: " + option + " needs a value");
                return 2;
            }
            String value = args[++i];
            switch (option) {
                case "--classes" -> dirs.add(Path.of(value));
                case "--root" -> roots.add(value);
                case "--generated-packages" -> {
                    for (String g : value.split(",")) {
                        String pkg = g.trim();
                        if (pkg.isEmpty()) {
                            continue;
                        }
                        if (!PACKAGE_NAME.matcher(pkg).matches()) {
                            System.err.println("archunit-gate: --generated-packages: not a package name: " + pkg);
                            return 2;
                        }
                        generated.add(pkg);
                    }
                }
                default -> {
                    if (packageRoot != null) {
                        System.err.println("archunit-gate: --package-root given twice; a repository has one package root");
                        return 2;
                    }
                    packageRoot = value;
                }
            }
        }
        if (packageRoot != null) {
            for (String root : roots) {
                if (!root.equals(packageRoot)) {
                    System.err.println("archunit-gate: --root " + root + " differs from --package-root " + packageRoot
                            + "; with a package root pinned, rules 1-4 run on that root only (drop --root)");
                    return 2;
                }
            }
            roots = List.of(packageRoot);
            for (String g : generated) {
                if (isUnder(packageRoot, g)) {
                    System.err.println("archunit-gate: --generated-packages " + g + " contains package root "
                            + packageRoot + "; declare only the generators' own packages");
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
                .anyMatch(r -> classes.stream().anyMatch(c -> isUnder(c.getPackageName(), r)));
        if (checkedRoots.isEmpty() || !anyClass) {
            System.err.println("archunit-gate: no classes under roots " + checkedRoots + " in " + existing);
            return 2;
        }
        GateResult result = packageRoot != null
                ? checkPackageRoot(classes, packageRoot, generated)
                : check(classes, checkedRoots, generated);
        (result.passed() ? System.out : System.err).print(result.report());
        return result.passed() ? 0 : 1;
    }

    public static void main(String[] args) {
        System.exit(run(args));
    }
}
