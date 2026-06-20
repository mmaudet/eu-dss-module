/**
 * PrerequisitesScreen.tsx — re-openable "Prérequis" screen.
 *
 * A standalone, full-page version of the prerequisite detection frame from
 * FirstRunWizard (frame 1). The detection logic and the three row labels are
 * intentionally identical to the wizard so they always agree.
 *
 * Architecture note: the design canvas still mentions "localhost:9795". That
 * agent no longer exists. The three rows are re-mapped exactly as the wizard
 * documents:
 *   1. Middleware PKCS#11 — agentApi.isAvailable()
 *   2. Clé USB de signature              — same isAvailable() probe (token present)
 *   3. Service de signature (EU-DSS)     — backendApi.validate('') probe
 * The string "localhost:9795" never appears in this file.
 */

import { useCallback, useEffect, useState } from 'react';
import { agentApi } from '../services/agentApi';
import { backendApi } from '../services/backendApi';
import { detectOs, PREREQ_MANIFEST } from '../services/prerequisites';

type RowState = 'checking' | 'ok' | 'waiting';

interface PrereqState {
  module: RowState;  // PKCS#11 middleware
  token: RowState;   // USB signing key
  backend: RowState; // hosted EU-DSS signing service
}

interface PrerequisitesScreenProps {
  onGoToSign: () => void;
}

/* ── icon atoms ────────────────────────────────────────────────────────────── */

function MiddlewareIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
      <rect x="3" y="6" width="18" height="12" rx="2" stroke="currentColor" strokeWidth="1.7" />
      <path d="M7 10v4M11 10v4M15 10h2M15 14h2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function TokenIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
      <path d="M12 21V6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M9 9l3-3 3 3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="10" y="9" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

function BackendIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" />
      <path d="M3.5 12h17M12 3c2.6 2.7 2.6 15.3 0 18M12 3c-2.6 2.7-2.6 15.3 0 18" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function RetryIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M20 11a8 8 0 10-2 5.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M20 5v5h-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ flex: 'none' }}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" />
      <path d="M12 11.5v5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="8" r="1.1" fill="currentColor" />
    </svg>
  );
}

function ArrowRightIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M5 12h14m0 0-5-5m5 5-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ── prereq row ────────────────────────────────────────────────────────────── */

interface PrereqRowProps {
  icon: React.ReactNode;
  title: string;
  sub: string;
  state: RowState;
  okLabel: string;
  helpHref?: string;
  onRetry?: () => void;
}

function PrereqRow({ icon, title, sub, state, okLabel, helpHref, onRetry }: PrereqRowProps) {
  const isWaiting = state === 'waiting';

  return (
    <div className={'prq-row prq-row--' + state}>
      <span className="prq-row-icon">{icon}</span>
      <div className="prq-row-text">
        <div className="prq-row-title">{title}</div>
        <div className="prq-row-sub">{sub}</div>
        {isWaiting && (
          <div className="prq-row-actions">
            {onRetry && (
              <button type="button" className="frw-link-action" onClick={onRetry}>
                <RetryIcon />
                Réessayer la détection
              </button>
            )}
            {helpHref && (
              <a className="frw-prow-help" href={helpHref} target="_blank" rel="noreferrer">
                Besoin d'aide ?
              </a>
            )}
          </div>
        )}
      </div>
      {state === 'ok' ? (
        <span className="prq-row-status prq-row-status--ok">{okLabel}</span>
      ) : state === 'checking' ? (
        <span className="prq-row-status prq-row-status--checking">
          <span className="spinner" style={{ width: 14, height: 14 }} />
          Détection…
        </span>
      ) : (
        <span className="prq-row-status prq-row-status--wait">En attente</span>
      )}
    </div>
  );
}

/* ── component ────────────────────────────────────────────────────────────── */

