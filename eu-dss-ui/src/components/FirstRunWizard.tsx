/**
 * FirstRunWizard.tsx — mandatory first-launch onboarding (Phase 2).
 *
 * Shown once, before the main shell, when onboarding has not passed. It
 * auto-detects the prerequisites, then REALLY exercises the signing loop by
 * signing an internal throwaway document on the card (unlock → sign → assemble
 * → validate via services/selfTest). On success it persists the onboarding flag
 * and never reappears.
 *
 * Architecture note: the design canvas predates the Tauri pivot and shows a
 * "localhost:9795" local agent row. That agent no longer exists — signing is
 * in-app over IPC. The three prerequisite rows are re-mapped to the real
 * architecture (PKCS#11 middleware, USB token, hosted EU-DSS backend); the
 * string "localhost:9795" appears nowhere here.
 *
 * The wizard owns its own PIN flow with agentApi directly (it does NOT route
 * through the shared PinModal). Exactly one unlock attempt per submit — a wrong
 * PIN is never auto-retried, since the card has a limited try counter.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { agentApi, AgentError } from '../services/agentApi';
import { backendApi } from '../services/backendApi';
import { detectOs, PREREQ_MANIFEST } from '../services/prerequisites';
import { runSelfTest, SelfTestResult } from '../services/selfTest';
import { store } from '../services/store';
import { useT, type TKey } from '../i18n';

/* ── helpers ──────────────────────────────────────────────────────────────── */

/** Extract a single RDN value (CN / O) from an RFC-ish DN. Falls back to the raw DN. */
function dnPart(dn: string | undefined, key: 'CN' | 'O'): string {
  if (!dn) return '';
  const parts = dn.split(/(?<!\\),/);
  for (const raw of parts) {
    const seg = raw.trim();
    const eq = seg.indexOf('=');
    if (eq < 0) continue;
    if (seg.slice(0, eq).trim().toUpperCase() === key) {
      return seg.slice(eq + 1).trim().replace(/\\(.)/g, '$1');
    }
  }
  return '';
}
const cnOf = (dn: string | undefined): string => dnPart(dn, 'CN') || (dn ?? '');

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'] as const;
const PIN_MAX = 12;
const PIN_MIN = 4;

type Step = 'prereq' | 'pin' | 'verifying' | 'done';

/** Per-row prerequisite state. */
type RowState = 'checking' | 'ok' | 'waiting';

interface PrereqState {
  module: RowState; // PKCS#11 middleware
  token: RowState; // USB signing key
  backend: RowState; // hosted EU-DSS signing service
}

/* ── small presentational atoms ───────────────────────────────────────────── */

