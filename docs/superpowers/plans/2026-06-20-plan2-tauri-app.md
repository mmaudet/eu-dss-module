# Plan 2: Tauri app shell + IPC bridge (standalone signing client)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrap the existing `eu-dss-ui` React app in a native Tauri 2 desktop app whose Rust side owns the token via the `eudss-signer` crate, so signing happens over native IPC instead of a `fetch` to `https://localhost:9795` — removing the localhost bridge while keeping the same UI and the hosted DSS backend.

**Architecture:** One UI codebase runs in two environments. In a browser it keeps the current behaviour (`agentApi` → `fetch(localhost:9795)`, `backendApi` → `/api` Vite proxy). Inside the Tauri app, `agentApi` switches to Tauri `invoke()` calls handled by Rust commands that wrap a managed `eudss_signer::Signer` (real-card-validated in Plan 1), and `backendApi` calls the hosted backend through the Tauri HTTP plugin (Rust-side requests, no browser CORS). The webview loads the bundled UI (same-origin, so injecting native signing is safe). No deep-link yet (that is Plan 3).

**Tech Stack:** Tauri 2.10 (already installed), Rust + `eudss-signer` (path dep), `@tauri-apps/api`, `@tauri-apps/plugin-http`, the existing Vite 6 + React 19 + TS UI.

This is Plan 2 of 5 (see `docs/superpowers/specs/2026-06-20-option-a-tauri-signing-client-design.md`). It depends on Plan 1 (the `eudss-signer` crate, merged to `eu-dss`). It does NOT build the deep-link / jobs flow (Plan 3), detached XAdES (Plan 4), or code-signing/packaging (Plan 5).

---

## Conventions

