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
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

public class TokenService implements AutoCloseable {

    private static final Logger LOG = LoggerFactory.getLogger(TokenService.class);

    private final AgentConfig config;
    private volatile Pkcs11SignatureToken token;
    private volatile long expiresAtEpochMs; // 0 = locked; Long.MAX_VALUE = headless (never idle-locks)
    private final ScheduledExecutorService idleLocker =
            Executors.newSingleThreadScheduledExecutor(r -> {
                Thread th = new Thread(r, "token-idle-lock");
                th.setDaemon(true);
                return th;
            });
    private ScheduledFuture<?> idleTask;

    public TokenService(AgentConfig config) {
        this.config = config;
    }

    /** Opens the PKCS#11 token and forces a login with the given PIN. Overridable for tests. */
    protected void doOpenAndLogin(char[] pin) {
        Pkcs11SignatureToken t = new Pkcs11SignatureToken(
                config.pkcs11Driver().toString(),
                // NOTE: KeyStore.PasswordProtection keeps an internal PIN copy; not destroyed here because the SunPKCS11 callback may be reused on sign. Known JDK limitation; acceptable for a localhost agent.
                new PrefilledPasswordCallback(new KeyStore.PasswordProtection(pin)),
                -1,
                config.slotListIndex(),
                null
        );
        t.getKeys(); // forces C_Login; throws on wrong/locked PIN
        this.token = t;
    }

    /** Closes the PKCS#11 token. Overridable for tests. */
    protected void doClose() {
        if (token != null) {
            try { token.close(); } catch (Exception e) { LOG.warn("Error closing PKCS#11 token", e); }
        }
    }

    public synchronized void unlock(char[] pin) {
        if (token != null) {                 // I2: close a prior real session before reopening
            if (idleTask != null) { idleTask.cancel(false); idleTask = null; }
            doClose();
            token = null;
        }
        try {
            LOG.info("Unlocking PKCS#11 token: driver={} slotListIndex={}", config.pkcs11Driver(), config.slotListIndex());
            doOpenAndLogin(pin);
            if (config.headless()) {
                expiresAtEpochMs = Long.MAX_VALUE; // headless: stay unlocked, no idle-lock
            } else {
                scheduleIdleLock();
            }
        } finally {
            if (!config.headless()) {
                Arrays.fill(pin, '\0'); // zeroize the interactive PIN; never cached
            }
        }
    }

    private synchronized void scheduleIdleLock() {
        expiresAtEpochMs = System.currentTimeMillis() + config.pinSessionTtlSeconds() * 1000L;
        if (idleTask != null) idleTask.cancel(false);
        idleTask = idleLocker.schedule(this::lock, config.pinSessionTtlSeconds(), TimeUnit.SECONDS);
    }

    /** Marks activity: extends the idle window (no-op in headless / when locked). */
    public synchronized void touch() {
        if (isUnlocked() && !config.headless()) scheduleIdleLock();
    }

    public synchronized boolean isUnlocked() {
        return expiresAtEpochMs > 0 && System.currentTimeMillis() < expiresAtEpochMs;
    }

    public synchronized Long expiresInSeconds() {
        if (!isUnlocked() || expiresAtEpochMs == Long.MAX_VALUE) return null;
        return Math.max(0, (expiresAtEpochMs - System.currentTimeMillis()) / 1000);
    }

    public synchronized void lock() {
        if (idleTask != null) { idleTask.cancel(false); idleTask = null; }
        doClose();
        token = null;
        expiresAtEpochMs = 0;
    }

    private synchronized Pkcs11SignatureToken requireUnlocked() {
        if (!isUnlocked()) throw new LockedException();
        return token;
    }

    public List<CertificateInfo> listCertificates() {
        List<CertificateInfo> out = requireUnlocked().getKeys().stream().map(this::toInfo).toList();
        touch();
        return out;
    }

    public byte[] signDigest(String keyId, byte[] digestBytes, DigestAlgorithm algorithm) {
        Pkcs11SignatureToken t = requireUnlocked();
        DSSPrivateKeyEntry key = t.getKeys().stream()
                .filter(k -> keyId.equals(aliasOf(k)))
                .findFirst()
                .orElseThrow(() -> new IllegalArgumentException("Unknown keyId: " + keyId));
        SignatureValue sv = t.signDigest(new Digest(algorithm, digestBytes), key);
        touch();
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
        lock();
        idleLocker.shutdownNow();
    }
}
