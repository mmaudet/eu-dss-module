# EU-DSS Sign — deep-link test client

A tiny, dependency-free Node server that simulates an **external web app** driving
*EU-DSS Sign* through the `eudss://` deep link — both **signing** a document and
**validating** the result, each time receiving the outcome on a callback.

See the full integration guide: [`docs/deeplink-integration.md`](../docs/deeplink-integration.md).

## Prerequisites

- **Node.js ≥ 18**.
- *EU-DSS Sign* **installed** (or, on Linux/Windows, `npm run tauri dev` running) so the
  `eudss://` URL scheme is registered with the OS.
  - On **macOS**, deep links only resolve to a **built/installed** `.app` (the scheme
    lives in the bundle's `Info.plist`); `tauri dev` is not enough.
- Your PKCS#11 token plugged in (you will be asked for the PIN when **signing**;
  validation needs no token/PIN).

## Run

```bash
node deeplink-test.mjs          # http://localhost:8787  (override: node deeplink-test.mjs 9000  or  PORT=9000 …)
```

Open <http://localhost:8787>, then:

1. **« Signer avec EU-DSS »** — builds `eudss://sign?doc_url=…/doc.pdf&callback_url=…/callback&state=…`.
   The app downloads a small valid PDF (generated on the fly), shows a confirmation
   screen, asks for the **PIN**, signs (PAdES-B-T / ASiC-E), and POSTs the signed
   document back. It is saved to **`./received/`** and the page shows it.
2. **« Valider le dernier document signé »** (enabled after a signature) — builds
   `eudss://verify?doc_url=…/last-signed&callback_url=…/verify-callback&state=…`.
   The app downloads that just-signed document, validates it (no PIN), and POSTs the
   **validation report** back; the page shows the verdict (signature count + each
   signer's `indication`).

## Endpoints

| Method | Path                | Purpose                                              |
|--------|---------------------|------------------------------------------------------|
| GET    | `/`                 | the test page (sign + verify)                        |
| GET    | `/doc.pdf`          | the document to sign (generated, valid PDF)          |
| POST   | `/callback`         | receives the **signed** document from the app        |
| GET    | `/last-signed`      | serves the most recent signed document (verify input)|
| POST   | `/verify-callback`  | receives the **validation report** from the app      |
| GET    | `/result?state=…`   | sign-result poll                                     |
| GET    | `/verify-result?state=…` | verify-result poll                              |
| GET    | `/received/<f>`     | download a previously received signed file           |

## Troubleshooting

- **Clicking a button does nothing / "no app for eudss://"** — the app isn't installed
  or the scheme isn't registered. Install the app; on macOS use the built `.app`.
- **The app opens but can't fetch the document** — make sure this server is running on
  the same `localhost` port the link points to.
- **Validate says "Indéterminé"** — the signing certificate's trust anchor may not be in
  the loaded EU trust list, or LOTL refresh is disabled; check the returned report.
- **Timeout, no callback** — confirm the app finished (PIN entered for signing) and that
  the callback URL is reachable from the machine running the app.
