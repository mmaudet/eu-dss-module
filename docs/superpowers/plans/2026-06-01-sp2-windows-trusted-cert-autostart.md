# SP2 Windows — Trusted Cert + Auto-start Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On Windows, the MSI install provisions a machine-wide `localhost` cert, trusts it in `LocalMachine\Root` (so no browser cert warning), and registers `HKLM\Run` user-session auto-start (agent always running) — eliminating the "accept the cert" + manual-launch friction.

**Architecture:** The agent gains a machine-wide keystore path (Windows → `C:\ProgramData\eudss-agent`) and a `--provision-cert` mode (generate keystore + export the public `.cer`, then exit). The Windows installer runs, at install (elevated), a PowerShell action that calls `--provision-cert`, trusts the cert via `certutil -addstore -f Root`, and writes `HKLM\Run`; uninstall reverses it. The cert stays a directly-trusted self-signed `localhost` cert (no CA hierarchy). Auto-start is a user-session launch (HKLM\Run), never a Windows service (the agent needs the user's smart-card session).

**Tech Stack:** Java 21 + BouncyCastle (agent) ; JUnit 5 + AssertJ (agent tests) ; jpackage + WiX 3 + PowerShell (Windows MSI). The MSI tasks build on the `windows-latest` CI + are verified on the Parallels Windows 11 ARM VM.

**Spec:** `docs/superpowers/specs/2026-06-01-sp2-windows-trusted-cert-autostart-design.md`

---

## File Structure

- `eu-dss-agent/.../tls/AgentTls.java` — MODIFY: OS-aware `defaultKeystorePath`, add `exportCertificate`.
- `eu-dss-agent/.../AgentMain.java` — MODIFY: handle `--provision-cert` arg (provision + exit).
- `eu-dss-agent/src/test/.../tls/AgentTlsTest.java` — MODIFY/ADD: keystore-path + export-cert tests.
- `packaging/windows/wix-resources/provision-install.ps1` — CREATE: trust cert + HKLM\Run.
- `packaging/windows/wix-resources/provision-uninstall.ps1` — CREATE: untrust + cleanup.
- `packaging/windows/wix-resources/main.wxs` — CREATE: jpackage WiX override (perMachine + custom actions).
- `packaging/windows/build-agent-msi.ps1` — MODIFY: pass `--resource-dir` + `--win-per-user-install` removed.

---

## Task 1: Agent — machine-wide keystore path on Windows

**Files:**
- Modify: `eu-dss-agent/src/main/java/com/linagora/eudss/agent/tls/AgentTls.java`
- Test: `eu-dss-agent/src/test/java/com/linagora/eudss/agent/AgentTlsTest.java`

- [ ] **Step 1: Write the failing test** (append to `AgentTlsTest`)

```java
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
```

- [ ] **Step 2: Run it — verify it fails to compile**

Run: `mvn -f eu-dss-agent/pom.xml -q -Dtest=AgentTlsTest test`
Expected: FAIL — `defaultKeystorePath(String,String,String,String)` not found.

- [ ] **Step 3: Implement** — replace the existing `defaultKeystorePath()` in `AgentTls.java` with:

```java
    public static Path defaultKeystorePath() {
        return defaultKeystorePath(
                System.getProperty("os.name", ""),
                System.getProperty("user.home", ""),
                System.getenv().getOrDefault("ProgramData", "C:\\ProgramData"),
                System.getenv("EUDSS_AGENT_KEYSTORE"));
    }

    /** Pure resolution (package-visible for tests). Windows → machine-wide ProgramData so the MSI
     *  (SYSTEM) and the user-launched agent share one keystore; other OS → user home. Override via
     *  EUDSS_AGENT_KEYSTORE. */
    static Path defaultKeystorePath(String osName, String userHome, String programData, String envKeystore) {
        if (envKeystore != null && !envKeystore.isBlank()) {
            return Path.of(envKeystore);
        }
        if (osName.toLowerCase().contains("win")) {
            return Path.of(programData, "eudss-agent", "agent-keystore.p12");
        }
        return Path.of(userHome, ".eudss-agent", "agent-keystore.p12");
    }
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `mvn -f eu-dss-agent/pom.xml -q -Dtest=AgentTlsTest test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add eu-dss-agent/src/main/java/com/linagora/eudss/agent/tls/AgentTls.java eu-dss-agent/src/test/java/com/linagora/eudss/agent/AgentTlsTest.java
git commit -m "feat(agent): machine-wide keystore path on Windows (ProgramData) + EUDSS_AGENT_KEYSTORE override"
```

---

## Task 2: Agent — export cert (.cer) + `--provision-cert` mode

**Files:**
- Modify: `eu-dss-agent/src/main/java/com/linagora/eudss/agent/tls/AgentTls.java`
- Modify: `eu-dss-agent/src/main/java/com/linagora/eudss/agent/AgentMain.java`
- Test: `eu-dss-agent/src/test/java/com/linagora/eudss/agent/AgentTlsTest.java`

- [ ] **Step 1: Write the failing test** (append to `AgentTlsTest`)

```java
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
```

- [ ] **Step 2: Run it — verify it fails**

Run: `mvn -f eu-dss-agent/pom.xml -q -Dtest=AgentTlsTest test`
Expected: FAIL — `exportCertificate` not found.

- [ ] **Step 3: Implement `exportCertificate` in `AgentTls.java`** (add before the private constructor)

```java
    /** Exports the "agent" cert from the keystore as a DER .cer (for certutil -addstore). */
    public static void exportCertificate(Path keystorePath, char[] password, Path cerOut) throws Exception {
        KeyStore ks = KeyStore.getInstance("PKCS12");
        try (var in = Files.newInputStream(keystorePath)) {
            ks.load(in, password);
        }
        Certificate cert = ks.getCertificate("agent");
        if (cert == null) throw new IllegalStateException("No 'agent' cert in keystore " + keystorePath);
        Files.createDirectories(cerOut.getParent());
        Files.write(cerOut, cert.getEncoded());
        LOG.info("Exported agent cert (DER) to {}", cerOut);
    }
```

- [ ] **Step 4: Wire `--provision-cert` in `AgentMain.main`** — at the very start of `main(String[] args)`, before `AgentConfig config = AgentConfig.load();`, add:

```java
        if (java.util.Arrays.asList(args).contains("--provision-cert")) {
            try {
                java.nio.file.Path ks = com.linagora.eudss.agent.tls.AgentTls.defaultKeystorePath();
                com.linagora.eudss.agent.tls.AgentTls.ensureKeystore(ks, TLS_KEYSTORE_PASSWORD);
                java.nio.file.Path cer = ks.resolveSibling("agent.cer");
                com.linagora.eudss.agent.tls.AgentTls.exportCertificate(ks, TLS_KEYSTORE_PASSWORD, cer);
                LOG.info("Provisioned agent cert: keystore={} cer={}", ks, cer);
                System.out.println("PROVISIONED keystore=" + ks + " cer=" + cer);
                return; // do not start the server
            } catch (Exception e) {
                System.err.println("PROVISION FAILED: " + e.getMessage());
                System.exit(2);
            }
        }
```

- [ ] **Step 5: Run the test + build — verify green**

Run: `mvn -f eu-dss-agent/pom.xml test`
Expected: BUILD SUCCESS (AgentTlsTest now has the export test green; existing tests unaffected — `--provision-cert` is only exercised manually).

- [ ] **Step 6: Manual local check of `--provision-cert`** (optional, on the Mac)

Run: `EUDSS_AGENT_KEYSTORE=/tmp/eudss-prov/ks.p12 java -jar eu-dss-agent/target/eu-dss-agent-0.1.0-SNAPSHOT.jar --provision-cert && ls -l /tmp/eudss-prov/`
Expected: prints `PROVISIONED …`, creates `ks.p12` + `agent.cer`, exits 0 (no server).

- [ ] **Step 7: Commit**

```bash
git add eu-dss-agent/src/main/java/com/linagora/eudss/agent/tls/AgentTls.java eu-dss-agent/src/main/java/com/linagora/eudss/agent/AgentMain.java eu-dss-agent/src/test/java/com/linagora/eudss/agent/AgentTlsTest.java
git commit -m "feat(agent): --provision-cert mode + AgentTls.exportCertificate (.cer for certutil)"
```

---

## Task 3: Provisioning PowerShell scripts

**Files:**
- Create: `packaging/windows/wix-resources/provision-install.ps1`
- Create: `packaging/windows/wix-resources/provision-uninstall.ps1`

- [ ] **Step 1: Create `provision-install.ps1`**

```powershell
# Runs elevated at MSI install. Provisions the agent's localhost cert, trusts it machine-wide, sets auto-start.
$ErrorActionPreference = 'Stop'
$exe = Join-Path ${env:ProgramFiles} 'EU-DSS Agent\EU-DSS Agent.exe'
$dataDir = Join-Path $env:ProgramData 'eudss-agent'
$cer = Join-Path $dataDir 'agent.cer'

# 1. Generate keystore + export agent.cer (agent writes to C:\ProgramData\eudss-agent on Windows)
& "$exe" --provision-cert | Out-Null
if (-not (Test-Path $cer)) { throw "provision-cert did not produce $cer" }

# 2. Trust the cert machine-wide (Edge/Chrome/IE use LocalMachine\Root)
$import = Import-Certificate -FilePath $cer -CertStoreLocation 'Cert:\LocalMachine\Root'
Set-Content -Path (Join-Path $dataDir 'trusted-thumbprint.txt') -Value $import.Thumbprint -Encoding ASCII -NoNewline

# 3. Auto-start at login, in the user's session (NOT a service)
New-ItemProperty -Path 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run' `
  -Name 'EU-DSS Agent' -Value ('"' + $exe + '"') -PropertyType String -Force | Out-Null

Write-Host "EU-DSS provisioned: cert trusted (thumbprint $($import.Thumbprint)), auto-start set."
```

- [ ] **Step 2: Create `provision-uninstall.ps1`**

```powershell
# Runs elevated at MSI uninstall. Reverses provision-install.
$ErrorActionPreference = 'Continue'
$dataDir = Join-Path $env:ProgramData 'eudss-agent'
$tpFile = Join-Path $dataDir 'trusted-thumbprint.txt'

if (Test-Path $tpFile) {
  $tp = (Get-Content -Raw $tpFile).Trim()
  Get-ChildItem 'Cert:\LocalMachine\Root' | Where-Object { $_.Thumbprint -eq $tp } | Remove-Item -Force -ErrorAction SilentlyContinue
}
Remove-ItemProperty -Path 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'EU-DSS Agent' -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue
Write-Host "EU-DSS unprovisioned: cert untrusted, auto-start + data removed."
```

- [ ] **Step 3: Commit**

```bash
git add packaging/windows/wix-resources/provision-install.ps1 packaging/windows/wix-resources/provision-uninstall.ps1
git commit -m "feat(packaging): provision/unprovision PowerShell scripts (trust cert + HKLM Run)"
```

---

## Task 4: Wire provisioning into the Windows MSI (built + verified on Windows CI/VM)

**Files:**
- Create: `packaging/windows/wix-resources/main.wxs` (jpackage WiX override)
- Modify: `packaging/windows/build-agent-msi.ps1`

> This task's exact WiX is finalized on the Windows runner (the override must match the jpackage-generated `main.wxs`). The logic below is concrete; the implementer captures jpackage's template and grafts the additions.

- [ ] **Step 1: Capture jpackage's generated WiX template** (on the Windows VM/CI)

Run jpackage once with `--temp` to keep the generated sources:
`jpackage --type msi --name "EU-DSS Agent" --app-version 0.1.0 --vendor LINAGORA --input <staging> --main-jar <jar> --main-class com.linagora.eudss.agent.AgentMain --win-console --temp C:\eudss-jp-temp --dest C:\eudss-jp-out`
Then copy `C:\eudss-jp-temp\config\main.wxs` to `packaging/windows/wix-resources/main.wxs` as the editable base.

- [ ] **Step 2: Edit `main.wxs`** — make it perMachine + add the install/uninstall custom actions. In the `<Package>` element set `InstallScope="perMachine"` (or `<Property Id="ALLUSERS" Value="1"/>`), and inside the `<Product>` add (the two PS scripts are laid down as app payload under the install dir's `wix-resources\`):

```xml
    <CustomAction Id="EudssProvision" Directory="INSTALLDIR" Impersonate="no" Execute="deferred" Return="check"
        ExeCommand="powershell.exe -NoProfile -ExecutionPolicy Bypass -File &quot;[INSTALLDIR]wix-resources\provision-install.ps1&quot;" />
    <CustomAction Id="EudssUnprovision" Directory="INSTALLDIR" Impersonate="no" Execute="deferred" Return="ignore"
        ExeCommand="powershell.exe -NoProfile -ExecutionPolicy Bypass -File &quot;[INSTALLDIR]wix-resources\provision-uninstall.ps1&quot;" />
    <InstallExecuteSequence>
      <Custom Action="EudssProvision" After="InstallFiles">NOT Installed</Custom>
      <Custom Action="EudssUnprovision" Before="RemoveFiles">Installed AND (REMOVE="ALL")</Custom>
    </InstallExecuteSequence>
```

Ensure the two `.ps1` are part of the installed payload (add them to the jpackage `--input` staging so they land under `INSTALLDIR\wix-resources\`, or reference them via a WiX `<Component>` in the override).

- [ ] **Step 3: Update `build-agent-msi.ps1`** — copy the scripts into staging + pass the resource dir; drop per-user:

Replace the `& jpackage` block with one that adds:
```powershell
# stage the provisioning scripts so they install under INSTALLDIR\wix-resources\
$wixRes = Join-Path $root 'packaging\windows\wix-resources'
New-Item -ItemType Directory -Force -Path (Join-Path $staging 'wix-resources') | Out-Null
Copy-Item (Join-Path $wixRes 'provision-install.ps1')   (Join-Path $staging 'wix-resources') -Force
Copy-Item (Join-Path $wixRes 'provision-uninstall.ps1') (Join-Path $staging 'wix-resources') -Force
```
and add `--resource-dir $wixRes` to the `jpackage` arguments (so `main.wxs` overrides the generated one). Keep `--win-console --win-menu --win-shortcut`. Do NOT add `--win-per-user-install` (we want perMachine).

- [ ] **Step 4: Build the MSI on CI**

Trigger: `gh workflow run windows-installer.yml -R mmaudet/twake-eu-dss-module --ref eu-dss`, then `gh run watch <id> --exit-status`. Expected: BUILD SUCCESS, `eu-dss-agent-msi` artifact produced. If the WiX override fights jpackage (build error), switch to the **fallback** (Step 5).

- [ ] **Step 5: FALLBACK (only if Step 2–4 WiX override proves intractable): Inno wrapper**

Create `packaging/windows/wrapper.iss` (Inno Setup) that: bundles the jpackage MSI + the two `.ps1`; on install runs `msiexec /i agent.msi /qn ALLUSERS=1` then `powershell -File provision-install.ps1`; on uninstall runs `provision-uninstall.ps1` then `msiexec /x`. Build it with `iscc` in CI. The wrapper `.exe` becomes the published installer. (The `provision-*.ps1` from Task 3 are reused verbatim.) This is the proven ChamberSign-style pattern.

- [ ] **Step 6: Commit**

```bash
git add packaging/windows/wix-resources/main.wxs packaging/windows/build-agent-msi.ps1
git commit -m "feat(packaging): MSI provisions trusted cert + HKLM Run auto-start (jpackage --resource-dir custom action)"
```

---

## Task 5: Verify on the Windows VM (acceptance gate)

**Files:** none (manual verification on the Parallels Windows 11 ARM VM)

- [ ] **Step 1: Install the new MSI** (download the CI artifact, `msiexec /i ... /qn` as admin).

- [ ] **Step 2: Verify provisioning**

- `certutil -store Root | findstr /i localhost` → the agent cert is present in `LocalMachine\Root`.
- `reg query "HKLM\Software\Microsoft\Windows\CurrentVersion\Run" /v "EU-DSS Agent"` → present.
- `Test-Path 'C:\ProgramData\eudss-agent\agent-keystore.p12'` → True.

- [ ] **Step 3: Verify the trusted-HTTPS + auto-start outcome**

- Log off / log on (or reboot). Confirm the agent is running: `curl.exe -sk -o NUL -w "%{http_code}" https://localhost:9795/rest/health` → 200, with NO manual launch.
- In Edge: open `https://localhost:9795/rest/health` → **NO certificate warning** (trusted). The SP1 wizard shows "✓ Agent connecté" directly (no "accept the cert" step).

- [ ] **Step 4: Verify uninstall cleanup**

- `msiexec /x` (or via Add/Remove). Then: cert gone from `Root` (`certutil -store Root`), `HKLM\Run` entry gone, `C:\ProgramData\eudss-agent\` removed.

- [ ] **Step 5: (If passed) publish a refreshed Release**

Re-run `gh release upload eu-dss-agent-v0.1.0 <new-msi> --clobber` (or a new tag) so the wizard's download link serves the auto-provisioning MSI.

---

## Self-Review (completed by plan author)

- **Spec coverage:** machine-wide keystore (spec A1) → Task 1. `--provision-cert` (spec A2) → Task 2. Trust in LocalMachine\Root + HKLM\Run (spec B) → Task 3 scripts + Task 4 custom action. jpackage `--resource-dir` + CI (spec C) → Task 4 + build-script change; wrapper fallback (spec) → Task 4 Step 5. Acceptance #1–6 → Task 5 (+ agent unit tests for the path/export). ✓
- **Placeholder scan:** none — agent code + PS scripts are complete; Task 4's WiX is concrete (the only "finalized on Windows" part is grafting the custom-action XML onto jpackage's captured template, with exact XML provided + a fully-specified wrapper fallback). Not hand-waving.
- **Type consistency:** `defaultKeystorePath(String,String,String,String)` signature consistent (Task 1 def ↔ Task 2 `--provision-cert` no-arg call). `exportCertificate(Path,char[],Path)` consistent (Task 2 def ↔ test ↔ provision-install.ps1 expecting `agent.cer` beside the keystore). Keystore password `eudss-agent` (TLS_KEYSTORE_PASSWORD) consistent agent↔scripts. `EUDSS_AGENT_KEYSTORE` override consistent. ✓
