import { useCallback, useEffect, useRef, useState } from 'react';
import { useAgent } from '../agent/AgentContext';
import type { AgentCertificate } from '../services/agentApi';
import { backendApi, type SignatureParams } from '../services/backendApi';
import { arrayBufferToBase64, downloadBase64 } from '../services/fileUtils';
import { defaultSignatureForm, signDocumentToBase64 } from '../services/signFlow';
import { useT, type TFunction } from '../i18n';
import { Btn, Icon } from './ui';

/**
 * DeepLinkSignModal — single-shot overlay that handles an external
 * `eudss://sign?doc_url=…&callback_url=…&state=…` request.
 *
 * The trigger is UNTRUSTED, so the flow is gated by an explicit confirmation
 * screen (and the PIN modal from ensureUnlocked) — never silent signing.
 *
 *   loading → confirm → signing → sending → success
 *                    ↘ (cancel/any failure) → error
 *
 * It reuses the production sign pipeline via signDocumentToBase64; it does NOT
 * touch the normal multi-doc workspace.
 */

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Same CORS-free transport backendApi uses: in Tauri go through the http
 *  plugin (Rust-side request), in the browser use native fetch. */
async function appFetch(input: string, init?: RequestInit): Promise<Response> {
  if (isTauri) {
    const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
    return tauriFetch(input, init);
  }
  return fetch(input, init);
}

type Phase = 'loading' | 'starting' | 'confirm' | 'signing' | 'sending' | 'success' | 'error';

interface ParsedRequest {
  docUrl: string;
  callbackUrl: string;
  /** Destination host shown to the user + echoed in the success copy. */
  callbackHost: string;
  /** Opaque, echoed verbatim in the callback; never interpreted. */
  state: string | null;
}

interface FetchedDoc {
  documentBase64: string;
  fileName: string;
  mediaType: string;
}

