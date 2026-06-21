import { useCallback, useEffect, useRef, useState } from 'react';
import { backendApi, type ValidationResponse } from '../services/backendApi';
import { useT, type TFunction } from '../i18n';
import { fetchDoc, postVerifyResult } from './deepLinkShared';
import { useToast } from './Toast';

/**
 * DeepLinkVerifyModal — single-shot overlay that handles an external
 * `eudss://verify?doc_url=…&callback_url=…&state=…` request.
 *
 * Symmetric to DeepLinkSignModal, but validation needs NO token and NO PIN: it
 * is public (DSS checks the signature against the EU trust lists). The trigger
 * is still EXTERNAL, so the flow is gated by an explicit (light) confirmation
 * screen — never a silent action.
 *
 *   loading → confirm → validating → sending → result
 *                    ↘ (cancel/any failure) → error
 *
 * If validation SUCCEEDS but the callback POST fails, the report is STILL shown
 * (with a note that the requesting site was unreachable). The opaque `state` is
 * echoed verbatim in the callback and never interpreted.
 */

type Phase = 'loading' | 'starting' | 'confirm' | 'validating' | 'sending' | 'result' | 'error';

interface ParsedRequest {
  docUrl: string;
  callbackUrl: string;
  /** Destination host shown to the user; the report is sent here. */
  callbackHost: string;
  /** Opaque, echoed verbatim in the callback; never interpreted. */
  state: string | null;
}

interface FetchedDoc {
  documentBase64: string;
  fileName: string;
}

/** Parse + validate an eudss:// URL. Returns null for anything that isn't a
 *  well-formed `eudss://verify` request with both required params. */
function parseRequest(rawUrl: string): ParsedRequest | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'eudss:') return null;
  // For `eudss://verify?…` the action lands in the host component.
  if (url.host !== 'verify') return null;

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

/* ---- Verdict helpers — driven strictly off the report's indications ---- */

type Verdict = 'ok' | 'danger' | 'warn';

/** Worst-case aggregation across all signatures (mirrors ValidatePage). */
function overallVerdict(result: ValidationResponse): Verdict {
  const inds = result.signatures.map((s) => s.indication);
  if (inds.some((i) => i === 'TOTAL_FAILED')) return 'danger';
  if (inds.length > 0 && inds.every((i) => i === 'TOTAL_PASSED')) return 'ok';
  return 'warn'; // no signatures, INDETERMINATE, or a mix
}

interface DeepLinkVerifyModalProps {
  /** The raw eudss:// URL to handle, or null when the overlay is inactive. */
  url: string | null;
  /** Called when the user dismisses the overlay (close/cancel). */
  onClose: () => void;
}

export function DeepLinkVerifyModal({ url, onClose }: DeepLinkVerifyModalProps) {
  const t = useT();
  const toast = useToast();

  const [phase, setPhase] = useState<Phase>('loading');
  const [request, setRequest] = useState<ParsedRequest | null>(null);
  const [doc, setDoc] = useState<FetchedDoc | null>(null);
  const [result, setResult] = useState<ValidationResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>('');
  /** Set when validation succeeded but the callback POST failed. */
  const [callbackFailed, setCallbackFailed] = useState(false);

  // Guards against a stale async run writing state after a new URL arrives or
  // the overlay closes (React 18/19 StrictMode double-invoke + re-entrancy).
  const runIdRef = useRef(0);

  const fail = useCallback(
    (msg: string, runId: number) => {
      if (runId !== runIdRef.current) return;
      setErrorMsg(msg);
      setPhase('error');
      toast.error(msg);
    },
    [toast],
  );

  // ── On a new URL: parse, wait for backend readiness, fetch the document ──────
  useEffect(() => {
    if (!url) return;
    const runId = ++runIdRef.current;

    // Reset per-request state.
    setRequest(null);
    setDoc(null);
    setResult(null);
    setErrorMsg('');
    setCallbackFailed(false);

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
        fail(t('deeplinkVerify.starting.title'), runId);
        return;
      }

      setPhase('loading');
      try {
        const fetched = await fetchDoc(parsed.docUrl);
        if (runId !== runIdRef.current) return;
        setDoc({ documentBase64: fetched.documentBase64, fileName: fetched.fileName });
        setPhase('confirm');
      } catch {
        fail(t('deeplink.error.fetchFailed'), runId);
      }
    })();
  }, [url, t, fail]);

  // ── Validate (after explicit consent) → POST the report to the callback ──────
  const runValidate = useCallback(async () => {
    if (!request || !doc) return;
    const runId = runIdRef.current;

    setPhase('validating');
    let res: ValidationResponse;
    try {
      res = await backendApi.validate(doc.documentBase64);
    } catch (e) {
      fail((e as Error).message || t('common.unknownError'), runId);
      return;
    }
    if (runId !== runIdRef.current) return;
    setResult(res);

    // ── POST the report back. Past this point validation has SUCCEEDED, so a
    //    callback failure must STILL show the report (with a note). ──────────
    setPhase('sending');
    let ok = false;
    try {
      const post = await postVerifyResult(request.callbackUrl, request.state, res);
      ok = post.ok;
    } catch {
      ok = false;
    }
    if (runId !== runIdRef.current) return;

    if (ok) {
      setCallbackFailed(false);
      toast.success(t('deeplinkVerify.toast.sent', { host: request.callbackHost }));
    } else {
      setCallbackFailed(true);
      toast.error(t('deeplinkVerify.toast.callbackFailed'));
    }
    // Either way the validation completed — show the report.
    setPhase('result');
  }, [request, doc, fail, t, toast]);

  function close() {
    runIdRef.current++; // invalidate any in-flight run
    onClose();
  }

  if (!url) return null;

  return (
    <div
      className="scrim"
      role="dialog"
      aria-modal="true"
      aria-label={t('deeplinkVerify.confirm.title')}
    >
      <div className="sign-modal-card">
        {phase === 'loading' && (
          <SpinnerBlock
            title={t('deeplink.loading.title')}
            sub={t('deeplink.loading.sub')}
          />
        )}

        {phase === 'starting' && (
          <SpinnerBlock
            title={t('deeplinkVerify.starting.title')}
            sub={t('deeplinkVerify.starting.sub')}
          />
        )}

        {phase === 'validating' && (
          <SpinnerBlock
            title={t('deeplinkVerify.validating.title')}
            sub={t('deeplinkVerify.validating.sub')}
          />
        )}

        {phase === 'sending' && request && (
          <SpinnerBlock
            title={t('deeplinkVerify.sending.title')}
            sub={t('deeplinkVerify.sending.sub', { host: request.callbackHost })}
          />
        )}

        {phase === 'confirm' && request && doc && (
          <ConfirmBlock
            t={t}
            fileName={doc.fileName}
            host={request.callbackHost}
            onValidate={() => void runValidate()}
            onCancel={close}
          />
        )}

        {phase === 'result' && result && (
          <ResultBlock t={t} result={result} callbackFailed={callbackFailed} onClose={close} />
        )}

        {phase === 'error' && <ErrorBlock t={t} message={errorMsg} onClose={close} />}
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
            <path
              d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinejoin="round"
            />
            <path
              d="M9 11.5l2 2 4-4"
              stroke="currentColor"
              strokeWidth="1.9"
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
  onValidate,
  onCancel,
}: {
  t: TFunction;
  fileName: string;
  host: string;
  onValidate: () => void;
  onCancel: () => void;
}) {
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
      <h3 className="sign-modal-title">{t('deeplinkVerify.confirm.title')}</h3>
      <p className="sign-modal-sub">{t('deeplinkVerify.confirm.lead', { file: fileName })}</p>

      <div className="cert" style={{ marginTop: 20, textAlign: 'left' }}>
        <div className="ci">
          <div className="k">{t('deeplinkVerify.confirm.file')}</div>
          <div className="v">{fileName}</div>
        </div>
        <div className="ci">
          <div className="k">{t('deeplinkVerify.confirm.destination')}</div>
          <div className="v mono">{host}</div>
        </div>
      </div>

      <button type="button" className="sign-btn" style={{ marginTop: 20 }} onClick={onValidate}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path
            d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
          <path
            d="M9 11.5l2 2 4-4"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {t('deeplinkVerify.confirm.validate')}
      </button>
      <button type="button" className="pm-cancel-btn" style={{ marginTop: 10 }} onClick={onCancel}>
        {t('common.cancel')}
      </button>
    </>
  );
}

