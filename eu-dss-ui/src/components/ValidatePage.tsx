import { useState } from 'react';
import { backendApi, ValidationResponse } from '../services/backendApi';
import { fileToBase64 } from '../services/fileUtils';

export function ValidatePage() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ValidationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function validate() {
    if (!file) return;
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      const pdfBase64 = await fileToBase64(file);
      const res = await backendApi.validate(pdfBase64);
      setResult(res);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="card">
        <h2>Document signé à vérifier</h2>
        <input
          type="file"
          accept=".pdf,.asice,.scs,.sce,.p7s,.xml,.docx,.xlsx,.odt"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setResult(null);
            setError(null);
          }}
        />
        <button className="primary" disabled={busy || !file} onClick={validate}>
          {busy ? 'Vérification…' : 'Vérifier la signature'}
        </button>
      </div>

      {error && <div className="card"><div className="status error">{error}</div></div>}

      {result && (
        <div className="card">
          <h2>Résultat</h2>
          <p>
            <strong>{result.signatureCount}</strong> signature(s) détectée(s).
          </p>
          {result.signatures.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Signataire</th>
                  <th>Format</th>
                  <th>Indication</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {result.signatures.map((s) => (
                  <tr key={s.signatureId}>
                    <td>{s.signedBy ?? '—'}</td>
                    <td><code>{s.signatureFormat ?? '—'}</code></td>
                    <td>
                      <code>{s.indication}</code>
                      {s.subIndication && <> / <code>{s.subIndication}</code></>}
                    </td>
                    <td>{s.signingDate ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {result.simpleReportXml && (
            <details style={{ marginTop: '1rem' }}>
              <summary>Rapport DSS détaillé (XML)</summary>
              <pre style={{ fontSize: '0.75rem', overflow: 'auto', maxHeight: 400 }}>
                {result.simpleReportXml}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
