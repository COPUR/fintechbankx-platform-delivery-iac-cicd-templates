package com.fintechbankx.platform.archunit;

import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Violations per rule; a rule with no entry or an empty list passed. {@code packageRoot} is the pinned
 * root ({@code --package-root}) or null when the roots were given with {@code --root} or detected.
 * {@code generatedPackages} were declared with {@code --generated-packages}; {@code generatedExcluded} lists the
 * packages ("package (n classes)") rule 5 skipped because of them.
 */
public record GateResult(List<String> roots, String packageRoot, Map<Rule, List<String>> violations,
        List<String> generatedPackages, List<String> generatedExcluded) {

    public GateResult {
        roots = List.copyOf(roots);
        Map<Rule, List<String>> copy = new EnumMap<>(Rule.class);
        violations.forEach((rule, list) -> copy.put(rule, List.copyOf(list)));
        violations = copy;
        generatedPackages = List.copyOf(generatedPackages);
        generatedExcluded = List.copyOf(generatedExcluded);
    }

    public GateResult(List<String> roots, String packageRoot, Map<Rule, List<String>> violations) {
        this(roots, packageRoot, violations, List.of(), List.of());
    }

    public GateResult(List<String> roots, Map<Rule, List<String>> violations) {
        this(roots, null, violations);
    }

    public boolean passed() {
        return violations.values().stream().allMatch(List::isEmpty);
    }

    public Set<Rule> evaluatedRules() {
        return violations.keySet();
    }

    public String report() {
        StringBuilder out = new StringBuilder("ArchUnit gate (ADR-028) for ")
                .append(packageRoot == null ? "roots " + roots : "package root " + packageRoot + " (pinned)")
                .append('\n');
        for (Rule rule : Rule.values()) {
            List<String> list = violations.getOrDefault(rule, List.of());
            out.append(list.isEmpty() ? "  PASS " : "  FAIL ").append(rule.description()).append('\n');
            list.forEach(v -> out.append("       - ").append(v).append('\n'));
        }
        if (!generatedPackages.isEmpty()) {
            out.append("  generated packages excluded from rule 5: ").append(generatedPackages).append('\n');
            if (generatedExcluded.isEmpty()) {
                out.append("       (no classes found in them)\n");
            }
            generatedExcluded.forEach(p -> out.append("       - ").append(p).append('\n'));
        }
        return out.toString();
    }
}