function ResultBlock({
  t,
  result,
  callbackFailed,
  onClose,
}: {
  t: TFunction;
  result: ValidationResponse;
  callbackFailed: boolean;
  onClose: () => void;
}) {
  const verdict = overallVerdict(result);

  const title =
    verdict === 'ok'
      ? t('deeplinkVerify.result.validTitle')
      : verdict === 'danger'
      ? t('deeplinkVerify.result.invalidTitle')
      : t('deeplinkVerify.result.indetTitle');

  return (
    <>
      <div
        className={
          'dl-verdict-hero ' +
          (verdict === 'ok'
            ? 'dl-verdict-hero--ok'
            : verdict === 'danger'
            ? 'dl-verdict-hero--danger'
            : 'dl-verdict-hero--warn')
        }
        style={{ margin: '0 auto 18px' }}
      >
        {verdict === 'ok' ? (
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
            <path
              d="m6.5 12.4 3.2 3.2L18 7.2"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : verdict === 'danger' ? (
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none">
            <path d="M8 8l8 8M16 8l-8 8" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" />
          </svg>
        ) : (
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none">
            <path d="M12 7.5v5.5M12 16.5h.01" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
        )}
      </div>

      <h3 className="sign-modal-title">{title}</h3>
      <p className="sign-modal-sub">
        {t('deeplinkVerify.result.lead', { n: result.signatureCount })}
      </p>

      {result.signatures.length > 0 && (
        <div className="cert" style={{ marginTop: 18, textAlign: 'left' }}>
          {result.signatures.map((s) => (
            <div className="ci" key={s.signatureId}>
              <div className="k">{s.signedBy ?? t('deeplinkVerify.result.unknownSigner')}</div>
              <div className="v">
                <span className="mono">{s.indication}</span>
                {s.signingDate ? <span className="dl-sig-date"> · {s.signingDate}</span> : null}
              </div>
            </div>
          ))}
        </div>
      )}

      {callbackFailed && (
        <div className="sign-modal-caution" style={{ textAlign: 'left' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
            <path d="M12 8v5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <circle cx="12" cy="16.5" r=".5" fill="currentColor" />
            <path
              d="M10.3 4.3l-7 12A1.9 1.9 0 005 19.2h14a1.9 1.9 0 001.7-2.9l-7-12a1.9 1.9 0 00-3.4 0z"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
          </svg>
          <span>{t('deeplinkVerify.result.callbackFailed')}</span>
        </div>
      )}

      <button type="button" className="sign-btn" style={{ marginTop: 20 }} onClick={onClose}>
        {t('deeplink.close')}
      </button>
    </>
  );
}

function ErrorBlock({
  t,
  message,
  onClose,
}: {
  t: TFunction;
  message: string;
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
      <h3 className="sign-modal-title">{t('deeplinkVerify.error.title')}</h3>
      <p className="sign-modal-sub">{message}</p>

      <button type="button" className="pm-cancel-btn" style={{ marginTop: 20 }} onClick={onClose}>
        {t('deeplink.close')}
      </button>
    </>
  );
}
