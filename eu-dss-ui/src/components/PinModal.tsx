import { useEffect, useState } from 'react';
import { useAgent } from '../agent/AgentContext';
import { Icon } from './ui';
import { useT } from '../i18n';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'] as const;

export function PinModal() {
  const t = useT();
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
      className="pm-scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget && !pinBusy) cancelPin();
      }}
    >
      <div className="pm-card" role="dialog" aria-modal="true" aria-label={t('pin.dialogLabel')}>

        {/* Lock icon */}
        <span className={'pm-icon-tile' + (pinError ? ' pm-icon-tile--err' : '')}>
          <svg width="25" height="25" viewBox="0 0 24 24" fill="none">
            <rect x="5" y="11" width="14" height="9" rx="2.2"
              stroke={pinError ? 'var(--danger)' : 'var(--brand)'} strokeWidth="1.8" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3"
              stroke={pinError ? 'var(--danger)' : 'var(--brand)'} strokeWidth="1.8" />
            <circle cx="12" cy="15.5" r="1.3"
              fill={pinError ? 'var(--danger)' : 'var(--brand)'} />
          </svg>
        </span>

        {/* Title + subtitle */}
        <h3 className="pm-title">
          {pinError ? t('pin.incorrectTitle') : t('pin.unlockTitle')}
        </h3>
        {pinError ? (
          <p className="pm-sub pm-sub--err">{pinError}</p>
        ) : (
          <p className="pm-sub" dangerouslySetInnerHTML={{ __html: t('pin.sub') }} />
        )}

        {/* PIN dots */}
        <div className={'pm-dots' + (shake ? ' shake' : '')}>
          {Array.from({ length: 6 }).map((_, i) => {
            const filled = !!pin[i];
            const isErr = !!pinError;
            return (
              <span
                key={i}
                className={
                  'pm-dot' +
                  (isErr ? ' pm-dot--err' : filled ? ' pm-dot--filled' : '')
                }
              />
            );
          })}
        </div>

        {/* Numeric keypad */}
        <div className="pm-keypad">
          {KEYS.map((k, i) =>
            k === '' ? (
              <div key={i} />
            ) : (
              <button
                key={i}
                type="button"
                className="pm-key"
                disabled={pinBusy}
                onClick={() => press(k)}
                aria-label={k === 'del' ? t('pin.clearAria') : k}
              >
                {k === 'del' ? (
                  /* Backspace / erase icon matching the design canvas */
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M20 6H9L4 12l5 6h11a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1Z"
                      stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"
                    />
                    <path
                      d="m13 10 4 4m0-4-4 4"
                      stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"
                    />
                  </svg>
                ) : (
                  k
                )}
              </button>
            ),
          )}
        </div>

        {/* Primary action — Unlock */}
        <button
          type="button"
          className="pm-unlock-btn"
          disabled={!canSubmit}
          onClick={() => void submitPin(pin)}
        >
          {pinBusy ? (
            <>
              <span className="spinner" style={{ width: 16, height: 16 }} />
              {t('pin.unlocking')}
            </>
          ) : (
            <>
              <Icon.lock size={17} />
              {t('pin.unlockAndSign')}
            </>
          )}
        </button>

        {/* Cancel link */}
        <button
          type="button"
          className="pm-cancel-btn"
          disabled={pinBusy}
          onClick={cancelPin}
        >
          {t('common.cancel')}
        </button>

        {/* Footer note */}
        <div className="pm-footer-note">
          <Icon.clock size={13} />
          {t('pin.footer')}
        </div>
      </div>
    </div>
  );
}
