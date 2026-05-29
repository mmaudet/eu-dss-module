import { useEffect, useState } from 'react';
import { agentApi, AgentCertificate } from '../services/agentApi';
import { backendApi, SignatureParams } from '../services/backendApi';
import { downloadBase64Pdf, fileToBase64 } from '../services/pdfUtils';

type AgentStatus = 'checking' | 'available' | 'unavailable';

export function SignPage() {
  const [agentStatus, setAgentStatus] = useState<AgentStatus>('checking');
  const [certificates, setCertificates] = useState<AgentCertificate[]>([]);
  const [selectedKeyId, setSelectedKeyId] = useState<string>('');
  const [files, setFiles] = useState<File[]>([]);
  const [reason, setReason] = useState('Signature électronique');
  const [location, setLocation] = useState('');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  useEffect(() => {
    void checkAgent();
  }, []);

  async function checkAgent() {
    setAgentStatus('checking');
    const ok = await agentApi.isAvailable();
    setAgentStatus(ok ? 'available' : 'unavailable');
    if (ok) {
      try {
        const { certificates } = await agentApi.listCertificates();
        setCertificates(certificates);
        if (certificates[0]) setSelectedKeyId(certificates[0].keyId);
      } catch (e) {
        appendLog(`Erreur lecture certificats : ${(e as Error).message}`);
      }
    }
  }

  function appendLog(line: string) {
    setLog((l) => [...l, `${new Date().toLocaleTimeString()} ${line}`]);
  }

  async function signAll() {
    const cert = certificates.find((c) => c.keyId === selectedKeyId);
    if (!cert) {
      appendLog('Aucun certificat sélectionné.');
      return;
    }
    setBusy(true);
    try {
      for (const file of files) {
        appendLog(`▶ ${file.name} — préparation`);
        const pdfBase64 = await fileToBase64(file);
        const params: SignatureParams = {
          certificateChainBase64: cert.certificateChainBase64,
          digestAlgorithm: 'SHA256',
          signingTimeEpochMs: Date.now(),
          signatureLevel: 'PADES_BASELINE_T',
          signatureReason: reason || undefined,
          signatureLocation: location || undefined,
          signerName: cert.subjectDn,
        };

        const prepared = await backendApi.prepare(pdfBase64, params);
        appendLog(`  digest reçu, demande signature au token…`);

        const { signatureValueBase64 } = await agentApi.signDigest(
          cert.keyId,
          prepared.dataToSignDigestBase64,
          'SHA256'
        );
        appendLog(`  signature OK, assemblage…`);

        const { signedPdfBase64 } = await backendApi.assemble(pdfBase64, params, signatureValueBase64);
        downloadBase64Pdf(signedPdfBase64, file.name.replace(/\.pdf$/i, '') + '-signed.pdf');
        appendLog(`  ✓ ${file.name} signé et téléchargé.`);
      }
    } catch (e) {
      appendLog(`✗ Erreur : ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="card">
        <h2>1. Agent local (clé USB)</h2>
        {agentStatus === 'checking' && <div className="status info">Vérification…</div>}
        {agentStatus === 'unavailable' && (
          <div className="status warn">
            Agent local introuvable sur <code>https://localhost:9795</code>. Lance l'agent puis{' '}
            <button onClick={checkAgent} style={{ marginLeft: 4 }}>
              recharger
            </button>
            .
            <div className="muted" style={{ marginTop: 6 }}>
              Le premier appel demandera d'accepter le certificat HTTPS auto-signé de l'agent dans le navigateur.
            </div>
          </div>
        )}
        {agentStatus === 'available' && certificates.length === 0 && (
          <div className="status warn">
            Agent OK mais aucun certificat trouvé. Vérifie que la clé USB est branchée et que le PIN est saisi.
          </div>
        )}
        {agentStatus === 'available' && certificates.length > 0 && (
          <>
            <div className="status ok">Agent connecté, {certificates.length} certificat(s) détecté(s).</div>
            <label>
              Certificat à utiliser :{' '}
              <select value={selectedKeyId} onChange={(e) => setSelectedKeyId(e.target.value)}>
                {certificates.map((c) => (
                  <option key={c.keyId} value={c.keyId}>
                    {c.subjectDn} (exp. {c.notAfter.slice(0, 10)})
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </div>

      <div className="card">
        <h2>2. PDFs à signer</h2>
        <input
          type="file"
          accept="application/pdf"
          multiple
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
        />
        {files.length > 0 && (
          <ul>
            {files.map((f) => (
              <li key={f.name}>
                {f.name} <span className="muted">({(f.size / 1024).toFixed(1)} KB)</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <h2>3. Métadonnées de signature</h2>
        <label>
          Motif :{' '}
          <input value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: 300 }} />
        </label>
        <br />
        <label>
          Lieu :{' '}
          <input value={location} onChange={(e) => setLocation(e.target.value)} style={{ width: 300 }} />
        </label>
        <p className="muted">Niveau : PAdES-BASELINE-T (avec horodatage qualifié)</p>
      </div>

      <div className="card">
        <button
          className="primary"
          disabled={busy || agentStatus !== 'available' || files.length === 0 || !selectedKeyId}
          onClick={signAll}
        >
          {busy ? 'Signature en cours…' : `Signer ${files.length} PDF`}
        </button>
      </div>

      {log.length > 0 && (
        <div className="card">
          <h2>Journal</h2>
          <pre style={{ fontSize: '0.85rem', whiteSpace: 'pre-wrap' }}>{log.join('\n')}</pre>
        </div>
      )}
    </div>
  );
}
