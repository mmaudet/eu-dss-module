import { useState } from 'react';

interface PinModalProps {
  open: boolean;
  busy: boolean;
  errorMessage?: string;
  onSubmit: (pin: string) => void;
  onCancel: () => void;
}

export function PinModal({ open, busy, errorMessage, onSubmit, onCancel }: PinModalProps) {
  const [pin, setPin] = useState('');
  if (!open) return null;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pin.length === 0 || busy) return;
    onSubmit(pin);
    setPin('');
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Saisie du PIN">
      <div className="modal-card">
        <h3>Déverrouiller la clé de signature</h3>
        <p className="muted">Saisissez le PIN de votre carte pour signer.</p>
        <form onSubmit={submit}>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            autoFocus
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="PIN"
            style={{ width: '100%', fontSize: 18, letterSpacing: 4 }}
          />
          {errorMessage && <div className="status error" style={{ marginTop: 8 }}>{errorMessage}</div>}
          <div className="status warn" style={{ marginTop: 8 }}>
            ⚠ Attention : un PIN erroné plusieurs fois (≈3) <strong>bloque la carte</strong>.
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" onClick={onCancel} disabled={busy}>Annuler</button>
            <button type="submit" className="primary" disabled={busy || pin.length === 0}>
              {busy ? 'Déverrouillage…' : 'Déverrouiller'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
