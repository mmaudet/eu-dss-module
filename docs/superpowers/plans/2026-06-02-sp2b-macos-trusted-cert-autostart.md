# SP2b macOS — Trusted Cert + Auto-start (.pkg) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the macOS agent as an unsigned `.pkg` whose postinstall provisions the `localhost` cert into the System keychain (trusted machine-wide → Safari + Chrome) and installs a user-session LaunchAgent — eliminating the "accept the certificate" + manual-launch friction, exactly as the Windows MSI does.

**Architecture:** `jpackage --type app-image` builds `EU-DSS Agent.app` (bundled arm64 JRE); `pkgbuild`/`productbuild` wrap it into a `.pkg` carrying a `postinstall` script. At install (root), postinstall runs the agent's existing `--provision-cert` (keystore + `agent.cer` at a machine-wide path via `EUDSS_AGENT_KEYSTORE`), trusts the cert with `security add-trusted-cert` in `/Library/Keychains/System.keychain`, and installs `/Library/LaunchAgents/com.linagora.eudss.agent.plist` (user-session launch, **not** a LaunchDaemon — the agent must see the user's smart card). No Java code changes.

**Tech Stack:** JDK 21 `jpackage` + `pkgbuild`/`productbuild` + bash + `launchd` plist ; `security`/`openssl` for cert trust ; GitHub Actions on `macos-latest` (arm64). Tested locally on the arm64 dev Mac (middleware already present).

**Spec:** `docs/superpowers/specs/2026-06-02-sp2b-macos-trusted-cert-autostart-design.md`

---

## File Structure

- `packaging/macos/scripts/postinstall` — CREATE: pkg postinstall (root): provision cert, trust in System keychain, save SHA, install + bootstrap LaunchAgent, drop uninstall.sh.
- `packaging/macos/scripts/com.linagora.eudss.agent.plist` — CREATE: the LaunchAgent plist (static; fixed paths). Bundled in the pkg Scripts dir; copied to `/Library/LaunchAgents` by postinstall.
- `packaging/macos/scripts/uninstall.sh` — CREATE: reverse everything (bootout + untrust by SHA + remove). Copied into the data dir at install; run with `sudo`.
- `packaging/macos/build-agent-pkg.sh` — CREATE: jpackage app-image → pkgbuild → productbuild → `dist/EU-DSS-Agent-0.1.0.pkg`.
- `.github/workflows/macos-installer.yml` — CREATE: CI build on `macos-latest`.
- `docs/INSTALL.md` — MODIFY: refresh the macOS section to describe the `.pkg` (Task 7, after local verification).

> The three files under `packaging/macos/scripts/` are all bundled by `pkgbuild --scripts` into the installer's Scripts archive, so at install time `postinstall` finds its siblings (`com.linagora.eudss.agent.plist`, `uninstall.sh`) next to itself via `"$(dirname "$0")"`.

> No `eu-dss-agent` Java change: `AgentMain --provision-cert` and `AgentTls.defaultKeystorePath`'s `EUDSS_AGENT_KEYSTORE` override already exist and are reused.

---

## Task 1: LaunchAgent plist

**Files:**
- Create: `packaging/macos/scripts/com.linagora.eudss.agent.plist`

- [ ] **Step 1: Create the plist**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.linagora.eudss.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Applications/EU-DSS Agent.app/Contents/MacOS/EU-DSS Agent</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>EUDSS_AGENT_KEYSTORE</key>
    <string>/Library/Application Support/eudss-agent/agent-keystore.p12</string>
    <key>EUDSS_PKCS11_DRIVER</key>
    <string>/Library/SCMiddleware/libidop11.dylib</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
