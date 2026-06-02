import { useEffect, useState } from 'react';
import { useAgent } from '../agent/AgentContext';
import { Btn, Icon } from './ui';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'] as const;

export function PinModal() {
  const { pinOpen, pinBusy, pinError, submitPin, cancelPin } = useAgent();
  const [pin, setPin] = useState('');
  const [shake, setShake] = useState(false);

  // Clear the field + shake the dots whenever a new error arrives.
  useEffect(() => {
    if (!pinError) return;
    setShake(true);
    setPin('');
    const t = setTimeout(() => setShake(false), 420);
    return () => clearTimeout(t);
  }, [pinError]);

  // Reset the field each time the modal (re)opens.
  useEffect(() => {
    if (pinOpen) setPin('');
  }, [pinOpen]);

  const press = (k: string) => {
    if (pinBusy) return;
    if (k === 'del') {
      setPin((p) => p.slice(0, -1));
      return;
    }
    setPin((p) => (p.length >= 6 ? p : p + k));
  };

  // Physical keyboard support: digits append, Backspace deletes, Enter submits (≥4).
  useEffect(() => {
    if (!pinOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Backspace') {
        e.preventDefault();
        press('del');
      } else if (/^[0-9]$/.test(e.key)) {
        press(e.key);
      } else if (e.key === 'Enter' && pin.length >= 4 && !pinBusy) {
        void submitPin(pin);
      } else if (e.key === 'Escape' && !pinBusy) {
        cancelPin();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pinOpen, pin, pinBusy, submitPin, cancelPin]);

  if (!pinOpen) return null;

  const canSubmit = pin.length >= 4 && !pinBusy;

  return (
    <div
      className="scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget && !pinBusy) cancelPin();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label="Code PIN de la carte">
        <div className="modal-h">
          <div className="mi">
            <Icon.key size={20} />
          </div>
          <div>
            <h3>Code PIN de la carte</h3>
            <p>Saisissez le code PIN pour déverrouiller votre certificat qualifié et signer.</p>
          </div>
        </div>

        <div className="modal-b">
          <div className={'pin-grid' + (shake ? ' shake' : '')}>
            {Array.from({ length: 6 }).map((_, i) => {
              const cls = pinError
                ? ' err'
                : pin.length === i
                  ? ' active'
                  : pin[i]
                    ? ' filled'
                    : '';
              return (
                <div key={i} className={'pin-cell' + cls}>
                  {pin[i] ? '•' : ''}
                </div>
              );
            })}
          </div>

          {pinError && (
            <div
              style={{
                color: 'var(--danger)',
                fontSize: 12.5,
                fontWeight: 700,
                textAlign: 'center',
                marginTop: 12,
                display: 'flex',
                gap: 6,
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              <Icon.alert size={14} /> {pinError}
            </div>
          )}

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3,1fr)',
              gap: 9,
              marginTop: 16,
            }}
          >
            {KEYS.map((k, i) =>
              k === '' ? (
                <div key={i} />
              ) : (
                <button
                  key={i}
                  type="button"
                  className="btn btn-ghost"
                  disabled={pinBusy}
                  style={{
                    padding: '13px 0',
                    fontSize: k === 'del' ? 14 : 18,
                    fontFamily: k === 'del' ? 'inherit' : '"JetBrains Mono",monospace',
                  }}
                  onClick={() => press(k)}
                >
                  {k === 'del' ? <Icon.x size={18} /> : k}
                </button>
              ),
            )}
          </div>

          <div
            className="help"
            style={{
              marginTop: 14,
              textAlign: 'center',
              display: 'flex',
              gap: 6,
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            <Icon.shield size={13} /> Le PIN n'est jamais stocké ni transmis. La clé privée ne quitte
            pas la carte.
          </div>
        </div>

        <div className="modal-f">
          <Btn variant="ghost" onClick={cancelPin} disabled={pinBusy}>
            Annuler
          </Btn>
          <Btn
            onClick={() => void submitPin(pin)}
            disabled={!canSubmit}
            icon={<Icon.key size={18} />}
          >
            {pinBusy ? 'Déverrouillage…' : 'Déverrouiller'}
          </Btn>
        </div>
      </div>
    </div>
  );
}
