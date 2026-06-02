import { useRef, useState } from 'react';
import { backendApi, ValidationResponse, SignatureSummary } from '../services/backendApi';
import { fileToBase64 } from '../services/fileUtils';
import { Icon, Btn, Card, Banner, Tag, fileKind } from './ui';

/* ---- helpers ---- */

function initials(name: string | null): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  return `${(bytes / 1024).toFixed(0)} Ko`;
}

function todayFR(): string {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

/* ---- Signature row ---- */

function SignatureRow({ s }: { s: SignatureSummary }) {
  const passed = s.indication === 'TOTAL_PASSED';
  return (
    <tr>
      <td>
        <div className="signer-cell">
          <div className="avatar">{initials(s.signedBy)}</div>
          <div>
            <div style={{ fontWeight: 700 }}>{s.signedBy ?? 'Signataire inconnu'}</div>
            <div style={{ fontSize: 12, color: 'var(--ink-3)', fontWeight: 600 }}>{s.signatureId}</div>
          </div>
        </div>
      </td>
      <td><Tag kind="brand">{s.signatureFormat ?? '—'}</Tag></td>
      <td>
        {passed
          ? <Tag kind="ok"><Icon.check size={12} /> TOTAL_PASSED</Tag>
          : <Tag kind="warn">{s.indication}{s.subIndication ? ' · ' + s.subIndication : ''}</Tag>
        }
      </td>
      <td className="mono" style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>
        {s.signingDate ?? '—'}
      </td>
    </tr>
  );
}

/* ---- XmlReport ---- */

function XmlReport({ xml }: { xml: string | null }) {
  if (!xml) {
    return <div className="xmlbox"><div className="empty-note">Rapport XML indisponible.</div></div>;
  }
  return (
    <div className="xmlbox">
      <pre>{xml}</pre>
    </div>
  );
}

/* ---- Main component ---- */

export function ValidatePage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ValidationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  function clearFile() {
    setFile(null);
    setResult(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = '';
  }

  function pickFile(chosen: File | undefined) {
    if (!chosen) return;
    setFile(chosen);
    setResult(null);
    setError(null);
  }

  async function validate() {
    if (!file) return;
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      const base64 = await fileToBase64(file);
      const res = await backendApi.validate(base64);
      setResult(res);
    } catch (e) {
      setError((e as Error).message ?? 'Erreur inconnue');
    } finally {
      setBusy(false);
    }
  }

  /* verdict */
  const valid =
    result !== null &&
    result.signatureCount > 0 &&
    result.signatures.every((s) => s.indication === 'TOTAL_PASSED');

  const noSig = result !== null && result.signatureCount === 0;

  return (
    <div className="rise" key="verify">
      <Card
        no=""
        title="Document signé à vérifier"
        desc="Déposez un PDF (PAdES) ou un conteneur ASiC-E (.asice) pour contrôler ses signatures."
      >
        {/* hidden file input */}
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.asice,.asics,.p7s,.p7m,.xml,.scs"
          style={{ display: 'none' }}
          onChange={(e) => pickFile(e.target.files?.[0])}
        />

        {!file ? (
          /* ---- dropzone ---- */
          <div
            className="dropzone"
            style={dragOver ? { borderColor: 'var(--brand)', background: 'var(--brand-soft)' } : undefined}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              pickFile(e.dataTransfer.files?.[0]);
            }}
          >
            <div className="dz-ic"><Icon.upload size={22} /></div>
            <b>Choisir un fichier signé</b>
            <span className="dz-sub">PAdES (.pdf) · ASiC-E (.asice) · CAdES / XAdES</span>
          </div>
        ) : (
          /* ---- file chosen ---- */
          <div>
            <div className="frow">
              <div className="fic">{fileKind(file.name).ext}</div>
              <div className="fmeta">
                <div className="fname">{file.name}</div>
                <div className="fsub">
                  <span>{formatBytes(file.size)} · prêt à vérifier</span>
                </div>
              </div>
              <button className="x-btn" title="Retirer" onClick={clearFile}>
                <Icon.x size={15} />
              </button>
            </div>

            <div style={{ marginTop: 16, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <Btn
                onClick={validate}
                disabled={busy}
                icon={busy ? <span className="spinner" /> : <Icon.shieldCheck size={18} />}
              >
                {busy ? 'Vérification…' : 'Vérifier la signature'}
              </Btn>

              {result !== null && (
                <Btn
                  variant="ghost"
                  onClick={() => { setResult(null); setError(null); }}
                  icon={<Icon.refresh size={16} />}
                >
                  Réinitialiser
                </Btn>
              )}
            </div>
          </div>
        )}
      </Card>

      {/* ---- error banner ---- */}
      {error && (
        <div style={{ marginTop: 20 }}>
          <Banner kind="danger" icon={<Icon.alert size={20} />} title="Échec de la vérification">
            {error}
          </Banner>
        </div>
      )}

      {/* ---- result card ---- */}
      {result !== null && (
        <section className="card rise" style={{ marginTop: 20 }}>
          <div className="card-h">
            <div className="hh">
              <h2>Résultat de la validation</h2>
              <p>
                <b style={{ color: 'var(--ink)' }}>{result.signatureCount}</b>{' '}
                signature(s) détectée(s) · contrôle eIDAS effectué le {todayFR()}
              </p>
            </div>
          </div>
          <div className="card-b">
            {/* verdict banner */}
            {valid && (
              <div className="banner ok" style={{ marginBottom: 18 }}>
                <span className="bi"><Icon.shieldCheck size={20} /></span>
                <div style={{ flex: 1 }}>
                  <b>Signature valide — TOTAL_PASSED</b>
                  <div style={{ marginTop: 3 }}>
                    L'intégrité du document est confirmée et le certificat du signataire est reconnu.
                    Horodatage qualifié présent.
                  </div>
                </div>
                <Tag kind="ok">eIDAS · QESig</Tag>
              </div>
            )}
            {noSig && (
              <Banner kind="warn" icon={<Icon.alert size={20} />} title="Aucune signature détectée">
                Aucune signature numérique n'a été trouvée dans ce document.
              </Banner>
            )}
            {!valid && !noSig && result.signatureCount > 0 && (
              <Banner kind="danger" icon={<Icon.alert size={20} />} title="Signature(s) non valide(s)">
                Une ou plusieurs signatures n'ont pas pu être validées. Vérifiez les indications ci-dessous.
              </Banner>
            )}

            {/* signatures table */}
            {result.signatures.length > 0 && (
              <div style={{ overflowX: 'auto', marginTop: valid ? 0 : 18 }}>
                <table className="rtable">
                  <thead>
                    <tr>
                      <th>Signataire</th>
                      <th>Format</th>
                      <th>Indication</th>
                      <th>Horodatage</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.signatures.map((s) => (
                      <SignatureRow key={s.signatureId} s={s} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* DSS XML disclosure */}
            <details className="disclosure">
              <summary>
                <span className="chev"><Icon.chevR size={16} /></span>
                Rapport DSS détaillé (XML)
              </summary>
              <div style={{ paddingBottom: 16 }}>
                <XmlReport xml={result.simpleReportXml} />
              </div>
            </details>
          </div>
        </section>
      )}
    </div>
  );
}
