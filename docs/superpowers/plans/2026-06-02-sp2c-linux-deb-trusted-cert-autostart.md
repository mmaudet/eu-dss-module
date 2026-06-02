# SP2c-core Linux/Ubuntu trusted-cert + auto-start Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an amd64 Debian package of the eu-dss agent that, on install, trusts its localhost certificate (system store + first-run Chromium trust) and auto-starts in the user GUI session, mirroring SP2 (Windows MSI) and SP2b (macOS pkg) on Linux.

**Architecture:** Three small Java changes in `eu-dss-agent` (fix the Linux PKCS#11 driver path, add a Linux machine-wide keystore branch, add a best-effort first-run NSS trust helper for Chromium), plus a new `packaging/linux/` tree (hand-assembled `.deb` via `jpackage --type app-image` then `dpkg-deb`, with `postinst`/`prerm`/`postrm` maintainer scripts and an XDG autostart entry), plus a CI workflow building the amd64 `.deb` on `ubuntu-latest`. Two-layer trust: `postinst` (root) drops the cert in the system store for curl/Java; the agent on first user-session run runs `certutil` into `~/.pki/nssdb` for Chrome/Chromium. Firefox, `.rpm`, arm64, and real-signing verification are out of scope (follow-ups).

**Tech Stack:** Java 21, Maven, JUnit 5 + AssertJ, jpackage (JDK 21), `dpkg-deb`/`fakeroot`, GitHub Actions (`ubuntu-latest`). Spec: `docs/superpowers/specs/2026-06-02-sp2c-linux-deb-trusted-cert-autostart-design.md`.

**Working branch:** Continue on `eu-dss` (the repo's default/live branch, as with every prior SP increment). No worktree, no PR; the finish step is a push.

**Convention:** No em-dash characters anywhere (docs or comments), per the project style. New Java/shell comments stay ASCII (use `->`, `:`, parentheses).

---

## File Structure

**Modified (Java + test + shell):**
- `eu-dss-agent/src/main/java/com/linagora/eudss/agent/config/AgentConfig.java` : fix `DEFAULT_DRIVER_LINUX`.
- `eu-dss-agent/src/test/java/com/linagora/eudss/agent/config/AgentConfigDefaultsTest.java` : update Linux driver assertion.
- `eu-dss-agent/src/main/java/com/linagora/eudss/agent/tls/AgentTls.java` : add Linux keystore branch.
- `eu-dss-agent/src/test/java/com/linagora/eudss/agent/AgentTlsTest.java` : add Linux keystore-path test.
- `eu-dss-agent/src/main/java/com/linagora/eudss/agent/AgentMain.java` : wire first-run NSS trust on Linux.
- `bin/eu-dss-agent-linux.sh` : fix the default driver path.

**Created (Java + test):**
- `eu-dss-agent/src/main/java/com/linagora/eudss/agent/tls/LinuxNssTrust.java` : pure decision + best-effort `certutil` runner.
- `eu-dss-agent/src/test/java/com/linagora/eudss/agent/tls/LinuxNssTrustTest.java` : tests for the pure decision.

**Created (packaging):**
- `packaging/linux/deb/DEBIAN/control` : package metadata template (`@VERSION@`, `@ARCH@`).
- `packaging/linux/deb/DEBIAN/postinst` : provision cert + system-store trust.
- `packaging/linux/deb/DEBIAN/prerm` : best-effort agent stop.
- `packaging/linux/deb/DEBIAN/postrm` : remove system cert + state on remove/purge.
- `packaging/linux/deb/etc/xdg/autostart/eu-dss-agent.desktop` : user-session autostart.
- `packaging/linux/build-agent-deb.sh` : jpackage app-image + assemble + `dpkg-deb --build`.

**Created (CI):**
- `.github/workflows/linux-installer.yml` : build amd64 `.deb` on `ubuntu-latest`.

---

## Task 1: Fix the Linux default PKCS#11 driver path

The repo hard-codes `/usr/lib/libidop11.so`, but the real IDOPTE Linux path is `/usr/lib/SCMiddleware/libidop11.so` (confirmed in the middleware research). Fix the constant, its test, and the dev launch script.

**Files:**
- Modify: `eu-dss-agent/src/test/java/com/linagora/eudss/agent/config/AgentConfigDefaultsTest.java:44`
- Modify: `eu-dss-agent/src/main/java/com/linagora/eudss/agent/config/AgentConfig.java:18`
- Modify: `bin/eu-dss-agent-linux.sh:13`

- [ ] **Step 1: Update the failing assertion in the test**

In `AgentConfigDefaultsTest.java`, change the Linux line of `default_driver_is_os_specific` (line 44):

```java
        assertThat(AgentConfig.defaultDriver("Linux")).isEqualTo("/usr/lib/SCMiddleware/libidop11.so");
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `mvn -q -pl eu-dss-agent test -Dtest=AgentConfigDefaultsTest`
Expected: FAIL on `default_driver_is_os_specific` (expected `/usr/lib/SCMiddleware/libidop11.so` but was `/usr/lib/libidop11.so`).

- [ ] **Step 3: Fix the constant**

In `AgentConfig.java`, change line 18:

```java
    private static final String DEFAULT_DRIVER_LINUX = "/usr/lib/SCMiddleware/libidop11.so";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `mvn -q -pl eu-dss-agent test -Dtest=AgentConfigDefaultsTest`
Expected: PASS (all 4 tests green).

- [ ] **Step 5: Fix the dev launch script**

In `bin/eu-dss-agent-linux.sh`, change line 13:

```bash
: "${EUDSS_PKCS11_DRIVER:=/usr/lib/SCMiddleware/libidop11.so}"
```

- [ ] **Step 6: Commit**

```bash
git add eu-dss-agent/src/main/java/com/linagora/eudss/agent/config/AgentConfig.java \
        eu-dss-agent/src/test/java/com/linagora/eudss/agent/config/AgentConfigDefaultsTest.java \
        bin/eu-dss-agent-linux.sh
git commit -m "fix(agent): correct Linux PKCS#11 driver path to /usr/lib/SCMiddleware/libidop11.so

The real IDOPTE/ChamberSign Linux middleware installs at
/usr/lib/SCMiddleware/libidop11.so, not /usr/lib/libidop11.so.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Linux machine-wide keystore path branch in AgentTls

On Linux the `.deb` postinst (root) and the user-launched agent must share one keystore, so add a Linux branch returning `/var/lib/eudss-agent/agent-keystore.p12` (parallel to Windows ProgramData and macOS `/Library/Application Support`). The `EUDSS_AGENT_KEYSTORE` override still wins; macOS/Windows stay unchanged.

**Files:**
- Modify: `eu-dss-agent/src/test/java/com/linagora/eudss/agent/AgentTlsTest.java`
- Modify: `eu-dss-agent/src/main/java/com/linagora/eudss/agent/tls/AgentTls.java:42-52`

- [ ] **Step 1: Write the failing test**

In `AgentTlsTest.java`, add this test method after `keystorePath_is_machinewide_on_windows_else_home` (after line 46):

```java
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `mvn -q -pl eu-dss-agent test -Dtest=AgentTlsTest`
Expected: FAIL on `keystorePath_is_machinewide_on_linux` (expected `/var/lib/eudss-agent/agent-keystore.p12` but was `/home/u/.eudss-agent/agent-keystore.p12`).

- [ ] **Step 3: Add the Linux branch**

In `AgentTls.java`, replace the `defaultKeystorePath(String, String, String, String)` method body (lines 42-52) with:

```java
    public static Path defaultKeystorePath(String osName, String userHome, String programData, String envKeystore) {
        if (envKeystore != null && !envKeystore.isBlank()) {
            return Path.of(envKeystore);
        }
        String os = osName.toLowerCase();
        if (os.contains("win")) {
            // Literal '\' via string-concat (NOT Path.of varargs): produces a correct Windows path
            // even when resolved on a non-Windows JVM (CI/tests run on macOS/Linux).
            return Path.of(programData + "\\eudss-agent\\agent-keystore.p12");
        }
        if (os.contains("nux")) {
            // Machine-wide on Linux so the .deb postinst (root) and the user-launched agent share
            // one keystore; parallels Windows ProgramData and macOS /Library/Application Support.
            return Path.of("/var/lib/eudss-agent/agent-keystore.p12");
        }
        return Path.of(userHome, ".eudss-agent", "agent-keystore.p12");
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `mvn -q -pl eu-dss-agent test -Dtest=AgentTlsTest`
Expected: PASS (all tests green, including the unchanged Windows/macOS/override cases).

- [ ] **Step 5: Commit**

```bash
git add eu-dss-agent/src/main/java/com/linagora/eudss/agent/tls/AgentTls.java \
        eu-dss-agent/src/test/java/com/linagora/eudss/agent/AgentTlsTest.java
git commit -m "feat(agent): machine-wide keystore at /var/lib/eudss-agent on Linux

So the .deb postinst (root) and the user-launched agent share one
keystore. EUDSS_AGENT_KEYSTORE override and macOS/Windows paths unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: First-run Chromium NSS trust (LinuxNssTrust) + AgentMain wiring

The system store (set by the `.deb` postinst) is ignored by browsers. Chrome/Chromium read a per-user NSS DB at `~/.pki/nssdb`. Add a best-effort, idempotent helper that, on the agent's first user-session run, trusts the localhost cert there via `certutil`. The decision logic is pure and unit-tested; the `certutil` execution is best-effort and never blocks startup.

**Files:**
- Create: `eu-dss-agent/src/test/java/com/linagora/eudss/agent/tls/LinuxNssTrustTest.java`
- Create: `eu-dss-agent/src/main/java/com/linagora/eudss/agent/tls/LinuxNssTrust.java`
- Modify: `eu-dss-agent/src/main/java/com/linagora/eudss/agent/AgentMain.java` (after the `app.start()` block in `main`)

- [ ] **Step 1: Write the failing test**

Create `eu-dss-agent/src/test/java/com/linagora/eudss/agent/tls/LinuxNssTrustTest.java`:

```java
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `mvn -q -pl eu-dss-agent test -Dtest=LinuxNssTrustTest`
Expected: FAIL to compile (`cannot find symbol: class LinuxNssTrust`).

- [ ] **Step 3: Create the LinuxNssTrust class**

Create `eu-dss-agent/src/main/java/com/linagora/eudss/agent/tls/LinuxNssTrust.java`:

```java
package com.linagora.eudss.agent.tls;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

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
            String out = new String(p.getInputStream().readAllBytes()).trim();
            return (p.waitFor() == 0 && !out.isBlank()) ? out.lines().findFirst().orElse(null) : null;
        } catch (IOException e) {
            return null;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return null;
        }
    }

    private static int run(List<String> cmd) throws IOException, InterruptedException {
        Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
        p.getInputStream().readAllBytes(); // drain so the process never blocks on a full pipe
        return p.waitFor();
    }

    private LinuxNssTrust() {}
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `mvn -q -pl eu-dss-agent test -Dtest=LinuxNssTrustTest`
Expected: PASS (4 tests green).