function CheckGlyph({ size = 14, color = '#fff', sw = 2.4 }: { size?: number; color?: string; sw?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="m6.5 12.4 3.2 3.2L18 7.2" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Stepper: 1 Prérequis · 2 Test du PIN · 3 Terminé. */
function Stepper({ active }: { active: 1 | 2 | 3 }) {
  const t = useT();
  const labels = [t('wizard.step.prereq'), t('wizard.step.pin'), t('wizard.step.done')];
  return (
    <div className="frw-stepper">
      {labels.map((label, i) => {
        const n = (i + 1) as 1 | 2 | 3;
        const done = n < active;
        const cur = n === active;
        return (
          <div className="frw-step-seg" key={label}>
            <div className="frw-step">
              <span className={'frw-step-dot' + (done ? ' is-done' : cur ? ' is-cur' : '')}>
                {done ? <CheckGlyph size={14} color="var(--ok-ink)" sw={2.3} /> : n}
              </span>
              <span className={'frw-step-label' + (done ? ' is-done' : cur ? ' is-cur' : '')}>{label}</span>
            </div>
            {n < 3 && <span className={'frw-step-line' + (n < active ? ' is-fill' : '')} />}
          </div>
        );
      })}
    </div>
  );
}

interface PrereqRowProps {
  icon: React.ReactNode;
  title: string;
  sub: React.ReactNode;
  state: RowState;
  okLabel: string;
  helpHref?: string;
}

function PrereqRow({ icon, title, sub, state, okLabel, helpHref }: PrereqRowProps) {
  const t = useT();
  return (
    <div className={'frw-prrow frw-prow--' + state}>
      <span className="frw-prow-icon">{icon}</span>
      <div className="frw-prow-text">
        <div className="frw-prow-title">{title}</div>
        <div className="frw-prow-sub">{sub}</div>
      </div>
      {state === 'ok' ? (
        <span className="frw-prow-status frw-prow-status--ok">{okLabel}</span>
      ) : state === 'checking' ? (
        <span className="frw-prow-status frw-prow-status--checking">
          <span className="spinner" style={{ width: 14, height: 14 }} />
          {t('common.detecting')}
        </span>
      ) : (
        <span className="frw-prow-wait">
          <span className="frw-prow-status frw-prow-status--wait">{t('common.waiting')}</span>
          {helpHref && (
            <a className="frw-prow-help" href={helpHref} target="_blank" rel="noreferrer">
              {t('wizard.needHelp')}
            </a>
          )}
        </span>
      )}
    </div>
  );
}

/* ── component ────────────────────────────────────────────────────────────── */

interface FirstRunWizardProps {
  onComplete: () => void;
}

export function FirstRunWizard({ onComplete }: FirstRunWizardProps) {
  const t = useT();
  const [step, setStep] = useState<Step>('prereq');
  const [prereq, setPrereq] = useState<PrereqState>({ module: 'checking', token: 'checking', backend: 'checking' });
  const [result, setResult] = useState<SelfTestResult | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false); // pin_locked → no retry
  const [unlocked, setUnlocked] = useState(false); // PIN accepted → drives the verifying checklist
  const [certCn, setCertCn] = useState(''); // CN of the unlocked cert (token row detail)

  const [pin, setPin] = useState('');
  const [shake, setShake] = useState(false);

  const prereqDoc = PREREQ_MANIFEST[detectOs()];

  /* — prerequisite detection — */
  const detect = useCallback(async () => {
    setPrereq({ module: 'checking', token: 'checking', backend: 'checking' });

    // (1) middleware + (2) token: isAvailable() conflates the native module load
    //     and a present token. We surface two honest rows derived from the same
    //     probe — we never invent a state we cannot detect.
    const tokenPromise = agentApi
      .isAvailable()
      .then((ok) => (ok ? 'ok' : 'waiting') as RowState)
      .catch(() => 'waiting' as RowState);

    // (3) backend ready: the embedded EU-DSS sidecar's readiness flag, which
    //     flips true once its /api/health answers 200. ready() never throws,
    //     but we guard defensively.
    const backendPromise = backendApi
      .ready()
      .then((ok) => (ok ? 'ok' : 'waiting') as RowState)
      .catch(() => 'waiting' as RowState);

    const [tokenState, backendState] = await Promise.all([tokenPromise, backendPromise]);
    setPrereq({ module: tokenState, token: tokenState, backend: backendState });
  }, []);

  // Run detection on mount and whenever we (re)enter the prereq step.
  useEffect(() => {
    if (step === 'prereq') void detect();
  }, [step, detect]);

  // Light polling while on the prereq step: the embedded backend boots
  // asynchronously, so re-probe every 1.5s until the backend row is OK (the
  // token/middleware rows also benefit from rechecking as the user plugs the
  // key in). The interval clears when we leave the prereq step.
  useEffect(() => {
    if (step !== 'prereq') return;
    if (prereq.backend === 'ok' && prereq.token === 'ok') return;
    const id = setInterval(() => void detect(), 1500);
    return () => clearInterval(id);
  }, [step, prereq.backend, prereq.token, detect]);

  const tokenReady = prereq.token === 'ok';

  /* — PIN keypad — */
  const press = useCallback(
    (k: string) => {
      if (busy || locked) return;
      if (k === 'del') {
        setPin((p) => p.slice(0, -1));
        return;
      }
      if (!/^[0-9]$/.test(k)) return;
      setPin((p) => (p.length >= PIN_MAX ? p : p + k));
    },
    [busy, locked],
  );

  // Physical keyboard support while on the PIN step.
  const submitRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (step !== 'pin') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Backspace') {
        e.preventDefault();
        press('del');
      } else if (/^[0-9]$/.test(e.key)) {
        press(e.key);
      } else if (e.key === 'Enter') {
        submitRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, press]);

  // Clear the field + shake whenever a new PIN error arrives.
  useEffect(() => {
    if (!pinError) return;
    setShake(true);
    setPin('');
    const t = setTimeout(() => setShake(false), 420);
    return () => clearTimeout(t);
  }, [pinError]);

  /* — the real end-to-end test: exactly one unlock attempt, then self-test — */
  const test = useCallback(async () => {
    if (busy || locked) return;
    if (pin.length < PIN_MIN) return;
    setBusy(true);
    setPinError(null);
    try {
      // ONE unlock attempt — never auto-retried.
      await agentApi.unlock(pin);
      setUnlocked(true);

      const { certificates } = await agentApi.listCertificates();
      const cert =
        certificates.find((c) => c.certificateChainBase64 && c.certificateChainBase64.length > 0) ??
        certificates[0];
      if (!cert) {
        setUnlocked(false);
        setPinError(t('pinerr.noCert'));
        setBusy(false);
        return;
      }
      setCertCn(cnOf(cert.subjectDn));

      // Move to the live checklist and run the throwaway-document self-test.
      setStep('verifying');
      const res = await runSelfTest({
        keyId: cert.keyId,
        certificateChainBase64: cert.certificateChainBase64,
        subjectDn: cert.subjectDn,
      });
      setResult(res);
      if (res.ok) setStep('done');
      // else: stay on 'verifying' to render the failure card.
    } catch (e) {
      setUnlocked(false);
      if (e instanceof AgentError) {
        if (e.code === 'pin_locked') {
          setLocked(true);
          setPinError(t('pinerr.lockedPukMiddleware'));
        } else if (e.code === 'pin_incorrect') {
          setPinError(t('pinerr.incorrectFull'));
        } else if (e.code === 'token_unavailable') {
          setPinError(t('pinerr.tokenUnavailableShort'));
        } else {
          setPinError(e.message || t('pinerr.unlockFailed'));
        }
      } else {
        setPinError((e as Error).message || t('pinerr.unlockFailed'));
      }
      // Stay on the PIN step for re-entry (except pin_locked, which disables it).
    } finally {
      setBusy(false);
    }
  }, [busy, locked, pin, t]);

  // Keep the latest test() reachable from the keydown handler.
  useEffect(() => {
    submitRef.current = () => {
      if (!busy && !locked && pin.length >= PIN_MIN) void test();
    };
  }, [busy, locked, pin, test]);

  /* — "Configurer plus tard": mark passed + enter the app (never hard-brick). — */
  const skip = useCallback(() => {
    store.setOnboardingPassed(new Date().toISOString());
    onComplete();
  }, [onComplete]);

  /* — enter the app from the done screen — */
  const enter = useCallback(() => {
    store.setOnboardingPassed(new Date().toISOString());
    onComplete();
  }, [onComplete]);

  /* — retry after a failed self-test: back to PIN entry — */
  const retry = useCallback(() => {
    setResult(null);
    setUnlocked(false);
    setPin('');
    setPinError(null);
    setStep('pin');
  }, []);

  const activeStep: 1 | 2 | 3 = step === 'prereq' ? 1 : step === 'done' ? 3 : 2;

  return (
    <div className="frw-scrim">
      <div className="frw-card rise" role="dialog" aria-modal="true" aria-label={t('wizard.dialogLabel')}>
        {/* Window-style header bar */}
        <div className="frw-head">
          <span className="frw-head-mark">
            <CheckGlyph size={11} sw={2.4} />
          </span>
          <span className="frw-head-title">{t('wizard.headTitle')}</span>
        </div>

        <div className="frw-body">
          <Stepper active={activeStep} />

          {step === 'prereq' && (
            <PrereqView
              prereq={prereq}
              certCn={certCn}
              tokenReady={tokenReady}
              docUrl={prereqDoc.docUrl}
              middlewareUrl={prereqDoc.middleware.url}
              onContinue={() => setStep('pin')}
              onRetry={() => void detect()}
              onSkip={skip}
            />
          )}

          {step === 'pin' && (
            <PinView
              pin={pin}
              shake={shake}
              busy={busy}
              locked={locked}
              pinError={pinError}
              canSubmit={pin.length >= PIN_MIN && !busy && !locked}
              onPress={press}
              onSubmit={() => void test()}
              onSkip={skip}
            />
          )}

          {step === 'verifying' && (
            <VerifyingView result={result} unlocked={unlocked} certCn={certCn} onRetry={retry} onSkip={skip} />
          )}

          {step === 'done' && <DoneView result={result} certCn={certCn} onEnter={enter} />}
        </div>
      </div>
    </div>
  );
}

