package com.linagora.eudss.agent.service;

import com.linagora.eudss.agent.config.AgentConfig;
import com.linagora.eudss.agent.dto.CertificateInfo;
import eu.europa.esig.dss.enumerations.DigestAlgorithm;
import eu.europa.esig.dss.model.Digest;
import eu.europa.esig.dss.model.SignatureValue;
import eu.europa.esig.dss.model.x509.CertificateToken;
import eu.europa.esig.dss.token.DSSPrivateKeyEntry;
import eu.europa.esig.dss.token.KSPrivateKeyEntry;
import eu.europa.esig.dss.token.Pkcs11SignatureToken;
import eu.europa.esig.dss.token.PrefilledPasswordCallback;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.security.KeyStore;
import java.util.Arrays;
import java.util.Base64;
import java.util.List;
import java.util.NoSuchElementException;

public class TokenService implements AutoCloseable {

    private static final Logger LOG = LoggerFactory.getLogger(TokenService.class);

    private final AgentConfig config;
    private volatile Pkcs11SignatureToken token;

    public TokenService(AgentConfig config) {
        this.config = config;
    }

    private synchronized Pkcs11SignatureToken token() {
        if (token == null) {
            LOG.info("Opening PKCS#11 token: driver={} slotListIndex={}", config.pkcs11Driver(), config.slotListIndex());
            token = new Pkcs11SignatureToken(
                    config.pkcs11Driver().toString(),
                    new PrefilledPasswordCallback(new KeyStore.PasswordProtection(config.pin())),
                    -1,
                    config.slotListIndex(),
                    null
            );
        }
        return token;
    }

    public List<CertificateInfo> listCertificates() {
        return token().getKeys().stream()
                .map(this::toInfo)
                .toList();
    }

    public byte[] signDigest(String keyId, byte[] digestBytes, DigestAlgorithm algorithm) {
        DSSPrivateKeyEntry key = token().getKeys().stream()
                .filter(k -> keyId.equals(aliasOf(k)))
                .findFirst()
                .orElseThrow(() -> new NoSuchElementException("Unknown keyId: " + keyId));
        Digest digest = new Digest(algorithm, digestBytes);
        SignatureValue sv = token().signDigest(digest, key);
        return sv.getValue();
    }

    private CertificateInfo toInfo(DSSPrivateKeyEntry key) {
        CertificateToken cert = key.getCertificate();
        CertificateToken[] chain = key.getCertificateChain();
        Base64.Encoder b64 = Base64.getEncoder();
        return new CertificateInfo(
                aliasOf(key),
                b64.encodeToString(cert.getEncoded()),
                chain == null ? List.of() : Arrays.stream(chain).map(c -> b64.encodeToString(c.getEncoded())).toList(),
                cert.getSubject().getRFC2253(),
                cert.getIssuer().getRFC2253(),
                cert.getSerialNumber().toString(),
                cert.getNotBefore().toInstant().toString(),
                cert.getNotAfter().toInstant().toString()
        );
    }

    private static String aliasOf(DSSPrivateKeyEntry key) {
        if (key instanceof KSPrivateKeyEntry ks) return ks.getAlias();
        return key.getCertificate().getDSSIdAsString();
    }

    @Override
    public synchronized void close() {
        if (token != null) {
            try {
                token.close();
            } catch (Exception e) {
                LOG.warn("Error closing PKCS#11 token", e);
            } finally {
                token = null;
            }
        }
    }
}