- [ ] **Step 5: Wire the helper into AgentMain**

In `AgentMain.java`, inside `main(...)`, immediately after the `if (config.tlsEnabled()) { ... } else { ... }` block that starts the server (after line 63, before the closing `}` of `main`), add:

```java

        // Linux desktop: on first run, trust our localhost cert in ~/.pki/nssdb so Chrome/Chromium
        // accept it without a warning (the system store, set by the .deb, is ignored by browsers).
        // Best-effort and never blocks startup; skipped in headless mode (no user browser there).
        String osName = System.getProperty("os.name", "").toLowerCase();
        if (osName.contains("nux") && !config.headless()) {
            com.linagora.eudss.agent.tls.LinuxNssTrust.trustOnFirstRun(
                    System.getProperty("user.home", ""),
                    com.linagora.eudss.agent.tls.AgentTls.defaultKeystorePath());
        }
```

- [ ] **Step 6: Compile and run the full agent test suite to confirm no regression**

Run: `mvn -q -pl eu-dss-agent test`
Expected: PASS (all agent tests green: config, TLS, NSS, HTTP smoke, token session).

- [ ] **Step 7: Commit**

```bash
git add eu-dss-agent/src/main/java/com/linagora/eudss/agent/tls/LinuxNssTrust.java \
        eu-dss-agent/src/test/java/com/linagora/eudss/agent/tls/LinuxNssTrustTest.java \
        eu-dss-agent/src/main/java/com/linagora/eudss/agent/AgentMain.java
git commit -m "feat(agent): first-run Chromium NSS trust on Linux (certutil into ~/.pki/nssdb)

Browsers ignore the system trust store on Linux. On the first user-session
run, the agent trusts its localhost cert in the per-user NSS DB via certutil
(idempotent, gated by a marker, best-effort, never blocks startup). Pure
decision logic is unit-tested; Firefox is out of scope.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Debian maintainer scripts + XDG autostart entry

Static, version-controlled files under `packaging/linux/deb/` (the analogue of the committed WiX/pkg scripts). The build script (Task 5) copies these into the package root.

**Files:**
- Create: `packaging/linux/deb/DEBIAN/control`
- Create: `packaging/linux/deb/DEBIAN/postinst`
- Create: `packaging/linux/deb/DEBIAN/prerm`
- Create: `packaging/linux/deb/DEBIAN/postrm`
- Create: `packaging/linux/deb/etc/xdg/autostart/eu-dss-agent.desktop`

- [ ] **Step 1: Create the control template**

Create `packaging/linux/deb/DEBIAN/control` (the build script substitutes `@VERSION@` and `@ARCH@`):

```
Package: eu-dss-agent
Version: @VERSION@
Architecture: @ARCH@
Maintainer: LINAGORA <contact@linagora.com>
Depends: pcscd, libccid, libnss3-tools, ca-certificates
Section: utils
Priority: optional
Description: EU-DSS Agent (local PKCS#11 signing bridge)
 Local HTTPS agent that bridges a PKCS#11 smart-card token to the EU-DSS
 signing web application. On install it trusts its self-signed localhost
 certificate and starts automatically in the user GUI session.
```

- [ ] **Step 2: Create the postinst script**

Create `packaging/linux/deb/DEBIAN/postinst`:

```sh
#!/bin/sh
# Runs as root after files are unpacked. Provisions the localhost keystore + cert at the
# machine-wide path and trusts the cert in the system store (curl/Java/diagnostics). Browsers
# are handled per-user at the agent's first run. Idempotent / re-install safe.
set -e

DATA=/var/lib/eudss-agent
LAUNCHER=/opt/eu-dss-agent/bin/eu-dss-agent
CERT="$DATA/agent.cer"
SYSCERT=/usr/local/share/ca-certificates/eudss-agent.crt

mkdir -p "$DATA"

# 1. Generate the keystore + export agent.cer at the machine-wide path.
EUDSS_AGENT_KEYSTORE="$DATA/agent-keystore.p12" "$LAUNCHER" --provision-cert
[ -f "$CERT" ] || { echo "postinst: --provision-cert did not produce $CERT" >&2; exit 1; }
chmod 644 "$DATA/agent-keystore.p12" "$CERT"

# 2. Trust in the system store (read by curl/wget/openssl/Java, NOT by browsers).
install -m 644 "$CERT" "$SYSCERT"
update-ca-certificates

exit 0
```

- [ ] **Step 3: Create the prerm script**

Create `packaging/linux/deb/DEBIAN/prerm`:

```sh
#!/bin/sh
# Runs as root before files are removed (on remove and upgrade). Best-effort stop of any
# running agent; XDG autostart relaunches it at the next GUI login.
set -e
pkill -f '/opt/eu-dss-agent/bin/eu-dss-agent' 2>/dev/null || true
exit 0
```

- [ ] **Step 4: Create the postrm script**

Create `packaging/linux/deb/DEBIAN/postrm`:

```sh
#!/bin/sh
# Runs as root after files are removed. On remove/purge: drop the system-store cert and the
# machine-wide state. The per-user ~/.pki/nssdb cert + ~/.eudss-agent/.nss-trusted marker are
# NOT removed here (a root postrm cannot reliably reach every user home); harmless localhost cert.
set -e
SYSCERT=/usr/local/share/ca-certificates/eudss-agent.crt
case "$1" in
  remove|purge)
    rm -f "$SYSCERT"
    update-ca-certificates --fresh >/dev/null 2>&1 || true
    rm -rf /var/lib/eudss-agent
    ;;
