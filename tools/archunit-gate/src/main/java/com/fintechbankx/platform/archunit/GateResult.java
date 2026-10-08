package com.fintechbankx.platform.archunit;

import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Violations per rule; a rule with no entry or an empty list passed. {@code packageRoot} is the pinned
 * root ({@code --package-root}) or null when the roots were given with {@code --root} or detected.
 */
public record GateResult(List<String> roots, String packageRoot, Map<Rule, List<String>> violations) {

    public GateResult {
        roots = List.copyOf(roots);
        Map<Rule, List<String>> copy = new EnumMap<>(Rule.class);
        violations.forEach((rule, list) -> copy.put(rule, List.copyOf(list)));
        violations = copy;
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
        return out.toString();
    }
}
