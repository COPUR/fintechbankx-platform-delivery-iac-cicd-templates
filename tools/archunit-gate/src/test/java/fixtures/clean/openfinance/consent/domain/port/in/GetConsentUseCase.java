package fixtures.clean.openfinance.consent.domain.port.in;

import fixtures.clean.openfinance.consent.domain.model.Consent;

public interface GetConsentUseCase {
    Consent get(String id);
}
