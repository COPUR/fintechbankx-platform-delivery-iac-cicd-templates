package com.fintechbankx.platform.archunit;

/** The four hexagonal rules of ADR-028 (FINTECHBANKX_SERVICE_GUARDRAILS.md, section 3). */
public enum Rule {
    DOMAIN_IS_FRAMEWORK_FREE(
            "1. domain.. depends on no application, infrastructure, Spring, JPA, Kafka or Mongo packages"),
    APPLICATION_IS_INFRASTRUCTURE_FREE("2. application.. depends on no infrastructure.. package"),
    INBOUND_ADAPTERS_USE_PORTS_IN(
            "3. controllers and listeners in infrastructure.. depend on domain.port.in.., not on application implementations"),
    PORT_OUT_IMPLEMENTATIONS_IN_INFRASTRUCTURE("4. implementations of domain.port.out.. interfaces live in infrastructure..");

    private final String description;

    Rule(String description) {
        this.description = description;
    }

    public String description() {
        return description;
    }
}