```

- [ ] **Step 2: Validate the plist syntax**

Run: `plutil -lint "packaging/macos/scripts/com.linagora.eudss.agent.plist"`
Expected: `packaging/macos/scripts/com.linagora.eudss.agent.plist: OK`

- [ ] **Step 3: Commit**

```bash
git add packaging/macos/scripts/com.linagora.eudss.agent.plist
git commit -m "feat(packaging-macos): LaunchAgent plist (user-session agent, trusted-keystore env)"
```

---

## Task 2: postinstall script

**Files:**
- Create: `packaging/macos/scripts/postinstall`

- [ ] **Step 1: Create `postinstall`**

```bash
#!/bin/bash
# pkg postinstall (runs as root). Provisions the localhost cert, trusts it machine-wide in the System
# keychain, installs the user-session LaunchAgent, and drops uninstall.sh. No-op-safe on re-install.
set -euo pipefail

APP="/Applications/EU-DSS Agent.app"
LAUNCHER="$APP/Contents/MacOS/EU-DSS Agent"
DATA="/Library/Application Support/eudss-agent"
KS="$DATA/agent-keystore.p12"
CER="$DATA/agent.cer"
HERE="$(cd "$(dirname "$0")" && pwd)"
PLIST_SRC="$HERE/com.linagora.eudss.agent.plist"
PLIST_DST="/Library/LaunchAgents/com.linagora.eudss.agent.plist"
KEYCHAIN="/Library/Keychains/System.keychain"

mkdir -p "$DATA"

# 1. Generate the keystore + export agent.cer at the machine-wide path (agent reads EUDSS_AGENT_KEYSTORE).
EUDSS_AGENT_KEYSTORE="$KS" "$LAUNCHER" --provision-cert
[ -f "$CER" ] || { echo "postinstall: --provision-cert did not produce $CER" >&2; exit 1; }
chmod 644 "$KS" "$CER"

# 2. Trust the cert machine-wide (Safari + Chrome read the System keychain on macOS).
security add-trusted-cert -d -r trustRoot -k "$KEYCHAIN" "$CER"

# 3. Save the SHA-1 (no colons) for a targeted uninstall.
SHA="$(openssl x509 -inform der -in "$CER" -noout -fingerprint -sha1 | sed 's/.*=//; s/://g')"
printf '%s' "$SHA" > "$DATA/trusted-sha.txt"

# 4. Install the LaunchAgent plist (user-session launch, NOT a LaunchDaemon).
cp "$PLIST_SRC" "$PLIST_DST"
chown root:wheel "$PLIST_DST"
chmod 644 "$PLIST_DST"

# 5. Drop uninstall.sh in the data dir (macOS has no native .pkg uninstaller).
cp "$HERE/uninstall.sh" "$DATA/uninstall.sh"
chmod 755 "$DATA/uninstall.sh"

# 6. Start now for the console user (else it starts at next login). Non-fatal if no GUI user.
CONSOLE_USER="$(stat -f%Su /dev/console 2>/dev/null || true)"
if [ -n "$CONSOLE_USER" ] && [ "$CONSOLE_USER" != "root" ] && [ "$CONSOLE_USER" != "loginwindow" ]; then
  UID_N="$(id -u "$CONSOLE_USER")"
  launchctl bootout "gui/$UID_N/com.linagora.eudss.agent" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_N" "$PLIST_DST" 2>/dev/null || true
fi

echo "EU-DSS Agent provisioned: cert trusted (SHA $SHA), LaunchAgent installed."
exit 0
```

- [ ] **Step 2: Make it executable + syntax-check**

```bash
chmod +x packaging/macos/scripts/postinstall
bash -n packaging/macos/scripts/postinstall && echo "syntax OK"
```
Expected: `syntax OK`. (If `shellcheck` is installed: `shellcheck packaging/macos/scripts/postinstall` — warnings acceptable, no errors.)

- [ ] **Step 3: Commit**

```bash
git add packaging/macos/scripts/postinstall
git commit -m "feat(packaging-macos): pkg postinstall (provision cert + System-keychain trust + LaunchAgent)"
```

---

## Task 3: uninstall script

**Files:**
- Create: `packaging/macos/scripts/uninstall.sh`

- [ ] **Step 1: Create `uninstall.sh`**

```bash
#!/bin/bash
# Reverses the EU-DSS Agent install. Run with sudo: macOS has no native .pkg uninstaller.
# Copied into /Library/Application Support/eudss-agent/uninstall.sh by the postinstall.
set -uo pipefail

