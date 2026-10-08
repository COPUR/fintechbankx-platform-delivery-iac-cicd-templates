package fixtures.clean.bank.loan.domain.port.out;

import fixtures.clean.bank.loan.domain.Loan;

public interface LoanRepository {
    Loan load(String id);
}
