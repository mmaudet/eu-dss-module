# Cross-platform browser access (B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Serve the agent over HTTPS (self-signed, accept-once) so a browser can call it, refresh cross-OS launch, and produce a **Windows MSI** installer.

**Architecture:** The Javalin agent gains an HTTPS connector backed by a self-signed PKCS12 keystore generated on first run (BouncyCastle). A `tlsEnabled` flag keeps HTTP for tests/dev. The UI gets an actionable "accept the cert once" card. A Windows MSI is built by `jpackage` on a `windows-latest` GitHub Actions runner.

**Tech Stack:** Java 21, Javalin 6.7.0 / Jetty 11.0.25, BouncyCastle (`bcpkix-jdk18on`), `io.javalin.community.ssl:ssl-plugin`, React/Vite UI, jpackage + WiX 3 (CI), GitHub Actions.

**Conventions:** JDK 21 (`JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home`). Build agent: `mvn -f /Users/mmaudet/work/eu-dss/pom.xml -pl eu-dss-agent -am`. Branch `eu-dss`. **Verification note:** if a BouncyCastle or javalin-ssl coordinate/version does not resolve or an API differs, resolve it from Maven Central and adjust (e.g., check `~/.m2` after a build, or `javap` the class); the versions below are best-known and managed by `dss-bom`/`javalin.version` where possible.

---

## File Structure

`eu-dss-agent/`:
- `pom.xml` — add `bcpkix-jdk18on` + `io.javalin.community.ssl:ssl-plugin`.
- `src/main/java/.../config/AgentConfig.java` — add `boolean tlsEnabled` (+ keystore path/password defaults).
- `src/main/java/.../tls/AgentTls.java` — CREATE: load-or-generate the self-signed PKCS12 keystore.
- `src/main/java/.../AgentMain.java` — register the SSL plugin when TLS on; PNA header; start without a fixed HTTP port when TLS on.
- `src/test/java/.../AgentHttpSmokeTest.java`, `src/test/.../AgentTlsTest.java` (CREATE) — TLS off for existing tests; a new HTTPS test.
- `eu-dss-server/src/test/.../FullStackE2ETest.java` — update the `new AgentConfig(...)` call for the new field.

`bin/`: add `eu-dss-agent-windows.ps1`; refresh `eu-dss-agent-macos.sh` / `eu-dss-agent-linux.sh` wording.
`packaging/windows/build-agent-msi.ps1` — CREATE: jpackage MSI build.
`.github/workflows/windows-installer.yml` — CREATE: build MSI on windows-latest.
`docs/INSTALL.md` — CREATE: per-OS install + cert-trust guide.
`eu-dss-ui/src/components/SignWorkspace.tsx` — actionable cert-trust card.

---

## Task 1: Agent HTTPS (self-signed keystore + SSL connector)

**Files:** `eu-dss-agent/pom.xml`, `config/AgentConfig.java`, `tls/AgentTls.java` (new), `AgentMain.java`, tests.

- [ ] **Step 1: Add dependencies**

In `eu-dss-agent/pom.xml`, inside `<dependencies>` add (versions: bcpkix via `dss-bom`; ssl-plugin matches Javalin — if `${javalin.version}` is not published for ssl-plugin, use the latest `6.x` from Maven Central):

```xml
        <!-- Self-signed cert generation for the agent's HTTPS listener -->
        <dependency>
            <groupId>org.bouncycastle</groupId>
            <artifactId>bcpkix-jdk18on</artifactId>
        </dependency>
        <!-- Javalin SSL (HTTPS) -->
        <dependency>
            <groupId>io.javalin.community.ssl</groupId>
            <artifactId>ssl-plugin</artifactId>
            <version>${javalin.version}</version>
        </dependency>
```

- [ ] **Step 2: Verify the deps resolve**

Run: `JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home mvn -f /Users/mmaudet/work/eu-dss/pom.xml -pl eu-dss-agent -am -DskipTests dependency:resolve 2>&1 | grep -iE "bcpkix|ssl-plugin|BUILD"`
Expected: both resolve, `BUILD SUCCESS`. If `ssl-plugin:${javalin.version}` is missing, browse Maven Central for `io.javalin.community.ssl:ssl-plugin` latest 6.x and pin that exact version, then re-run.

- [ ] **Step 3: Add `tlsEnabled` (and keystore defaults) to AgentConfig**

