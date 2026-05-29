package com.linagora.eudss.server.service;

import com.linagora.eudss.server.dto.SignatureParamsDto;
import eu.europa.esig.dss.asic.xades.signature.ASiCWithXAdESService;
import eu.europa.esig.dss.model.DSSDocument;
import eu.europa.esig.dss.model.SignatureValue;
import eu.europa.esig.dss.model.ToBeSigned;
import org.springframework.stereotype.Service;

@Service
public class AsicSigningService implements DocumentSigner {

    private final ASiCWithXAdESService asicService;

    public AsicSigningService(ASiCWithXAdESService asicService) {
        this.asicService = asicService;
    }

    @Override
    public ToBeSigned dataToSign(DSSDocument document, SignatureParamsDto params) {
        return asicService.getDataToSign(document, SignatureMapper.toAsicParams(params));
    }

    @Override
    public DSSDocument sign(DSSDocument document, SignatureParamsDto params, SignatureValue signatureValue) {
        return asicService.signDocument(document, SignatureMapper.toAsicParams(params), signatureValue);
    }
}
