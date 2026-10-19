package com.bank.shared.kernel.domain;

import java.math.BigDecimal;

// Shared kernel kept as com.bank.shared.kernel where it already is
// (FINTECHBANKX_SERVICE_GUARDRAILS.md section 2): allowed next to the package root.
public record Money(BigDecimal amount, String currency) {}
