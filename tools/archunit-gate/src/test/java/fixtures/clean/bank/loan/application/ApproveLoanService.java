package fixtures.clean.bank.loan.application;

import fixtures.clean.bank.loan.domain.Loan;
import fixtures.clean.bank.loan.domain.port.in.ApproveLoanUseCase;
import fixtures.clean.bank.loan.domain.port.out.LoanRepository;

public class ApproveLoanService implements ApproveLoanUseCase {
    private final LoanRepository loans;

    public ApproveLoanService(LoanRepository loans) {
        this.loans = loans;
    }

    @Override
    public Loan approve(String loanId) {
        return loans.load(loanId);
    }
}
