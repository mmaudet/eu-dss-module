package com.linagora.eudss.agent.tls;

import org.bouncycastle.asn1.x500.X500Name;
import org.bouncycastle.asn1.x509.Extension;
import org.bouncycastle.asn1.x509.GeneralName;
import org.bouncycastle.asn1.x509.GeneralNames;
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter;
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder;
import org.bouncycastle.operator.ContentSigner;
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.OutputStream;
import java.math.BigInteger;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.util.Date;

/** Loads, or generates on first run, the self-signed PKCS12 keystore backing the agent's HTTPS listener. */
public final class AgentTls {

    private static final Logger LOG = LoggerFactory.getLogger(AgentTls.class);
    private static final long YEAR_MS = 365L * 24 * 60 * 60 * 1000;

    public static Path defaultKeystorePath() {
        return Path.of(System.getProperty("user.home"), ".eudss-agent", "agent-keystore.p12");
    }

    public static void ensureKeystore(Path path, char[] password) throws Exception {
        if (Files.exists(path)) {
            LOG.info("Using existing agent TLS keystore: {}", path);
            return;
        }
        Files.createDirectories(path.getParent());

        KeyPairGenerator kpg = KeyPairGenerator.getInstance("RSA");
        kpg.initialize(2048);
        KeyPair kp = kpg.generateKeyPair();

        X500Name dn = new X500Name("CN=localhost");
        long now = System.currentTimeMillis();
        BigInteger serial = BigInteger.valueOf(now);
        Date notBefore = new Date(now - 24 * 60 * 60 * 1000);
        Date notAfter = new Date(now + 10 * YEAR_MS);

        JcaX509v3CertificateBuilder builder =
                new JcaX509v3CertificateBuilder(dn, serial, notBefore, notAfter, dn, kp.getPublic());
        GeneralNames sans = new GeneralNames(new GeneralName[]{
                new GeneralName(GeneralName.dNSName, "localhost"),
                new GeneralName(GeneralName.iPAddress, "127.0.0.1"),
        });
        builder.addExtension(Extension.subjectAlternativeName, false, sans);

        ContentSigner signer = new JcaContentSignerBuilder("SHA256WithRSA").build(kp.getPrivate());
        X509Certificate cert = new JcaX509CertificateConverter().getCertificate(builder.build(signer));

        KeyStore ks = KeyStore.getInstance("PKCS12");
        ks.load(null, null);
        ks.setKeyEntry("agent", kp.getPrivate(), password, new Certificate[]{cert});
        try (OutputStream os = Files.newOutputStream(path)) {
            ks.store(os, password);
        }
        LOG.info("Generated self-signed agent TLS keystore: {} (CN=localhost, SAN localhost/127.0.0.1)", path);
    }

    private AgentTls() {}
}
