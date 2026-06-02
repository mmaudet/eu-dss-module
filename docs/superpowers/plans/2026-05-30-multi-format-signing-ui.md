# Multi-format document signing : UI (A2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Turn the `eu-dss-ui` Sign page into a multi-document workspace that signs PDF **and** office files, updates to the new backend wire contract, isolates per-file errors, and downloads results individually or as a ZIP, plus generalize the Validate view to any signed document.

**Architecture:** React 19 / Vite, no router (tab state in `App`). A `SignWorkspace` component holds a list of per-file `SignDoc` records (status machine), drives the 3-round-trip flow per file through `backendApi` (new contract) + the unchanged `agentApi`, and downloads via `fileUtils`. Client-side ZIP via `fflate`.

**Tech Stack:** React 19, TypeScript ~5.7, Vite 6, `fflate` (new). **No unit-test runner exists** in this module, so each task is verified with `npm run build` (which runs `tsc -b && vite build`, a real typecheck + bundle) and the final task adds a browser smoke.

**HARD DEPENDENCY (why this plan exists):** the backend wire contract changed in A1 and the current UI still speaks the old one. After A1, requests use `documentBase64` + `documentName`, the level enum is `BASELINE_*` (not `PADES_BASELINE_*`), the assemble response is `{signedDocumentBase64, signedFileName, mediaType}`, and validate takes `documentBase64`. This plan updates the UI to that contract. (The agent contract, `keyId`/`digestBase64`/`digestAlgorithm` → `signatureValueBase64`, is unchanged; `agentApi.ts` stays as-is. The `https://localhost:9795` agent URL and mixed-content/HTTPS are increment **B**, out of scope here.)

**Conventions:** work in `/Users/mmaudet/work/eu-dss/eu-dss-ui`. Build = `cd eu-dss-ui && npm run build`. Commit on branch `eu-dss`.

---

## File Structure

`eu-dss-ui/`:
- `package.json` : ADD dependency `fflate`.
- `src/services/backendApi.ts` : MODIFY: new contract (types + calls).
- `src/services/pdfUtils.ts` → RENAME to `src/services/fileUtils.ts` : generalize download (any media type) + add `downloadZip`.
- `src/components/SignPage.tsx` → REPLACE with `src/components/SignWorkspace.tsx` : per-file workspace.
- `src/components/ValidatePage.tsx` : MODIFY: accept any file; wording.
- `src/App.tsx` : MODIFY: render `SignWorkspace`; header wording.
- `src/styles.css` : MODIFY: add styles for the document list + status badges.

---

## Task 1: New backend contract + generalized file utilities

**Files:** `package.json`, `src/services/backendApi.ts`, rename `src/services/pdfUtils.ts` → `src/services/fileUtils.ts`

- [ ] **Step 1: Add the zip dependency**

Run: `cd /Users/mmaudet/work/eu-dss/eu-dss-ui && npm install fflate@^0.8.2`
Expected: `package.json` gains `"fflate"` under dependencies; `npm` exits 0.

- [ ] **Step 2: Rewrite `src/services/backendApi.ts` to the new contract**

```ts
const BASE = '/api';

export type DigestAlgo = 'SHA256' | 'SHA384' | 'SHA512';
export type SignatureLevel = 'BASELINE_B' | 'BASELINE_T' | 'BASELINE_LT' | 'BASELINE_LTA';

export interface SignatureParams {
  certificateChainBase64: string[];
  digestAlgorithm: DigestAlgo;
  signingTimeEpochMs: number;
  signatureLevel?: SignatureLevel;
  signatureReason?: string;
  signatureLocation?: string;
  signerName?: string;
}

export interface PrepareResponse {
  dataToSignBase64: string;
  dataToSignDigestBase64: string;
}

export interface AssembleResponse {
  signedDocumentBase64: string;
  signedFileName: string;
  mediaType: string;
}

export interface SignatureSummary {
  signatureId: string;
  signatureFormat: string | null;
  indication: string;
  subIndication: string | null;
  signedBy: string | null;
  signingDate: string | null;
}

export interface ValidationResponse {
  signatureCount: number;
  signatures: SignatureSummary[];
  simpleReportXml: string | null;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${path} → HTTP ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export const backendApi = {
  prepare: (documentBase64: string, documentName: string, params: SignatureParams) =>
    postJson<PrepareResponse>('/sign/prepare', { documentBase64, documentName, params }),

  assemble: (
    documentBase64: string,
    documentName: string,
    params: SignatureParams,
    signatureValueBase64: string,
  ) => postJson<AssembleResponse>('/sign/assemble', { documentBase64, documentName, params, signatureValueBase64 }),

  validate: (documentBase64: string) =>
    postJson<ValidationResponse>('/validate', { documentBase64 }),
};
```