In `AgentConfig.java`, add `boolean tlsEnabled` as the LAST record component:
```java
public record AgentConfig(
        Path pkcs11Driver,
        int slotListIndex,
        int port,
        List<String> corsHosts,
        char[] pin,
        boolean tlsEnabled
) {
```
In `fromEnv(...)`, resolve it (default true) and pass it to the constructor:
```java
        boolean tls = !"false".equalsIgnoreCase(env.getOrDefault("EUDSS_AGENT_TLS", "true"));
        return new AgentConfig(
                Path.of(driver), slot, port,
                Arrays.stream(origins.split(",")).map(String::trim).filter(s -> !s.isBlank()).toList(),
                pin, tls);
```

- [ ] **Step 4: Create `tls/AgentTls.java`**

```java
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

    /** Ensure a keystore exists at {@code path}; generate a self-signed localhost cert if absent. */
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
```

- [ ] **Step 5: Wire HTTPS + PNA into AgentMain**

In `AgentMain.java`: add the keystore password constant + imports, register the `SslPlugin` when `config.tlsEnabled()`, add the Private-Network-Access response header, and start appropriately. Replace `main` and `buildApp`:

```java
    private static final char[] TLS_KEYSTORE_PASSWORD =
            System.getenv().getOrDefault("EUDSS_AGENT_TLS_PASSWORD", "eudss-agent").toCharArray();

    public static void main(String[] args) {
        AgentConfig config = AgentConfig.load();
        TokenService tokenService = new TokenService(config);
        Runtime.getRuntime().addShutdownHook(new Thread(tokenService::close, "token-close"));

        Javalin app = buildApp(config, tokenService);
        if (config.tlsEnabled()) {
            app.start();   // the SSL plugin binds the secure port
            LOG.info("eu-dss agent listening on https://localhost:{} (TLS, self-signed) — CORS {}",
                    config.port(), config.corsHosts());
        } else {
            app.start(config.port());
            LOG.info("eu-dss agent listening on http://localhost:{} (no TLS) — CORS {}",
                    config.port(), config.corsHosts());
        }
    }

    public static Javalin buildApp(AgentConfig config, TokenService tokenService) {
        Javalin app = Javalin.create(cfg -> {
            cfg.bundledPlugins.enableCors(cors -> cors.addRule(rule -> config.corsHosts().forEach(rule::allowHost)));
            cfg.showJavalinBanner = false;
            if (config.tlsEnabled()) {
                try {
                    java.nio.file.Path ks = com.linagora.eudss.agent.tls.AgentTls.defaultKeystorePath();
                    com.linagora.eudss.agent.tls.AgentTls.ensureKeystore(ks, TLS_KEYSTORE_PASSWORD);
                    cfg.registerPlugin(new io.javalin.community.ssl.SslPlugin(ssl -> {
                        ssl.keystoreFromPath(ks.toString(), new String(TLS_KEYSTORE_PASSWORD));
                        ssl.insecure = false;
                        ssl.secure = true;
                        ssl.securePort = config.port();
                        ssl.http2 = false;
                    }));
                } catch (Exception e) {
                    throw new IllegalStateException("Failed to set up agent TLS keystore", e);
                }
            }
        });

        // Private Network Access: allow secure public sites to call this localhost agent.
        app.before(ctx -> ctx.header("Access-Control-Allow-Private-Network", "true"));

        app.get("/rest/health", ctx -> ctx.json(java.util.Map.of("status", "ok")));
        // ... keep the existing /rest/certificates and /rest/sign and exception handlers unchanged ...
        return app;
    }
```
Keep the existing `/rest/certificates`, `/rest/sign`, and `app.exception(...)` bodies exactly as they are. **Verification:** confirm the `SslPlugin` config field names (`keystoreFromPath`, `insecure`, `secure`, `securePort`, `http2`) against the resolved ssl-plugin version; adjust if the API differs (e.g. `keystoreFromPath(path, pass)` may be the right form, or a `KeystoreConfig`).

- [ ] **Step 6: Update existing tests to the new record field (TLS off)**