export function PrerequisitesScreen({ onGoToSign }: PrerequisitesScreenProps) {
  const [prereq, setPrereq] = useState<PrereqState>({
    module: 'checking',
    token: 'checking',
    backend: 'checking',
  });

  const prereqDoc = PREREQ_MANIFEST[detectOs()];

  /**
   * Detection mirrors FirstRunWizard.detect() exactly:
   * - module + token both derive from the same agentApi.isAvailable() probe
   *   (we surface two honest rows; we never invent a state we cannot detect).
   * - backend: any HTTP response (even non-2xx) = reachable; TypeError = not.
   */
  const detect = useCallback(async () => {
    setPrereq({ module: 'checking', token: 'checking', backend: 'checking' });

    const tokenPromise = agentApi
      .isAvailable()
      .then((ok) => (ok ? 'ok' : 'waiting') as RowState)
      .catch(() => 'waiting' as RowState);

    const backendPromise = backendApi
      .validate('')
      .then(() => 'ok' as RowState)
      .catch((e: unknown) => {
        const msg = (e as Error).message || '';
        return /HTTP \d{3}/.test(msg) ? ('ok' as RowState) : ('waiting' as RowState);
      });

    const [tokenState, backendState] = await Promise.all([tokenPromise, backendPromise]);
    setPrereq({ module: tokenState, token: tokenState, backend: backendState });
  }, []);

  useEffect(() => {
    void detect();
  }, [detect]);

  const checking =
    prereq.module === 'checking' || prereq.token === 'checking' || prereq.backend === 'checking';
  const readyCount = [prereq.module, prereq.token, prereq.backend].filter((s) => s === 'ok').length;
  const allReady = readyCount === 3;

  const progressPct = Math.round((readyCount / 3) * 100);

  return (
    <div className="prq-screen">
      <div className="prq-inner">
        {/* Info banner */}
        <div className="prq-info-banner">
          <InfoIcon />
          <span>
            S'ouvre <strong>automatiquement au premier lancement</strong>. Vous pouvez le rouvrir ici
            à tout moment.
          </span>
        </div>

        {/* Heading */}
        <h2 className="prq-heading">Préparons votre signature</h2>
        <p className="prq-lead">
          Trois éléments sont nécessaires pour signer. EU‑DSS les détecte automatiquement.
        </p>

        {/* Progress bar */}
        <div className="prq-progress-wrap" role="progressbar" aria-valuenow={readyCount} aria-valuemin={0} aria-valuemax={3}>
          <div className="prq-progress-fill" style={{ width: checking ? '0%' : `${progressPct}%` }} />
        </div>
        <div className="prq-progress-labels">
          <span>{checking ? 'Détection en cours…' : `${readyCount} / 3 prérequis prêts`}</span>
        </div>

        {/* Row 1 — Middleware PKCS#11 */}
        <PrereqRow
          icon={<MiddlewareIcon />}
          title="Middleware PKCS#11 de votre clé"
          sub={prereq.module === 'ok' ? 'Pilote PKCS#11 détecté' : 'Pilote cryptographique requis'}
          state={prereq.module}
          okLabel="OK"
          helpHref={prereqDoc.middleware.url}
          onRetry={() => void detect()}
        />

        {/* Row 2 — Clé USB de signature */}
        <PrereqRow
          icon={<TokenIcon />}
          title="Clé USB de signature"
          sub={prereq.token === 'ok' ? 'Token cryptographique présent' : 'Insérez votre clé de signature'}
          state={prereq.token}
          okLabel="Détectée"
          helpHref={prereqDoc.docUrl}
          onRetry={() => void detect()}
        />

        {/* Row 3 — Service de signature (EU-DSS) */}
        <PrereqRow
          icon={<BackendIcon />}
          title="Service de signature (EU-DSS)"
          sub={prereq.backend === 'ok' ? 'Service de signature joignable' : 'Connexion au service requise'}
          state={prereq.backend}
          okLabel="OK"
          helpHref={prereqDoc.docUrl}
          onRetry={() => void detect()}
        />

        {/* Continue button */}
        <button
          type="button"
          className="prq-continue-btn"
          disabled={!allReady}
          onClick={onGoToSign}
        >
          Continuer vers Signer
          <ArrowRightIcon />
        </button>
      </div>
    </div>
  );
}