- [ ] **Step 3: Rename and generalize the file utilities**

Run: `cd /Users/mmaudet/work/eu-dss/eu-dss-ui && git mv src/services/pdfUtils.ts src/services/fileUtils.ts`
Then replace `src/services/fileUtils.ts` with:

```ts
import { zipSync } from 'fflate';

export async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  return arrayBufferToBase64(buf);
}

export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
  }
  return btoa(parts.join(''));
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function downloadBase64(base64: string, filename: string, mediaType = 'application/octet-stream'): void {
  triggerDownload(new Blob([base64ToBytes(base64)], { type: mediaType }), filename);
}

export function downloadZip(entries: { name: string; base64: string }[], zipName: string): void {
  const files: Record<string, Uint8Array> = {};
  for (const e of entries) files[e.name] = base64ToBytes(e.base64);
  triggerDownload(new Blob([zipSync(files)], { type: 'application/zip' }), zipName);
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
```

- [ ] **Step 4: Build (typecheck). It will FAIL until Task 2/3 update the components**

Run: `cd /Users/mmaudet/work/eu-dss/eu-dss-ui && npx tsc -b`
Expected: type errors ONLY in `SignPage.tsx` / `ValidatePage.tsx` (they still import `pdfUtils`/`downloadBase64Pdf` and use old fields). That's expected; those are replaced in Tasks 2-3. Do NOT fix them here.

- [ ] **Step 5: Commit**

```bash
cd /Users/mmaudet/work/eu-dss
git add eu-dss-ui/package.json eu-dss-ui/package-lock.json eu-dss-ui/src/services/
git commit -m "feat(ui): backend new wire contract + generalized download/zip utils"
```

---

## Task 2: Multi-document Sign workspace

Replaces `SignPage` with `SignWorkspace`: a per-file list with status, multi-format upload, existing-signature detection, sign-all (one token session) + per-file sign, per-file error isolation, and individual + ZIP download.

**Files:** delete `src/components/SignPage.tsx`, create `src/components/SignWorkspace.tsx`, modify `src/App.tsx`, modify `src/styles.css`

