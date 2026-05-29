package com.linagora.eudss.server.service;

import com.linagora.eudss.server.dto.SignatureParamsDto;
import eu.europa.esig.dss.enumerations.DigestAlgorithm;
import eu.europa.esig.dss.enumerations.SignatureLevel;
import eu.europa.esig.dss.model.x509.CertificateToken;
import eu.europa.esig.dss.pades.PAdESSignatureParameters;

import java.security.cert.CertificateException;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.Base64;
import java.util.Date;
import java.util.List;

public final class SignatureMapper {

    private SignatureMapper() {}

    public static PAdESSignatureParameters toPadesParams(SignatureParamsDto dto) {
        PAdESSignatureParameters params = new PAdESSignatureParameters();
        params.setSignatureLevel(toDssLevel(dto.signatureLevelOrDefault()));
        params.setDigestAlgorithm(toDssDigest(dto.digestAlgorithm()));
        params.bLevel().setSigningDate(new Date(dto.signingTimeEpochMs()));
        if (dto.signatureReason() != null && !dto.signatureReason().isBlank()) {
            params.setReason(dto.signatureReason());
        }
        if (dto.signatureLocation() != null && !dto.signatureLocation().isBlank()) {
            params.setLocation(dto.signatureLocation());
        }
        if (dto.signerName() != null && !dto.signerName().isBlank()) {
            params.setContactInfo(dto.signerName());
        }

        List<CertificateToken> chain = decodeChain(dto.certificateChainBase64());
        params.setSigningCertificate(chain.get(0));
        params.setCertificateChain(chain);
        return params;
    }

    public static DigestAlgorithm toDssDigest(SignatureParamsDto.DigestAlgorithmDto dto) {
        return switch (dto) {
            case SHA256 -> DigestAlgorithm.SHA256;
            case SHA384 -> DigestAlgorithm.SHA384;
            case SHA512 -> DigestAlgorithm.SHA512;
        };
    }

    public static SignatureLevel toDssLevel(SignatureParamsDto.SignatureLevelDto dto) {
        return switch (dto) {
            case PADES_BASELINE_B -> SignatureLevel.PAdES_BASELINE_B;
            case PADES_BASELINE_T -> SignatureLevel.PAdES_BASELINE_T;
            case PADES_BASELINE_LT -> SignatureLevel.PAdES_BASELINE_LT;
            case PADES_BASELINE_LTA -> SignatureLevel.PAdES_BASELINE_LTA;
        };
    }

    private static List<CertificateToken> decodeChain(List<String> chainBase64) {
        try {
            CertificateFactory cf = CertificateFactory.getInstance("X.509");
            Base64.Decoder decoder = Base64.getDecoder();
            return chainBase64.stream()
                    .map(decoder::decode)
                    .map(bytes -> {
                        try {
                            X509Certificate x509 = (X509Certificate) cf.generateCertificate(new java.io.ByteArrayInputStream(bytes));
                            return new CertificateToken(x509);
                        } catch (CertificateException e) {
                            throw new IllegalArgumentException("Invalid X.509 certificate in chain", e);
                        }
                    })
                    .toList();
        } catch (CertificateException e) {
            throw new IllegalStateException("X.509 CertificateFactory unavailable", e);
        }
    }
}
