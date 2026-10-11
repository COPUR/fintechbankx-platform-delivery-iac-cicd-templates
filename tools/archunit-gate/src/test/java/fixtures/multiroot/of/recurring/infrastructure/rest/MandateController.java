package fixtures.multiroot.of.recurring.infrastructure.rest;

import fixtures.multiroot.of.recurring.domain.Mandate;
import fixtures.multiroot.of.recurring.domain.port.in.CreateMandateUseCase;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class MandateController {
    private final CreateMandateUseCase createMandate;

    public MandateController(CreateMandateUseCase createMandate) {
        this.createMandate = createMandate;
    }

    @PostMapping("/mandates/{id}")
    public Mandate create(@PathVariable String id) {
        return createMandate.create(id);
    }
}
