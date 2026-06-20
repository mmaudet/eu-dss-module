import { useState } from 'react';
import { AgentProvider, useAgent } from './agent/AgentContext';
import { AccueilScreen } from './components/AccueilScreen';
import { FirstRunWizard } from './components/FirstRunWizard';
import { KeyCertScreen } from './components/KeyCertScreen';
import { PinModal } from './components/PinModal';
import { PrerequisitesScreen } from './components/PrerequisitesScreen';
import { SignWorkspace } from './components/SignWorkspace';
import { TitleBar } from './components/TitleBar';
import { ValidatePage } from './components/ValidatePage';
import { store } from './services/store';
import type { ThemePref } from './services/store';
import { useLang, useT } from './i18n';

export type Tab = 'accueil' | 'sign' | 'verify' | 'cle' | 'prerequis';

// ── Agent status pill (sidebar bottom) ─────────────────────────────────────

function AgentChip() {
  const { status, locked } = useAgent();
  const t = useT();

  let dotCls: string;
  let title: string;
  let sub: string;

  if (status === 'available') {
    dotCls = 'on';
    title = t('agent.chip.connected');
    sub = locked ? t('agent.chip.cardLocked') : t('agent.chip.sessionActive');
  } else if (status === 'checking') {
    dotCls = 'busy';
    title = t('agent.chip.detecting');
    sub = t('agent.chip.checking');
  } else if (status === 'error') {
    dotCls = 'off';
    title = t('agent.chip.cardUnavailable');
    sub = t('agent.chip.tokenBusy');
  } else {
    dotCls = 'off';
    title = t('agent.chip.notDetected');
    sub = t('agent.chip.checkKey');
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
  theme: ThemePref;
  setTheme: (t: ThemePref) => void;
}

function Sidebar({ tab, setTab, theme, setTheme }: SidebarProps) {
  const t = useT();
  const { lang, setLang } = useLang();

  function handleTheme(next: ThemePref) {
    store.setTheme(next);
    if (next === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.setAttribute('data-theme', 'light');
    }
    setTheme(next);
  }

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
          <div className="sb-logo-sub">{t('nav.brandSub')}</div>
        </div>
      </div>

      {/* SIGNATURE group */}
      <div className="sb-group-label">{t('nav.groupSignature')}</div>

      {/* Accueil — active nav target */}
      <button
        type="button"
        className={'sb-item' + (tab === 'accueil' ? ' sb-item--active' : '')}
        onClick={() => setTab('accueil')}
      >
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
        <span className="sb-item-label">{t('nav.home')}</span>
      </button>

      {/* Signer — active nav target */}
      <button
        type="button"
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
        <span className="sb-item-label">{t('nav.sign')}</span>
      </button>

      {/* Vérifier — active nav target */}
      <button
        type="button"
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
        <span className="sb-item-label">{t('nav.verify')}</span>
      </button>

      {/* GÉRER group */}
      <div className="sb-group-label sb-group-label--spaced">{t('nav.groupManage')}</div>

      {/* Clé & certificat — active nav target */}
      <button
        type="button"
        className={'sb-item' + (tab === 'cle' ? ' sb-item--active' : '')}
        onClick={() => setTab('cle')}
      >
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
        <span className="sb-item-label">{t('nav.key')}</span>
      </button>

      {/* Prérequis — active nav target */}
      <button
        type="button"
        className={'sb-item' + (tab === 'prerequis' ? ' sb-item--active' : '')}
        onClick={() => setTab('prerequis')}
      >
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
        <span className="sb-item-label">{t('nav.prereq')}</span>
      </button>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Thème toggle — wired to dark/light theme */}
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
          {t('nav.theme')}
        </div>
        <div className="sb-toggle-group">
          <button
            type="button"
            className={'sb-toggle-opt' + (theme === 'light' ? ' sb-toggle-opt--active' : '')}
            onClick={() => handleTheme('light')}
          >{t('nav.themeLight')}</button>
          <button
            type="button"
            className={'sb-toggle-opt' + (theme === 'dark' ? ' sb-toggle-opt--active' : '')}
            onClick={() => handleTheme('dark')}
          >{t('nav.themeDark')}</button>
        </div>
      </div>

      {/* Langue toggle — switches the whole UI language */}
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
          {t('nav.language')}
        </div>
        <div className="sb-toggle-group">
          <button
            type="button"
            className={'sb-toggle-opt' + (lang === 'fr' ? ' sb-toggle-opt--active' : '')}
            onClick={() => setLang('fr')}
          >FR</button>
          <button
            type="button"
            className={'sb-toggle-opt' + (lang === 'en' ? ' sb-toggle-opt--active' : '')}
            onClick={() => setLang('en')}
          >EN</button>
        </div>
      </div>

      {/* Agent status pill */}
      <AgentChip />
    </aside>
  );
}

// ── Shell ───────────────────────────────────────────────────────────────────

function Shell() {
  const [tab, setTab] = useState<Tab>('accueil');
  const [theme, setTheme] = useState<ThemePref>(() => store.getTheme());

  return (
    <div className="shell">
      <TitleBar />
      <div className="shell-body">
        <Sidebar tab={tab} setTab={setTab} theme={theme} setTheme={setTheme} />
        <main className="main">
          {tab === 'accueil' ? (
            <AccueilScreen onNavigate={setTab} />
          ) : tab === 'sign' ? (
            <SignWorkspace onGoVerify={() => setTab('verify')} />
          ) : tab === 'verify' ? (
            <ValidatePage />
          ) : tab === 'prerequis' ? (
            <PrerequisitesScreen onGoToSign={() => setTab('sign')} />
          ) : (
            <KeyCertScreen />
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
