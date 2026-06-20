import { useAgent } from '../agent/AgentContext';
import type { Tab } from '../App';

/** Extract a single RDN value (CN / O) from an RFC-ish DN. */
function dnPart(dn: string | undefined, key: 'CN' | 'O'): string {
  if (!dn) return '';
  const parts = dn.split(/(?<!\\),/);
  for (const raw of parts) {
    const seg = raw.trim();
    const eq = seg.indexOf('=');
    if (eq < 0) continue;
    if (seg.slice(0, eq).trim().toUpperCase() === key) {
      return seg
        .slice(eq + 1)
        .trim()
        .replace(/\\(.)/g, '$1');
    }
  }
  return '';
}

const cnOf = (dn: string | undefined): string => dnPart(dn, 'CN') || (dn ?? '');
const orgOf = (dn: string | undefined): string => dnPart(dn, 'O');
const issuerOf = (dn: string | undefined): string =>
  dnPart(dn, 'CN') || dnPart(dn, 'O') || (dn ?? '');

/** Format an ISO date string (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ssZ) to "MM/YYYY". */
function fmtMonthYear(iso: string): string {
  // notAfter is like "2028-12-31T23:59:59Z"
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 7); // fallback: raw slice
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${mm}/${yyyy}`;
}

/** Compute whole months remaining from now until `iso`. Returns null if cert absent. */
function monthsRemaining(iso: string): number {
  const now = new Date();
  const exp = new Date(iso);
  if (isNaN(exp.getTime())) return 0;
  const months =
    (exp.getFullYear() - now.getFullYear()) * 12 +
    (exp.getMonth() - now.getMonth());
  return Math.max(0, months);
}

interface AccueilScreenProps {
  onNavigate: (tab: Tab) => void;
}

export function AccueilScreen({ onNavigate }: AccueilScreenProps) {
  const { status, selectedCert, locked } = useAgent();
  const available = status === 'available';

  // ── Hero data ──────────────────────────────────────────────────────────────
  const holderName = selectedCert ? cnOf(selectedCert.subjectDn) : null;
  const org = selectedCert ? orgOf(selectedCert.subjectDn) : null;
  const issuer = selectedCert ? issuerOf(selectedCert.issuerDn) : null;
  const validUntil = selectedCert ? fmtMonthYear(selectedCert.notAfter) : null;

  // ── Info cards (real data only) ────────────────────────────────────────────
  const months = selectedCert ? monthsRemaining(selectedCert.notAfter) : null;

  const keyStatusLabel = available
    ? locked
      ? 'Connectée · verrouillée'
      : 'Connectée · déverrouillée'
    : status === 'checking'
    ? 'Détection…'
    : status === 'error'
    ? 'Indisponible'
    : 'Déconnectée';

  const keyStatusKind: 'ok' | 'warn' | 'idle' =
    available && !locked ? 'ok' : available ? 'warn' : 'idle';

  return (
    <div className="accueil-root rise">
      {/* ── Hero card ── */}
      <div className="accueil-hero">
        {/* Background glow (purely decorative, matches cert-hero pattern) */}
        <div className="accueil-hero-glow" />

        {/* Key icon tile */}
        <div className="accueil-hero-key-tile" aria-hidden>
          <svg width="46" height="46" viewBox="0 0 24 24" fill="none">
            <circle cx="8" cy="13" r="3.6" stroke="#9FC0FF" strokeWidth="1.7" />
            <path
              d="m10.6 10.4 8.4-8.4M15.5 5l2.5 2.5M18.5 8 21 5.5"
              stroke="#9FC0FF"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>

        {/* Text block */}
        <div className="accueil-hero-body">
          {/* Status pill */}
          {available ? (
            <div className="accueil-hero-pill accueil-hero-pill--on">
              <span className="accueil-hero-dot accueil-hero-dot--on" />
              Clé connectée · carte reconnue
            </div>
          ) : (
            <div className="accueil-hero-pill accueil-hero-pill--off">
              <span className="accueil-hero-dot accueil-hero-dot--off" />
              {status === 'checking' ? 'Détection…' : 'En attente de connexion'}
            </div>
          )}

          {/* Holder name */}
          <div className="accueil-hero-name">
            {holderName ?? 'En attente de connexion'}
          </div>

          {/* Sub-line: org · issuer · valid until — only when cert is present */}
          <div className="accueil-hero-sub">
            {selectedCert ? (
              <>
                {org && <>{org} · </>}
                {issuer && <>{issuer} · </>}
                {validUntil && <>valide jusqu'au {validUntil}</>}
              </>
            ) : (
              'Insérez votre clé USB pour commencer.'
            )}
          </div>
        </div>

        {/* Action buttons */}
        <div className="accueil-hero-actions">
          <button
            type="button"
            className="accueil-btn-primary"
            onClick={() => onNavigate('sign')}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
              <path
                d="M3 17c3-1 4-7 7-7s2 4 5 3 4-6 6-6"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Signer un document
          </button>
          <button
            type="button"
            className="accueil-btn-ghost"
            onClick={() => onNavigate('verify')}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 3.5 5.5 6v5c0 4 2.7 7.3 6.5 8.5 3.8-1.2 6.5-4.5 6.5-8.5V6L12 3.5Z"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinejoin="round"
              />
              <path
                d="m9.5 11.8 1.7 1.7 3.4-3.5"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Vérifier une signature
          </button>
        </div>
      </div>

      {/* ── Info cards row (real data only — no fabricated counts) ── */}
      <div className="accueil-cards">
        {/* Card 1 – Certificate validity */}
        <div className="accueil-card">
          <div className="accueil-card-label">Certificat valide</div>
          {months !== null ? (
            <div className="accueil-card-value">
              {months}
              <span className="accueil-card-unit"> mois restants</span>
            </div>
          ) : (
            <div className="accueil-card-value accueil-card-value--empty">—</div>
          )}
        </div>

        {/* Card 2 – Key status */}
        <div className="accueil-card">
          <div className="accueil-card-label">Statut de la clé</div>
          <div
            className={
              'accueil-card-status ' +
              (keyStatusKind === 'ok'
                ? 'accueil-card-status--ok'
                : keyStatusKind === 'warn'
                ? 'accueil-card-status--warn'
                : 'accueil-card-status--idle')
            }
          >
            {keyStatusLabel}
          </div>
        </div>

        {/* Card 3 – Signature levels (factual: what the app actually does) */}
        <div className="accueil-card">
          <div className="accueil-card-label">Niveaux de signature</div>
          <div className="accueil-card-levels">
            <span className="accueil-level-pill">PAdES-B-T</span>
            <span className="accueil-level-sep">·</span>
            <span className="accueil-level-pill">ASiC-E XAdES-B-T</span>
          </div>
        </div>
      </div>

      {/* ── Recent activity — honest empty state ── */}
      {/* TODO: populate from a local history store once that feature is approved (conception §4, option b) */}
      <div className="accueil-activity-card">
        <div className="accueil-activity-header">
          <span className="accueil-activity-title">Activité récente</span>
        </div>
        <div className="accueil-activity-empty">
          {/* Clock / history icon */}
          <div className="accueil-empty-icon" aria-hidden>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
              <path
                d="M12 7v5l3.5 2"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div className="accueil-empty-title">Aucune activité pour le moment</div>
          <div className="accueil-empty-sub">
            Vos signatures et vérifications récentes apparaîtront ici.
          </div>
        </div>
      </div>
    </div>
  );
}