In `eu-dss-agent/.../AgentHttpSmokeTest.java` the config is `new AgentConfig(Path.of("/nonexistent/driver"), 0, 0, List.of("localhost:5173"), "0000".toCharArray())` — append `, false` (tlsEnabled=false) so it stays HTTP on a random port.
In `eu-dss-server/.../FullStackE2ETest.java` the config `new AgentConfig(Path.of("/nonexistent/driver"), 0, 0, List.of("localhost"), "0000".toCharArray())` — append `, false`.

- [ ] **Step 7: Add a TLS test** — create `eu-dss-agent/src/test/java/com/linagora/eudss/agent/AgentTlsTest.java`:

```java
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

        // second call must reuse, not throw
        AgentTls.ensureKeystore(ks, pwd);
        assertThat(Files.exists(ks)).isTrue();
    }
}
```

- [ ] **Step 8: Build + test**

Run: `JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home mvn -f /Users/mmaudet/work/eu-dss/pom.xml test`
Expected: `BUILD SUCCESS`; `AgentTlsTest` passes; existing agent + server tests pass (they run TLS off). If the ssl-plugin API differs and main fails to compile, fix per Step 5's verification note.

- [ ] **Step 9: macOS HTTPS smoke (manual-ish, scripted)**

Run (TLS on, dummy PIN, no token needed for /rest/health):
```bash
JDK21=/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home
JAVA_HOME=$JDK21 mvn -f /Users/mmaudet/work/eu-dss/pom.xml -pl eu-dss-agent -am -DskipTests package >/dev/null 2>&1
EUDSS_AGENT_PIN=000000 "$JDK21/bin/java" -jar /Users/mmaudet/work/eu-dss/eu-dss-agent/target/eu-dss-agent-0.1.0-SNAPSHOT.jar >/tmp/agent-tls.log 2>&1 &
sleep 3
curl -sk https://localhost:9795/rest/health   # -k accepts the self-signed cert
pkill -f eu-dss-agent-0.1.0-SNAPSHOT.jar
```
Expected: `{"status":"ok"}` over HTTPS; the log shows "listening on https://localhost:9795 (TLS, self-signed)" and a generated keystore at `~/.eudss-agent/agent-keystore.p12`.

- [ ] **Step 10: Commit**

```bash
cd /Users/mmaudet/work/eu-dss
git add eu-dss-agent/pom.xml eu-dss-agent/src eu-dss-server/src/test/java/com/linagora/eudss/server/FullStackE2ETest.java
git commit -m "feat(agent): serve HTTPS with a self-signed localhost cert (BouncyCastle) + Private Network Access header"
```

---

## Task 2: UI cert-trust card

**Files:** `eu-dss-ui/src/components/SignWorkspace.tsx`

- [ ] **Step 1: Make the agent-unavailable state actionable**

In `SignWorkspace.tsx`, replace the `agentStatus === 'unavailable'` block with a first-run setup card:

```tsx
        {agentStatus === 'unavailable' && (
          <div className="status warn">
            <strong>Agent local non joignable.</strong> Première utilisation : l'agent tourne en HTTPS avec un certificat auto-signé qu'il faut accepter une fois.
            <ol style={{ margin: '8px 0 0 18px' }}>
              <li>Lance l'agent local (clé USB branchée, PIN saisi).</li>
              <li>Ouvre <a href="https://localhost:9795/rest/health" target="_blank" rel="noreferrer">https://localhost:9795/rest/health</a> et accepte le certificat de l'agent.</li>
              <li>Reviens ici et <button onClick={checkAgent} style={{ marginLeft: 2 }}>recharger</button>.</li>
            </ol>
          </div>
        )}
```

- [ ] **Step 2: Build**

Run: `cd /Users/mmaudet/work/eu-dss/eu-dss-ui && npm run build`
Expected: tsc + vite build green.

- [ ] **Step 3: Commit**

```bash
cd /Users/mmaudet/work/eu-dss
git add eu-dss-ui/src/components/SignWorkspace.tsx
git commit -m "feat(ui): actionable first-run card to accept the agent's self-signed HTTPS cert"
```

---

## Task 3: Cross-OS launch scripts + install guide

**Files:** `bin/eu-dss-agent-windows.ps1` (new), refresh `bin/eu-dss-agent-macos.sh` / `bin/eu-dss-agent-linux.sh` (PIN wording already fixed in increment A), `docs/INSTALL.md` (new).

- [ ] **Step 1: Create `bin/eu-dss-agent-windows.ps1`**

