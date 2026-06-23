package com.linagora.eudss.server.dto;

import java.util.List;

public record ValidationResponseDto(
        ValidationKind kind,
        String overallIndication,
        int signatureCount,
        List<SignatureSummary> signatures,
        String simpleReportXml
) {
    /** Outcome of inspecting the uploaded file (drives the verify UI). */
    public enum ValidationKind {
        /**
         * A signature was found and was cryptographically checked — NOT necessarily that it passed.
         * Read {@code overallIndication} and {@code signatures[].indication} for the cryptographic verdict.
         */
        VALIDATED,
        /** A detached signature whose original document is missing — caller must resend with it. */
        DETACHED_CONTENT_REQUIRED,
        /** No signature found (e.g. the caller uploaded the source document instead). */
        NOT_A_SIGNATURE
    }

    public record SignatureSummary(
            String signatureId,
            String signatureFormat,
            String indication,
            String subIndication,
            String signedBy,
            String signingDate
    ) {}
}