esac
exit 0
```

- [ ] **Step 5: Create the XDG autostart entry**

Create `packaging/linux/deb/etc/xdg/autostart/eu-dss-agent.desktop`:

```desktop
[Desktop Entry]
Type=Application
Name=EU-DSS Agent
Exec=/opt/eu-dss-agent/bin/eu-dss-agent
X-GNOME-Autostart-enabled=true
NoDisplay=true
```

- [ ] **Step 6: Make the maintainer scripts executable and syntax-check them**

```bash
chmod +x packaging/linux/deb/DEBIAN/postinst \
         packaging/linux/deb/DEBIAN/prerm \
         packaging/linux/deb/DEBIAN/postrm
for f in postinst prerm postrm; do sh -n "packaging/linux/deb/DEBIAN/$f" && echo "OK $f"; done
```

Expected: `OK postinst`, `OK prerm`, `OK postrm` (no syntax errors). Functional execution happens in CI (Task 6) and on the VM (Task 7); these scripts cannot run on macOS.

- [ ] **Step 7: Commit**

```bash
git add packaging/linux/deb
git commit -m "feat(packaging): Debian maintainer scripts + XDG autostart for the Linux agent

control (deps pcscd/libccid/libnss3-tools/ca-certificates), postinst
(provision + system-store trust), prerm (best-effort stop), postrm
(remove system cert + state), and the user-session autostart .desktop.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: build-agent-deb.sh (jpackage app-image + dpkg-deb)

