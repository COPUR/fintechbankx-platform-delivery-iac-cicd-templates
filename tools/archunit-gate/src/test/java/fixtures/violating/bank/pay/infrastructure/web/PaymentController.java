package fixtures.violating.bank.pay.infrastructure.web;

import fixtures.violating.bank.pay.application.InitiatePaymentService;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

// Rule 3: controller wired to the application implementation, not the in-port.
@RestController
public class PaymentController {
    private final InitiatePaymentService service = new InitiatePaymentService();

    @PostMapping("/payments")
    public String initiate(String request) {
        return service.initiate(request);
    }
}
