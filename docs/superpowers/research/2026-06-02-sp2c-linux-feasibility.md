# SP2c Feasibility Memo — Linux/Ubuntu zero-friction onboarding for the eu-dss agent

**Date:** 2026-06-02 · Status: feasibility (research only, no code changed) · Parallels: SP2 (Windows, shipped) / SP2b (macOS, spec'd 2026-06-02).

> Seeds a future SP2c design spec. Bottom line: feasible and worth doing, but **materially harder than macOS — entirely because of browser trust** (Linux has no universal trust store). Recommend shipping **SP2c-core** (amd64 `.deb`, system-store + Chromium per-user first-run trust, XDG autostart, `/var/lib` keystore) and deferring Firefox/NSS depth, `.rpm`, and arm64. Verifying ChamberSign/IDOPTE Linux `libidop11.so` availability (esp. arm64) is a **blocking prerequisite**.

## Key risks / blockers (read first)

1. **Browser trust is NOT fully solvable the Windows/macOS way.** The system store (`update-ca-certificates`) is read by curl/wget/openssl/Java but **NOT by Chrome/Chromium/Edge or Firefox** — both use their own NSS databases. A root `postinst` cannot cleanly reach every user's future browser profile. This breaks the "no browser warning, ever" guarantee.
2. **`certutil` (libnss3-tools) is the only programmatic path into the Chromium/Firefox stores, and it is per-user, per-profile, and must run as the user** → forces a first-run user-session helper, not a root install step.
3. **Middleware (`libidop11.so`) Linux availability for ChamberSign/IDOPTE is UNVERIFIED**, especially arm64. Hard prerequisite.
4. `jpackage --type deb` cannot inject `postinst`/`prerm` Debian maintainer scripts → assemble the `.deb` ourselves with `dpkg-deb`.
5. Auto-start must run in the **graphical user session** (PC/SC smart-card access) — same lesson as the Windows session-0 bug; use XDG autostart or `systemd --user`, never a root system service.

The agent's OS-agnostic core (`--provision-cert`, `AgentTls.defaultKeystorePath`, `EUDSS_AGENT_KEYSTORE`) is already in place and needs only a Linux branch for the keystore path (`AgentTls.java:42`, `AgentMain.java:27`).

## 1. Package format (Ubuntu-first): `.deb` via jpackage app-image + `dpkg-deb`

`jpackage --type deb` works and bundles a JRE (parallel to MSI / .pkg), Linux-host-only, needs `dpkg-deb`/`fakeroot` (default on `ubuntu-latest`). `--type rpm` later. **But jpackage has no `--postinst`/`--prerm` option.** Recommended path (B): build the app-image, then hand-assemble the `.deb`:

```
jpackage --type app-image --name eu-dss-agent --input <staging> \
         --main-jar eu-dss-agent-<v>.jar \
         --main-class com.linagora.eudss.agent.AgentMain --dest build/appimage
# then:
pkgroot/
  DEBIAN/control          # Package, Version, Depends: pcscd, libccid, libnss3-tools
  DEBIAN/postinst         # provisioning (Points 2/3/4)
  DEBIAN/prerm            # stop user units (best-effort)
  DEBIAN/postrm           # untrust cert, remove /var/lib/eudss-agent
  opt/eu-dss-agent/...    # the jpackage app-image (bundled JRE + launcher)
  etc/xdg/autostart/eu-dss-agent.desktop
dpkg-deb --build --root-owner-group pkgroot dist/eu-dss-agent_<v>_amd64.deb
```

Full version-controlled control over maintainer scripts — the analogue of committing `provision-install.ps1` under `packaging/windows/`. New tree: `packaging/linux/`. Size: **M**.

## 2. THE HARD PART — browser trust on Linux

- **System CA store** (`/usr/local/share/ca-certificates/<name>.crt` + `update-ca-certificates`) → consumed by OpenSSL/curl/wget/Java, **NOT browsers**. Fundamental divergence from Windows (`LocalMachine\Root`) and macOS (System keychain).
- **Chromium family (Chrome/Chromium/Edge/Brave)** → per-user NSS at `~/.pki/nssdb`, via `certutil` (pkg `libnss3-tools`), run **as the user**:
  ```
  certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n "EU-DSS Agent localhost" -i /var/lib/eudss-agent/agent.cer
  ```
- **Firefox** → separate `cert9.db` per profile (`~/.mozilla/firefox/<rand>.default-release/`, plus Snap paths `~/snap/firefox/...` on Ubuntu's default Snap Firefox). Enterprise alternative: `/etc/firefox/policies/policies.json` (`Certificates.Install`) or `security.enterprise_roots.enabled`.
- A root `postinst` **cannot** realistically trust the cert for all users' browsers (misses future users, not-yet-created `~/.pki/nssdb`, Snap-confined Firefox).
- Note: `AutoSelectCertificateForUrls` is for *client* cert selection, **not** server-trust — not applicable.

**Recommendation (two-layer):**
1. Root `postinst`: drop cert into the **system store** (cheap; covers Java/curl/diagnostics).
2. **First-run, user-session step** does browser trust: the autostart-launched agent, on first run, runs an idempotent `certutil -d sql:$HOME/.pki/nssdb -A …` (create nssdb if missing), gated by a marker file — covers Chromium-family for that user automatically. Declare `libnss3-tools` as a `.deb` dependency.
3. **Firefox:** document a one-click "accept the cert", or optionally extend the helper to enumerate `~/.mozilla/firefox/*/` (+ Snap) — flag Snap-confined Firefox as a known gap.

**Bottom line:** Chromium-family → zero-warning per-user via first-run `certutil`; **Firefox / brand-new-user / Snap-Firefox cannot be guaranteed** → SP2c must explicitly accept a residual "accept once" path for those. Do not promise Windows-parity. Size: **L**.

## 3. Auto-start: XDG autostart (recommended) vs `systemd --user`

Must run in the user's graphical session (PC/SC), same rationale as Windows HKLM\Run (not a service).

| | XDG autostart | `systemd --user` |
|---|---|---|
| File (root-installable, machine-wide) | `/etc/xdg/autostart/eu-dss-agent.desktop` | `/usr/lib/systemd/user/eu-dss-agent.service` |
| Enabled for all users by root postinst? | ✓ (drop one file) | ✗ (needs `systemctl --user enable` as each user) |
| Restart-on-crash / journald | ✗ | ✓ |

**Recommend XDG autostart** (one machine-wide file activates for every user's GUI session — cleanest HKLM\Run analogue). Declare `Depends: pcscd, libccid`. Example:
```desktop
[Desktop Entry]
Type=Application
Name=EU-DSS Agent
Exec=/opt/eu-dss-agent/bin/eu-dss-agent
X-GNOME-Autostart-enabled=true
NoDisplay=true
```
Size: **S**.

## 4. Machine-wide keystore path (FHS): `/var/lib/eudss-agent/`

Parallel to Windows `C:\ProgramData\eudss-agent` (`/opt/eu-dss-agent` = app, `/var/lib/eudss-agent` = generated state). Keystore `agent-keystore.p12`, exported `agent.cer`; `--provision-cert` runs as root in `postinst`. Add a Linux branch to `AgentTls.defaultKeystorePath(...)` returning `/var/lib/eudss-agent/agent-keystore.p12` (the `EUDSS_AGENT_KEYSTORE` override already short-circuits, so dev/tests unaffected).

**Permissions / private-key note:** dir `0755 root:root`, `agent.cer` `0644`, `agent-keystore.p12` `0644` (world-readable) for single-user workstations — the key only authenticates a **localhost** listener (low value off-box), but a world-readable key + fixed password (`AgentMain.java:23`) means any local user can impersonate the localhost agent. Call this out; multi-user hardening (per-user keystores) is a follow-up. Mirrors the Windows machine-wide model. Size: **S**.

## 5. Middleware availability (PREREQUISITE TO VERIFY)

Repo hard-codes Linux driver `/usr/lib/libidop11.so` (`AgentConfig.java:18`), but **whether ChamberSign/IDOPTE publishes an Ubuntu `.deb` of `libidop11.so`, and for which arches, is UNKNOWN.** Action: confirm with the vendor — package format, install path (`/usr/lib/...` vs `/usr/lib/x86_64-linux-gnu/...`), and **arch coverage (x86_64 vs arm64)**. Smart-card middleware is frequently x86_64-only on Linux → **arm64 is the likely gap** and would block an arm64 `.deb`. Reader stack `pcscd` + `libccid` is standard in Ubuntu repos (correct `Depends:`). The agent does not ship the module (same policy as Windows/macOS). Size to verify: **S**; impact if arm64 missing: blocks that arch.

## 6. CI — `.github/workflows/linux-installer.yml`

`ubuntu-latest` is **x86_64** → `amd64` `.deb` only. arm64 needs `ubuntu-24.04-arm` (or self-hosted) + arm64 JDK — defer until Point 5 confirms arm64 middleware. Needs `fakeroot`, `binutils`, `dpkg-dev` + Temurin 21 + `packaging/linux/build-agent-deb.sh`. Size: **S**.

## 7. Effort & recommendation

Net: **SP2c is materially harder than SP2b — the whole delta is Point 2 (browser trust / NSS).**

| Component | Size | vs macOS |
|---|---|---|
| 1. `.deb` packaging | M | ≈ `.pkg` |
| 2. Browser trust | **L** | **Much harder** (no universal store; per-user NSS; Firefox/Snap not guaranteed) |
| 3. Auto-start (XDG) | S | ≈ LaunchAgent |
| 4. Keystore `/var/lib` + Java branch | S | ≈ |
| 5. Middleware verification | S to verify / L if arm64 missing | extra risk |
| 6. CI | S | ≈ |

**Split.** Ship **SP2c-core** (packaging + system-store trust + XDG autostart + `/var/lib` keystore + Chromium-family first-run `certutil` helper — zero-warning for the common Chrome/Chromium-on-Ubuntu case), defer **SP2c-firefox** (per-profile `cert9.db` + Snap + enterprise policy), as SP2 deferred Firefox. Keep amd64 `.deb` in core; `.rpm` and arm64 are follow-ups gated on Point 5.
