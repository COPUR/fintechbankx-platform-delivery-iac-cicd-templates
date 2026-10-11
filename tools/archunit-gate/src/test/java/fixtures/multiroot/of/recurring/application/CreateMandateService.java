package fixtures.multiroot.of.recurring.application;

import fixtures.multiroot.of.recurring.domain.Mandate;
import fixtures.multiroot.of.recurring.domain.port.in.CreateMandateUseCase;

public class CreateMandateService implements CreateMandateUseCase {
    @Override
    public Mandate create(String id) {
        return new Mandate(id);
    }
}