- [ ] **Step 1: Create `src/components/SignWorkspace.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { agentApi, AgentCertificate } from '../services/agentApi';
import { backendApi, SignatureParams } from '../services/backendApi';
import { downloadBase64, downloadZip, fileToBase64 } from '../services/fileUtils';

type AgentStatus = 'checking' | 'available' | 'unavailable';
type DocStatus = 'pending' | 'signing' | 'signed' | 'error';

interface SignDoc {
  id: string;
  file: File;
  status: DocStatus;
  existingSignatures: number | null; // null until detected
  signed?: { base64: string; fileName: string; mediaType: string };
  error?: string;
}

let counter = 0;
const nextId = () => `doc-${++counter}`;

export function SignWorkspace() {
  const [agentStatus, setAgentStatus] = useState<AgentStatus>('checking');
  const [certificates, setCertificates] = useState<AgentCertificate[]>([]);
  const [selectedKeyId, setSelectedKeyId] = useState('');
  const [docs, setDocs] = useState<SignDoc[]>([]);
  const [reason, setReason] = useState('Signature électronique');
  const [location, setLocation] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void checkAgent();
  }, []);

  async function checkAgent() {
    setAgentStatus('checking');
    const ok = await agentApi.isAvailable();
    setAgentStatus(ok ? 'available' : 'unavailable');
    if (ok) {
      try {
        const { certificates } = await agentApi.listCertificates();
        setCertificates(certificates);
        if (certificates[0]) setSelectedKeyId(certificates[0].keyId);
      } catch {
        setAgentStatus('unavailable');
      }
    }
  }

  function patch(id: string, p: Partial<SignDoc>) {
    setDocs((d) => d.map((x) => (x.id === id ? { ...x, ...p } : x)));
  }

  function addFiles(list: FileList | null) {
    const added: SignDoc[] = Array.from(list ?? []).map((file) => ({
      id: nextId(),
      file,
      status: 'pending',
      existingSignatures: null,
    }));
    if (added.length === 0) return;
    setDocs((d) => [...d, ...added]);
    added.forEach((doc) => void detect(doc));
  }

  async function detect(doc: SignDoc) {
    try {
      const res = await backendApi.validate(await fileToBase64(doc.file));
      patch(doc.id, { existingSignatures: res.signatureCount });
    } catch {
      patch(doc.id, { existingSignatures: 0 });
    }
  }

  async function signOne(doc: SignDoc, cert: AgentCertificate) {
    patch(doc.id, { status: 'signing', error: undefined });
    try {
      const documentBase64 = await fileToBase64(doc.file);
      const params: SignatureParams = {
        certificateChainBase64: cert.certificateChainBase64,
        digestAlgorithm: 'SHA256',
        signingTimeEpochMs: Date.now(),
        signatureLevel: 'BASELINE_T',
        signatureReason: reason || undefined,
        signatureLocation: location || undefined,
        signerName: cert.subjectDn,
      };
      const prepared = await backendApi.prepare(documentBase64, doc.file.name, params);
      const { signatureValueBase64 } = await agentApi.signDigest(
        cert.keyId,
        prepared.dataToSignDigestBase64,
        'SHA256',
      );
      const assembled = await backendApi.assemble(documentBase64, doc.file.name, params, signatureValueBase64);
      patch(doc.id, {
        status: 'signed',
        signed: {
          base64: assembled.signedDocumentBase64,
          fileName: assembled.signedFileName,
          mediaType: assembled.mediaType,
        },
      });
    } catch (e) {
      patch(doc.id, { status: 'error', error: (e as Error).message });
    }
  }

  async function signAll() {
    const cert = certificates.find((c) => c.keyId === selectedKeyId);
    if (!cert) return;
    setBusy(true);
    for (const doc of docs) {
      if (doc.status !== 'signed') await signOne(doc, cert);
    }
    setBusy(false);
  }

  async function signSingle(doc: SignDoc) {
    const cert = certificates.find((c) => c.keyId === selectedKeyId);
    if (!cert) return;
    setBusy(true);
    await signOne(doc, cert);
    setBusy(false);
  }

  const signedDocs = docs.filter((d) => d.status === 'signed' && d.signed);
  const canSign = agentStatus === 'available' && !!selectedKeyId && docs.length > 0 && !busy;

  return (
    <div>
      <div className="card">
        <h2>1. Agent local (clé USB)</h2>
        {agentStatus === 'checking' && <div className="status info">Vérification…</div>}
        {agentStatus === 'unavailable' && (
          <div className="status warn">
            Agent local introuvable. Lance l'agent puis{' '}
            <button onClick={checkAgent} style={{ marginLeft: 4 }}>recharger</button>.
          </div>
        )}
        {agentStatus === 'available' && certificates.length === 0 && (
          <div className="status warn">Agent OK mais aucun certificat. Vérifie la clé USB et le PIN.</div>
        )}
        {agentStatus === 'available' && certificates.length > 0 && (
          <>
            <div className="status ok">Agent connecté, {certificates.length} certificat(s).</div>
            <label>
              Certificat :{' '}
              <select value={selectedKeyId} onChange={(e) => setSelectedKeyId(e.target.value)}>
                {certificates.map((c) => (
                  <option key={c.keyId} value={c.keyId}>
                    {c.subjectDn} (exp. {c.notAfter.slice(0, 10)})
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </div>

      <div className="card">
        <h2>2. Documents</h2>
        <input
          type="file"
          multiple
          accept=".pdf,.docx,.xlsx,.pptx,.odt,.ods,.odp,.odg,.txt,.xml"
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <p className="muted">PDF → PAdES ; bureautique &amp; autres → conteneur ASiC-E (.asice). Un document déjà signé sera contre-signé.</p>
        {docs.length > 0 && (
          <table>
            <thead>
              <tr><th>Document</th><th>Signatures</th><th>État</th><th></th></tr>
            </thead>
            <tbody>
              {docs.map((doc) => (
                <tr key={doc.id}>
                  <td>{doc.file.name} <span className="muted">({(doc.file.size / 1024).toFixed(1)} KB)</span></td>
                  <td>
                    {doc.existingSignatures === null
                      ? <span className="muted">…</span>
                      : doc.existingSignatures > 0
                        ? <span className="badge">déjà signé : {doc.existingSignatures}</span>
                        : <span className="muted">non signé</span>}
                  </td>
                  <td>
                    {doc.status === 'pending' && <span className="muted">en attente</span>}
                    {doc.status === 'signing' && <span className="status-inline info">signature…</span>}
                    {doc.status === 'signed' && <span className="status-inline ok">✓ signé</span>}
                    {doc.status === 'error' && <span className="status-inline error" title={doc.error}>✗ {doc.error}</span>}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {doc.status === 'signed' && doc.signed ? (
                      <button onClick={() => downloadBase64(doc.signed!.base64, doc.signed!.fileName, doc.signed!.mediaType)}>
                        Télécharger
                      </button>
                    ) : (
                      <button disabled={!canSign} onClick={() => void signSingle(doc)}>
                        {doc.existingSignatures && doc.existingSignatures > 0 ? 'Contre-signer' : 'Signer'}
                      </button>
                    )}{' '}
                    <button onClick={() => setDocs((d) => d.filter((x) => x.id !== doc.id))} disabled={busy}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>3. Métadonnées</h2>
        <label>Motif : <input value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: 300 }} /></label>
        <br />
        <label>Lieu : <input value={location} onChange={(e) => setLocation(e.target.value)} style={{ width: 300 }} /></label>
        <p className="muted">Niveau : BASELINE-T (avec horodatage).</p>
      </div>

      <div className="card">
        <button className="primary" disabled={!canSign} onClick={() => void signAll()}>
          {busy ? 'Signature en cours…' : `Signer tout (${docs.filter((d) => d.status !== 'signed').length})`}
        </button>{' '}
        <button disabled={signedDocs.length === 0 || busy}
          onClick={() => downloadZip(signedDocs.map((d) => ({ name: d.signed!.fileName, base64: d.signed!.base64 })), 'documents-signes.zip')}>
          Tout télécharger (ZIP)
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Delete the old SignPage and wire the workspace into App**

Run: `cd /Users/mmaudet/work/eu-dss/eu-dss-ui && git rm src/components/SignPage.tsx`
Replace `src/App.tsx`:

```tsx
import { useState } from 'react';
import { SignWorkspace } from './components/SignWorkspace';
import { ValidatePage } from './components/ValidatePage';

