# EU-DSS Sign — deep-link test client

A tiny, dependency-free Node server that simulates an **external web app** asking
*EU-DSS Sign* to sign a document via the `eudss://` deep link, and receiving the
signed document back on a callback.

## Prerequisites

- **Node.js ≥ 18**.
- *EU-DSS Sign* **installed** (or, on Linux/Windows, `npm run tauri dev` running)
  so the `eudss://` URL scheme is registered with the OS.
  - On **macOS**, deep links only resolve to a **built/installed** `.app` (the
    scheme lives in the bundle's `Info.plist`); `tauri dev` is not enough.
- Your PKCS#11 token plugged in (you will be asked for the PIN, as usual).

## Run

```bash
node deeplink-test.mjs          # http://localhost:8787  (override with: node deeplink-test.mjs 9000  or  PORT=9000 …)
```

Open <http://localhost:8787> and click **« Signer avec EU-DSS »**.

## What happens

1. The page builds and opens:
   ```
   eudss://sign?doc_url=http://localhost:8787/doc.pdf
               &callback_url=http://localhost:8787/callback
               &state=<uuid>
   ```
2. The OS launches *EU-DSS Sign*, which **downloads** `doc.pdf` (a small valid PDF
   this server generates on the fly).
3. The app shows a **confirmation screen** (filename, signature format, destination
   host) and asks for the **PIN** — nothing is signed silently.
4. The app signs (PAdES-B-T) and **POSTs** the signed document to `callback_url`
   as JSON `{ state, signedFileName, mediaType, signedDocumentBase64 }`.
5. This server saves it to **`./received/`** and the page shows
   `✅ Document signé reçu … télécharger`.

## Endpoints

| Method | Path           | Purpose                                            |
|--------|----------------|----------------------------------------------------|
| GET    | `/`            | the test page                                      |
| GET    | `/doc.pdf`     | the document to sign (generated, valid PDF)        |
| POST   | `/callback`    | receives the signed document from the app          |
| GET    | `/result?state=…` | the page polls this to learn the callback arrived |
| GET    | `/received/<f>`| download a previously received signed file         |

## Troubleshooting

- **Clicking the button does nothing / “no app for eudss://”** — the app isn't
  installed or the scheme isn't registered. Install the app; on macOS use the
  built `.app`, not `tauri dev`.
- **The app opens but can't fetch the document** — make sure this server is
  running on the same `localhost` port the link points to.
- **Timeout, no callback** — check the app finished signing (PIN entered) and that
  `callback_url` is reachable from the machine running the app.
