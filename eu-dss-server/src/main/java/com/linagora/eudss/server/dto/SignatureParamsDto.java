package com.linagora.eudss.server.dto;

import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;

import java.util.List;

public record SignatureParamsDto(
        @NotEmpty List<String> certificateChainBase64,
        @NotNull DigestAlgorithmDto digestAlgorithm,
        @NotNull Long signingTimeEpochMs,
        SignatureLevelDto signatureLevel,
        String signatureReason,
        String signatureLocation,
        String signerName
) {
    public SignatureLevelDto signatureLevelOrDefault() {
        return signatureLevel != null ? signatureLevel : SignatureLevelDto.PADES_BASELINE_T;
    }

    public enum DigestAlgorithmDto {
        SHA256, SHA384, SHA512
    }

    public enum SignatureLevelDto {
        PADES_BASELINE_B, PADES_BASELINE_T, PADES_BASELINE_LT, PADES_BASELINE_LTA
    }
}
