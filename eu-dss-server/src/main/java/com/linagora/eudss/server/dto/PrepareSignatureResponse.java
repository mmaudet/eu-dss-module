package com.linagora.eudss.server.dto;

public record PrepareSignatureResponse(
        String dataToSignBase64,
        String dataToSignDigestBase64
) {}
