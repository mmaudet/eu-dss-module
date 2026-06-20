package com.linagora.eudss.server.service;

import com.linagora.eudss.server.dto.SignatureParamsDto.SignatureFormDto;

import java.util.Locale;

/**
 * Resolved signing format. Either chosen explicitly by the client (via
 * {@link SignatureFormDto}) or auto-detected from the file name for backward compatibility.
 */
public enum SigningFormat {
    /** PAdES signature embedded in the PDF. */
    PADES,
    /** ASiC-E container wrapping a XAdES signature (default for non-PDF files). */
    ASIC,
    /** Standalone XAdES signature, ENVELOPING packaging (file embedded in the XML). */
    XADES_ENVELOPING,
    /** Standalone XAdES signature, DETACHED packaging (only the signature XML is returned). */
    XADES_DETACHED;

    /** PDFs are signed in place (PAdES); everything else is wrapped in an ASiC-E/XAdES container. */
    public static SigningFormat forFileName(String fileName) {
        String name = fileName == null ? "" : fileName.toLowerCase(Locale.ROOT);
        return name.endsWith(".pdf") ? PADES : ASIC;
    }

    /**
     * Resolves the format from the client's explicit choice, falling back to file-name
     * auto-detection when the client did not specify one (legacy callers).
     */
    public static SigningFormat resolve(SignatureFormDto form, String fileName) {
        if (form == null) {
            return forFileName(fileName);
        }
        return switch (form) {
            case PADES -> PADES;
            case ASIC_E -> ASIC;
            case XADES_ENVELOPING -> XADES_ENVELOPING;
            case XADES_DETACHED -> XADES_DETACHED;
        };
    }
}