APP="/Applications/EU-DSS Agent.app"
DATA="/Library/Application Support/eudss-agent"
PLIST_DST="/Library/LaunchAgents/com.linagora.eudss.agent.plist"
KEYCHAIN="/Library/Keychains/System.keychain"

if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo." >&2; exit 1; fi

# 1. Stop + remove the LaunchAgent (best-effort).
CONSOLE_USER="$(stat -f%Su /dev/console 2>/dev/null || true)"
if [ -n "$CONSOLE_USER" ] && [ "$CONSOLE_USER" != "root" ] && [ "$CONSOLE_USER" != "loginwindow" ]; then
  UID_N="$(id -u "$CONSOLE_USER")"
  launchctl bootout "gui/$UID_N/com.linagora.eudss.agent" 2>/dev/null || true
fi
rm -f "$PLIST_DST"

# 2. Untrust + remove the cert from the System keychain (targeted by SHA-1).
if [ -f "$DATA/trusted-sha.txt" ]; then
  SHA="$(cat "$DATA/trusted-sha.txt")"
  security delete-certificate -Z "$SHA" "$KEYCHAIN" 2>/dev/null || true
fi

# 3. Remove the app + data dir.
rm -rf "$APP" "$DATA"
echo "EU-DSS Agent uninstalled (cert untrusted, LaunchAgent removed, app + data deleted)."
exit 0
```

- [ ] **Step 2: Make it executable + syntax-check**

```bash
chmod +x packaging/macos/scripts/uninstall.sh
bash -n packaging/macos/scripts/uninstall.sh && echo "syntax OK"
```
Expected: `syntax OK`.

- [ ] **Step 3: Commit**

```bash
git add packaging/macos/scripts/uninstall.sh
git commit -m "feat(packaging-macos): uninstall.sh (bootout LaunchAgent + untrust cert + remove)"
```

---

## Task 4: build-agent-pkg.sh + local build

**Files:**
- Create: `packaging/macos/build-agent-pkg.sh`

- [ ] **Step 1: Create `build-agent-pkg.sh`**

```bash
#!/bin/bash
# Build the EU-DSS Agent macOS .pkg: jpackage app-image (bundled JRE) -> pkgbuild -> productbuild.
# Run on macOS with JDK 21. Output: dist/EU-DSS-Agent-<version>.pkg (unsigned).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VERSION="0.1.0"
# jpackage on macOS rejects a version whose first component is 0 (CFBundleVersion rule);
# map 0.x.y -> 1.x.y for --app-version only. VERSION stays 0.1.0 for the jar/pkg name + pkgbuild.
APP_VERSION="1.0.0"
JAR_DIR="$ROOT/eu-dss-agent/target"
JAR="eu-dss-agent-${VERSION}-SNAPSHOT.jar"
if [ ! -f "$JAR_DIR/$JAR" ]; then
  echo "Build the agent jar first:  mvn -pl eu-dss-agent -am -DskipTests package" >&2
  exit 1
fi

JPACKAGE="${JAVA_HOME:-$(/usr/libexec/java_home -v 21)}/bin/jpackage"
"$JPACKAGE" --version >/dev/null || { echo "jpackage not found (need JDK 21)" >&2; exit 1; }

STAGING="$(mktemp -d)/input"; mkdir -p "$STAGING"
cp "$JAR_DIR/$JAR" "$STAGING/"

