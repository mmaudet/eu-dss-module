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
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Service;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.Base64;

@Service
public class DocumentSigningService {

    private final DocumentSigner padesSigner;
    private final DocumentSigner asicSigner;
    private final DocumentSigner xadesEnvelopingSigner;

    public DocumentSigningService(@Qualifier("padesSigningService") DocumentSigner padesSigner,
                                  @Qualifier("asicSigningService") DocumentSigner asicSigner,
                                  @Qualifier("xadesEnvelopingSigningService") DocumentSigner xadesEnvelopingSigner) {
        this.padesSigner = padesSigner;
        this.asicSigner = asicSigner;
        this.xadesEnvelopingSigner = xadesEnvelopingSigner;
    }

    public PrepareSignatureResponse prepare(PrepareSignatureRequest req) {
        DSSDocument document = toDocument(req.documentBase64(), req.documentName());
        SigningFormat format = formatFor(req.params(), req.documentName());
        ToBeSigned dataToSign = signerFor(format).dataToSign(document, req.params());
        byte[] digest = DSSUtils.digest(SignatureMapper.toDssDigest(req.params().digestAlgorithm()), dataToSign.getBytes());
        return new PrepareSignatureResponse(
                Base64.getEncoder().encodeToString(dataToSign.getBytes()),
                Base64.getEncoder().encodeToString(digest));
    }

    public AssembleSignatureResponse assemble(AssembleSignatureRequest req) {
        DSSDocument document = toDocument(req.documentBase64(), req.documentName());
        SigningFormat format = formatFor(req.params(), req.documentName());
        SignatureValue signatureValue = signatureValue(req.params(), Base64.getDecoder().decode(req.signatureValueBase64()));
        DSSDocument signed = signerFor(format).sign(document, req.params(), signatureValue);
        byte[] bytes = toBytes(signed);
        String mediaType = signed.getMimeType() != null ? signed.getMimeType().getMimeTypeString() : "application/octet-stream";
        return new AssembleSignatureResponse(
                Base64.getEncoder().encodeToString(bytes),
                signedFileName(req.documentName(), format),
                mediaType);
    }

    /**
     * Resolves the signature format identically for prepare and assemble: the client's explicit
     * {@code signatureForm} wins; otherwise it falls back to file-name auto-detection. Keeping this
     * single resolution point guarantees the data-to-sign and the incorporated signature use the
     * same DSS parameters across the two round-trips.
     */
    private static SigningFormat formatFor(SignatureParamsDto params, String fileName) {
        return SigningFormat.resolve(params.signatureForm(), fileName);
    }

    private DocumentSigner signerFor(SigningFormat format) {
        return switch (format) {
            case PADES -> padesSigner;
            case ASIC -> asicSigner;
            case XADES_ENVELOPING -> xadesEnvelopingSigner;
        };
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

    /**
     * Names the produced artifact per format: PDFs keep their name (PAdES, in place); ASiC-E
     * becomes an {@code .asice} container; standalone XAdES (enveloping) becomes an {@code .xml}
     * signature file.
     */
    private static String signedFileName(String fileName, SigningFormat format) {
        if (format == SigningFormat.PADES) {
            return fileName;
        }
        String base = baseName(fileName);
        return switch (format) {
            case ASIC -> base + ".asice";
            case XADES_ENVELOPING -> base + ".xml";
            case PADES -> fileName; // unreachable, handled above
        };
    }

    private static String baseName(String fileName) {
        String base = fileName == null || fileName.isBlank() ? "document" : fileName;
        int dot = base.lastIndexOf('.');
        if (dot > 0) {
            base = base.substring(0, dot);
        }
        return base;
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