/* ── Frame 1 · Prérequis ──────────────────────────────────────────────────── */

interface PrereqViewProps {
  prereq: PrereqState;
  certCn: string;
  tokenReady: boolean;
  docUrl: string;
  middlewareUrl: string;
  onContinue: () => void;
  onRetry: () => void;
  onSkip: () => void;
}

function PrereqView({ prereq, certCn, tokenReady, docUrl, middlewareUrl, onContinue, onRetry, onSkip }: PrereqViewProps) {
  const t = useT();
  const checking = prereq.module === 'checking' || prereq.token === 'checking' || prereq.backend === 'checking';
  const anyMissing = !checking && (prereq.module !== 'ok' || prereq.token !== 'ok' || prereq.backend !== 'ok');

  return (
    <div key="prereq" className="frw-pane">
      <h3 className="frw-h3">{t('wizard.prereq.welcome')}</h3>
      <p className="frw-lead">
        {t('wizard.prereq.lead')}
      </p>

      <PrereqRow
        icon={
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
            <rect x="3" y="6" width="18" height="12" rx="2" stroke="currentColor" strokeWidth="1.7" />
            <path d="M7 10v4M11 10v4M15 10h2M15 14h2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
        }
        title={t('prereq.row.middlewareTitle')}
        sub={prereq.module === 'ok' ? t('prereq.row.middlewareOk') : t('prereq.row.middlewareWait')}
        state={prereq.module}
        okLabel={t('common.ok')}
        helpHref={middlewareUrl}
      />

      <PrereqRow
        icon={
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
            <path d="M12 21V6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            <path d="M9 9l3-3 3 3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            <rect x="10" y="9" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.7" />
          </svg>
        }
        title={t('prereq.row.tokenTitle')}
        sub={prereq.token === 'ok' ? (certCn ? certCn : t('prereq.row.tokenOk')) : t('prereq.row.tokenWait')}
        state={prereq.token}
        okLabel={t('prereq.row.tokenDetected')}
        helpHref={docUrl}
      />

      <PrereqRow
        icon={
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" />
            <path d="M3.5 12h17M12 3c2.6 2.7 2.6 15.3 0 18M12 3c-2.6 2.7-2.6 15.3 0 18" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        }
        title={t('prereq.row.backendTitle')}
        sub={prereq.backend === 'ok' ? t('prereq.row.backendOk') : t('prereq.row.backendWait')}
        state={prereq.backend}
        okLabel={t('common.ok')}
        helpHref={docUrl}
      />

      {anyMissing && (
        <div className="frw-prereq-actions">
          <button type="button" className="frw-link-action" onClick={onRetry}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M20 11a8 8 0 10-2 5.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              <path d="M20 5v5h-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {t('wizard.prereq.retry')}
          </button>
        </div>
      )}

      <button type="button" className="frw-primary-btn" disabled={!tokenReady} onClick={onContinue}>
        {t('wizard.prereq.continue')}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path d="M5 12h14m0 0-5-5m5 5-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <button type="button" className="frw-skip-link" onClick={onSkip}>
        {t('wizard.skip')}
      </button>
    </div>
  );
}

