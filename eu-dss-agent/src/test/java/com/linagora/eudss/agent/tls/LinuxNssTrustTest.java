package com.linagora.eudss.agent.tls;

import org.junit.jupiter.api.Test;

import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

class LinuxNssTrustTest {

    private static final Path NSSDB = Path.of("/home/u/.pki/nssdb");
    private static final Path CERT = Path.of("/var/lib/eudss-agent/agent.cer");

    @Test
    void marker_present_is_noop() {
        var d = LinuxNssTrust.decide(true, "/usr/bin/certutil", true, NSSDB, CERT);
        assertThat(d.action()).isEqualTo(LinuxNssTrust.Action.NOOP);
        assertThat(d.commands()).isEmpty();
    }

    @Test
    void certutil_missing_skips_with_advice() {
        var d = LinuxNssTrust.decide(false, null, false, NSSDB, CERT);
        assertThat(d.action()).isEqualTo(LinuxNssTrust.Action.SKIP_NO_CERTUTIL);
        assertThat(d.commands()).isEmpty();
        assertThat(d.advice()).contains("libnss3-tools");
    }

    @Test
    void uninitialized_db_inits_then_adds_cert() {
        var d = LinuxNssTrust.decide(false, "/usr/bin/certutil", false, NSSDB, CERT);
        assertThat(d.action()).isEqualTo(LinuxNssTrust.Action.TRUST);
        assertThat(d.commands()).hasSize(2);
        assertThat(d.commands().get(0)).containsExactly(
                "/usr/bin/certutil", "-d", "sql:/home/u/.pki/nssdb", "-N", "--empty-password");
        assertThat(d.commands().get(1)).containsExactly(
                "/usr/bin/certutil", "-d", "sql:/home/u/.pki/nssdb", "-A", "-t", "C,,",
                "-n", "EU-DSS Agent localhost", "-i", "/var/lib/eudss-agent/agent.cer");
    }

    @Test
    void initialized_db_only_adds_cert() {
        var d = LinuxNssTrust.decide(false, "/usr/bin/certutil", true, NSSDB, CERT);
        assertThat(d.action()).isEqualTo(LinuxNssTrust.Action.TRUST);
        assertThat(d.commands()).hasSize(1);
        assertThat(d.commands().get(0)).containsExactly(
                "/usr/bin/certutil", "-d", "sql:/home/u/.pki/nssdb", "-A", "-t", "C,,",
                "-n", "EU-DSS Agent localhost", "-i", "/var/lib/eudss-agent/agent.cer");
    }
}
