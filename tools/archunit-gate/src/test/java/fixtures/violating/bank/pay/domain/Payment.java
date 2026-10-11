package fixtures.violating.bank.pay.domain;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;

// Rule 1: JPA in the domain.
@Entity
public class Payment {
    @Id
    private String id;
}