The build script: jpackage produces a bundled-JRE app-image, then we hand-assemble the `.deb` (jpackage `--type deb` cannot inject maintainer scripts). Mirrors `packaging/macos/build-agent-pkg.sh`. Architecture is detected (`amd64` on `ubuntu-latest`, `arm64` on the test VM).

**Files:**
- Create: `packaging/linux/build-agent-deb.sh`

- [ ] **Step 1: Create the build script**

Create `packaging/linux/build-agent-deb.sh`:

```bash
#!/usr/bin/env bash
# Build the EU-DSS Agent Debian package: jpackage app-image (bundled JRE) -> hand-assembled .deb.
# Run on Linux with JDK 21 + dpkg-deb. Output: dist/eu-dss-agent_<version>_<arch>.deb (unsigned).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VERSION="0.1.0"
# jpackage requires the app-image version first component to be >= 1 (same as the macOS pkg);
# the user-facing .deb Version is the real 0.1.0 set in DEBIAN/control.
APP_VERSION="1.0.0"
ARCH="$(dpkg --print-architecture)"   # amd64 on ubuntu-latest; arm64 on the ARM test VM
JAR_DIR="$ROOT/eu-dss-agent/target"
JAR="eu-dss-agent-${VERSION}-SNAPSHOT.jar"
if [ ! -f "$JAR_DIR/$JAR" ]; then
  echo "Build the agent jar first:  mvn -pl eu-dss-agent -am -DskipTests package" >&2
  exit 1
fi

JPACKAGE="${JAVA_HOME:+$JAVA_HOME/bin/}jpackage"
"$JPACKAGE" --version >/dev/null || { echo "jpackage not found (need JDK 21)" >&2; exit 1; }

# 1. Build the app-image (bundled JRE + launcher bin/eu-dss-agent).
STAGING="$(mktemp -d)/input"; mkdir -p "$STAGING"
cp "$JAR_DIR/$JAR" "$STAGING/"
APPDIR="$ROOT/build/linux-appimage"
rm -rf "$APPDIR"; mkdir -p "$APPDIR"
"$JPACKAGE" --type app-image \
  --name eu-dss-agent \
  --app-version "$APP_VERSION" \
  --vendor "LINAGORA" \
  --input "$STAGING" \
  --main-jar "$JAR" \
  --main-class com.linagora.eudss.agent.AgentMain \
  --dest "$APPDIR"

# 2. Assemble the .deb tree.
PKGROOT="$(mktemp -d)/pkgroot"
mkdir -p "$PKGROOT/opt/eu-dss-agent" "$PKGROOT/etc/xdg/autostart"
cp -a "$APPDIR/eu-dss-agent/." "$PKGROOT/opt/eu-dss-agent/"
cp -a "$ROOT/packaging/linux/deb/DEBIAN" "$PKGROOT/"
cp -a "$ROOT/packaging/linux/deb/etc/xdg/autostart/eu-dss-agent.desktop" \
      "$PKGROOT/etc/xdg/autostart/"

# 3. Fill in control (version + arch) and enforce maintainer-script perms.
sed -e "s/@VERSION@/$VERSION/" -e "s/@ARCH@/$ARCH/" \
  "$ROOT/packaging/linux/deb/DEBIAN/control" > "$PKGROOT/DEBIAN/control"
chmod 755 "$PKGROOT/DEBIAN/postinst" "$PKGROOT/DEBIAN/prerm" "$PKGROOT/DEBIAN/postrm"

# 4. Build the package.
OUT="$ROOT/dist"; mkdir -p "$OUT"
DEB="$OUT/eu-dss-agent_${VERSION}_${ARCH}.deb"
dpkg-deb --build --root-owner-group "$PKGROOT" "$DEB"
echo "DEB written to $DEB"
```

