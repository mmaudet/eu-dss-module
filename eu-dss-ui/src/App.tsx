import { useState } from 'react';
import { AgentProvider, useAgent } from './agent/AgentContext';
import { PinModal } from './components/PinModal';
import { SignWorkspace } from './components/SignWorkspace';
import { ValidatePage } from './components/ValidatePage';
import { Icon, TrustBadge } from './components/ui';

type Tab = 'sign' | 'verify';

interface SidebarProps {
  tab: Tab;
  setTab: (t: Tab) => void;
}

function AgentChip() {
  const { status, locked } = useAgent();
  const a =
    status === 'available'
      ? { cls: 'on', t: 'Agent connecté', s: locked ? 'Carte verrouillée' : 'Session active' }
      : status === 'checking'
        ? { cls: 'busy', t: 'Détection…', s: 'Vérification' }
        : status === 'error'
          ? { cls: 'off', t: 'Carte indisponible', s: 'Token occupé' }
          : { cls: 'off', t: 'Agent non détecté', s: 'localhost:9795' };
  return (
    <div className="agent-chip">
      <span className={'agent-dot ' + a.cls} />
      <div className="t">
        <b>{a.t}</b>
        <span>{a.s}</span>
      </div>
    </div>
  );
}

function Sidebar({ tab, setTab }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="brand-row">
        <div className="brand-mark">
          <Icon.shieldCheck size={20} />
        </div>
        <div className="brand-name">
          <b>EU-DSS Sign</b>
          <span>Signature électronique</span>
        </div>
      </div>

      <div className="nav-label">Signature</div>
      <button
        className={'nav-item' + (tab === 'sign' ? ' active' : '')}
        onClick={() => setTab('sign')}
      >
        <span className="ico">
          <Icon.sign size={19} />
        </span>
        <span className="lbl">Signer</span>
      </button>
      <button
        className={'nav-item' + (tab === 'verify' ? ' active' : '')}
        onClick={() => setTab('verify')}
      >
        <span className="ico">
          <Icon.shieldCheck size={19} />
        </span>
        <span className="lbl">Vérifier</span>
      </button>

      <div className="sidebar-foot">
        <AgentChip />
      </div>
    </aside>
  );
}

function Shell() {
  const [tab, setTab] = useState<Tab>('sign');

  const head =
    tab === 'sign'
      ? {
          h: 'Signer',
          s: 'Signez un ou plusieurs documents avec votre clé USB cryptographique.',
        }
      : {
          h: 'Vérifier',
          s: "Contrôlez les signatures et la conformité eIDAS d'un document.",
        };

  return (
    <div className="shell">
      <Sidebar tab={tab} setTab={setTab} />
      <main className="main">
        <header className="topbar">
          <div>
            <h1>{head.h}</h1>
            <div className="sub">{head.s}</div>
          </div>
          <div className="spacer" />
          <div className="trust-row">
            <TrustBadge kind="solid" icon={<Icon.euro size={14} />}>
              eIDAS
            </TrustBadge>
            <TrustBadge icon={<Icon.shieldCheck size={14} />}>
              Signature avancée (AdES)
            </TrustBadge>
          </div>
        </header>

        <div className="content">
          {tab === 'sign' ? <SignWorkspace onGoVerify={() => setTab('verify')} /> : <ValidatePage />}
        </div>
      </main>

      <PinModal />
    </div>
  );
}

export function App() {
  return (
    <AgentProvider>
      <Shell />
    </AgentProvider>
  );
}