/** Guess a media type from a file name extension (best-effort, for the POST body). */
function mediaTypeFor(fileName: string): string {
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
function fileNameFromUrl(rawUrl: string): string {
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
function fileNameFromContentDisposition(header: string | null): string | null {
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

/** Parse + validate an eudss:// URL. Returns null for anything that isn't a
 *  well-formed `eudss://sign` request with both required params. */
function parseRequest(rawUrl: string): ParsedRequest | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'eudss:') return null;
  // For `eudss://sign?…` the action lands in the host component.
  if (url.host !== 'sign') return null;

  const docUrl = url.searchParams.get('doc_url');
  const callbackUrl = url.searchParams.get('callback_url');
  if (!docUrl || !callbackUrl) return null;

  let callbackHost: string;
  try {
    callbackHost = new URL(callbackUrl).host;
    // Validate the document URL is parseable too.
    new URL(docUrl);
  } catch {
    return null;
  }
  if (!callbackHost) return null;

  return {
    docUrl,
    callbackUrl,
    callbackHost,
    state: url.searchParams.get('state'),
  };
}

interface DeepLinkSignModalProps {
  /** The raw eudss:// URL to handle, or null when the overlay is inactive. */
  url: string | null;
  /** Called when the user dismisses the overlay (close/cancel). */
  onClose: () => void;
}

export function DeepLinkSignModal({ url, onClose }: DeepLinkSignModalProps) {
  const t = useT();
  const agent = useAgent();
  const { ensureUnlocked, selectedKeyId, selectedCert } = agent;

  const [phase, setPhase] = useState<Phase>('loading');
  const [request, setRequest] = useState<ParsedRequest | null>(null);
  const [doc, setDoc] = useState<FetchedDoc | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>('');
  /** Set when signing succeeded but the callback POST failed (offer download). */
  const [signedFallback, setSignedFallback] = useState<{
    base64: string;
    fileName: string;
    mediaType: string;
  } | null>(null);

  // Guards against a stale async run writing state after a new URL arrives or
  // the overlay closes (React 18/19 StrictMode double-invoke + re-entrancy).
  const runIdRef = useRef(0);

  const fail = useCallback((msg: string, runId: number) => {
    if (runId !== runIdRef.current) return;
    setErrorMsg(msg);
    setPhase('error');
  }, []);

  // ── On a new URL: parse, wait for backend readiness, fetch the document ──────
  useEffect(() => {
    if (!url) return;
    const runId = ++runIdRef.current;

    // Reset per-request state.
    setRequest(null);
    setDoc(null);
    setErrorMsg('');
    setSignedFallback(null);

    const parsed = parseRequest(url);
    if (!parsed) {
      setPhase('error');
      setErrorMsg(t('deeplink.error.invalidLink'));
      return;
    }
    setRequest(parsed);
    setPhase('loading');

    void (async () => {
      // Wait (briefly) for the embedded backend to come up before fetching.
      let ready = await backendApi.ready().catch(() => false);
      if (!ready && runId === runIdRef.current) {
        setPhase('starting');
        const startedAt = Date.now();
        // Poll up to ~30s; the sidecar usually boots well within that.
        while (!ready && Date.now() - startedAt < 30_000 && runId === runIdRef.current) {
          await new Promise((r) => setTimeout(r, 500));
          ready = await backendApi.ready().catch(() => false);
        }
      }
      if (runId !== runIdRef.current) return;
      if (!ready) {
        fail(t('deeplink.starting.title'), runId);
        return;
      }

      setPhase('loading');
      try {
        const res = await appFetch(parsed.docUrl);
        if (!res.ok) {
          fail(t('deeplink.error.fetchFailed'), runId);
          return;
        }
        const buf = await res.arrayBuffer();
        const fileName =
          fileNameFromContentDisposition(res.headers.get('content-disposition')) ||
          fileNameFromUrl(parsed.docUrl);
        if (runId !== runIdRef.current) return;
        setDoc({
          documentBase64: arrayBufferToBase64(buf),
          fileName,
          mediaType: mediaTypeFor(fileName),
        });
        setPhase('confirm');
      } catch {
        fail(t('deeplink.error.fetchFailed'), runId);
      }
    })();
  }, [url, t, fail]);

  // ── Sign (after explicit consent) → POST to callback ─────────────────────────
  const runSign = useCallback(async () => {
    if (!request || !doc) return;
    const runId = runIdRef.current;

    // PIN gate (locked → prompt). Cancelling returns to the confirm screen.
    let chosenCert: AgentCertificate;
    try {
      const certs = await ensureUnlocked();
      const cert = certs.find((c) => c.keyId === selectedKeyId) ?? selectedCert ?? certs[0];
      if (!cert) {
        fail(t('common.unknownError'), runId);
        return;
      }
      chosenCert = cert;
    } catch {
      // PIN cancelled — stay on confirm so the user can retry or cancel.
      return;
    }
    if (runId !== runIdRef.current) return;

    setPhase('signing');
    let signed: { signedDocumentBase64: string; signedFileName: string; mediaType: string };
    try {
      const params: SignatureParams = {
        certificateChainBase64: chosenCert.certificateChainBase64,
        digestAlgorithm: 'SHA256',
        signingTimeEpochMs: Date.now(),
        signatureLevel: 'BASELINE_T',
        signatureForm: defaultSignatureForm(doc.fileName),
        signatureReason: t('sign.reasonDefault'),
        signerName: chosenCert.subjectDn,
      };
      signed = await signDocumentToBase64({
        documentBase64: doc.documentBase64,
        fileName: doc.fileName,
        params,
        keyId: chosenCert.keyId,
      });
    } catch (e) {
      fail((e as Error).message || t('common.unknownError'), runId);
      return;
    }
    if (runId !== runIdRef.current) return;

    // ── POST the signed document back. Past this point signing has SUCCEEDED,
    //    so a callback failure must offer the signed document for download. ──
    setPhase('sending');
    try {
      const res = await appFetch(request.callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          state: request.state, // echoed verbatim; never interpreted
          signedFileName: signed.signedFileName,
          mediaType: signed.mediaType,
          signedDocumentBase64: signed.signedDocumentBase64,
        }),
      });
      if (!res.ok) {
        setSignedFallback({
          base64: signed.signedDocumentBase64,
          fileName: signed.signedFileName,
          mediaType: signed.mediaType,
        });
        fail(t('deeplink.error.callbackFailed'), runId);
        return;
      }
      if (runId !== runIdRef.current) return;
      setPhase('success');
    } catch {
      setSignedFallback({
        base64: signed.signedDocumentBase64,
        fileName: signed.signedFileName,
        mediaType: signed.mediaType,
      });
      fail(t('deeplink.error.callbackFailed'), runId);
    }
  }, [request, doc, ensureUnlocked, selectedKeyId, selectedCert, fail, t]);

  function close() {
    runIdRef.current++; // invalidate any in-flight run
    onClose();
  }

  if (!url) return null;

  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-label={t('deeplink.confirm.title')}>
      <div className="sign-modal-card">
        {phase === 'loading' && (
          <SpinnerBlock title={t('deeplink.loading.title')} sub={t('deeplink.loading.sub')} />
        )}

        {phase === 'starting' && (
          <SpinnerBlock title={t('deeplink.starting.title')} sub={t('deeplink.starting.sub')} />
        )}

        {phase === 'signing' && (
          <SpinnerBlock title={t('deeplink.signing.title')} sub={t('deeplink.signing.sub')} />
        )}

        {phase === 'sending' && request && (
          <SpinnerBlock
            title={t('deeplink.sending.title')}
            sub={t('deeplink.sending.sub', { host: request.callbackHost })}
          />
        )}

        {phase === 'confirm' && request && doc && (
          <ConfirmBlock
            t={t}
            fileName={doc.fileName}
            host={request.callbackHost}
            onSign={() => void runSign()}
            onCancel={close}
          />
        )}

        {phase === 'success' && request && (
          <SuccessBlock t={t} host={request.callbackHost} onClose={close} />
        )}

        {phase === 'error' && (
          <ErrorBlock t={t} message={errorMsg} fallback={signedFallback} onClose={close} />
        )}
      </div>
    </div>
  );
}

