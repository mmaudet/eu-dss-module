package com.linagora.eudss.agent;

import com.linagora.eudss.agent.tls.AgentTls;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;

import static org.assertj.core.api.Assertions.assertThat;

class AgentTlsTest {

    @Test
    void generates_then_reloads_a_self_signed_localhost_keystore() throws Exception {
        Path ks = Files.createTempDirectory("eudss-tls").resolve("agent-keystore.p12");
        char[] pwd = "test-pass".toCharArray();

        AgentTls.ensureKeystore(ks, pwd);
        assertThat(Files.exists(ks)).isTrue();

        KeyStore store = KeyStore.getInstance("PKCS12");
        try (var in = Files.newInputStream(ks)) {
            store.load(in, pwd);
        }
        assertThat(store.containsAlias("agent")).isTrue();
        var cert = (java.security.cert.X509Certificate) store.getCertificate("agent");
        assertThat(cert.getSubjectX500Principal().getName()).contains("CN=localhost");

        AgentTls.ensureKeystore(ks, pwd); // reuse, must not throw
        assertThat(Files.exists(ks)).isTrue();
    }

    @org.junit.jupiter.api.Test
    void keystorePath_is_machinewide_on_windows_else_home() {
        assertThat(com.linagora.eudss.agent.tls.AgentTls.defaultKeystorePath(
                "Windows 11", "C:\\Users\\u", "C:\\ProgramData", null).toString())
            .isEqualTo("C:\\ProgramData\\eudss-agent\\agent-keystore.p12");
        assertThat(com.linagora.eudss.agent.tls.AgentTls.defaultKeystorePath(
                "Mac OS X", "/Users/u", "/ignored", null).toString())
            .isEqualTo("/Users/u/.eudss-agent/agent-keystore.p12");
        // explicit override wins on any OS
        assertThat(com.linagora.eudss.agent.tls.AgentTls.defaultKeystorePath(
                "Windows 11", "C:\\Users\\u", "C:\\ProgramData", "D:\\custom\\ks.p12").toString())
            .isEqualTo("D:\\custom\\ks.p12");
    }

    @org.junit.jupiter.api.Test
    void keystorePath_is_machinewide_on_linux() {
        assertThat(com.linagora.eudss.agent.tls.AgentTls.defaultKeystorePath(
                "Linux", "/home/u", "/ignored", null).toString())
            .isEqualTo("/var/lib/eudss-agent/agent-keystore.p12");
        // override still wins on Linux
        assertThat(com.linagora.eudss.agent.tls.AgentTls.defaultKeystorePath(
                "Linux", "/home/u", "/ignored", "/tmp/ks.p12").toString())
            .isEqualTo("/tmp/ks.p12");
        // macOS stays on the user home (no "nux" / "win" substring)
        assertThat(com.linagora.eudss.agent.tls.AgentTls.defaultKeystorePath(
                "Mac OS X", "/Users/u", "/ignored", null).toString())
            .isEqualTo("/Users/u/.eudss-agent/agent-keystore.p12");
    }

    @org.junit.jupiter.api.Test
    void exportCertificate_writes_a_localhost_der_cert() throws Exception {
        java.nio.file.Path dir = java.nio.file.Files.createTempDirectory("eudss-tls-export");
        java.nio.file.Path ks = dir.resolve("agent-keystore.p12");
        char[] pw = "eudss-agent".toCharArray();
        com.linagora.eudss.agent.tls.AgentTls.ensureKeystore(ks, pw);
        java.nio.file.Path cer = dir.resolve("agent.cer");
        com.linagora.eudss.agent.tls.AgentTls.exportCertificate(ks, pw, cer);
        assertThat(java.nio.file.Files.exists(cer)).isTrue();
        java.security.cert.X509Certificate c = (java.security.cert.X509Certificate)
            java.security.cert.CertificateFactory.getInstance("X.509")
                .generateCertificate(java.nio.file.Files.newInputStream(cer));
        assertThat(c.getSubjectX500Principal().getName()).contains("CN=localhost");
    }
}
