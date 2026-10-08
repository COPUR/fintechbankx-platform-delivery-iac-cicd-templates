package fixtures.multiroot.of.recurring.domain.port.in;

import fixtures.multiroot.of.recurring.domain.Mandate;

public interface CreateMandateUseCase {
    Mandate create(String id);
}
