import { useCallback, useEffect, useRef, useState } from 'react';
import { useAgent } from '../agent/AgentContext';
import type { AgentCertificate } from '../services/agentApi';
import { backendApi, type SignatureParams } from '../services/backendApi';
import { downloadBase64 } from '../services/fileUtils';
import { defaultSignatureForm, signDocumentToBase64 } from '../services/signFlow';
import { useT, type TFunction } from '../i18n';
import { fetchDoc, postSignResult, type FetchedDoc } from './deepLinkShared';
import { Btn, Icon } from './ui';
import { useToast } from './Toast';

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

type Phase = 'loading' | 'starting' | 'confirm' | 'signing' | 'sending' | 'success' | 'error';

interface ParsedRequest {
  docUrl: string;
  callbackUrl: string;
  /** Destination host shown to the user + echoed in the success copy. */
  callbackHost: string;
  /** Opaque, echoed verbatim in the callback; never interpreted. */
  state: string | null;
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
        const fetched = await fetchDoc(parsed.docUrl);
        if (runId !== runIdRef.current) return;
        setDoc(fetched);
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
      const res = await postSignResult(request.callbackUrl, request.state, signed);
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
  const toast = useToast();
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
            onClick={() => {
              try {
                downloadBase64(fallback.base64, fallback.fileName, fallback.mediaType);
                toast.success(t('download.ok', { filename: fallback.fileName }));
              } catch {
                toast.error(t('download.error'));
              }
            }}
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
