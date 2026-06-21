# Deep-Link Signing — Design

**Status:** approved — protocol decisions confirmed by the user 2026-06-21.
**Goal:** Let an external web app trigger document signing in *EU-DSS Sign* via an
`eudss://` deep link, and receive the signed document back.

## Protocol

External site opens:

```
eudss://sign?doc_url=<urlencoded>&callback_url=<urlencoded>&state=<opaque,optional>
```

- `doc_url` — HTTPS (or `localhost`/`127.0.0.1` for testing) URL the app GETs to
  obtain the document to sign.
- `callback_url` — URL the app POSTs the signed document to.
- `state` — opaque string echoed back verbatim for request correlation (optional).

Flow:

1. OS launches / focuses *EU-DSS Sign* with the URL.
2. App fetches `doc_url` → document bytes, filename, media type.
3. App shows a **confirmation screen**: filename, resolved signature format,
   callback host. The trigger is untrusted, so explicit user consent + PIN are
   mandatory — never silent signing.
4. On confirm, the app runs the **existing** pipeline:
   `POST /api/sign/prepare` → Tauri `invoke('sign')` (PKCS#11) →
   `POST /api/sign/assemble`.
5. App POSTs to `callback_url` (JSON):
   `{ state, signedFileName, mediaType, signedDocumentBase64 }`.
6. App shows success/failure.

### Decisions (confirmed)

- **Transport = `doc_url`** (app downloads). Identical for local test and real
  remote apps; stateless.
- **Result = POST to `callback_url`** (webhook model).
- **v1 scope = sign only** (verify is a trivial later addition). No encryption.

## Components

1. **Rust / config** — `tauri-plugin-deep-link` registers the `eudss` scheme;
   `tauri-plugin-single-instance` forwards the URL to an already-running instance
   (required on Linux/Windows). Capability grants `deep-link:default`. The doc
   fetch and the callback POST both happen in the **frontend** via
   `tauri-plugin-http` (CORS-free), so the Rust side is pure plumbing.
2. **Frontend** — an `onOpenUrl` / `getCurrent` handler parses the URL, fetches
   the doc, shows the confirmation modal, reuses the sign pipeline (`signOne`
   core), POSTs the callback, shows the result.
3. **Test client** — `test-client/deeplink-test.mjs`: a one-file Node server that
   serves a sample PDF at `doc_url`, hosts the `callback_url`, and serves an HTML
   page with a "Signer avec EU-DSS" button. Verifies the full round-trip locally.

## Security

- Any site can fire `eudss://`. The confirmation screen (what / where) + the PIN
  are the trust gate. No silent or background signing.
- `state` is echoed verbatim; the app never interprets it.
- The HTTP capability scope permits `https://**`, `http://localhost:**`,
  `http://127.0.0.1:**` only.
- SSRF note: `doc_url` is fetched by the app, but the confirmation screen shows
  the resolved filename/size before anything is signed, and signing requires the
  PIN — this bounds misuse.

## Reused wiring (from the existing Sign flow)

- prepare/assemble: `backendApi.prepare` / `backendApi.assemble`
  (`eu-dss-ui/src/components/SignWorkspace.tsx`, `services/backendApi.ts`).
- token sign: Tauri `invoke('sign', {keyId, digestBase64, digestAlgorithm})`
  (`src-tauri/src/commands.rs` → `eudss-signer`).
- PIN unlock: `ensureUnlocked()` (`src/agent/AgentContext.tsx`) → Tauri `unlock`.
- format-by-type: `defaultForm(name)` (already added in `SignWorkspace.tsx`).
