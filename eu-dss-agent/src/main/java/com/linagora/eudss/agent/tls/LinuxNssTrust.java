package com.linagora.eudss.agent.tls;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * First-run, user-session trust of the agent's localhost cert in the Chromium-family NSS DB
 * (~/.pki/nssdb) via `certutil`. Linux only, best-effort, idempotent (gated by a marker file).
 * The system trust store (update-ca-certificates) is set by the .deb postinst; this covers
 * Chrome/Chromium, which ignore the system store. Firefox (per-profile cert9.db) is out of scope.
 */
public final class LinuxNssTrust {

    private static final Logger LOG = LoggerFactory.getLogger(LinuxNssTrust.class);
    static final String NICKNAME = "EU-DSS Agent localhost";

    public enum Action { NOOP, SKIP_NO_CERTUTIL, TRUST }

    /** What to do, computed purely from inputs (visible for tests). */
    public record Decision(Action action, List<List<String>> commands, String advice) {}

    /**
     * Pure decision: marker present -> NOOP; certutil missing -> SKIP_NO_CERTUTIL (+advice);
     * else TRUST with the certutil argv list(s) to run (init the nssdb first if not yet initialized).
     */
    static Decision decide(boolean markerExists, String certutilPath,
                           boolean nssdbInitialized, Path nssdb, Path certFile) {
        if (markerExists) {
            return new Decision(Action.NOOP, List.of(), null);
        }
        if (certutilPath == null || certutilPath.isBlank()) {
            return new Decision(Action.SKIP_NO_CERTUTIL, List.of(),
                    "certutil not found; install libnss3-tools for automatic Chrome/Chromium trust");
        }
        String db = "sql:" + nssdb;
        List<List<String>> commands = new ArrayList<>();
        if (!nssdbInitialized) {
            commands.add(List.of(certutilPath, "-d", db, "-N", "--empty-password"));
        }
        commands.add(List.of(certutilPath, "-d", db, "-A", "-t", "C,,",
                "-n", NICKNAME, "-i", certFile.toString()));
        return new Decision(Action.TRUST, commands, null);
    }

    /** Best-effort entry point, called once at agent startup on Linux. Never throws. */
    public static void trustOnFirstRun(String userHome, Path keystorePath) {
        try {
            if (userHome == null || userHome.isBlank()) {
                LOG.info("NSS trust skipped: user.home not set");
                return;
            }
            Path marker = Path.of(userHome, ".eudss-agent", ".nss-trusted");
            Path nssdb = Path.of(userHome, ".pki", "nssdb");
            Path certFile = keystorePath.resolveSibling("agent.cer");
            String certutil = which("certutil");
            boolean nssdbInitialized = Files.exists(nssdb.resolve("cert9.db"));
            Decision d = decide(Files.exists(marker), certutil, nssdbInitialized, nssdb, certFile);
            switch (d.action()) {
                case NOOP -> { /* already trusted on a previous run */ }
                case SKIP_NO_CERTUTIL -> LOG.info("NSS trust skipped: {}", d.advice());
                case TRUST -> {
                    if (!Files.exists(certFile)) {
                        LOG.info("NSS trust skipped: agent cert not found at {}", certFile);
                        return;
                    }
                    Files.createDirectories(nssdb);
                    for (List<String> cmd : d.commands()) {
                        int code = run(cmd);
                        if (code != 0) {
                            LOG.warn("certutil exited {} for {}; will retry next run", code, cmd);
                            return; // do not write the marker so the next run retries
                        }
                    }
                    Files.createDirectories(marker.getParent());
                    Files.writeString(marker, "trusted\n");
                    LOG.info("Trusted agent cert in {} for Chrome/Chromium", nssdb);
                }
            }
        } catch (Exception e) {
            LOG.warn("NSS trust attempt failed (non-fatal): {}", e.getMessage());
        }
    }

    private static String which(String tool) {
        try {
            Process p = new ProcessBuilder("which", tool).redirectErrorStream(true).start();
            if (!p.waitFor(5, TimeUnit.SECONDS)) {
                p.destroyForcibly();
                return null;
            }
            String out = new String(p.getInputStream().readAllBytes()).trim();
            return (p.exitValue() == 0 && !out.isBlank()) ? out.lines().findFirst().orElse(null) : null;
        } catch (IOException e) {
            return null;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return null;
        }
    }

    private static int run(List<String> cmd) throws IOException, InterruptedException {
        Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
        if (!p.waitFor(10, TimeUnit.SECONDS)) {
            p.destroyForcibly();
            throw new IOException("certutil timed out: " + cmd);
        }
        p.getInputStream().readAllBytes(); // drain buffered output
        return p.exitValue();
    }

    private LinuxNssTrust() {}
}