/* -------------------- sub-blocks -------------------- */

function SpinnerBlock({ title, sub }: { title: string; sub: string }) {
  return (
    <>
      <div className="ring-spinner" style={{ margin: '0 auto 18px' }}>
        <div className="ring-spinner-track" />
        <div className="ring-spinner-arc" />
        <div className="ring-spinner-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <circle cx="8" cy="13" r="3.2" stroke="currentColor" strokeWidth="1.8" />
            <path
              d="m10.4 10.6 8-8M15 5l2.5 2.5M18.5 8 21 5.5"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      </div>
      <h3 className="sign-modal-title">{title}</h3>
      <p className="sign-modal-sub">{sub}</p>
    </>
  );
}

function ConfirmBlock({
  t,
  fileName,
  host,
  onSign,
  onCancel,
}: {
  t: TFunction;
  fileName: string;
  host: string;
  onSign: () => void;
  onCancel: () => void;
}) {
  const format = defaultSignatureForm(fileName) === 'PADES' ? 'PAdES‑B‑T' : 'ASiC‑E';
  return (
    <>
      <span className="pm-icon-tile" style={{ marginBottom: 16 }}>
        <svg width="25" height="25" viewBox="0 0 24 24" fill="none">
          <path
            d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"
            stroke="var(--brand)"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
          <path
            d="M9 11.5l2 2 4-4"
            stroke="var(--brand)"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <h3 className="sign-modal-title">{t('deeplink.confirm.title')}</h3>
      <p className="sign-modal-sub">{t('deeplink.confirm.lead')}</p>

      <div className="cert" style={{ marginTop: 20, textAlign: 'left' }}>
        <div className="ci">
          <div className="k">{t('deeplink.confirm.file')}</div>
          <div className="v">{fileName}</div>
        </div>
        <div className="ci">
          <div className="k">{t('deeplink.confirm.format')}</div>
          <div className="v mono">{format}</div>
        </div>
        <div className="ci">
          <div className="k">{t('deeplink.confirm.destination')}</div>
          <div className="v mono">{host}</div>
        </div>
      </div>

      <div className="sign-modal-caution" style={{ textAlign: 'left' }}>
        <Icon.alert size={15} fill="" />
        <span>{t('deeplink.confirm.warn')}</span>
      </div>

      <button type="button" className="sign-btn" style={{ marginTop: 20 }} onClick={onSign}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path
            d="M3 17c3-1 4-7 7-7s2 4 5 3 4-6 6-6"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {t('deeplink.confirm.sign')}
      </button>
      <button type="button" className="pm-cancel-btn" style={{ marginTop: 10 }} onClick={onCancel}>
        {t('common.cancel')}
      </button>
    </>
  );
}

function SuccessBlock({ t, host, onClose }: { t: TFunction; host: string; onClose: () => void }) {
  return (
    <>
      <div className="sv-hero-icon" style={{ margin: '0 auto 18px' }}>
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none">
          <path
            d="m6.5 12.4 3.2 3.2L18 7.2"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <h3 className="sign-modal-title">{t('deeplink.success.title')}</h3>
      <p className="sign-modal-sub">{t('deeplink.success.sub', { host })}</p>
      <button type="button" className="sign-btn" style={{ marginTop: 20 }} onClick={onClose}>
        {t('deeplink.close')}
      </button>
    </>
  );
}

function ErrorBlock({
  t,
  message,
  fallback,
  onClose,
}: {
  t: TFunction;
  message: string;
  fallback: { base64: string; fileName: string; mediaType: string } | null;
  onClose: () => void;
}) {
  return (
    <>
      <span className="pm-icon-tile pm-icon-tile--err" style={{ marginBottom: 16 }}>
        <svg width="25" height="25" viewBox="0 0 24 24" fill="none">
          <path d="M12 8v5" stroke="var(--danger)" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="12" cy="16.5" r=".5" fill="var(--danger)" />
          <path
            d="M10.3 4.3l-7 12A1.9 1.9 0 005 19.2h14a1.9 1.9 0 001.7-2.9l-7-12a1.9 1.9 0 00-3.4 0z"
            stroke="var(--danger)"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <h3 className="sign-modal-title">{t('deeplink.error.title')}</h3>
      <p className="sign-modal-sub">{message}</p>

      <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {fallback && (
          <Btn
            icon={<Icon.download size={16} />}
            onClick={() => downloadBase64(fallback.base64, fallback.fileName, fallback.mediaType)}
          >
            {t('common.download')}
          </Btn>
        )}
        <button type="button" className="pm-cancel-btn" onClick={onClose}>
          {t('deeplink.close')}
        </button>
      </div>
    </>
  );
}
