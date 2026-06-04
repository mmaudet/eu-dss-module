package com.linagora.eudss.agent.tls;

import org.junit.jupiter.api.Test;

import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

class LinuxNssTrustTest {

    private static final Path NSSDB = Path.of("/home/u/.pki/nssdb");
    private static final Path CERT = Path.of("/var/lib/eudss-agent/agent.cer");
    private static final Path SNAPDB =
            Path.of("/home/u/snap/chromium/current/.local/share/pki/nssdb");

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

    // --- Snap Chromium NSS DB (a DB the agent does NOT own: never init, add idempotently) ---

    @Test
    void snap_chromium_nssdb_path_is_the_confined_xdg_path() {
        assertThat(LinuxNssTrust.snapChromiumNssdb("/home/u")).isEqualTo(SNAPDB);
    }

    @Test
    void existing_db_absent_is_noop() {
        assertThat(LinuxNssTrust.decideExistingDb("/usr/bin/certutil", false, false, SNAPDB, CERT))
                .isEmpty();
    }

    @Test
    void existing_db_already_trusted_is_noop() {
        assertThat(LinuxNssTrust.decideExistingDb("/usr/bin/certutil", true, true, SNAPDB, CERT))
                .isEmpty();
    }

    @Test
    void existing_db_without_certutil_is_noop() {
        assertThat(LinuxNssTrust.decideExistingDb(null, true, false, SNAPDB, CERT)).isEmpty();
    }

    @Test
    void existing_db_present_and_untrusted_adds_cert_without_init() {
        var cmds = LinuxNssTrust.decideExistingDb("/usr/bin/certutil", true, false, SNAPDB, CERT);
        assertThat(cmds).hasSize(1);
        assertThat(cmds.get(0)).containsExactly(
                "/usr/bin/certutil", "-d",
                "sql:/home/u/snap/chromium/current/.local/share/pki/nssdb",
                "-A", "-t", "C,,", "-n", "EU-DSS Agent localhost",
                "-i", "/var/lib/eudss-agent/agent.cer");
    }
}