```powershell
# eu-dss agent launcher (Windows)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$jar  = Join-Path $root 'eu-dss-agent\target\eu-dss-agent-0.1.0-SNAPSHOT.jar'
if (-not (Test-Path $jar)) { Write-Error "Jar not found: $jar`nBuild first: mvn -DskipTests package"; exit 1 }

if (-not $env:EUDSS_PKCS11_DRIVER) { $env:EUDSS_PKCS11_DRIVER = 'C:\Windows\System32\idop11.dll' }
if (-not $env:EUDSS_PKCS11_SLOT)   { $env:EUDSS_PKCS11_SLOT = '0' }
if (-not $env:EUDSS_AGENT_PORT)    { $env:EUDSS_AGENT_PORT = '9795' }

Write-Host "eu-dss agent (Windows)"
Write-Host "  PKCS#11 driver : $env:EUDSS_PKCS11_DRIVER  (slot 0 = signing cert, 4-digit Card PIN)"
Write-Host "  port           : $env:EUDSS_AGENT_PORT (HTTPS)"
Write-Host "Enter your Card PIN when prompted."
& java -jar $jar
```

- [ ] **Step 2: Create `docs/INSTALL.md`** (per-OS install + cert-trust):

```markdown
# eu-dss agent — install & first-run

The agent bridges the website to your USB token (PKCS#11). It runs locally and serves **HTTPS on https://localhost:9795** with a self-signed certificate you accept once per browser.

## Prerequisites (all OSes)
- The **IDOPRO PKCS#11 driver** for your token (the agent does not ship it).
- Java 21 — **except on Windows**, where the MSI bundles its own runtime.

## Windows (MSI)
1. Install the IDOPRO Windows driver.
2. Install **EU-DSS Agent** from the MSI (Start menu shortcut "EU-DSS Agent").
3. Launch it; a console opens, asks your Card PIN, then serves https://localhost:9795.
4. In your browser, open https://localhost:9795/rest/health once and accept the certificate.

## macOS / Linux (jar)
1. Install Temurin JDK 21 and the IDOPRO driver (`/Library/SCMiddleware/libidop11.dylib` on macOS, `/usr/lib/libidop11.so` on Linux).
2. Build once: `mvn -DskipTests package`.
3. Run `bin/eu-dss-agent-macos.sh` (or `-linux.sh`), enter your Card PIN.
4. Open https://localhost:9795/rest/health once and accept the certificate.

## Notes
- The agent only ever signs a digest; your private key never leaves the token.
- Slot 0 = the signing certificate (4-digit Card PIN). Override with `EUDSS_PKCS11_SLOT`.
- Disable TLS for pure-local dev with `EUDSS_AGENT_TLS=false` (then it serves http://localhost:9795).
```

- [ ] **Step 3: Commit**

```bash
cd /Users/mmaudet/work/eu-dss
git add bin/eu-dss-agent-windows.ps1 docs/INSTALL.md
git commit -m "docs(agent): Windows launch script + per-OS install & cert-trust guide"
```

---

## Task 4: Windows MSI (jpackage + GitHub Actions)

**Files:** `packaging/windows/build-agent-msi.ps1` (new), `.github/workflows/windows-installer.yml` (new).

- [ ] **Step 1: Create `packaging/windows/build-agent-msi.ps1`**

```powershell
# Build the EU-DSS Agent Windows MSI with jpackage. Run on Windows with JDK 21 + WiX 3 on PATH.
$ErrorActionPreference = 'Stop'
$root    = (Resolve-Path "$PSScriptRoot\..\..").Path
$version = '0.1.0'
$jarDir  = Join-Path $root 'eu-dss-agent\target'
$jar     = "eu-dss-agent-$version-SNAPSHOT.jar"
if (-not (Test-Path (Join-Path $jarDir $jar))) { Write-Error "Build the agent jar first (mvn -pl eu-dss-agent -am -DskipTests package)"; exit 1 }

$staging = Join-Path $env:TEMP 'eudss-msi-input'
Remove-Item -Recurse -Force $staging -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $staging | Out-Null
Copy-Item (Join-Path $jarDir $jar) $staging

$out = Join-Path $root 'dist'
New-Item -ItemType Directory -Force -Path $out | Out-Null

& jpackage `
  --type msi `
  --name 'EU-DSS Agent' `
  --app-version $version `
  --vendor 'LINAGORA' `
  --input $staging `
  --main-jar $jar `
  --main-class com.linagora.eudss.agent.AgentMain `
  --win-console `
  --win-menu `
  --win-shortcut `
  --dest $out
Write-Host "MSI written to $out"
```

- [ ] **Step 2: Create `.github/workflows/windows-installer.yml`**

```yaml
name: Windows installer (MSI)

on:
  workflow_dispatch:
  push:
    tags: ['v*']

jobs:
  build-msi:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '21'
      - name: Build agent jar
        run: mvn -B -f pom.xml -pl eu-dss-agent -am -DskipTests package
      - name: Install WiX 3
        run: choco install wixtoolset --version=3.14.1 -y --no-progress
      - name: Build MSI (jpackage)
        shell: pwsh
        run: ./packaging/windows/build-agent-msi.ps1
      - name: Upload MSI
        uses: actions/upload-artifact@v4
        with:
          name: eu-dss-agent-msi
          path: dist/*.msi
          if-no-files-found: error
```

- [ ] **Step 3: Commit**

```bash
cd /Users/mmaudet/work/eu-dss
git add packaging/windows/build-agent-msi.ps1 .github/workflows/windows-installer.yml
git commit -m "ci(agent): Windows MSI via jpackage + windows-latest GitHub Actions workflow"
```

---

## Task 5: Push, trigger the MSI build, verify

**Files:** none (verification + push only)

- [ ] **Step 1: Full test suite green**

Run: `JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home mvn -f /Users/mmaudet/work/eu-dss/pom.xml test`
Expected: `BUILD SUCCESS`, all modules green.

- [ ] **Step 2: Push the branch** (the workflow only exists on the remote once pushed)

```bash
GIT_SSH_COMMAND="ssh -o BatchMode=yes" git -C /Users/mmaudet/work/eu-dss push origin eu-dss
```

- [ ] **Step 3: Trigger the Windows MSI build on CI and verify it succeeds + produces the artifact**

```bash
cd /Users/mmaudet/work/eu-dss
gh workflow run windows-installer.yml --ref eu-dss
sleep 10
RUN=$(gh run list --workflow=windows-installer.yml --branch eu-dss --limit 1 --json databaseId -q '.[0].databaseId')
gh run watch "$RUN" --exit-status   # waits; non-zero exit if the build fails
gh run view "$RUN" --json conclusion -q '.conclusion'   # expect: success
gh api repos/mmaudet/twake-eu-dss-module/actions/runs/$RUN/artifacts -q '.artifacts[].name'  # expect: eu-dss-agent-msi
```
Expected: workflow `success`, artifact `eu-dss-agent-msi` present. If WiX/jpackage args fail on the runner, read `gh run view "$RUN" --log-failed`, fix `build-agent-msi.ps1` / the workflow, commit, push, re-run.

- [ ] **Step 4: No extra commit** (verification only). The MSI is downloadable from the workflow run's artifacts; install/run is verified by the user on the Windows demo box.

---

## Self-Review (completed by plan author)

**Spec coverage:** agent HTTPS self-signed (T1) ✔; CORS already wired + PNA header (T1) ✔; `EUDSS_AGENT_TLS` flag default true, HTTP for tests (T1) ✔; UI accept-once card (T2) ✔; cross-OS scripts + install guide (T3) ✔; **Windows MSI via jpackage + CI** with trigger+verify (T4, T5) ✔; keystore at `~/.eudss-agent/agent-keystore.p12` (T1) ✔.

**Placeholder scan:** none — complete code/scripts/yaml; commands with expected output. Two explicit *verification points* (ssl-plugin version + API) are flagged with how to resolve, not left vague.

**Type consistency:** `AgentConfig` gains a trailing `boolean tlsEnabled`; every `new AgentConfig(...)` site updated (fromEnv, AgentHttpSmokeTest, FullStackE2ETest; AgentConfigDefaultsTest uses `fromEnv` so it picks up the default). `AgentTls.ensureKeystore(Path, char[])` / `defaultKeystorePath()` used consistently in AgentMain and the test.

**Out of scope (flagged):** native `.pkg`/`.deb`, MSI code-signing, public-cert-domain transport, multi-user (C). Windows/Linux launch scripts and the MSI are not run from macOS — the MSI is built+verified on CI; the scripts are smoke-tested by the user on those OSes.
```
