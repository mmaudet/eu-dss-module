/**
 * deepLinkShared — helpers shared by the `eudss://sign` and `eudss://verify`
 * single-shot deep-link overlays (DeepLinkSignModal / DeepLinkVerifyModal).
 *
 * Extracted verbatim from DeepLinkSignModal so both flows fetch the requested
 * document, derive a filename and POST results over the SAME CORS-free
 * transport. The sign flow's observable behaviour is unchanged.
 */

import { arrayBufferToBase64 } from '../services/fileUtils';

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
