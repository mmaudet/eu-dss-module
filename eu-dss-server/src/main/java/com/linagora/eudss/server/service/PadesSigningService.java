package com.linagora.eudss.server.service;

import com.linagora.eudss.server.dto.AssembleSignatureRequest;
import com.linagora.eudss.server.dto.AssembleSignatureResponse;
import com.linagora.eudss.server.dto.PrepareSignatureRequest;
import com.linagora.eudss.server.dto.PrepareSignatureResponse;
import eu.europa.esig.dss.enumerations.EncryptionAlgorithm;
import eu.europa.esig.dss.enumerations.SignatureAlgorithm;
import eu.europa.esig.dss.model.DSSDocument;
import eu.europa.esig.dss.model.InMemoryDocument;
import eu.europa.esig.dss.model.SignatureValue;
import eu.europa.esig.dss.model.ToBeSigned;
import eu.europa.esig.dss.pades.PAdESSignatureParameters;
import eu.europa.esig.dss.pades.signature.PAdESService;
import eu.europa.esig.dss.spi.DSSUtils;
import org.springframework.stereotype.Service;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.Base64;

@Service
public class PadesSigningService {

    private final PAdESService padesService;

    public PadesSigningService(PAdESService padesService) {
        this.padesService = padesService;
    }

    public PrepareSignatureResponse prepare(PrepareSignatureRequest req) {
        DSSDocument document = decodePdf(req.pdfBase64());
        PAdESSignatureParameters params = SignatureMapper.toPadesParams(req.params());

        ToBeSigned dataToSign = padesService.getDataToSign(document, params);
        byte[] digest = DSSUtils.digest(params.getDigestAlgorithm(), dataToSign.getBytes());

        return new PrepareSignatureResponse(
                Base64.getEncoder().encodeToString(dataToSign.getBytes()),
                Base64.getEncoder().encodeToString(digest)
        );
    }

    public AssembleSignatureResponse assemble(AssembleSignatureRequest req) {
        DSSDocument document = decodePdf(req.pdfBase64());
        PAdESSignatureParameters params = SignatureMapper.toPadesParams(req.params());

        SignatureValue signatureValue = new SignatureValue();
        EncryptionAlgorithm encryption = EncryptionAlgorithm.forKey(params.getSigningCertificate().getPublicKey());
        signatureValue.setAlgorithm(SignatureAlgorithm.getAlgorithm(encryption, params.getDigestAlgorithm()));
        signatureValue.setValue(Base64.getDecoder().decode(req.signatureValueBase64()));

        DSSDocument signed = padesService.signDocument(document, params, signatureValue);

        try (ByteArrayOutputStream baos = new ByteArrayOutputStream()) {
            signed.writeTo(baos);
            return new AssembleSignatureResponse(Base64.getEncoder().encodeToString(baos.toByteArray()));
        } catch (IOException e) {
            throw new IllegalStateException("Failed to serialize signed PDF", e);
        }
    }

    private DSSDocument decodePdf(String pdfBase64) {
        byte[] bytes = Base64.getDecoder().decode(pdfBase64);
        return new InMemoryDocument(bytes, "input.pdf");
    }
}
