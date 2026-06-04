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
 * First-run, user-session trust of the agent's localhost cert in the Chromium-family NSS DBs via
 * `certutil`. Linux only, best-effort, idempotent. Covers two DBs:
 * <ul>
 *   <li><b>~/.pki/nssdb</b> - read by Chrome/Chromium installed as a .deb. The agent creates it if
 *       needed and gates the work with a marker file so it runs once.</li>
 *   <li><b>~/snap/chromium/current/.local/share/pki/nssdb</b> - the snap Chromium DB. The snap runs
 *       with a confined HOME, so it never sees ~/.pki; its DB lives under the snap's data dir. The
 *       snap owns it, so we never initialize it: we add the cert only when the DB already exists,
 *       idempotently, on every startup (so a snap installed after the agent's first login is still
 *       covered).</li>
 * </ul>
 * The system trust store (update-ca-certificates) is set by the .deb postinst. Firefox (per-profile
 * cert9.db) remains out of scope.
 */
public final class LinuxNssTrust {

    private static final Logger LOG = LoggerFactory.getLogger(LinuxNssTrust.class);
    static final String NICKNAME = "EU-DSS Agent localhost";

    public enum Action { NOOP, SKIP_NO_CERTUTIL, TRUST }

    /** What to do for the agent-owned ~/.pki/nssdb (visible for tests). */
    public record Decision(Action action, List<List<String>> commands, String advice) {}

    /**
     * Pure decision for ~/.pki/nssdb: marker present -> NOOP; certutil missing -> SKIP_NO_CERTUTIL
     * (+advice); else TRUST with the certutil argv list(s) to run (init the nssdb first if not yet
     * initialized).
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

    /**
     * Pure decision for an NSS DB the agent does NOT own (e.g. snap Chromium): add the cert only if
     * certutil is available, the DB already exists, and the cert is not already trusted there. Never
     * initializes the DB (the owning app creates it). Returns the certutil argv(s) to run, or empty.
     * Visible for tests.
     */
    static List<List<String>> decideExistingDb(String certutilPath, boolean dbExists,
                                               boolean alreadyTrusted, Path nssdb, Path certFile) {
        if (certutilPath == null || certutilPath.isBlank() || !dbExists || alreadyTrusted) {
            return List.of();
        }
        return List.of(List.of(certutilPath, "-d", "sql:" + nssdb, "-A", "-t", "C,,",
                "-n", NICKNAME, "-i", certFile.toString()));
    }

    /** The snap Chromium confined NSS DB path (current revision via the `current` symlink). */
    static Path snapChromiumNssdb(String userHome) {
        return Path.of(userHome, "snap", "chromium", "current", ".local", "share", "pki", "nssdb");
    }

    /** Best-effort entry point, called once at agent startup on Linux. Never throws. */
    public static void trustOnFirstRun(String userHome, Path keystorePath) {
        try {
            if (userHome == null || userHome.isBlank()) {
                LOG.info("NSS trust skipped: user.home not set");
                return;
            }
            Path certFile = keystorePath.resolveSibling("agent.cer");
            String certutil = which("certutil");
            if (certutil == null || certutil.isBlank()) {
                LOG.info("NSS trust skipped: certutil not found; install libnss3-tools for automatic Chrome/Chromium trust");
                return;
            }
            if (!Files.exists(certFile)) {
                LOG.info("NSS trust skipped: agent cert not found at {}", certFile);
                return;
            }
            trustOwnNssdb(userHome, certFile, certutil);
            trustSnapChromium(userHome, certFile, certutil);
        } catch (Exception e) {
            LOG.warn("NSS trust attempt failed (non-fatal): {}", e.getMessage());
        }
    }

    /** Agent-owned ~/.pki/nssdb: created if needed, gated by a marker so the work runs once. */
    private static void trustOwnNssdb(String userHome, Path certFile, String certutil)
            throws IOException, InterruptedException {
        Path marker = Path.of(userHome, ".eudss-agent", ".nss-trusted");
        Path nssdb = Path.of(userHome, ".pki", "nssdb");
        boolean nssdbInitialized = Files.exists(nssdb.resolve("cert9.db"));
        Decision d = decide(Files.exists(marker), certutil, nssdbInitialized, nssdb, certFile);
        if (d.action() != Action.TRUST) {
            return; // NOOP (already trusted) - SKIP_NO_CERTUTIL cannot happen (certutil checked above)
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

    /**
     * Snap Chromium DB: chromium owns it (confined HOME, never sees ~/.pki). Add the cert
     * idempotently when the DB exists. Not marker-gated: runs every startup so a Chromium snap
     * installed after the agent's first login is still covered on the next login.
     */
    private static void trustSnapChromium(String userHome, Path certFile, String certutil) {
        try {
            Path snapDb = snapChromiumNssdb(userHome);
            boolean dbExists = Files.exists(snapDb.resolve("cert9.db"));
            boolean alreadyTrusted = dbExists && nicknamePresent(certutil, "sql:" + snapDb);
            for (List<String> cmd : decideExistingDb(certutil, dbExists, alreadyTrusted, snapDb, certFile)) {
                int code = run(cmd);
                if (code == 0) LOG.info("Trusted agent cert in snap Chromium NSS DB {}", snapDb);
                else LOG.warn("certutil exited {} adding cert to snap Chromium DB {}", code, snapDb);
            }
        } catch (Exception e) {
            LOG.warn("snap Chromium NSS trust attempt failed (non-fatal): {}", e.getMessage());
        }
    }

    /** True if NICKNAME already exists in the given NSS DB ("certutil -L -n" exits 0 when present). */
    private static boolean nicknamePresent(String certutilPath, String db) {
        try {
            int code = run(List.of(certutilPath, "-L", "-d", db, "-n", NICKNAME));
            return code == 0;
        } catch (IOException | InterruptedException e) {
            if (e instanceof InterruptedException) Thread.currentThread().interrupt();
            return false;
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
