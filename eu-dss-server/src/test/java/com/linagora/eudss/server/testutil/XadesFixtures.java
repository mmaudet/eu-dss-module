package com.linagora.eudss.server.testutil;

import com.linagora.eudss.server.dto.SignatureParamsDto;
import com.linagora.eudss.server.service.XadesSigningService;
import eu.europa.esig.dss.enumerations.DigestAlgorithm;
import eu.europa.esig.dss.enumerations.EncryptionAlgorithm;
import eu.europa.esig.dss.enumerations.SignatureAlgorithm;
import eu.europa.esig.dss.enumerations.SignaturePackaging;
import eu.europa.esig.dss.model.DSSDocument;
import eu.europa.esig.dss.model.InMemoryDocument;
import eu.europa.esig.dss.model.SignatureValue;
import eu.europa.esig.dss.model.ToBeSigned;
import eu.europa.esig.dss.xades.signature.XAdESService;

import java.io.ByteArrayOutputStream;
import java.security.Signature;
import java.util.Base64;
import java.util.List;

/**
 * Builds standalone XAdES signatures (DETACHED or ENVELOPING) for validation tests, reusing the
 * production {@link XadesSigningService} + a software {@link TestPki} key. Mirrors the real
 * prepare/sign/assemble round-trip (getDataToSign -> raw RSA sign -> signDocument).
 */
public final class XadesFixtures {

    private XadesFixtures() {}

    /** Returns the produced XAdES signature bytes (for DETACHED, the signature only). */
    public static byte[] xades(XAdESService xadesService, TestPki.SelfSigned pki,
                               SignaturePackaging packaging, byte[] original, String originalName) throws Exception {
        String certB64 = Base64.getEncoder().encodeToString(pki.certificate().getEncoded());
        SignatureParamsDto params = new SignatureParamsDto(
                List.of(certB64),
                SignatureParamsDto.DigestAlgorithmDto.SHA256,
                System.currentTimeMillis(),
                SignatureParamsDto.SignatureLevelDto.BASELINE_B,
                "fixture", "Paris", "eu-dss test signer");

        XadesSigningService signer = new XadesSigningService(xadesService, packaging);
        DSSDocument doc = new InMemoryDocument(original, originalName);

        ToBeSigned tbs = signer.dataToSign(doc, params);
        Signature s = Signature.getInstance("SHA256withRSA");
        s.initSign(pki.privateKey());
        s.update(tbs.getBytes());
        SignatureValue sv = new SignatureValue();
        sv.setAlgorithm(SignatureAlgorithm.getAlgorithm(EncryptionAlgorithm.RSA, DigestAlgorithm.SHA256));
        sv.setValue(s.sign());

        DSSDocument signed = signer.sign(doc, params, sv);
        try (ByteArrayOutputStream baos = new ByteArrayOutputStream()) {
            signed.writeTo(baos);
            return baos.toByteArray();
        }
    }
}