- [ ] **Step 2: Make it executable and syntax-check**

```bash
chmod +x packaging/linux/build-agent-deb.sh
bash -n packaging/linux/build-agent-deb.sh && echo "OK build-agent-deb.sh"
```

Expected: `OK build-agent-deb.sh`. (A full run needs Linux + `dpkg-deb` + jpackage; it executes in CI in Task 6 and on the VM in Task 7, not on macOS.)

- [ ] **Step 3: Commit**

```bash
git add packaging/linux/build-agent-deb.sh
git commit -m "feat(packaging): build-agent-deb.sh (jpackage app-image + dpkg-deb)

Builds a bundled-JRE app-image, hand-assembles the .deb tree (opt/, etc/xdg
autostart, DEBIAN maintainer scripts), substitutes version/arch into control,
and runs dpkg-deb --build. Arch auto-detected (amd64 in CI, arm64 on the VM).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: CI workflow (linux-installer.yml)

Build the amd64 `.deb` on `ubuntu-latest` and upload it as an artifact. Mirrors `macos-installer.yml`. (arm64 is a follow-up: needs an arm64 runner + middleware.)

**Files:**
- Create: `.github/workflows/linux-installer.yml`

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/linux-installer.yml`:

```yaml
name: Linux installer (deb)

on:
  workflow_dispatch:
  push:
    tags: ['v*']

jobs:
  build-deb:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '21'
      - name: Install packaging tools
        run: sudo apt-get update && sudo apt-get install -y fakeroot dpkg-dev binutils
      - name: Build agent jar
        run: mvn -B -f pom.xml -pl eu-dss-agent -am -DskipTests package
      - name: Build .deb (jpackage + dpkg-deb)
        run: ./packaging/linux/build-agent-deb.sh
      - name: Upload deb
        uses: actions/upload-artifact@v4
        with:
          name: eu-dss-agent-deb
          path: dist/*.deb
          if-no-files-found: error
```

