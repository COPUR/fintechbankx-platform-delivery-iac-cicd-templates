package fixtures.clean.bank.loan.infrastructure.persistence;

import fixtures.clean.bank.loan.domain.Loan;
import fixtures.clean.bank.loan.domain.port.out.LoanRepository;

public class JpaLoanRepository implements LoanRepository {
    @Override
    public Loan load(String id) {
        return new Loan(id, 0);
    }
}
