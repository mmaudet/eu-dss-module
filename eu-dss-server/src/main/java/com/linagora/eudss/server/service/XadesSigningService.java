package com.linagora.eudss.server.service;

import com.linagora.eudss.server.dto.SignatureParamsDto;
import eu.europa.esig.dss.enumerations.SignaturePackaging;
import eu.europa.esig.dss.model.DSSDocument;
import eu.europa.esig.dss.model.SignatureValue;
import eu.europa.esig.dss.model.ToBeSigned;
import eu.europa.esig.dss.xades.signature.XAdESService;

/**
 * Standalone (non-ASiC) XAdES signer. Each instance is bound to a fixed {@link SignaturePackaging}
 * (ENVELOPING or DETACHED), so {@code prepare} and {@code assemble} always rebuild identical
 * DSS parameters from the DTO — a requirement of the 3-round-trip flow.
 */
public class XadesSigningService implements DocumentSigner {

    private final XAdESService xadesService;
    private final SignaturePackaging packaging;

    public XadesSigningService(XAdESService xadesService, SignaturePackaging packaging) {
        this.xadesService = xadesService;
        this.packaging = packaging;
    }

    @Override
    public ToBeSigned dataToSign(DSSDocument document, SignatureParamsDto params) {
        return xadesService.getDataToSign(document, SignatureMapper.toXadesParams(params, packaging));
    }

    @Override
    public DSSDocument sign(DSSDocument document, SignatureParamsDto params, SignatureValue signatureValue) {
        return xadesService.signDocument(document, SignatureMapper.toXadesParams(params, packaging), signatureValue);
    }
}
