package com.linagora.eudss.server.dto;

public record AssembleSignatureResponse(
        String signedDocumentBase64,
        String signedFileName,
        String mediaType
) {}
