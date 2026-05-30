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
