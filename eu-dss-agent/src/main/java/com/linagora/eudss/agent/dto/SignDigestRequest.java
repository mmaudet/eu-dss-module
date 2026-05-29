package com.linagora.eudss.agent.dto;

public record SignDigestRequest(
        String keyId,
        String digestBase64,
        String digestAlgorithm
) {}
