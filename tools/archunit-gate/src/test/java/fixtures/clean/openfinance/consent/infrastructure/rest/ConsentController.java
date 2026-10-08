package fixtures.clean.openfinance.consent.infrastructure.rest;

import fixtures.clean.openfinance.consent.domain.model.Consent;
import fixtures.clean.openfinance.consent.domain.port.in.GetConsentUseCase;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ConsentController {
    private final GetConsentUseCase consents;

    public ConsentController(GetConsentUseCase consents) {
        this.consents = consents;
    }

    @GetMapping("/consents/{id}")
    public Consent get(String id) {
        return consents.get(id);
    }
}
