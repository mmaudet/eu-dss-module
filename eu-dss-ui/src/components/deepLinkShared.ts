/**
 * deepLinkShared — helpers shared by the `eudss://sign` and `eudss://verify`
 * single-shot deep-link overlays (DeepLinkSignModal / DeepLinkVerifyModal).
 *
 * Extracted verbatim from DeepLinkSignModal so both flows fetch the requested
 * document, derive a filename and POST results over the SAME CORS-free
 * transport. The sign flow's observable behaviour is unchanged.
 */

import { arrayBufferToBase64, base64ToBytes } from '../services/fileUtils';
import type { ValidationResponse } from '../services/backendApi';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Same CORS-free transport backendApi uses: in Tauri go through the http
 *  plugin (Rust-side request), in the browser use native fetch. */
export async function appFetch(input: string, init?: RequestInit): Promise<Response> {
  if (isTauri) {
    const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
    return tauriFetch(input, init);
  }
  return fetch(input, init);
}

/** Guess a media type from a file name extension (best-effort, for the POST body). */
export function mediaTypeFor(fileName: string): string {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  switch (ext) {
    case 'pdf':
      return 'application/pdf';
    case 'xml':
      return 'application/xml';
    case 'txt':
      return 'text/plain';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case 'odt':
      return 'application/vnd.oasis.opendocument.text';
    case 'ods':
      return 'application/vnd.oasis.opendocument.spreadsheet';
    case 'odp':
      return 'application/vnd.oasis.opendocument.presentation';
    case 'asice':
      return 'application/vnd.etsi.asic-e+zip';
    default:
      return 'application/octet-stream';
  }
}

/** Derive a filename from the URL path's last segment (URL-decoded). */
export function fileNameFromUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const last = u.pathname.split('/').filter(Boolean).pop();
    if (last) return decodeURIComponent(last);
  } catch {
    /* fall through */
  }
  return 'document';
}

/** Extract a filename from a Content-Disposition header, if present. */
export function fileNameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  // filename*=UTF-8''encoded  takes precedence over  filename="plain"
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      /* ignore */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain?.[1]?.trim() || null;
}

export interface FetchedDoc {
  documentBase64: string;
  fileName: string;
  mediaType: string;
}

/** Class of fetch outcome, so callers can pick the right error message. */
export type DocFetchError = 'fetch';

/**
 * Fetch a document URL → base64 + derived filename, over the CORS-free
 * transport. Throws `DocFetchError` ('fetch') on any non-2xx / network error.
 */
export async function fetchDoc(docUrl: string): Promise<FetchedDoc> {
  let res: Response;
  try {
    res = await appFetch(docUrl);
  } catch {
    throw 'fetch' as DocFetchError;
  }
  if (!res.ok) throw 'fetch' as DocFetchError;
  const buf = await res.arrayBuffer();
  const fileName =
    fileNameFromContentDisposition(res.headers.get('content-disposition')) ||
    fileNameFromUrl(docUrl);
  return {
    documentBase64: arrayBufferToBase64(buf),
    fileName,
    mediaType: mediaTypeFor(fileName),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Callback transport — two ways to POST the result back to the requesting site.
 *
 *  • Generic (default) — a JSON envelope: `state` plus the base64 document /
 *    the full validation report. This is the contract documented for arbitrary
 *    integrators in docs/deeplink-integration.md.
 *
 *  • Twake Drive — selected when `callback_url` carries a non-empty `token`
 *    query param. The callback then points straight at the Twake Drive
 *    (cozy-stack) write endpoint, which expects the RAW bytes (no JSON, no
 *    base64), the document's media type as `Content-Type`, and a `Bearer`
 *    credential taken from that `token` param (cozy-stack requires the header —
 *    the query token alone is not enough). The target filename travels in the
 *    URL (`Name=`), so it is NOT sent in the body, and the URL is POSTed
 *    verbatim (its `Type`/`Name`/`token` params are preserved). `state` is
 *    irrelevant here — the result is written directly into the drive.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Twake Drive passthrough is selected by a non-empty `token` query param on the
 * callback URL. Returns that token (used as the `Bearer` credential), or null
 * for the generic JSON callback.
 */
export function twakeDriveToken(callbackUrl: string): string | null {
  try {
    const token = new URL(callbackUrl).searchParams.get('token');
    return token ? token : null;
  } catch {
    return null;
  }
}

export interface SignedResult {
  signedDocumentBase64: string;
  signedFileName: string;
  mediaType: string;
}

/**
 * POST a signed document back to the requesting site, picking the transport
 * from the callback URL:
 *  • Twake Drive (token present): raw bytes, `Content-Type` = the document's
 *    media type, `Authorization: Bearer <token>` (filename is in the URL).
 *  • Generic: JSON `{ state, signedFileName, mediaType, signedDocumentBase64 }`.
 */
export async function postSignResult(
  callbackUrl: string,
  state: string | null,
  signed: SignedResult,
): Promise<Response> {
  const token = twakeDriveToken(callbackUrl);
  if (token) {
    return appFetch(callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': signed.mediaType,
        Authorization: `Bearer ${token}`,
      },
      body: base64ToBytes(signed.signedDocumentBase64),
    });
  }
  return appFetch(callbackUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      state, // echoed verbatim; never interpreted
      signedFileName: signed.signedFileName,
      mediaType: signed.mediaType,
      signedDocumentBase64: signed.signedDocumentBase64,
    }),
  });
}

/**
 * POST a validation report back to the requesting site, picking the transport
 * from the callback URL:
 *  • Twake Drive (token present): the report XML as raw bytes,
 *    `Content-Type: application/xml`, `Authorization: Bearer <token>`
 *    (report filename is in the URL).
 *  • Generic: JSON `{ state, signatureCount, signatures, simpleReportXml }`.
 */
export async function postVerifyResult(
  callbackUrl: string,
  state: string | null,
  result: ValidationResponse,
): Promise<Response> {
  const token = twakeDriveToken(callbackUrl);
  if (token) {
    return appFetch(callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/xml',
        Authorization: `Bearer ${token}`,
      },
      body: new TextEncoder().encode(result.simpleReportXml ?? ''),
    });
  }
  return appFetch(callbackUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      state, // echoed verbatim; never interpreted
      signatureCount: result.signatureCount,
      signatures: result.signatures,
      simpleReportXml: result.simpleReportXml,
    }),
  });
}
