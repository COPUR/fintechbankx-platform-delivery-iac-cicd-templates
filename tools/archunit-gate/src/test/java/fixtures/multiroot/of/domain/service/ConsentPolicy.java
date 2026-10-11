package fixtures.multiroot.of.domain.service;

import org.springframework.stereotype.Service;

// Rule 5: a copied second root (like com.enterprise.openfinance.domain in the payment repos).
// It also imports Spring, which rules 1-4 report only when this prefix is checked as a root.
@Service
public class ConsentPolicy {
}
