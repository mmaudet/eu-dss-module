package com.linagora.eudss.server.service;

import java.util.Locale;

public enum SigningFormat {
    PADES,
    ASIC;

    /** PDFs are signed in place (PAdES); everything else is wrapped in an ASiC-E/XAdES container. */
    public static SigningFormat forFileName(String fileName) {
        String name = fileName == null ? "" : fileName.toLowerCase(Locale.ROOT);
        return name.endsWith(".pdf") ? PADES : ASIC;
    }
}
