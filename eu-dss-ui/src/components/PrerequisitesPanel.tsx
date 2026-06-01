import { AgentSessionStatus } from '../services/agentApi';
import { detectOs, PREREQ_MANIFEST } from '../services/prerequisites';

interface PrerequisitesPanelProps {
  agentStatus: 'checking' | 'available' | 'unavailable';
  status: AgentSessionStatus | null;
  hasCertificates: boolean;
  onRecheck: () => void;
  onUnlock: () => void;
  onLock: () => void;
}

export function PrerequisitesPanel({
  agentStatus,
  status,
  hasCertificates,
  onRecheck,
  onUnlock,
  onLock,
}: PrerequisitesPanelProps) {
  const links = PREREQ_MANIFEST[detectOs()];

  return (
    <div>
      {/* 1. Agent local */}
      {agentStatus === 'checking' && <div className="status info">Vérification de l'agent…</div>}
      {agentStatus === 'unavailable' && (
        <div className="status warn">
          <strong>✗ Agent local non détecté.</strong>
          <div className="muted" style={{ margin: '4px 0' }}>
            L'agent n'est pas lancé, pas installé, ou son certificat n'a pas encore été accepté.
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 6, alignItems: 'center' }}>
            <a href={links.agentInstaller.url} target="_blank" rel="noreferrer">{links.agentInstaller.label}</a>
            <a href="https://localhost:9795/rest/health" target="_blank" rel="noreferrer">Accepter le certificat de l'agent</a>
            <button onClick={onRecheck}>Revérifier</button>
          </div>
        </div>
      )}
      {agentStatus === 'available' && <div className="status ok">✓ Agent connecté.</div>}

      {/* 2. Carte / session */}
      {agentStatus === 'available' && (
        status?.unlocked ? (
          <div className="status ok">
            🔓 Carte déverrouillée{status.expiresInSeconds != null ? ` (re-verrou ~${status.expiresInSeconds}s)` : ''}{' '}
            <button onClick={onLock}>Verrouiller</button>
          </div>
        ) : (
          <div className="status info">
            🔒 Carte verrouillée — clique « Signer » et saisis ton PIN.{' '}
            <button onClick={onUnlock}>Déverrouiller</button>
          </div>
        )
      )}
      {agentStatus === 'available' && status?.unlocked && !hasCertificates && (
        <div className="status warn">Agent déverrouillé mais aucun certificat. Vérifie la clé USB.</div>
      )}

      {/* 3. Middleware & token (info passive; le besoin réel se révèle au unlock via token_unavailable) */}
      <div className="status info" style={{ marginTop: 6 }}>
        Carte branchée + middleware ChamberSign requis.{' '}
        <a href={links.middleware.url} target="_blank" rel="noreferrer">{links.middleware.label}</a>
        {' · '}
        <a href={links.docUrl} target="_blank" rel="noreferrer">Guide d'installation</a>
      </div>
    </div>
  );
}
