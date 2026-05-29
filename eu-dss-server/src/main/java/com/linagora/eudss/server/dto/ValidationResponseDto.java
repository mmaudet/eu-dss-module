package com.linagora.eudss.server.dto;

import java.util.List;

public record ValidationResponseDto(
        int signatureCount,
        List<SignatureSummary> signatures,
        String simpleReportXml
) {
    public record SignatureSummary(
            String signatureId,
            String signatureFormat,
            String indication,
            String subIndication,
            String signedBy,
            String signingDate
    ) {}
}
