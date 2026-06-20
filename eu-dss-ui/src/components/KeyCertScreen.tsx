import { useEffect, useState } from 'react';
import { useAgent } from '../agent/AgentContext';
import { downloadBase64 } from '../services/fileUtils';
import { Btn, Icon } from './ui';

// ── DN parsing (same helpers as SignWorkspace) ───────────────────────────────

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

// ── Clock helpers ─────────────────────────────────────────────────────────────

function fmtClock(s: number): string {
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${m}:${ss.toString().padStart(2, '0')}`;
}

// ── SHA-256 fingerprint ───────────────────────────────────────────────────────

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sha256Hex(base64: string): Promise<string> {
  const bytes = base64ToBytes(base64);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  // Group into space-separated 4-char blocks
  return hex.match(/.{1,4}/g)!.join(' ');
}

// ── KeyCertScreen ─────────────────────────────────────────────────────────────

export function KeyCertScreen() {
  const agent = useAgent();
  const { status, locked, secondsLeft, selectedCert, ensureUnlocked } = agent;

  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);

  // Compute SHA-256 fingerprint whenever the cert changes.
  useEffect(() => {
    setFingerprint(null);
    if (!selectedCert?.certificateBase64) return;
    let cancelled = false;
    sha256Hex(selectedCert.certificateBase64).then((fp) => {
      if (!cancelled) setFingerprint(fp);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedCert?.certificateBase64]);

  // Connection label
  const connectionLabel =
    status === 'available' ? 'Connectée' : 'Déconnectée';
  const connectionOk = status === 'available';

  // Lock label
  const lockLabel = locked
    ? 'Verrouillée'
    : `Déverrouillée · session active (${fmtClock(secondsLeft)})`;

  // Cert fields from real data
  const titulaire = cnOf(selectedCert?.subjectDn) || '—';
  const organisation = orgOf(selectedCert?.subjectDn) || '—';
  // Emetteur: CN from issuerDn, fallback to full issuerDn
  const emetteur =
    (selectedCert ? cnOf(selectedCert.issuerDn) || selectedCert.issuerDn : null) ?? '—';

  const validite = selectedCert
    ? `${new Date(selectedCert.notBefore).toLocaleDateString('fr-FR')} → ${new Date(selectedCert.notAfter).toLocaleDateString('fr-FR')}`
    : '—';

  const serial = selectedCert?.serialNumber || '—';

  const chainCount = selectedCert?.certificateChainBase64?.length ?? 0;

  async function handleUnlock() {
    setUnlocking(true);
    try {
      await ensureUnlocked();
    } catch {
      // User cancelled or PIN error — modal already handled the error display.
    } finally {
      setUnlocking(false);
    }
  }

  function handleExport() {
    if (!selectedCert) return;
    downloadBase64(
      selectedCert.certificateBase64,
      'certificat.cer',
      'application/x-x509-ca-cert',
    );
  }

  return (
    <div className="kc-screen">
      {/* ── Page header ── */}
      <div className="kc-header">
        <h2 className="kc-title">Clé &amp; certificat</h2>
        <p className="kc-sub">Votre token de signature et son certificat.</p>
      </div>

      {/* ── Two-column layout ── */}
      <div className="kc-body">
        {/* ── Left: Token card ── */}
        <div className="kc-token-card">
          {/* USB illustration */}
          <div className="kc-token-visual">
            <div className="kc-usb-wrap">
              <div className="kc-usb-plug" />
              <div className="kc-usb-body">
                <Icon.key size={22} />
                <span className="kc-led" data-ok={connectionOk ? '' : undefined} />
              </div>
            </div>
          </div>

          {/* Connection pill */}
          <div className={'kc-conn-pill' + (connectionOk ? ' ok' : ' off')}>
            <span className="kc-conn-dot" />
            {connectionLabel}
            {connectionOk && (
              <span className="kc-conn-sep">·</span>
            )}
            {connectionOk && (
              <span>{locked ? 'verrouillée' : 'déverrouillée'}</span>
            )}
          </div>

          {/* Token info rows */}
          <div className="kc-token-rows">
            <div className="kc-token-row">
              <span className="kc-token-label">Interface</span>
              <span className="kc-token-val mono">PKCS#11</span>
            </div>
            <div className="kc-token-row">
              <span className="kc-token-label">Session</span>
              <span className={'kc-token-val' + (locked ? ' kc-amber' : ' kc-green')}>
                {locked ? 'PIN requis' : lockLabel}
              </span>
            </div>
          </div>

          {/* Actions */}
          <div className="kc-token-actions">
            {locked ? (
              <button
                type="button"
                className="kc-btn-unlock"
                onClick={handleUnlock}
                disabled={unlocking || status !== 'available'}
              >
                <Icon.unlock size={15} />
                {unlocking ? 'Déverrouillage…' : 'Déverrouiller'}
              </button>
            ) : (
              <button
                type="button"
                className="kc-btn-lock"
                onClick={() => void agent.lock()}
              >
                <Icon.lock size={15} />
                Verrouiller
              </button>
            )}
            <div className="kc-pin-row">
              <button type="button" className="kc-btn-ghost" disabled>
                Changer le PIN
              </button>
              <span className="kc-pin-caption">via le middleware PKCS#11 de votre clé</span>
            </div>
          </div>
        </div>

        {/* ── Right: Cert details ── */}
        <div className="kc-cert-panel">
          {selectedCert ? (
            <>
              {/* Cert panel header */}
              <div className="kc-cert-head">
                <span className="kc-cert-title">Certificat de signature</span>
                <span className="kc-x509-badge">X.509</span>
              </div>

              {/* Cert grid */}
              <div className="kc-cert-grid">
                <div className="kc-cg-row">
                  <div className="kc-cg-cell">
                    <div className="kc-cg-label">TITULAIRE</div>
                    <div className="kc-cg-val">{titulaire}</div>
                  </div>
                  <div className="kc-cg-cell">
                    <div className="kc-cg-label">ORGANISATION</div>
                    <div className="kc-cg-val">{organisation || <span className="kc-dash">—</span>}</div>
                  </div>
                </div>
                <div className="kc-cg-row">
                  <div className="kc-cg-cell">
                    <div className="kc-cg-label">ÉMETTEUR</div>
                    <div className="kc-cg-val mono">{emetteur}</div>
                  </div>
                  <div className="kc-cg-cell">
                    <div className="kc-cg-label">VALIDITÉ</div>
                    <div className="kc-cg-val mono">{validite}</div>
                  </div>
                </div>
                <div className="kc-cg-row kc-cg-row--full">
                  <div className="kc-cg-cell">
                    <div className="kc-cg-label">N° DE SÉRIE</div>
                    <div className="kc-cg-val mono">{serial}</div>
                  </div>
                </div>
              </div>

              {/* Fingerprint — full width, monospaced */}
              <div className="kc-fp-block">
                <div className="kc-cg-label">EMPREINTE SHA-256</div>
                <div className="kc-fp-val mono">
                  {fingerprint ?? <span className="kc-computing">Calcul en cours…</span>}
                </div>
              </div>

              {/* Chain count */}
              {chainCount > 0 && (
                <div className="kc-chain-block">
                  <span className="kc-chain-toggle">
                    <Icon.key size={14} />
                    {chainCount} certificat{chainCount > 1 ? 's' : ''} dans la chaîne (fournis par le token)
                  </span>
                </div>
              )}

              {/* Bottom action bar */}
              <div className="kc-cert-actions">
                <Btn type="button" variant="ghost" size="sm" icon={<Icon.download size={15} />} onClick={handleExport}>
                  Exporter (.cer)
                </Btn>
                {chainCount === 0 && (
                  <Btn type="button" variant="ghost" size="sm" disabled>
                    Chaîne de confiance — bientôt
                  </Btn>
                )}
              </div>
            </>
          ) : (
            /* Empty state: either token absent or card locked */
            <div className="kc-cert-empty">
              <div className="kc-cert-empty-icon">
                {status !== 'available' ? <Icon.key size={26} /> : <Icon.lock size={26} />}
              </div>
              {status !== 'available' ? (
                <>
                  <p className="kc-cert-empty-title">Clé non connectée</p>
                  <p className="kc-cert-empty-sub">
                    Insérez votre clé USB pour afficher le certificat.
                  </p>
                  <Btn
                    type="button"
                    variant="primary"
                    icon={<Icon.unlock size={16} />}
                    disabled
                  >
                    Déverrouiller
                  </Btn>
                </>
              ) : (
                <>
                  <p className="kc-cert-empty-title">Clé verrouillée</p>
                  <p className="kc-cert-empty-sub">
                    Déverrouillez votre clé pour afficher le certificat.
                  </p>
                  <Btn
                    type="button"
                    variant="primary"
                    icon={<Icon.unlock size={16} />}
                    onClick={handleUnlock}
                    disabled={unlocking}
                  >
                    {unlocking ? 'Déverrouillage…' : 'Déverrouiller'}
                  </Btn>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
