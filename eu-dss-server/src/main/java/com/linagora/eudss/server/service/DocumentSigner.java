package com.linagora.eudss.server.service;

import com.linagora.eudss.server.dto.SignatureParamsDto;
import eu.europa.esig.dss.model.DSSDocument;
import eu.europa.esig.dss.model.SignatureValue;
import eu.europa.esig.dss.model.ToBeSigned;

/** One signature format (PAdES, ASiC/XAdES, …). Stateless: prepare and sign rebuild DSS params from the DTO. */
public interface DocumentSigner {
    ToBeSigned dataToSign(DSSDocument document, SignatureParamsDto params);

    DSSDocument sign(DSSDocument document, SignatureParamsDto params, SignatureValue signatureValue);
}