/* ── Frame 2 · Test du PIN ────────────────────────────────────────────────── */

interface PinViewProps {
  pin: string;
  shake: boolean;
  busy: boolean;
  locked: boolean;
  pinError: string | null;
  canSubmit: boolean;
  onPress: (k: string) => void;
  onSubmit: () => void;
  onSkip: () => void;
}

function PinView({ pin, shake, busy, locked, pinError, canSubmit, onPress, onSubmit, onSkip }: PinViewProps) {
  const t = useT();
  const err = !!pinError;
  // How many dots to render: at least 6, grow with the entered PIN (max 12).
  const dotCount = Math.max(6, Math.min(PIN_MAX, pin.length || 0));

  return (
    <div key="pin" className="frw-pane frw-pane--center">
      <span className={'frw-lock-tile' + (err ? ' is-err' : '')}>
        <svg width="23" height="23" viewBox="0 0 24 24" fill="none">
          <rect x="5" y="11" width="14" height="9" rx="2.2" stroke={err ? 'var(--danger)' : 'var(--brand)'} strokeWidth="1.8" />
          <path d="M8 11V8a4 4 0 0 1 8 0v3" stroke={err ? 'var(--danger)' : 'var(--brand)'} strokeWidth="1.8" />
        </svg>
      </span>

      <h3 className="frw-h3">{t('wizard.pin.title')}</h3>
      <p className="frw-lead frw-lead--narrow" dangerouslySetInnerHTML={{ __html: t('wizard.pin.lead') }} />

      {locked ? (
        <div className="frw-fail-box" role="alert" style={{ marginTop: 18 }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" style={{ flex: 'none' }}>
            <rect x="5" y="11" width="14" height="9" rx="2.2" stroke="var(--danger)" strokeWidth="1.8" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" stroke="var(--danger)" strokeWidth="1.8" />
            <path d="M12 14.5v2.5" stroke="var(--danger)" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <div className="frw-fail-text">{pinError}</div>
        </div>
      ) : (
        <>
          {err && (
            <p className="frw-pin-err" role="alert">
              {pinError}
            </p>
          )}

          {/* PIN dots */}
          <div className={'frw-dots' + (shake ? ' shake' : '')}>
            {Array.from({ length: dotCount }).map((_, i) => {
              const filled = !!pin[i];
              return <span key={i} className={'frw-dot' + (err ? ' frw-dot--err' : filled ? ' frw-dot--filled' : '')} />;
            })}
          </div>

          {/* Numeric keypad */}
          <div className="frw-keypad">
            {KEYS.map((k, i) =>
              k === '' ? (
                <div key={i} />
              ) : (
                <button
                  key={i}
                  type="button"
                  className="frw-key"
                  disabled={busy}
                  onClick={() => onPress(k)}
                  aria-label={k === 'del' ? t('wizard.pin.clearAria') : k}
                >
                  {k === 'del' ? (
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                      <path d="M20 6H9L4 12l5 6h11a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
                      <path d="m13 10 4 4m0-4-4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                    </svg>
                  ) : (
                    k
                  )}
                </button>
              ),
            )}
          </div>

          <button type="button" className="frw-primary-btn" disabled={!canSubmit} onClick={onSubmit}>
            {busy ? (
              <>
                <span className="spinner" style={{ width: 16, height: 16 }} />
                {t('wizard.pin.testing')}
              </>
            ) : (
              t('wizard.pin.testSign')
            )}
          </button>
        </>
      )}

      <div className="frw-pin-footer">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
          <rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 11V8a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        {t('wizard.pin.footer')}
      </div>

      <button type="button" className="frw-skip-link" onClick={onSkip}>
        {t('wizard.skip')}
      </button>
    </div>
  );
}

/* ── Frame 3 · Vérification de la boucle ──────────────────────────────────── */

interface VerifyingViewProps {
  result: SelfTestResult | null;
  unlocked: boolean;
  certCn: string;
  onRetry: () => void;
  onSkip: () => void;
}

type RowMark = 'pending' | 'active' | 'done' | 'fail';

function ChecklistRow({ label, mark }: { label: React.ReactNode; mark: RowMark }) {
  return (
    <div className={'frw-check-row frw-check-row--' + mark}>
      <span className="frw-check-mark">
        {mark === 'done' ? (
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9.2" fill="var(--ok-soft)" />
            <path d="m8.5 12.2 2.3 2.3 4.6-4.8" stroke="var(--ok-ink)" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : mark === 'fail' ? (
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9.2" fill="var(--danger-soft)" />
            <path d="M9 9l6 6m0-6-6 6" stroke="var(--danger)" strokeWidth="1.9" strokeLinecap="round" />
          </svg>
        ) : mark === 'active' ? (
          <span className="frw-check-spin" />
        ) : (
          <span className="frw-check-idle" />
        )}
      </span>
      <div className="frw-check-label">{label}</div>
    </div>
  );
}

function VerifyingView({ result, unlocked, certCn, onRetry, onSkip }: VerifyingViewProps) {
  const t = useT();
  const failed = result != null && !result.ok;

  if (failed) {
    const stepKey: Record<string, TKey> = {
      prepare: 'wizard.verify.step.prepare',
      sign: 'wizard.verify.step.sign',
      assemble: 'wizard.verify.step.assemble',
      validate: 'wizard.verify.step.validate',
    };
    const where = result?.failedStep ? t(stepKey[result.failedStep]) : t('wizard.verify.step.loop');
    return (
      <div key="verify-fail" className="frw-pane frw-pane--center">
        <span className="frw-fail-tile">
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none">
            <path d="M9 9l6 6m0-6-6 6" stroke="var(--danger)" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
        </span>
        <h3 className="frw-h3">{t('wizard.verify.failTitle')}</h3>
        <p
          className="frw-lead frw-lead--narrow"
          dangerouslySetInnerHTML={{ __html: t('wizard.verify.failLead', { step: where }) }}
        />
        {result?.error && (
          <div className="frw-fail-box" role="alert">
            <div className="frw-fail-text mono">{result.error}</div>
          </div>
        )}
        <button type="button" className="frw-primary-btn" onClick={onRetry}>
          {t('common.retry')}
        </button>
        <button type="button" className="frw-skip-link" onClick={onSkip}>
          {t('wizard.skip')}
        </button>
      </div>
    );
  }

  // In-progress checklist, driven off result.steps as they land.
  const unlockMark: RowMark = unlocked ? 'done' : 'active';
  const signMark: RowMark = result?.steps.sign ? 'done' : unlocked ? 'active' : 'pending';
  const validateMark: RowMark = result?.steps.validate ? 'done' : result?.steps.sign ? 'active' : 'pending';

  return (
    <div key="verify" className="frw-pane frw-pane--center">
      <div className="ring-spinner" style={{ margin: '6px auto 18px' }}>
        <div className="ring-spinner-track" />
        <div className="ring-spinner-arc" />
      </div>
      <h3 className="frw-h3">{t('wizard.verify.title')}</h3>
      <p className="frw-lead">{t('wizard.verify.lead')}</p>

      <div className="frw-checklist">
        <ChecklistRow
          label={<>{t('wizard.verify.rowUnlock')}{certCn ? <span className="frw-check-cn"> · {certCn}</span> : null}</>}
          mark={unlockMark}
        />
        <ChecklistRow label={t('wizard.verify.rowSign')} mark={signMark} />
        <ChecklistRow label={t('wizard.verify.rowValidate')} mark={validateMark} />
      </div>
    </div>
  );
}

/* ── Frame 4 · Terminé ────────────────────────────────────────────────────── */

function DoneView({ result, certCn, onEnter }: { result: SelfTestResult | null; certCn: string; onEnter: () => void }) {
  const t = useT();
  return (
    <div key="done" className="frw-pane frw-pane--center">
      <span className="frw-done-tile">
        <CheckGlyph size={34} color="var(--ok-ink)" sw={2.4} />
      </span>
      <h3 className="frw-h3 frw-h3--lg">{t('wizard.done.title')}</h3>
      <p
        className="frw-lead frw-lead--narrow"
        dangerouslySetInnerHTML={{
          __html: certCn ? t('wizard.done.leadWithCn', { cn: certCn }) : t('wizard.done.leadNoCn'),
        }}
      />

      {result?.indication && (
        <div className="frw-verdict">
          <span className="frw-verdict-k">{t('wizard.done.verdict')}</span>
          <span className="frw-verdict-v mono">{result.indication}</span>
        </div>
      )}

      <div className="frw-info-box">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ flex: 'none' }}>
          <circle cx="12" cy="12" r="9" stroke="var(--brand)" strokeWidth="1.7" />
          <path d="M12 11.5v5" stroke="var(--brand)" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="12" cy="8" r="1.1" fill="var(--brand)" />
        </svg>
        <div className="frw-info-text" dangerouslySetInnerHTML={{ __html: t('wizard.done.info') }} />
      </div>

      <button type="button" className="frw-primary-btn frw-primary-btn--strong" onClick={onEnter}>
        {t('wizard.done.enter')}
      </button>
    </div>
  );
}
