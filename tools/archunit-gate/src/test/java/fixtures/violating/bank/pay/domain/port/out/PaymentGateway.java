package fixtures.violating.bank.pay.domain.port.out;

public interface PaymentGateway {
    void send(String paymentId);
}
