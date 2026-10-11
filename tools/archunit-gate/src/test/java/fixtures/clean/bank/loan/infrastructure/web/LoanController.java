package fixtures.clean.bank.loan.infrastructure.web;

import fixtures.clean.bank.loan.domain.Loan;
import fixtures.clean.bank.loan.domain.port.in.ApproveLoanUseCase;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class LoanController {
    private final ApproveLoanUseCase approveLoan;

    public LoanController(ApproveLoanUseCase approveLoan) {
        this.approveLoan = approveLoan;
    }

    @PostMapping("/loans/{id}/approval")
    public Loan approve(@PathVariable String id) {
        return approveLoan.approve(id);
    }
}
