package com.linagora.eudss.server.dto;

import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;

import java.util.List;

public record SignatureParamsDto(
        @NotEmpty List<String> certificateChainBase64,
        @NotNull DigestAlgorithmDto digestAlgorithm,
        @NotNull Long signingTimeEpochMs,
        SignatureLevelDto signatureLevel,
        SignatureFormDto signatureForm,
        String signatureReason,
        String signatureLocation,
        String signerName
) {
    /**
     * Backward-compatible constructor (pre-{@code signatureForm}): the signature form is left
     * unset, so the format falls back to filename-based auto-detection (.pdf -&gt; PAdES, else ASiC-E).
     */
    public SignatureParamsDto(
            List<String> certificateChainBase64,
            DigestAlgorithmDto digestAlgorithm,
            Long signingTimeEpochMs,
            SignatureLevelDto signatureLevel,
            String signatureReason,
            String signatureLocation,
            String signerName) {
        this(certificateChainBase64, digestAlgorithm, signingTimeEpochMs, signatureLevel,
                null, signatureReason, signatureLocation, signerName);
    }

    public SignatureLevelDto signatureLevelOrDefault() {
        return signatureLevel != null ? signatureLevel : SignatureLevelDto.BASELINE_T;
    }

    public enum DigestAlgorithmDto {
        SHA256, SHA384, SHA512
    }

    public enum SignatureLevelDto {
        BASELINE_B, BASELINE_T, BASELINE_LT, BASELINE_LTA
    }

    /**
     * Explicit signature form chosen by the client. When {@code null}, the backend auto-detects
     * the form from the document file name (.pdf -&gt; PAdES, everything else -&gt; ASiC-E).
     *
     * <ul>
     *   <li>{@code PADES} – PAdES signature embedded in the PDF (input must be a PDF).</li>
     *   <li>{@code ASIC_E} – ASiC-E container holding a XAdES signature (wraps any file).</li>
     *   <li>{@code XADES_ENVELOPING} – standalone XAdES (ENVELOPING): the file is base64-embedded
     *       inside the returned XML signature.</li>
     * </ul>
     */
    public enum SignatureFormDto {
        PADES, ASIC_E, XADES_ENVELOPING
    }
}