APPDIR="$ROOT/build/macos-appimage"
rm -rf "$APPDIR"; mkdir -p "$APPDIR"
"$JPACKAGE" --type app-image \
  --name "EU-DSS Agent" \
  --app-version "$APP_VERSION" \
  --vendor "LINAGORA" \
  --input "$STAGING" \
  --main-jar "$JAR" \
  --main-class com.linagora.eudss.agent.AgentMain \
  --dest "$APPDIR"

OUT="$ROOT/dist"; mkdir -p "$OUT"
COMPONENT="$(mktemp -d)/component.pkg"
pkgbuild --component "$APPDIR/EU-DSS Agent.app" \
  --install-location /Applications \
  --scripts "$ROOT/packaging/macos/scripts" \
  --identifier com.linagora.eudss.agent \
  --version "$VERSION" \
  "$COMPONENT"

productbuild --package "$COMPONENT" "$OUT/EU-DSS-Agent-${VERSION}.pkg"
echo "PKG written to $OUT/EU-DSS-Agent-${VERSION}.pkg"
```

- [ ] **Step 2: Make it executable + syntax-check**

```bash
chmod +x packaging/macos/build-agent-pkg.sh
bash -n packaging/macos/build-agent-pkg.sh && echo "syntax OK"
```
Expected: `syntax OK`.

- [ ] **Step 3: Build the agent jar**

Run: `mvn -pl eu-dss-agent -am -DskipTests package`
Expected: `BUILD SUCCESS`; `eu-dss-agent/target/eu-dss-agent-0.1.0-SNAPSHOT.jar` exists.

- [ ] **Step 4: Build the .pkg locally**

Run: `./packaging/macos/build-agent-pkg.sh`
Expected: ends with `PKG written to .../dist/EU-DSS-Agent-0.1.0.pkg`.

- [ ] **Step 5: Sanity-check the .pkg contents**

Run:
```bash
pkgutil --payload-files dist/EU-DSS-Agent-0.1.0.pkg | grep -E "EU-DSS Agent.app/Contents/MacOS|Contents/runtime" | head
pkgutil --check-signature dist/EU-DSS-Agent-0.1.0.pkg 2>&1 | head -3   # expect: unsigned (no error)
```
Expected: payload lists the `.app` with a bundled `Contents/runtime`; signature check reports it is unsigned (that is intended for now).

- [ ] **Step 6: Commit**

```bash
git add packaging/macos/build-agent-pkg.sh
git commit -m "feat(packaging-macos): build-agent-pkg.sh (jpackage app-image -> pkgbuild/productbuild)"
```

---

## Task 5: CI workflow

**Files:**
- Create: `.github/workflows/macos-installer.yml`

- [ ] **Step 1: Create the workflow**

```yaml
name: macOS installer (pkg)

on:
  workflow_dispatch:
  push:
    tags: ['v*']

