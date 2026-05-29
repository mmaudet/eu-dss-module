package com.linagora.eudss.server.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

public record AssembleSignatureRequest(
        @NotBlank String documentBase64,
        @NotBlank String documentName,
        @NotNull @Valid SignatureParamsDto params,
        @NotBlank String signatureValueBase64
) {}
