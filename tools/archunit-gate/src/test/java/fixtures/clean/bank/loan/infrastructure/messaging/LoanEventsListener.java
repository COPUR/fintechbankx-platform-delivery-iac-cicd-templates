package fixtures.clean.bank.loan.infrastructure.messaging;

import fixtures.clean.bank.loan.domain.port.in.ApproveLoanUseCase;
import org.springframework.kafka.annotation.KafkaListener;

public class LoanEventsListener {
    private final ApproveLoanUseCase approveLoan;

    public LoanEventsListener(ApproveLoanUseCase approveLoan) {
        this.approveLoan = approveLoan;
    }

    @KafkaListener(topics = "evt.ln.loan.created.v1")
    public void on(String loanId) {
        approveLoan.approve(loanId);
    }
}