type Tab = 'sign' | 'validate';

export function App() {
  const [tab, setTab] = useState<Tab>('sign');

  return (
    <div className="app">
      <header>
        <h1>eu-dss : Signature électronique</h1>
        <p>Signer (PAdES / ASiC) et vérifier un ou plusieurs documents avec une clé USB cryptographique.</p>
      </header>

      <nav>
        <button className={tab === 'sign' ? 'active' : ''} onClick={() => setTab('sign')}>Signer</button>
        <button className={tab === 'validate' ? 'active' : ''} onClick={() => setTab('validate')}>Vérifier</button>
      </nav>

      {tab === 'sign' ? <SignWorkspace /> : <ValidatePage />}
    </div>
  );
}
```

- [ ] **Step 3: Add the workspace styles**

Append to `src/styles.css`:

```css
.badge { background: #e7f0fa; color: #003399; border-radius: 10px; padding: 1px 8px; font-size: 0.8rem; }
.status-inline { font-size: 0.85rem; }
.status-inline.ok { color: #1a6e1a; }
.status-inline.error { color: #a00; }
.status-inline.info { color: #003399; }
table button { font-size: 0.85rem; padding: 0.3rem 0.6rem; cursor: pointer; }
```

- [ ] **Step 4: Build (Validate page still uses old utils → may still error; that's Task 3)**

Run: `cd /Users/mmaudet/work/eu-dss/eu-dss-ui && npx tsc -b`
Expected: errors ONLY from `ValidatePage.tsx` (still imports `pdfUtils`). `SignWorkspace.tsx` and `App.tsx` typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/mmaudet/work/eu-dss
git add eu-dss-ui/src/components/SignWorkspace.tsx eu-dss-ui/src/App.tsx eu-dss-ui/src/styles.css
git rm --cached eu-dss-ui/src/components/SignPage.tsx 2>/dev/null || true
git commit -m "feat(ui): multi-document sign workspace (per-file status, multi-format, counter-sign, ZIP)"
```

---

## Task 3: Generalize the Validate view + green build

**Files:** `src/components/ValidatePage.tsx`

- [ ] **Step 1: Update `src/components/ValidatePage.tsx`** : accept any signed document and use the renamed util import:

Change the import line `import { fileToBase64 } from '../services/pdfUtils';` to `import { fileToBase64 } from '../services/fileUtils';`.

Change the file input to accept any document: replace `accept="application/pdf"` with `accept=".pdf,.asice,.scs,.sce,.p7s,.xml,.docx,.xlsx,.odt"` (or remove the `accept` attribute entirely to allow all).

Change the heading text `<h2>PDF signé à vérifier</h2>` to `<h2>Document signé à vérifier</h2>`.

(The rest of `ValidatePage.tsx` already uses `backendApi.validate(...)` which now sends `documentBase64`, and renders `signatureFormat` per signature; no further change needed.)

- [ ] **Step 2: Full typecheck + bundle must now be green**

Run: `cd /Users/mmaudet/work/eu-dss/eu-dss-ui && npm run build`
Expected: `tsc -b` passes (no type errors) and `vite build` writes `dist/`. `BUILD` succeeds with exit 0.

- [ ] **Step 3: Commit**

```bash
cd /Users/mmaudet/work/eu-dss
git add eu-dss-ui/src/components/ValidatePage.tsx
git commit -m "feat(ui): validate any signed document (not just PDF); use fileUtils"
```

---

## Task 4: Browser smoke verification

Confirms the built UI renders and the validate round-trip works against the live backend. (The full sign flow needs the user's USB token + agent and is verified manually by the user.)

**Files:** none (verification only)

- [ ] **Step 1: Ensure the backend is running** (port 8080). If not:
```bash
JDK21=/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home
"$JDK21/bin/java" -jar /Users/mmaudet/work/eu-dss/eu-dss-server/target/eu-dss-server-0.1.0-SNAPSHOT.jar
```
(Rebuild first with `JAVA_HOME=$JDK21 mvn -f /Users/mmaudet/work/eu-dss/pom.xml -pl eu-dss-server -am -DskipTests package` if the jar predates A1.)

- [ ] **Step 2: Start the UI dev server** (Vite proxies `/api` → `localhost:8080`):
```bash
cd /Users/mmaudet/work/eu-dss/eu-dss-ui && npm run dev
```
Expected: Vite serves on `http://localhost:5173`.

- [ ] **Step 3: Browser smoke** : load `http://localhost:5173`, confirm: the app renders with the "Signer / Vérifier" tabs; the Sign tab shows the agent card (likely "introuvable" without the token, acceptable), the multi-file Documents input, and the disabled "Signer tout" / "Tout télécharger (ZIP)" buttons; the Validate tab accepts a file and, given a signed PDF/`.asice`, returns the signatures table. Capture a screenshot of each tab. Report any console errors.

- [ ] **Step 4: No code commit** (verification only). If the smoke surfaces a bug, fix it in the relevant task's files, rebuild, and commit with a `fix(ui): …` message.

---

## Self-Review (completed by plan author)

**Spec coverage (spec §7):** multi-document upload (Task 2 list) ✔; per-file status + detected existing signatures (Task 2 `detect`/badge) ✔; "Sign all" one token session + per-file sign (Task 2 `signAll`/`signSingle`) ✔; counter-signature = signing an already-signed doc, labelled "Contre-signer" (Task 2) ✔; per-file error isolation (Task 2 try/catch per doc, loop continues) ✔; download each + ZIP (Task 1 utils + Task 2 buttons) ✔; Validate view for any signed document with per-signature report (Task 3) ✔; multi-format (PDF native, others → `.asice` via the backend; UI just uses `signedFileName`/`mediaType`) ✔. New contract update ✔.

**Placeholder scan:** none. Complete code for every changed file; exact commands with expected outcomes.

**Type consistency:** `backendApi.prepare(documentBase64, documentName, params)`, `assemble(documentBase64, documentName, params, signatureValueBase64)` returning `{signedDocumentBase64, signedFileName, mediaType}`, `validate(documentBase64)`; `SignatureLevel='BASELINE_T'`; `fileUtils.downloadBase64(base64, filename, mediaType)` + `downloadZip(entries, zipName)`; `SignDoc` status machine used consistently. `agentApi` unchanged.

**Out of scope (flagged):** agent HTTPS / mixed-content / cross-OS install = increment **B**; multi-user/auth = **C**; visible signatures, mail, remote signing = dropped. Within-session re-signing of a just-signed doc is intentionally not supported (download then re-upload to add a further signature); this keeps the per-file model simple and correct.
