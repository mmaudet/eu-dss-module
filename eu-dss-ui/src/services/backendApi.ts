const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/**
 * Resolve the backend API base URL.
 *  - In Tauri: the embedded Java backend runs as a local sidecar on a
 *    dynamically-chosen 127.0.0.1 port. We ask Rust once (`backend_base`) and
 *    cache the Promise so every request reuses the same resolved base.
 *    `VITE_BACKEND_URL` still overrides (e.g. to point at a hosted backend).
 *  - In the browser (dev/preview): same-origin `/api`.
 */
let basePromise: Promise<string> | null = null;

export function resolveBase(): Promise<string> {
  if (basePromise) return basePromise;
  if (!isTauri) {
    basePromise = Promise.resolve('/api');
    return basePromise;
  }
  const override = import.meta.env.VITE_BACKEND_URL;
  if (override) {
    basePromise = Promise.resolve(override);
    return basePromise;
  }
  basePromise = (async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string>('backend_base');
  })();
  return basePromise;
}

// In Tauri, use the plugin's fetch (Rust-side request, no browser CORS). In the browser, native fetch.
async function appFetch(input: string, init?: RequestInit): Promise<Response> {
  if (isTauri) {
    const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
    return tauriFetch(input, init);
  }
  return fetch(input, init);
}

export type DigestAlgo = 'SHA256' | 'SHA384' | 'SHA512';
export type SignatureLevel = 'BASELINE_B' | 'BASELINE_T' | 'BASELINE_LT' | 'BASELINE_LTA';
/**
 * Explicit signature form. When omitted, the backend auto-detects
 * (.pdf → PAdES, anything else → ASiC-E).
 *  - PADES            → PAdES (PDF input required); output = signed PDF.
 *  - ASIC_E           → ASiC-E container; output = <base>.asice.
 *  - XADES_ENVELOPING → standalone XAdES with the file embedded; output = <base>.xml.
 *  - XADES_DETACHED   → detached XAdES; output = the signature .xml only (original kept).
 */
export type SignatureForm = 'PADES' | 'ASIC_E' | 'XADES_ENVELOPING' | 'XADES_DETACHED';

export interface SignatureParams {
  certificateChainBase64: string[];
  digestAlgorithm: DigestAlgo;
  signingTimeEpochMs: number;
  signatureLevel?: SignatureLevel;
  signatureForm?: SignatureForm;
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

export type ValidationKind = 'VALIDATED' | 'DETACHED_CONTENT_REQUIRED' | 'NOT_A_SIGNATURE';

export interface ValidationResponse {
  kind: ValidationKind;
  signatureCount: number;
  signatures: SignatureSummary[];
  simpleReportXml: string | null;
}

/** Optional second document + names for validating a DETACHED signature. */
export interface ValidateOptions {
  documentName?: string;
  detachedContentBase64?: string;
  detachedContentName?: string;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const base = await resolveBase();
  const res = await appFetch(`${base}${path}`, {
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

/**
 * Is the backend ready to serve requests?
 *  - In Tauri: ask Rust for the embedded sidecar's readiness flag, which is
 *    flipped once its `GET /api/health` returns 200 (so the prereq row shows
 *    "En attente" → "OK" as the sidecar boots). Falls back to a live health GET
 *    if the command is unavailable.
 *  - In the browser: a direct `GET <base>/health` (any 2xx = ready).
 */
async function isReady(): Promise<boolean> {
  if (isTauri && !import.meta.env.VITE_BACKEND_URL) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<boolean>('backend_ready');
    } catch {
      /* fall through to a live health probe */
    }
  }
  try {
    const base = await resolveBase();
    const res = await appFetch(`${base}/health`, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

export const backendApi = {
  /** True once the (embedded, in Tauri) backend can serve requests. */
  ready: isReady,

  prepare: (documentBase64: string, documentName: string, params: SignatureParams) =>
    postJson<PrepareResponse>('/sign/prepare', { documentBase64, documentName, params }),

  assemble: (
    documentBase64: string,
    documentName: string,
    params: SignatureParams,
    signatureValueBase64: string,
  ) => postJson<AssembleResponse>('/sign/assemble', { documentBase64, documentName, params, signatureValueBase64 }),

  validate: (documentBase64: string, opts?: ValidateOptions) =>
    postJson<ValidationResponse>('/validate', {
      documentBase64,
      documentName: opts?.documentName,
      detachedContentBase64: opts?.detachedContentBase64,
      detachedContentName: opts?.detachedContentName,
    }),
};