- Paths relative to repo root `/Users/mmaudet/work/eu-dss`.
- The Tauri project lives at `eu-dss-ui/src-tauri/` (Tauri's standard "frontend with src-tauri" layout). Frontend commands run from `eu-dss-ui/`; cargo commands from `eu-dss-ui/src-tauri/`.
- Commit messages use scope `app` (the new Tauri app) or `signer` (crate changes).
- The Signer config (PKCS#11 module path, slot, TTL) mirrors the Java agent's per-OS defaults: macOS `/Library/SCMiddleware/libidop11.dylib`, Linux `/usr/lib/SCMiddleware/libidop11.so`, Windows `C:\\Program Files\\Smart Card Middleware\\bin\\idoPKCS.dll`; slot 0; TTL 300s. Overridable via `EUDSS_PKCS11_MODULE` / `EUDSS_PKCS11_SLOT`.

### Contract preserved (so AgentContext + components do not change)

`agentApi` keeps this exact shape (from `eu-dss-ui/src/services/agentApi.ts`), in both environments:
`isAvailable(): Promise<boolean>`, `getStatus(): Promise<AgentSessionStatus>`, `unlock(pin): Promise<AgentSessionStatus>`, `lock(): Promise<{status}>`, `listCertificates(): Promise<{certificates: AgentCertificate[]}>`, `signDigest(keyId, digestBase64, digestAlgorithm): Promise<{signatureValueBase64}>`. Errors remain `AgentError(status, code, message)` with codes `pin_incorrect | pin_locked | token_unavailable | locked`.

---

## Task 0: Make `eudss-signer` types serde-ready (+ apply Plan 1 review cleanups)

Tauri commands must return `Serialize` types whose JSON keys match `agentApi.ts`.

**Files:**
- Modify: `eudss-signer/Cargo.toml`
- Modify: `eudss-signer/src/signer.rs`
- Modify: `eudss-signer/src/token.rs` (field renames)
- Modify: `eudss-signer/src/error.rs`

- [ ] **Step 1: Add serde + drop the redundant zeroize dep in `eudss-signer/Cargo.toml`**

In `[dependencies]`: add `serde = { version = "1", features = ["derive"] }`. Remove the `zeroize = "1"` line (zeroization is handled transitively by `secrecy`; Plan 1 final review flagged it as unused).

- [ ] **Step 2: Write the failing serde round-trip test in `eudss-signer/src/signer.rs` (tests module)**

```rust
#[cfg(test)]
mod serde_tests {
    use super::*;

    #[test]
    fn session_status_serializes_camelcase() {
        let s = SessionStatus { unlocked: true, expires_in_seconds: Some(300), mode: "interactive" };
        let j = serde_json::to_string(&s).unwrap();
        assert!(j.contains("\"unlocked\":true"));
        assert!(j.contains("\"expiresInSeconds\":300"));
        assert!(j.contains("\"mode\":\"interactive\""));
    }

    #[test]
    fn cert_entry_serializes_agent_keys() {
        let c = CertEntry {
            key_id: "AB".into(),
            certificate_base64: "Zm9v".into(),
            certificate_chain_base64: vec!["Zm9v".into()],
            subject_dn: "CN=x".into(),
            issuer_dn: "CN=y".into(),
            serial_number: "01".into(),
            not_before: "a".into(),
            not_after: "b".into(),
        };
        let j = serde_json::to_string(&c).unwrap();
        for k in ["keyId", "certificateBase64", "certificateChainBase64", "subjectDn",
                  "issuerDn", "serialNumber", "notBefore", "notAfter"] {
            assert!(j.contains(&format!("\"{k}\"")), "missing key {k} in {j}");
        }
    }
}
```

Add `serde_json = "1"` to `[dev-dependencies]` for the test.

- [ ] **Step 3: Run it (fails to compile: fields renamed, no derives)**

Run: `cd eudss-signer && cargo test serde_`
Expected: FAIL.

- [ ] **Step 4: Derive serde + rename fields in `eudss-signer/src/signer.rs`**

Rename the two base64 fields to `certificate_base64` / `certificate_chain_base64` (so `camelCase` yields the agent keys) and add derives:

```rust
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    pub unlocked: bool,
    pub expires_in_seconds: Option<u64>,
    pub mode: &'static str, // Plan 1: only "interactive" exists; "headless" is a future variant
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CertEntry {
    pub key_id: String,
    pub certificate_base64: String,
    pub certificate_chain_base64: Vec<String>,
    pub subject_dn: String,
    pub issuer_dn: String,
    pub serial_number: String,
    pub not_before: String,
    pub not_after: String,
}
```

- [ ] **Step 5: Update the two field names in `eudss-signer/src/token.rs`**

In `list_certificates`, change the `CertEntry` construction fields `certificate_b64:` → `certificate_base64:` and `certificate_chain_b64:` → `certificate_chain_base64:` (values unchanged).

- [ ] **Step 6: Make `SignerError` serializable for command results in `eudss-signer/src/error.rs`**

Add a small serializable view used at the Tauri boundary (keep `SignerError` itself as the rich internal type):

```rust
use serde::Serialize;

/// Wire-form of an error for the IPC boundary: the agent-compatible code + a message.
#[derive(Debug, Clone, Serialize)]
pub struct ErrorBody {
    pub error: String,
    pub message: String,
}

impl From<&SignerError> for ErrorBody {
    fn from(e: &SignerError) -> Self {
        ErrorBody { error: e.code().to_string(), message: e.to_string() }
    }
}
```

Re-export from `lib.rs`: add `pub use error::ErrorBody;`.

- [ ] **Step 7: Run the full crate suite**

```bash
cd eudss-signer && eval "$(tests/setup_softhsm.sh)" && cargo test --all-targets && cargo clippy --all-targets -- -D warnings && cargo fmt --check
```
Expected: all tests pass (29 now: 27 + 2 serde), clippy + fmt clean.

- [ ] **Step 8: Commit**

```bash
git add eudss-signer/
git commit -m "feat(signer): serde-ready types (camelCase) for the Tauri IPC boundary"
```

---

## Task 1: Scaffold the Tauri 2 app

**Files:**
- Create: `eu-dss-ui/src-tauri/` (Cargo.toml, tauri.conf.json, src/lib.rs, src/main.rs, build.rs, capabilities/)
- Modify: `eu-dss-ui/package.json`
- Modify: `eu-dss-ui/.gitignore` (add `src-tauri/target`)

- [ ] **Step 1: Initialise Tauri in the existing UI**

```bash
cd eu-dss-ui
npm install -D @tauri-apps/cli@^2
npx tauri init --ci \
  --app-name "EU-DSS Sign" \
  --window-title "EU-DSS Sign" \
  --frontend-dist ../dist \
  --dev-url http://localhost:5173 \
  --before-dev-command "npm run dev" \
  --before-build-command "npm run build"
```

This creates `eu-dss-ui/src-tauri/`. Verify `src-tauri/tauri.conf.json` has `build.frontendDist = "../dist"`, `build.devUrl = "http://localhost:5173"`.

- [ ] **Step 2: Add the crate + plugins to `eu-dss-ui/src-tauri/Cargo.toml`**

Under `[dependencies]` add:

```toml
eudss-signer = { path = "../../eudss-signer" }
tauri-plugin-http = "2"
serde_json = "1"
```

(`tauri`, `serde`, `serde_json` are already present from `tauri init`.)

- [ ] **Step 3: Add the JS API packages to `eu-dss-ui/package.json`**

```bash
cd eu-dss-ui && npm install @tauri-apps/api@^2 @tauri-apps/plugin-http@^2
```

Add a script: `"tauri": "tauri"`.

- [ ] **Step 4: Ignore the Rust build dir**

Append to `eu-dss-ui/.gitignore` (create if absent): `src-tauri/target` and `src-tauri/gen`.

- [ ] **Step 5: Verify the shell builds (no commands yet)**

```bash
cd eu-dss-ui/src-tauri && cargo build
```
Expected: compiles (a bare Tauri app depending on eudss-signer).

- [ ] **Step 6: Commit**

```bash
git add eu-dss-ui/src-tauri eu-dss-ui/package.json eu-dss-ui/package-lock.json eu-dss-ui/.gitignore
git commit -m "feat(app): scaffold Tauri 2 app wrapping eu-dss-ui"
```

---

## Task 2: Managed Signer state + a lazy opener

The `Signer` is stateful (holds the session). Tauri holds it in managed state, opened lazily on first use so the app starts even with no token, surfacing `token_unavailable` cleanly.

**Files:**
- Create: `eu-dss-ui/src-tauri/src/signer_state.rs`
- Modify: `eu-dss-ui/src-tauri/src/lib.rs`

- [ ] **Step 1: Implement the managed state in `eu-dss-ui/src-tauri/src/signer_state.rs`**

```rust
use eudss_signer::{ErrorBody, Signer, SignerError};
use std::sync::Mutex;
use std::time::Duration;

/// Per-OS default PKCS#11 module path (overridable via EUDSS_PKCS11_MODULE).
fn default_module() -> String {
    if let Ok(p) = std::env::var("EUDSS_PKCS11_MODULE") {
        return p;
    }
    #[cfg(target_os = "macos")]
    { "/Library/SCMiddleware/libidop11.dylib".into() }
    #[cfg(target_os = "linux")]
    { "/usr/lib/SCMiddleware/libidop11.so".into() }
    #[cfg(target_os = "windows")]
    { "C:\\Program Files\\Smart Card Middleware\\bin\\idoPKCS.dll".into() }
}

fn default_slot() -> usize {
    std::env::var("EUDSS_PKCS11_SLOT").ok().and_then(|s| s.parse().ok()).unwrap_or(0)
}

/// Lazily-opened Signer. `None` until the first successful open.
#[derive(Default)]
pub struct SignerState(pub Mutex<Option<Signer>>);

impl SignerState {
    /// Run `f` with an open Signer, opening it on first use. Maps errors to ErrorBody.
    pub fn with<T>(
        &self,
        f: impl FnOnce(&mut Signer) -> Result<T, SignerError>,
    ) -> Result<T, ErrorBody> {
        let mut guard = self.0.lock().map_err(|_| ErrorBody {
            error: "internal".into(),
            message: "signer mutex poisoned".into(),
        })?;
        if guard.is_none() {
            let signer = Signer::new(&default_module(), default_slot(), Duration::from_secs(300))
                .map_err(|e| ErrorBody::from(&e))?;
            *guard = Some(signer);
        }
        let signer = guard.as_mut().unwrap();
        f(signer).map_err(|e| ErrorBody::from(&e))
    }
}
```

- [ ] **Step 2: Register the state + plugins in `eu-dss-ui/src-tauri/src/lib.rs`**

```rust
mod commands;
mod signer_state;

use signer_state::SignerState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .manage(SignerState::default())
        .invoke_handler(tauri::generate_handler![
            commands::status,
            commands::is_available,
            commands::unlock,
            commands::lock,
            commands::list_certificates,
            commands::sign,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 3: Build (will fail: commands module missing) — that is expected; Task 3 adds it.**

Run: `cd eu-dss-ui/src-tauri && cargo build`
Expected: FAIL (unresolved `commands`). Proceed to Task 3.

---

## Task 3: Tauri commands wrapping the Signer

**Files:**
- Create: `eu-dss-ui/src-tauri/src/commands.rs`

- [ ] **Step 1: Implement the commands in `eu-dss-ui/src-tauri/src/commands.rs`**

```rust
use crate::signer_state::SignerState;
use eudss_signer::{CertEntry, ErrorBody, SessionStatus};
use tauri::State;

#[tauri::command]
pub fn status(state: State<SignerState>) -> Result<SessionStatus, ErrorBody> {
    // status must not fail just because no token is open yet: report locked/unavailable.
    state.with(|s| Ok(s.status())).or_else(|_| {
        Ok(SessionStatus { unlocked: false, expires_in_seconds: None, mode: "interactive" })
    })
}

#[tauri::command]
pub fn is_available(state: State<SignerState>) -> bool {
    // "available" == the module opens and a token is present (list works without a PIN).
    state.with(|s| s.list_certificates().map(|_| ())).is_ok()
}

#[tauri::command]
pub fn unlock(state: State<SignerState>, pin: String) -> Result<SessionStatus, ErrorBody> {
    state.with(|s| s.unlock(&pin))
}

#[tauri::command]
pub fn lock(state: State<SignerState>) -> Result<(), ErrorBody> {
    state.with(|s| s.lock())
}

#[tauri::command]
pub fn list_certificates(state: State<SignerState>) -> Result<Vec<CertEntry>, ErrorBody> {
    state.with(|s| s.list_certificates())
}

#[tauri::command]
pub fn sign(
    state: State<SignerState>,
    key_id: String,
    digest_base64: String,
    digest_algorithm: String,
) -> Result<String, ErrorBody> {
    state.with(|s| s.sign(&key_id, &digest_base64, &digest_algorithm))
}
```

- [ ] **Step 2: Build the Rust side**

Run: `cd eu-dss-ui/src-tauri && cargo build && cargo clippy -- -D warnings`
Expected: compiles clean. (The `sign` arg names arrive from JS as `keyId`, `digestBase64`, `digestAlgorithm` — Tauri maps camelCase JS args to snake_case Rust params automatically.)

- [ ] **Step 3: Commit**

```bash
git add eu-dss-ui/src-tauri/src
git commit -m "feat(app): managed Signer state + IPC commands (status/unlock/lock/list/sign)"
```

---

## Task 4: Frontend agentApi — Tauri-IPC variant behind the same interface

**Files:**
- Modify: `eu-dss-ui/src/services/agentApi.ts`

- [ ] **Step 1: Add environment detection + the IPC implementation, keeping the same exported `agentApi` shape**

At the top of `agentApi.ts`, keep the existing HTTP implementation but rename its object to `httpAgentApi`, then add:

```ts
// Tauri 2 injects this global; use it to pick the transport.
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function invokeAgent<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    // Rust commands reject with ErrorBody { error, message }.
    const body = e as { error?: string; message?: string };
    throw new AgentError(0, body?.error ?? 'ipc_error', body?.message ?? String(e));
  }
}

