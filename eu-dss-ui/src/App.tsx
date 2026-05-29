import { useState } from 'react';
import { SignPage } from './components/SignPage';
import { ValidatePage } from './components/ValidatePage';

type Tab = 'sign' | 'validate';

export function App() {
  const [tab, setTab] = useState<Tab>('sign');

  return (
    <div className="app">
      <header>
        <h1>eu-dss — Signature PAdES qualifiée</h1>
        <p>Signer et vérifier des PDF avec une clé USB cryptographique (EU DSS).</p>
      </header>

      <nav>
        <button className={tab === 'sign' ? 'active' : ''} onClick={() => setTab('sign')}>
          Signer
        </button>
        <button className={tab === 'validate' ? 'active' : ''} onClick={() => setTab('validate')}>
          Vérifier
        </button>
      </nav>

      {tab === 'sign' ? <SignPage /> : <ValidatePage />}
    </div>
  );
}