jobs:
  build-pkg:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '21'
      - name: Build agent jar
        run: mvn -B -f pom.xml -pl eu-dss-agent -am -DskipTests package
      - name: Build .pkg (jpackage + pkgbuild)
        run: ./packaging/macos/build-agent-pkg.sh
      - name: Upload pkg
        uses: actions/upload-artifact@v4
        with:
          name: eu-dss-agent-pkg
          path: dist/*.pkg
          if-no-files-found: error
```

- [ ] **Step 2: Commit + push**

```bash
git add .github/workflows/macos-installer.yml
git commit -m "ci(macos): build the agent .pkg on macos-latest (arm64)"
git push origin eu-dss
```

- [ ] **Step 3: Trigger CI + watch**

Run:
```bash
gh workflow run macos-installer.yml -R mmaudet/twake-eu-dss-module --ref eu-dss
sleep 8 && gh run list --workflow=macos-installer.yml -R mmaudet/twake-eu-dss-module -L 1
# then watch the newest run id:
gh run watch <run-id> -R mmaudet/twake-eu-dss-module --exit-status --interval 15
```
Expected: `BUILD SUCCESS`; the `eu-dss-agent-pkg` artifact is produced. If the build fails, read `gh run view <id> --log-failed` and fix `build-agent-pkg.sh`.

---

## Task 6: Local install + acceptance verification (on the arm64 dev Mac)

**Files:** none (manual acceptance, fully reversible via `uninstall.sh`).

> ⚠️ This modifies the **System keychain** and `/Library` of the dev Mac. Reversible via `sudo "/Library/Application Support/eudss-agent/uninstall.sh"`. Requires `sudo` (admin password).

- [ ] **Step 1: Install the .pkg**

Run: `sudo installer -pkg dist/EU-DSS-Agent-0.1.0.pkg -target /`
Expected: `installer: The install was successful.`

- [ ] **Step 2: Verify provisioning artifacts**

Run:
```bash
ls -l "/Library/Application Support/eudss-agent/"   # agent-keystore.p12, agent.cer, trusted-sha.txt, uninstall.sh
security find-certificate -c localhost /Library/Keychains/System.keychain >/dev/null && echo "cert in System keychain: YES"
test -f /Library/LaunchAgents/com.linagora.eudss.agent.plist && echo "plist: YES"
```
Expected: all four data files present; `cert in System keychain: YES`; `plist: YES`.

- [ ] **Step 2b: Verify the cert is actually trusted (not just present)**

Run: `security verify-cert -c "/Library/Application Support/eudss-agent/agent.cer" -p ssl -s localhost`
Expected: `...certificate verification successful.` (trust settings honored).

- [ ] **Step 3: Verify the agent is running (auto-started) + serves trusted HTTPS**

Run:
```bash
launchctl print "gui/$(id -u)/com.linagora.eudss.agent" >/dev/null 2>&1 && echo "LaunchAgent loaded: YES"
sleep 2
curl -fsS https://localhost:9795/rest/health   # expect {"status":"ok"} WITHOUT -k
```
Expected: `LaunchAgent loaded: YES`; `{"status":"ok"}`. (`curl` may or may not consult the keychain; the authoritative trust test is Step 4.)

- [ ] **Step 4: Verify NO browser cert warning (the headline outcome)**

Open `https://localhost:9795/rest/health` in **Safari** and in **Chrome**.
Expected: the JSON `{"status":"ok"}` shows with **no certificate warning** in either browser.

- [ ] **Step 5: End-to-end signature with the real token**

Start the dev stack (server + UI) and sign a document with the token plugged in (PIN entered in the app at signing time), confirming the full chain works against the auto-started agent.
Expected: a signed PAdES document is produced.

- [ ] **Step 6: Verify uninstall cleanup**

Run:
```bash
sudo "/Library/Application Support/eudss-agent/uninstall.sh"
security find-certificate -c localhost /Library/Keychains/System.keychain >/dev/null 2>&1 && echo "STILL PRESENT (bad)" || echo "cert removed: YES"
test -e /Library/LaunchAgents/com.linagora.eudss.agent.plist && echo "plist STILL PRESENT (bad)" || echo "plist removed: YES"
test -e "/Applications/EU-DSS Agent.app" && echo "app STILL PRESENT (bad)" || echo "app removed: YES"
```
Expected: `cert removed: YES`, `plist removed: YES`, `app removed: YES`.

- [ ] **Step 7: Record the outcome**

No commit (verification only). If any step fails, fix the relevant script (Task 2/3/4) and re-run from Step 1 (reinstall).

---

## Task 7: Document the macOS .pkg in INSTALL.md

**Files:**
- Modify: `docs/INSTALL.md` (the `## 3. macOS` section)

> Do this only after Task 6 passes, so the doc matches verified behavior.

- [ ] **Step 1: Replace the macOS section body**

In `docs/INSTALL.md`, under `## 3. macOS`, add the `.pkg` path as the recommended option (keeping the manual jar path as the developer alternative). Use this content:

```markdown
## 3. macOS

### Installeur .pkg (recommandé)

1. Installez le **middleware ChamberSign** (module PKCS#11 `/Library/SCMiddleware/libidop11.dylib`) et branchez votre token.
2. Téléchargez **`EU-DSS-Agent-0.1.0.pkg`** (voir Releases). Comme il n'est pas encore signé, au premier lancement : **clic droit sur le .pkg → Ouvrir** (puis confirmez), ou Réglages Système → Confidentialité et sécurité → « Ouvrir quand même ».
3. Installez (mot de passe administrateur demandé). À la fin, l'agent :
   - fait confiance à son certificat `localhost` dans le **trousseau Système** (aucun avertissement dans Safari/Chrome) ;
   - démarre automatiquement à l'ouverture de session (LaunchAgent).
4. Ouvrez l'application de signature : « Agent connecté » doit apparaître.

> **Désinstaller** : `sudo "/Library/Application Support/eudss-agent/uninstall.sh"` (macOS n'a pas de désinstalleur .pkg natif).
> **Firefox** garde son propre magasin de certificats (NSS) — non couvert par le trousseau Système (suivi séparé).

### Alternative développeur (exécuter le jar)

1. Installez **Temurin JDK 21** et le middleware ChamberSign. Branchez votre token.
2. Construisez l'agent : `mvn -DskipTests package`
3. Lancez-le : `bin/eu-dss-agent-macos.sh` (l'agent démarre **verrouillé** ; le PIN sera demandé dans l'application au moment de signer).
4. Ouvrez **une fois** `https://localhost:9795/rest/health` et acceptez le certificat auto-signé (l'approbation automatique est gérée par le .pkg ci-dessus).

> **Linux** : identique à l'alternative développeur, avec le module PKCS#11 `/usr/lib/libidop11.so` et le script `bin/eu-dss-agent-linux.sh`.
```

- [ ] **Step 2: Commit**

```bash
git add docs/INSTALL.md
git commit -m "docs(install): document the macOS .pkg (System-keychain trust + auto-start + uninstall)"
```

---

## Self-Review (completed by plan author)

- **Spec coverage:** ① build jpackage app-image + pkgbuild/productbuild → Task 4 + Task 5 (CI). ② no Java change, `EUDSS_AGENT_KEYSTORE` machine-wide → used in the plist (Task 1) + postinstall (Task 2), no agent task. ③ postinstall provision + `security add-trusted-cert` System keychain + SHA + LaunchAgent + bootstrap → Task 2. ④ uninstall.sh → Task 3 (+ dropped by Task 2 step 5). ⑤ CI macos-latest arm64 → Task 5. ⑥ local acceptance (keychain, no browser warning, auto-start, sign, uninstall) → Task 6. Doc → Task 7. Acceptance criteria 1–5 of the spec ↔ Task 6 steps 2–6. ✓
- **Placeholder scan:** none — every script is shown in full; commands have expected output; no "TBD"/"handle errors". ✓
- **Type/Name consistency:** `com.linagora.eudss.agent` Label/identifier consistent (plist ↔ pkgbuild `--identifier` ↔ `launchctl …/com.linagora.eudss.agent` ↔ plist filename). Paths consistent across tasks: app `/Applications/EU-DSS Agent.app/Contents/MacOS/EU-DSS Agent`; data `/Library/Application Support/eudss-agent/{agent-keystore.p12,agent.cer,trusted-sha.txt,uninstall.sh}`; plist `/Library/LaunchAgents/com.linagora.eudss.agent.plist`; keychain `/Library/Keychains/System.keychain`. `EUDSS_AGENT_KEYSTORE` value identical in plist (Task 1) and postinstall provision call (Task 2). SHA stored colon-stripped (postinstall) and consumed by `security delete-certificate -Z` (uninstall). Version `0.1.0` consistent (build script ↔ pkg name ↔ doc). ✓
