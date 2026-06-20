import { useAgent } from '../agent/AgentContext';
import { history, type HistoryEntry } from '../services/history';
import { fileKind } from './ui';
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
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 7);
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

/** Format bytes into human-readable size string (Ko / Mo). */
function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${bytes} o`;
}

/** Relative time from an ISO timestamp, in French. */
function relativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  if (isNaN(then)) return iso;
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 2) return 'à l\'instant';
  if (diffMin < 60) return `il y a ${diffMin} min`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `il y a ${diffH} h`;
  const diffDays = Math.floor(diffH / 24);
  if (diffDays === 1) return 'hier';
  // fallback to DD/MM/YYYY
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

/* ── Activity row ── */
function ActivityRow({ entry, last }: { entry: HistoryEntry; last: boolean }) {
  const isPdf = !fileKind(entry.name).asic;
  const isSigned = entry.kind === 'sign';
  const isVerifyOk = entry.kind === 'verify' && entry.verdict === 'TOTAL_PASSED';
  const isVerifyFail = entry.kind === 'verify' && entry.verdict !== 'TOTAL_PASSED' && entry.verdict !== '';
  const isVerifyWarn = entry.kind === 'verify' && !isVerifyOk && !isVerifyFail;

  const verb = isSigned ? 'Signé' : 'Vérifié';
  const subLine = `${verb} ${relativeTime(entry.atIso)} · ${fmtSize(entry.sizeBytes)}`;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '14px 20px',
        borderBottom: last ? 'none' : '1px solid #F4F6FB',
      }}
    >
      {/* File type icon tile */}
      <span
        style={{
          width: 36,
          height: 36,
          borderRadius: 9,
          background: isPdf ? '#FDEEEE' : '#EAF0FE',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path d="M7 3h7l4 4v14H7V3Z" stroke={isPdf ? '#D8514F' : '#2D63E8'} strokeWidth="1.6" strokeLinejoin="round"/>
          <path d="M14 3v4h4" stroke={isPdf ? '#D8514F' : '#2D63E8'} strokeWidth="1.6" strokeLinejoin="round"/>
        </svg>
      </span>

      {/* Name + sub-line */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {entry.name}
        </div>
        <div style={{ fontSize: 11.5, color: '#9AA7BE', marginTop: 2 }}>
          {subLine}
        </div>
      </div>

      {/* Format pill */}
      {entry.format && (
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            fontFamily: "'Geist Mono', 'JetBrains Mono', monospace",
            color: '#5A6B85',
            background: '#F4F6FB',
            border: '1px solid #E7ECF4',
            borderRadius: 6,
            padding: '3px 8px',
            flexShrink: 0,
          }}
        >
          {entry.format}
        </span>
      )}

      {/* Status badge */}
      {isSigned && (
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            fontWeight: 600,
            color: '#18794E',
            flexShrink: 0,
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9.2" fill="#E7F6EE"/>
            <path d="m8.5 12.2 2.3 2.3 4.6-4.8" stroke="#18794E" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Signé
        </span>
      )}
      {isVerifyOk && (
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            fontWeight: 600,
            color: '#18794E',
            flexShrink: 0,
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9.2" fill="#E7F6EE"/>
            <path d="m8.5 12.2 2.3 2.3 4.6-4.8" stroke="#18794E" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Vérifié
        </span>
      )}
      {isVerifyWarn && (
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            fontWeight: 600,
            color: '#9A6213',
            flexShrink: 0,
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9.2" fill="#FBF0DA"/>
            <path d="M12 8.5v4M12 15.5h.01" stroke="#9A6213" strokeWidth="1.9" strokeLinecap="round"/>
          </svg>
          Indéterminé
        </span>
      )}
      {isVerifyFail && (
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            fontWeight: 600,
            color: '#C2362F',
            flexShrink: 0,
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9.2" fill="#FDEEEE"/>
            <path d="M9 9l6 6M15 9l-6 6" stroke="#C2362F" strokeWidth="1.9" strokeLinecap="round"/>
          </svg>
          Invalide
        </span>
      )}
    </div>
  );
}

interface AccueilScreenProps {
  onNavigate: (tab: Tab) => void;
}

export function AccueilScreen({ onNavigate }: AccueilScreenProps) {
  const { status, selectedCert } = useAgent();
  const available = status === 'available';

  // ── Hero data ──────────────────────────────────────────────────────────────
  const holderName = selectedCert ? cnOf(selectedCert.subjectDn) : null;
  const org = selectedCert ? orgOf(selectedCert.subjectDn) : null;
  const issuer = selectedCert ? issuerOf(selectedCert.issuerDn) : null;
  const validUntil = selectedCert ? fmtMonthYear(selectedCert.notAfter) : null;

  // ── Info cards (real data) ─────────────────────────────────────────────────
  const months = selectedCert ? monthsRemaining(selectedCert.notAfter) : null;
  const signedThisMonth = history.signedThisMonth();
  const { ok: verifyOk, total: verifyTotal } = history.verifyCounts();

  // ── Activity data ──────────────────────────────────────────────────────────
  const entries = history.list();

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

      {/* ── Stat cards row (real data from history + cert) ── */}
      <div className="accueil-cards">
        {/* Card 1 – Documents signés ce mois */}
        <div className="accueil-card">
          <div className="accueil-card-label">Documents signés · ce mois</div>
          <div className={`accueil-card-value${signedThisMonth === 0 ? ' accueil-card-value--empty' : ''}`}>
            {signedThisMonth === 0 ? '—' : signedThisMonth}
          </div>
        </div>

        {/* Card 2 – Vérifications réussies */}
        <div className="accueil-card">
          <div className="accueil-card-label">Vérifications réussies</div>
          {verifyTotal === 0 ? (
            <div className="accueil-card-value accueil-card-value--empty">—</div>
          ) : (
            <div className="accueil-card-value" style={{ color: verifyOk === verifyTotal ? '#18794E' : undefined }}>
              {verifyOk}
              <span className="accueil-card-unit"> / {verifyTotal}</span>
            </div>
          )}
        </div>

        {/* Card 3 – Certificate validity */}
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
      </div>

      {/* ── Recent activity ── */}
      <div className="accueil-activity-card">
        <div className="accueil-activity-header">
          <span className="accueil-activity-title">Activité récente</span>
        </div>
        {entries.length === 0 ? (
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
        ) : (
          <div>
            {entries.map((entry, i) => (
              <ActivityRow key={entry.id} entry={entry} last={i === entries.length - 1} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
