package fixtures.multiroot.of.recurring.jwt.domain;

// Rule 5: a second hexagon nested inside the root. Rules 1-4 check <root>.domain..,
// so <root>.jwt.domain.. would escape them.
public record Token(String value) {}
