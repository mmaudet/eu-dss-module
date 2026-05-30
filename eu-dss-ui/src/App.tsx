import { useState } from 'react';
import { SignWorkspace } from './components/SignWorkspace';
import { ValidatePage } from './components/ValidatePage';

type Tab = 'sign' | 'validate';

export function App() {
  const [tab, setTab] = useState<Tab>('sign');

  return (
    <div className="app">
      <header>
        <h1>eu-dss — Signature électronique</h1>
        <p>Signer (PAdES / ASiC) et vérifier un ou plusieurs documents avec une clé USB cryptographique.</p>
      </header>

      <nav>
        <button className={tab === 'sign' ? 'active' : ''} onClick={() => setTab('sign')}>Signer</button>
        <button className={tab === 'validate' ? 'active' : ''} onClick={() => setTab('validate')}>Vérifier</button>
      </nav>

      {tab === 'sign' ? <SignWorkspace /> : <ValidatePage />}
    </div>
  );
}
