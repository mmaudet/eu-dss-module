package com.linagora.eudss.server.service;

import com.linagora.eudss.server.dto.SignatureParamsDto;
import eu.europa.esig.dss.asic.xades.ASiCWithXAdESSignatureParameters;
import eu.europa.esig.dss.enumerations.ASiCContainerType;
import eu.europa.esig.dss.enumerations.DigestAlgorithm;
import eu.europa.esig.dss.enumerations.SignatureLevel;
import eu.europa.esig.dss.enumerations.SignaturePackaging;
import eu.europa.esig.dss.model.x509.CertificateToken;
import eu.europa.esig.dss.pades.PAdESSignatureParameters;
import eu.europa.esig.dss.xades.XAdESSignatureParameters;

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
        params.setSignatureLevel(toPadesLevel(dto.signatureLevelOrDefault()));
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

    public static ASiCWithXAdESSignatureParameters toAsicParams(SignatureParamsDto dto) {
        ASiCWithXAdESSignatureParameters params = new ASiCWithXAdESSignatureParameters();
        params.aSiC().setContainerType(ASiCContainerType.ASiC_E);
        params.setSignatureLevel(toXadesLevel(dto.signatureLevelOrDefault()));
        params.setDigestAlgorithm(toDssDigest(dto.digestAlgorithm()));
        params.bLevel().setSigningDate(new Date(dto.signingTimeEpochMs()));

        List<CertificateToken> chain = decodeChain(dto.certificateChainBase64());
        params.setSigningCertificate(chain.get(0));
        params.setCertificateChain(chain);
        return params;
    }

    /**
     * Standalone XAdES parameters (not wrapped in an ASiC container). The packaging selects how the
     * signed data relates to the signature XML: {@link SignaturePackaging#ENVELOPING} embeds the file
     * (base64) inside the signature; {@link SignaturePackaging#DETACHED} references it externally and
     * the original document is not part of the produced signature.
     */
    public static XAdESSignatureParameters toXadesParams(SignatureParamsDto dto, SignaturePackaging packaging) {
        XAdESSignatureParameters params = new XAdESSignatureParameters();
        params.setSignaturePackaging(packaging);
        params.setSignatureLevel(toXadesLevel(dto.signatureLevelOrDefault()));
        params.setDigestAlgorithm(toDssDigest(dto.digestAlgorithm()));
        params.bLevel().setSigningDate(new Date(dto.signingTimeEpochMs()));

        List<CertificateToken> chain = decodeChain(dto.certificateChainBase64());
        params.setSigningCertificate(chain.get(0));
        params.setCertificateChain(chain);
        return params;
    }

    public static CertificateToken firstCertificate(List<String> chainBase64) {
        return decodeChain(chainBase64).get(0);
    }

    public static SignatureLevel toPadesLevel(SignatureParamsDto.SignatureLevelDto dto) {
        return switch (dto) {
            case BASELINE_B -> SignatureLevel.PAdES_BASELINE_B;
            case BASELINE_T -> SignatureLevel.PAdES_BASELINE_T;
            case BASELINE_LT -> SignatureLevel.PAdES_BASELINE_LT;
            case BASELINE_LTA -> SignatureLevel.PAdES_BASELINE_LTA;
        };
    }

    public static SignatureLevel toXadesLevel(SignatureParamsDto.SignatureLevelDto dto) {
        return switch (dto) {
            case BASELINE_B -> SignatureLevel.XAdES_BASELINE_B;
            case BASELINE_T -> SignatureLevel.XAdES_BASELINE_T;
            case BASELINE_LT -> SignatureLevel.XAdES_BASELINE_LT;
            case BASELINE_LTA -> SignatureLevel.XAdES_BASELINE_LTA;
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
