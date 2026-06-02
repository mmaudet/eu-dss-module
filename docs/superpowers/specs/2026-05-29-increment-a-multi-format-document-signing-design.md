# eu-dss : Increment A: multi-format document signing (design)

- **Date:** 2026-05-29
- **Status:** design APPROVED, ready for implementation planning
- **Scope:** Increment A of the eu-dss signing webapp. Increments B and C are deferred (see §10).

## 1. Goal & context

Product vision: a React web app where a connected user can **upload one or more documents, sign them, co-sign them (a second signer adds their own signature), and validate them**, from a browser, using the beneficiary's **own** cryptographic keys (USB token / PKCS#11), at eIDAS **AES** level minimum.

Works today: single-PDF PAdES-B-T signing end-to-end (UI → backend `prepare`/`assemble` → local agent signs a digest with the IDEMIA/ChamberSign token on slot 0) + validation against the EU LOTL (FR) → `TOTAL_PASSED` / `AdESig-QC`. Stack: `eu-dss-server` (Spring Boot / DSS 6.4), `eu-dss-agent` (Javalin PKCS#11 bridge), `eu-dss-ui` (React 19 / Vite).

Increment A extends this to **multiple documents** and **multiple formats**, with **co-signature** and **batch** UX, keeping the current local topology.

## 2. CDC alignment (§7.4.6.3 Signatures)

Covered by A:
- "a minima AES, eIDAS" → PAdES/XAdES-B-T, validated AdES-QC (≥ AES). ✔
- "le bénéficiaire gère ses clés" → USB token via the local agent. ✔
- "support certificats AES et QES" → DSS handles both. ✔
- "signer PDF, docx, xlsx, OpenDocument" → PDF via PAdES; docx/xlsx/ODF via ASiC-E/XAdES. ✔
- co-signature, validation, multi-document. ✔
- Full parapheur + workflow → **not required** by CDC; not built. ✔

Out of this project (user decision 2026-05-29): "signature d'un mail" (S/MIME) and DocuSign/YouSign-equivalent remote signing. Deferred: B and C (§10).

## 3. Key decisions (brainstorming 2026-05-29)

- **Counter-signature = multiple INDEPENDENT signatures** (co-signature). Technically = signing a document that may already contain signatures (PDF incremental update; ASiC add-signature). Same backend operation as a first signature.
- **Invisible** signatures (no visible appearance) for MVP.
- **"Sign all"**: batch, sign N selected documents in one action, **one token session** (single PIN entered at agent start).
- **Formats:** PDF → **PAdES-B-T**; docx/xlsx/ODF (+ any other type) → **ASiC-E + XAdES-B-T**. Signed office artifact = a **`.asice` container** (eIDAS standard), **not** a native OOXML/ODF embedded signature.
- Keep the **3-round-trip external-signing flow**; the **agent is unchanged** (signs a raw digest, format-agnostic).
- **Topology unchanged for A:** UI :5173 + agent :9795 + backend :8080 over HTTP, single machine.

## 4. Architecture & data flow

Per document: UI → `POST /api/sign/prepare` (format-aware) → `{dataToSign, digest}` → agent `POST /rest/sign {keyId, digest, algo}` → `{signatureValue}` → `POST /api/sign/assemble` → signed artifact (`.pdf` or `.asice`). "Sign all" loops this for each selected document, reusing one agent token session. Co-signature = the same flow on a document that already has signatures. Validation: `POST /api/validate` (auto-detects PAdES/ASiC/XAdES/CAdES; trust via the LOTL already wired).

## 5. Backend design (eu-dss-server)

- Add deps: `dss-asic-xades` (and `dss-asic-cades` if needed), versions from `dss-bom`.
- New `DocumentSigningService` (facade): detect format from document name/content → delegate to:
  - `PadesSigningService` (existing) for `application/pdf`;
  - new `AsicSigningService` for docx/xlsx/ODF/others → `ASiCWithXAdESService`, ASiC-E, XAdES-BASELINE-T.
  - Both expose the same contract: `prepare(doc, params) → {dataToSign, digest}` and `assemble(doc, params, signatureValue) → signedDoc`.
- Generalize DTOs: make `SignatureParamsDto` packaging-agnostic (derive PAdES vs ASiC/XAdES from the document type); keep the level conceptually "B-T". Add `documentName` (and/or detected MIME) to drive dispatch; responses carry suggested filename + content type (`application/pdf` or `application/vnd.etsi.asic-e+zip`).
- `/api/validate`: generalize the response to report the detected container/format and per-signature results for any type (already auto-detects; trust + revocation + LOTL wired from prior work).
- TSA: reuse the configured `OnlineTSPSource` for the -T timestamp on both PAdES and XAdES.

## 6. Agent (eu-dss-agent)

**Unchanged.** Signs a raw digest with the local token (slot 0, AES/AdES-QC cert), format-agnostic. `/rest/certificates` and `/rest/sign` as-is.

## 7. UI design (eu-dss-ui)

A **multi-document signing workspace** (React 19 / Vite, current stack):
- Upload / drag-drop 1..N files (PDF + office).
- Document list; per file: name, type, **detected existing signatures** (quick validate call), status (pending / signed / error).
- Actions: **"Sign all"** (batch, one token session) + per-file **"Sign"**. Co-signature is the same "Sign" on a file that already has signatures (UI labels it as such).
- Results: per-file outcome (signed ✓, signature count) + download each + **"Download all (ZIP)"** (client-side zip lib, e.g. fflate/JSZip).
- **Validate** view: drop a signed file → per-signature report (signer, indication, qualification, format, signing time).
- Services: extend `backendApi` (generalized sign/validate), `agentApi` (unchanged); add light tab/route structure if needed.

## 8. Error handling

- Token absent / locked / PIN issue → agent error surfaced **per file** (don't crash the batch).
- Unsupported / empty file → clear per-file error.
- TSA / LOTL transient → signing still succeeds; validation may show INDETERMINATE (documented).
- **Partial batch:** each file independent; report per-file success/failure; never abort the whole batch on one failure.

## 9. Testing

- Backend: extend the E2E suite with an **ASiC sign+validate** test (mirroring the PAdES E2E with the stubbed PKCS#11 + `TestPki`), multi-format dispatch unit tests, and validation of a **co-signed (2-signature)** document. Keep the LOTL gated off in tests (`eudss.lotl.enabled=false`).
- UI: minimal smoke of the upload → sign → download flow if feasible.

## 10. Out of scope (A) / deferred / dropped

- **Deferred** (later increments): **B** (cross-platform browser access, mixed-content, agent packaging Win/macOS/Linux); **C** (multi-user / access / hosting).
- **Dropped from project:** mail / S-MIME signing; DocuSign/YouSign-equivalent remote signing; visible signatures; full parapheur workflow.

## 11. Assumptions / open points

- **ASiC-E + XAdES-B-T accepted** for office formats (vs native OOXML/ODF embedded signatures). If the buyer requires native embedded signatures, that is a separate technology (outside DSS); to confirm with the buyer.
- Single signing certificate per user = the local token's slot-0 cert (AES / AdES-QC).
- All documents in a batch are signed by the same connected user/token.
