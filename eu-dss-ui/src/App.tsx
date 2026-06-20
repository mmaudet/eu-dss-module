import { useState } from 'react';
import { AgentProvider, useAgent } from './agent/AgentContext';
import { FirstRunWizard } from './components/FirstRunWizard';
import { PinModal } from './components/PinModal';
import { SignWorkspace } from './components/SignWorkspace';
import { TitleBar } from './components/TitleBar';
import { ValidatePage } from './components/ValidatePage';
import { store } from './services/store';

type Tab = 'sign' | 'verify';

// ── Agent status pill (sidebar bottom) ─────────────────────────────────────

function AgentChip() {
  const { status, locked } = useAgent();

  let dotCls: string;
  let title: string;
  let sub: string;

  if (status === 'available') {
    dotCls = 'on';
    title = 'Agent connecté';
    sub = locked ? 'Carte verrouillée' : 'Session active';
  } else if (status === 'checking') {
    dotCls = 'busy';
    title = 'Détection…';
    sub = 'Vérification';
  } else if (status === 'error') {
    dotCls = 'off';
    title = 'Carte indisponible';
    sub = 'Token occupé';
  } else {
    dotCls = 'off';
    title = 'Agent non détecté';
    sub = 'localhost:9795';
  }

  return (
    <div className="agent-chip">
      <span className={'agent-dot ' + dotCls} />
      <div className="agent-chip-text">
        <b>{title}</b>
        <span>{sub}</span>
      </div>
    </div>
  );
}

// ── Sidebar ─────────────────────────────────────────────────────────────────

interface SidebarProps {
  tab: Tab;
  setTab: (t: Tab) => void;
}

function Sidebar({ tab, setTab }: SidebarProps) {
  return (
    <aside className="sidebar">
      {/* Logo block */}
      <div className="sb-logo-block">
        <span className="sb-logo-mark">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 2.6 5 5.4v5.3c0 4.3 2.9 8.2 7 9.4 4.1-1.2 7-5.1 7-9.4V5.4L12 2.6Z"
              fill="#fff"
              fillOpacity=".22"
            />
            <path
              d="m9.2 12.1 1.9 1.9 3.8-3.9"
              stroke="#fff"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <div className="sb-logo-text">
          <div className="sb-logo-name">EU-DSS Sign</div>
          <div className="sb-logo-sub">Signature qualifiée</div>
        </div>
      </div>

      {/* SIGNATURE group */}
      <div className="sb-group-label">SIGNATURE</div>

      {/* Accueil — Phase 2 placeholder */}
      <div className="sb-item sb-item--disabled" title="Bientôt disponible">
        <span className="sb-item-icon">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
            <path
              d="M4 11.5 12 5l8 6.5M6 10v9h12v-9"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className="sb-item-label">Accueil</span>
        <span className="sb-soon">bientôt</span>
      </div>

      {/* Signer — active nav target */}
      <button
        className={'sb-item' + (tab === 'sign' ? ' sb-item--active' : '')}
        onClick={() => setTab('sign')}
      >
        <span className="sb-item-icon">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
            <path
              d="M3 17c3-1 4-7 7-7s2 4 5 3 4-6 6-6"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className="sb-item-label">Signer</span>
      </button>

      {/* Vérifier — active nav target */}
      <button
        className={'sb-item' + (tab === 'verify' ? ' sb-item--active' : '')}
        onClick={() => setTab('verify')}
      >
        <span className="sb-item-icon">
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
        </span>
        <span className="sb-item-label">Vérifier</span>
      </button>

      {/* GÉRER group */}
      <div className="sb-group-label sb-group-label--spaced">GÉRER</div>

      {/* Clé & certificat — Phase 2 placeholder */}
      <div className="sb-item sb-item--disabled" title="Bientôt disponible">
        <span className="sb-item-icon">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
            <circle cx="8" cy="13" r="3.3" stroke="currentColor" strokeWidth="1.8" />
            <path
              d="m10.4 10.6 8-8M15 5l2.5 2.5M18.5 8 21 5.5"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className="sb-item-label">Clé &amp; certificat</span>
        <span className="sb-soon">bientôt</span>
      </div>

      {/* Prérequis — Phase 2 placeholder */}
      <div className="sb-item sb-item--disabled" title="Bientôt disponible">
        <span className="sb-item-icon">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
            <path
              d="M5 6h14M5 12h14M5 18h9"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
            />
          </svg>
        </span>
        <span className="sb-item-label">Prérequis</span>
        <span className="sb-soon">bientôt</span>
      </div>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Thème toggle — visual only, Clair active */}
      <div className="sb-toggle-row">
        <div className="sb-toggle-label">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
          Thème
        </div>
        <div className="sb-toggle-group">
          <span className="sb-toggle-opt sb-toggle-opt--active">Clair</span>
          <span className="sb-toggle-opt">Sombre</span>
        </div>
      </div>

      {/* Langue toggle — visual only, FR active */}
      <div className="sb-toggle-row">
        <div className="sb-toggle-label">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="M3.5 12h17M12 3c2.6 2.7 2.6 15.3 0 18M12 3c-2.6 2.7-2.6 15.3 0 18"
              stroke="currentColor"
              strokeWidth="1.3"
            />
          </svg>
          Langue
        </div>
        <div className="sb-toggle-group">
          <span className="sb-toggle-opt sb-toggle-opt--active">FR</span>
          <span className="sb-toggle-opt">EN</span>
        </div>
      </div>

      {/* Agent status pill */}
      <AgentChip />
    </aside>
  );
}

// ── Shell ───────────────────────────────────────────────────────────────────

function Shell() {
  const [tab, setTab] = useState<Tab>('sign');

  return (
    <div className="shell">
      <TitleBar />
      <div className="shell-body">
        <Sidebar tab={tab} setTab={setTab} />
        <main className="main">
          {tab === 'sign' ? (
            <SignWorkspace onGoVerify={() => setTab('verify')} />
          ) : (
            <ValidatePage />
          )}
        </main>
      </div>
      <PinModal />
    </div>
  );
}

// ── App root ────────────────────────────────────────────────────────────────

export function App() {
  const [onboarded, setOnboarded] = useState(() => store.getOnboarding().passed);

  return (
    <AgentProvider>
      {onboarded ? (
        <Shell />
      ) : (
        <div className="shell">
          <TitleBar />
          <FirstRunWizard onComplete={() => setOnboarded(true)} />
        </div>
      )}
    </AgentProvider>
  );
}