const tauriAgentApi = {
  isAvailable: () => invokeAgent<boolean>('is_available'),
  getStatus: () => invokeAgent<AgentSessionStatus>('status'),
  unlock: (pin: string) => invokeAgent<AgentSessionStatus>('unlock', { pin }),
  lock: () => invokeAgent<{ status: string }>('lock').then(() => ({ status: 'locked' })),
  listCertificates: () =>
    invokeAgent<AgentCertificate[]>('list_certificates').then((certificates) => ({ certificates })),
  signDigest: (keyId: string, digestBase64: string, digestAlgorithm: 'SHA256' | 'SHA384' | 'SHA512') =>
    invokeAgent<string>('sign', { keyId, digestBase64, digestAlgorithm }).then(
      (signatureValueBase64) => ({ signatureValueBase64 }),
    ),
};

export const agentApi = isTauri ? tauriAgentApi : httpAgentApi;
```

Note: the `lock` command returns `()` (mapped to `{status:'locked'}`); `list_certificates` returns the array directly (wrapped to `{certificates}`); `sign` returns the base64 string (wrapped to `{signatureValueBase64}`) — all to match the HTTP shapes `AgentContext` expects.

- [ ] **Step 2: Type-check + build the web bundle (must still work as a pure web app)**

```bash
cd eu-dss-ui && npm run build
```
Expected: `tsc -b` + `vite build` succeed. The web build still uses `httpAgentApi` (no `__TAURI_INTERNALS__`), so nothing regresses.

- [ ] **Step 3: Commit**

```bash
git add eu-dss-ui/src/services/agentApi.ts
git commit -m "feat(app): agentApi Tauri-IPC variant behind the same interface"
```

---

## Task 5: Backend transport — hosted backend via the Tauri HTTP plugin (no CORS)

In the browser, `backendApi` uses `/api` (Vite proxy). In the app there is no proxy; calls go to an absolute backend URL through the Tauri HTTP plugin so there is no browser CORS.

**Files:**
- Modify: `eu-dss-ui/src/services/backendApi.ts`
- Modify: `eu-dss-ui/src-tauri/capabilities/default.json`

- [ ] **Step 1: Make `backendApi` environment-aware in `eu-dss-ui/src/services/backendApi.ts`**

Replace the top of the file:

```ts
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
// In the app, call the hosted backend directly (default: local dev backend; override via VITE_BACKEND_URL).
const BASE = isTauri ? (import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:8080/api') : '/api';

// In Tauri, use the plugin's fetch (Rust-side request, no browser CORS). In the browser, native fetch.
async function appFetch(input: string, init?: RequestInit): Promise<Response> {
  if (isTauri) {
    const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
    return tauriFetch(input, init);
  }
  return fetch(input, init);
}
```

Then change `postJson` to call `appFetch` instead of `fetch`. Everything else (prepare/assemble/validate) is unchanged.

- [ ] **Step 2: Grant the HTTP permission for the backend host in `eu-dss-ui/src-tauri/capabilities/default.json`**

Add to the `permissions` array:

```json
{
  "identifier": "http:default",
  "allow": [{ "url": "http://localhost:8080/*" }, { "url": "https://*/*" }]
}
```

(Tighten `https://*/*` to the real hosted backend origin before Plan 5.)

- [ ] **Step 3: Build the web bundle (no regression)**

```bash
cd eu-dss-ui && npm run build
```
Expected: succeeds; web app still uses `/api` + native fetch.

- [ ] **Step 4: Commit**

```bash
git add eu-dss-ui/src/services/backendApi.ts eu-dss-ui/src-tauri/capabilities
git commit -m "feat(app): backend calls via Tauri HTTP plugin in-app (no CORS)"
```

---

## Task 6: Dev smoke — the app opens and reads the real card (no PIN)

**Files:** none (verification task).

- [ ] **Step 1: Run the app in dev**

```bash
cd eu-dss-ui && npm run tauri dev
```
Expected: a native window titled "EU-DSS Sign" opens, the React UI renders. (Vite serves the frontend; Tauri loads it.)

- [ ] **Step 2: Verify the IPC read path against the real card (token plugged, NO PIN)**

In the running app, the `AgentChip` should resolve to "connecté" via `is_available` → `list_certificates` (read-only, no PIN). The certificate dropdown in `SignWorkspace` should show `CN=Michel-Marie MAUDET` (keyId `B353F4B019938222EA8B2EAC6E072D7E60CE2DAF`).

If the chip text still says "localhost:9795", update the `AgentChip` copy in `App.tsx` for the app context (cosmetic; the UX/UI design pass will refine all copy).

Expected: the cert list loads over IPC, proving the native bridge works end to end for the read path. Zero PIN tries consumed.

---

## Task 7: Real-card sign E2E (with the local backend)

**Files:** none (manual real-card + backend verification, like Plan 1's oracle).

- [ ] **Step 1: Start the backend**

```bash
# JDK 21 required (per the demo runbook). From repo root:
( cd eu-dss-server && ./mvnw spring-boot:run )  # serves http://localhost:8080
```

- [ ] **Step 2: In the running Tauri app, sign a PDF**

Pick a small PDF in `SignWorkspace`, click sign, enter the 4-digit Card PIN in the PinModal (one attempt; the Signer never auto-retries). The flow runs: `backendApi.prepare` (HTTP plugin → backend) → `agentApi.signDigest` (IPC → Signer → real card) → `backendApi.assemble` → signed PDF downloaded.

- [ ] **Step 2b: Verify**

Switch to the Verify tab, load the signed PDF: `backendApi.validate` should report the signature (`signedBy = Michel-Marie MAUDET`, a PAdES level). Optionally `pdfsig` the file.

Expected: a real PAdES signature produced entirely through the app (no `https://localhost:9795`, no agent process). Record OS + result.

- [ ] **Step 3: (optional) Confirm an unsigned bundle builds**

```bash
cd eu-dss-ui && npm run tauri build
```
Expected: produces an unsigned `.app`/`.dmg` under `src-tauri/target/release/bundle/`. Code-signing + notarization is Plan 5; this only confirms the bundler runs.

---

## Done criteria for Plan 2

- `eudss-signer` types serialize with the agent-compatible camelCase keys; full crate suite still green.
- `npm run build` (pure web) still succeeds and behaves exactly as before (HTTP transport).
- `npm run tauri dev` opens the app; the real card's certificate loads over IPC with no PIN.
- A PDF signs + validates end-to-end inside the app (real card + local backend), with no localhost bridge in the path.

## What comes next (not in this plan)

- Plan 3: backend jobs API + `eudss://` deep-link so web pages (e.g. a Drive) trigger signing through the app.
- Plan 4: backend detached XAdES signer + explicit format selector.
- Plan 5: per-OS bundles, code-signing (Authenticode / Developer ID + notarization), auto-updater, `eudss://` scheme registration.
- In parallel: the dedicated "claude design" UX/UI pass refines the app's appearance and copy.
