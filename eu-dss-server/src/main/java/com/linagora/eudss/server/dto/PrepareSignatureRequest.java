package com.linagora.eudss.server.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

public record PrepareSignatureRequest(
        @NotBlank String pdfBase64,
        @NotNull @Valid SignatureParamsDto params
) {}
