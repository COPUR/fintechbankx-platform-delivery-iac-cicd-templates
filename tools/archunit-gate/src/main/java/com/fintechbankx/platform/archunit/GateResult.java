package com.fintechbankx.platform.archunit;

import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Violations per rule; a rule with no entry or an empty list passed. */
public record GateResult(List<String> roots, Map<Rule, List<String>> violations) {

    public GateResult {
        roots = List.copyOf(roots);
        Map<Rule, List<String>> copy = new EnumMap<>(Rule.class);
        violations.forEach((rule, list) -> copy.put(rule, List.copyOf(list)));
        violations = copy;
    }

    public boolean passed() {
        return violations.values().stream().allMatch(List::isEmpty);
    }

    public Set<Rule> evaluatedRules() {
        return violations.keySet();
    }

    public String report() {
        StringBuilder out = new StringBuilder("ArchUnit gate (ADR-028) for roots ").append(roots).append('\n');
        for (Rule rule : Rule.values()) {
            List<String> list = violations.getOrDefault(rule, List.of());
            out.append(list.isEmpty() ? "  PASS " : "  FAIL ").append(rule.description()).append('\n');
            list.forEach(v -> out.append("       - ").append(v).append('\n'));
        }
        return out.toString();
    }
}
