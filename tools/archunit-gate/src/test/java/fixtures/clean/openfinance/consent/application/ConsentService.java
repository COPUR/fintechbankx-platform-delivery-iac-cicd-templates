package fixtures.clean.openfinance.consent.application;

import fixtures.clean.openfinance.consent.domain.model.Consent;
import fixtures.clean.openfinance.consent.domain.port.in.GetConsentUseCase;

public class ConsentService implements GetConsentUseCase {
    @Override
    public Consent get(String id) {
        return new Consent(id);
    }
}