- [ ] **Step 2: Validate the YAML syntax**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/linux-installer.yml')); print('OK yaml')"`
Expected: `OK yaml`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/linux-installer.yml
git commit -m "ci(agent): build amd64 .deb on ubuntu-latest (linux-installer.yml)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Trigger the workflow and confirm a green build + a .deb artifact**

After pushing (end of the run), trigger and watch:

```bash
gh workflow run "Linux installer (deb)" --ref eu-dss
sleep 5
gh run list --workflow "Linux installer (deb)" --limit 1
```

Then poll the latest run to completion (`gh run watch <id>` or `gh run view <id>`). Expected: status `completed` / conclusion `success`, with an `eu-dss-agent-deb` artifact containing `eu-dss-agent_0.1.0_amd64.deb`. This is the CI acceptance check (acceptance criterion 1); the controller verifies it, not a subagent.

---

## Task 7: Mechanism verification on the Ubuntu 24.04 ARM VM (controller-executed)

> **Not a subagent task.** Requires Parallels/`prlctl` access to the host. The controller (main session) runs this directly after Tasks 1-6 are committed and pushed. Real signing is NOT tested here (no arm64 middleware); it is a documented follow-up on amd64.

VM: `Ubuntu 24.04 ARM64` Parallels VM `{3fd9b840-92a2-4747-a539-8ae48ea77993}` (currently stopped). Drive headlessly like the Windows VM but with bash: `prlctl exec {uuid} bash -lc '...'` (or `prlctl exec {uuid} -- bash /path/to/script.sh` with an ASCII script on the shared `\\Mac\Home` path, per the `-File`-not-inline lesson from Windows).

