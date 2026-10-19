package fixtures.violating.bank.pay.application;

import fixtures.violating.bank.pay.domain.port.out.PaymentGateway;

// Rule 4: an out-port implementation outside infrastructure.
public class LoggingPaymentGateway implements PaymentGateway {
    @Override
    public void send(String paymentId) {
    }
}
