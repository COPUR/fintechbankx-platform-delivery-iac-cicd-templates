package fixtures.violating.bank.pay.application;

import fixtures.violating.bank.pay.domain.port.in.InitiatePaymentUseCase;
import fixtures.violating.bank.pay.infrastructure.config.PaymentSettings;

// Rule 2: application depends on infrastructure.
public class InitiatePaymentService implements InitiatePaymentUseCase {
    private final PaymentSettings settings = new PaymentSettings();

    @Override
    public String initiate(String request) {
        return request + settings.retries();
    }
}
