package com.linagora.eudss.server.service;

import com.linagora.eudss.server.dto.AssembleSignatureRequest;
import com.linagora.eudss.server.dto.AssembleSignatureResponse;
import com.linagora.eudss.server.dto.PrepareSignatureRequest;
import com.linagora.eudss.server.dto.PrepareSignatureResponse;
import com.linagora.eudss.server.dto.SignatureParamsDto;
import eu.europa.esig.dss.enumerations.EncryptionAlgorithm;
import eu.europa.esig.dss.enumerations.SignatureAlgorithm;
import eu.europa.esig.dss.model.DSSDocument;
import eu.europa.esig.dss.model.InMemoryDocument;
import eu.europa.esig.dss.model.SignatureValue;
import eu.europa.esig.dss.model.ToBeSigned;
import eu.europa.esig.dss.model.x509.CertificateToken;
import eu.europa.esig.dss.spi.DSSUtils;
import org.springframework.stereotype.Service;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.Base64;

@Service
public class DocumentSigningService {

    private final PadesSigningService padesSigner;
    private final AsicSigningService asicSigner;

    public DocumentSigningService(PadesSigningService padesSigner, AsicSigningService asicSigner) {
        this.padesSigner = padesSigner;
        this.asicSigner = asicSigner;
    }

    public PrepareSignatureResponse prepare(PrepareSignatureRequest req) {
        DSSDocument document = toDocument(req.documentBase64(), req.documentName());
        ToBeSigned dataToSign = signerFor(req.documentName()).dataToSign(document, req.params());
        byte[] digest = DSSUtils.digest(SignatureMapper.toDssDigest(req.params().digestAlgorithm()), dataToSign.getBytes());
        return new PrepareSignatureResponse(
                Base64.getEncoder().encodeToString(dataToSign.getBytes()),
                Base64.getEncoder().encodeToString(digest));
    }

    public AssembleSignatureResponse assemble(AssembleSignatureRequest req) {
        DSSDocument document = toDocument(req.documentBase64(), req.documentName());
        SignatureValue signatureValue = signatureValue(req.params(), Base64.getDecoder().decode(req.signatureValueBase64()));
        DSSDocument signed = signerFor(req.documentName()).sign(document, req.params(), signatureValue);
        byte[] bytes = toBytes(signed);
        String mediaType = signed.getMimeType() != null ? signed.getMimeType().getMimeTypeString() : "application/octet-stream";
        return new AssembleSignatureResponse(
                Base64.getEncoder().encodeToString(bytes),
                signedFileName(req.documentName()),
                mediaType);
    }

    private DocumentSigner signerFor(String fileName) {
        return SigningFormat.forFileName(fileName) == SigningFormat.PADES ? padesSigner : asicSigner;
    }

    private static DSSDocument toDocument(String base64, String fileName) {
        return new InMemoryDocument(Base64.getDecoder().decode(base64), fileName);
    }

    private static SignatureValue signatureValue(SignatureParamsDto params, byte[] rawSignature) {
        CertificateToken signingCert = SignatureMapper.firstCertificate(params.certificateChainBase64());
        EncryptionAlgorithm encryption = EncryptionAlgorithm.forKey(signingCert.getPublicKey());
        SignatureValue value = new SignatureValue();
        value.setAlgorithm(SignatureAlgorithm.getAlgorithm(encryption, SignatureMapper.toDssDigest(params.digestAlgorithm())));
        value.setValue(rawSignature);
        return value;
    }

    /** PDFs keep their name; everything else becomes an .asice container. */
    private static String signedFileName(String fileName) {
        if (SigningFormat.forFileName(fileName) == SigningFormat.PADES) {
            return fileName;
        }
        String base = fileName == null || fileName.isBlank() ? "document" : fileName;
        int dot = base.lastIndexOf('.');
        if (dot > 0) {
            base = base.substring(0, dot);
        }
        return base + ".asice";
    }

    private static byte[] toBytes(DSSDocument document) {
        try (ByteArrayOutputStream baos = new ByteArrayOutputStream()) {
            document.writeTo(baos);
            return baos.toByteArray();
        } catch (IOException e) {
            throw new IllegalStateException("Failed to serialize signed document", e);
        }
    }
}
