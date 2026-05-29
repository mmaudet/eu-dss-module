package com.linagora.eudss.agent.dto;

import java.util.List;

public record CertificateInfo(
        String keyId,
        String certificateBase64,
        List<String> certificateChainBase64,
        String subjectDn,
        String issuerDn,
        String serialNumber,
        String notBefore,
        String notAfter
) {}
