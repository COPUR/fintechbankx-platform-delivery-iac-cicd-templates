package fixtures.clean.bank.loan.domain.port.in;

import fixtures.clean.bank.loan.domain.Loan;

public interface ApproveLoanUseCase {
    Loan approve(String loanId);
}