- [ ] **Step 1: Start the VM and confirm the toolchain**

```bash
prlctl start "{3fd9b840-92a2-4747-a539-8ae48ea77993}"
# wait for boot, then:
prlctl exec "{3fd9b840-92a2-4747-a539-8ae48ea77993}" bash -lc 'java -version; dpkg --print-architecture; which jpackage dpkg-deb || true'
```

Expected: JDK 21 present (install Temurin 21 if missing), `arm64`, and `dpkg-deb` available. Install `fakeroot dpkg-dev binutils` and a JDK 21 if absent.

- [ ] **Step 2: Build the arm64 .deb on the VM**

From the repo on the VM (or the shared path), run the agent build + packaging:

```bash
prlctl exec "{3fd9b840-92a2-4747-a539-8ae48ea77993}" bash -lc \
  'cd <repo> && mvn -B -pl eu-dss-agent -am -DskipTests package && ./packaging/linux/build-agent-deb.sh'
```

Expected: `dist/eu-dss-agent_0.1.0_arm64.deb` produced.

- [ ] **Step 3: Install and verify the mechanism**

```bash
sudo apt install -y ./dist/eu-dss-agent_0.1.0_arm64.deb
```

Verify each acceptance point:
- System-store trust: `ls -l /usr/local/share/ca-certificates/eudss-agent.crt` present; the cert appears under `/etc/ssl/certs` after `update-ca-certificates`.
- Keystore + cert: `/var/lib/eudss-agent/agent-keystore.p12` and `/var/lib/eudss-agent/agent.cer` present (mode 644).
- Autostart: `/etc/xdg/autostart/eu-dss-agent.desktop` present.
- Auto-start at login: log into the GUI session (or launch the autostart target), then `curl -k https://localhost:9795/rest/health` returns `{"status":"ok"}` (HTTP 200) without launching the agent manually.
- First-run Chromium trust: `certutil -d sql:$HOME/.pki/nssdb -L` lists `EU-DSS Agent localhost`; the marker `~/.eudss-agent/.nss-trusted` exists. If Chrome/Chromium is present, `https://localhost:9795/rest/health` loads without a certificate warning.

- [ ] **Step 4: Verify removal**

```bash
sudo apt remove -y eu-dss-agent
```

Expected: `/usr/local/share/ca-certificates/eudss-agent.crt` gone, system store refreshed, `/var/lib/eudss-agent` removed. (The per-user NSS cert + marker remain by design: documented limitation.)

- [ ] **Step 5: Record the result**

Note the verified points in the session and update the onboarding-status memory (RESUME anchor) to reflect SP2c-core verified-on-VM, with real-signing-on-amd64 as the remaining follow-up. Stop the VM if no longer needed (`prlctl stop {uuid}`).

---

## Done criteria (maps to the spec acceptance criteria)

1. `.deb` amd64 produced in CI (Task 6 Step 4).
2. Install -> cert in the system store, keystore + `agent.cer` in `/var/lib/eudss-agent`, XDG autostart entry present (Task 7 Step 3).
3. At GUI login: agent running, `/rest/health` 200, no manual action; cert added to `~/.pki/nssdb` on first run -> Chrome/Chromium without warning (Task 7 Step 3).
4. `apt remove`/`purge`: system cert removed, `/var/lib/eudss-agent` deleted (Task 7 Step 4).
5. Default Linux driver corrected to `/usr/lib/SCMiddleware/libidop11.so`; non-Linux agent behavior unchanged; full agent + server test suite green (Tasks 1-3).

After Task 7, run `superpowers:finishing-a-development-branch` (the finish is a push of `eu-dss`; no merge/PR since `eu-dss` is the live default branch).
