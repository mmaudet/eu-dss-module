import { useEffect, useState } from 'react';
import { agentApi, AgentCertificate, AgentError, AgentSessionStatus } from '../services/agentApi';
import { backendApi, SignatureParams } from '../services/backendApi';
import { downloadBase64, downloadZip, fileToBase64 } from '../services/fileUtils';
import { PinModal } from './PinModal';

type AgentStatus = 'checking' | 'available' | 'unavailable';
type DocStatus = 'pending' | 'signing' | 'signed' | 'error';

interface SignDoc {
  id: string;
  file: File;
  status: DocStatus;
  existingSignatures: number | null; // null until detected
  signed?: { base64: string; fileName: string; mediaType: string };
  error?: string;
}

let counter = 0;
const nextId = () => `doc-${++counter}`;

export function SignWorkspace() {
  const [agentStatus, setAgentStatus] = useState<AgentStatus>('checking');
  const [certificates, setCertificates] = useState<AgentCertificate[]>([]);
  const [selectedKeyId, setSelectedKeyId] = useState('');
  const [docs, setDocs] = useState<SignDoc[]>([]);
  const [reason, setReason] = useState('Signature électronique');
  const [location, setLocation] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<AgentSessionStatus | null>(null);
  const [pinOpen, setPinOpen] = useState(false);
  const [pinBusy, setPinBusy] = useState(false);
  const [pinError, setPinError] = useState<string | undefined>();
  // resolver for the unlock promise the signing flow awaits
  const [pinResolver, setPinResolver] = useState<{ resolve: () => void; reject: (e: Error) => void } | null>(null);

  useEffect(() => {
    void checkAgent();
  }, []);

  async function checkAgent() {
    setAgentStatus('checking');
    const ok = await agentApi.isAvailable();
    if (!ok) { setAgentStatus('unavailable'); return; }
    setAgentStatus('available');
    try {
      const st = await agentApi.getStatus();
      setStatus(st);
      if (st.unlocked) await loadCertificates();
    } catch {
      setStatus(null);
    }
  }

  async function loadCertificates() {
    const { certificates } = await agentApi.listCertificates();
    setCertificates(certificates);
    if (certificates[0]) setSelectedKeyId(certificates[0].keyId);
  }

  // Shows the modal and resolves once the token is unlocked (or rejects on cancel).
  function promptUnlock(): Promise<void> {
    setPinError(undefined);
    setPinOpen(true);
    return new Promise<void>((resolve, reject) => setPinResolver({ resolve, reject }));
  }

  async function submitPin(pin: string) {
    setPinBusy(true);
    setPinError(undefined);
    try {
      const st = await agentApi.unlock(pin);
      setStatus(st);
      await loadCertificates();
      setPinOpen(false);
      pinResolver?.resolve();
      setPinResolver(null);
    } catch (e) {
      const ae = e as AgentError;
      setPinError(ae.code === 'pin_locked'
        ? 'Carte bloquée (trop d\'essais). Déblocage par PUK nécessaire.'
        : ae.code === 'pin_incorrect' ? 'PIN incorrect.' : (ae.message || 'Échec du déverrouillage.'));
    } finally {
      setPinBusy(false);
    }
  }

  function cancelPin() {
    setPinOpen(false);
    pinResolver?.reject(new Error('PIN annulé'));
    setPinResolver(null);
  }

  // Ensures unlocked before a signing operation; prompts if needed.
  async function ensureUnlocked() {
    const st = await agentApi.getStatus().catch(() => null);
    setStatus(st);
    if (!st?.unlocked) await promptUnlock();
  }

  async function lockNow() {
    try { await agentApi.lock(); } catch { /* ignore */ }
    setStatus(await agentApi.getStatus().catch(() => null));
  }

  function patch(id: string, p: Partial<SignDoc>) {
    setDocs((d) => d.map((x) => (x.id === id ? { ...x, ...p } : x)));
  }

  function addFiles(list: FileList | null) {
    const added: SignDoc[] = Array.from(list ?? []).map((file) => ({
      id: nextId(),
      file,
      status: 'pending',
      existingSignatures: null,
    }));
    if (added.length === 0) return;
    setDocs((d) => [...d, ...added]);
    added.forEach((doc) => void detect(doc));
  }

  async function detect(doc: SignDoc) {
    try {
      const res = await backendApi.validate(await fileToBase64(doc.file));
      patch(doc.id, { existingSignatures: res.signatureCount });
    } catch {
      patch(doc.id, { existingSignatures: 0 });
    }
  }

  async function signOne(doc: SignDoc, cert: AgentCertificate) {
    patch(doc.id, { status: 'signing', error: undefined });
    try {
      const documentBase64 = await fileToBase64(doc.file);
      const params: SignatureParams = {
        certificateChainBase64: cert.certificateChainBase64,
        digestAlgorithm: 'SHA256',
        signingTimeEpochMs: Date.now(),
        signatureLevel: 'BASELINE_T',
        signatureReason: reason || undefined,
        signatureLocation: location || undefined,
        signerName: cert.subjectDn,
      };
      const prepared = await backendApi.prepare(documentBase64, doc.file.name, params);
      const { signatureValueBase64 } = await agentApi.signDigest(
        cert.keyId,
        prepared.dataToSignDigestBase64,
        'SHA256',
      );
      const assembled = await backendApi.assemble(documentBase64, doc.file.name, params, signatureValueBase64);
      patch(doc.id, {
        status: 'signed',
        signed: {
          base64: assembled.signedDocumentBase64,
          fileName: assembled.signedFileName,
          mediaType: assembled.mediaType,
        },
      });
    } catch (e) {
      if (e instanceof AgentError && e.code === 'locked') {
        try {
          await promptUnlock();      // idle-locked mid-batch → re-prompt
          await signOne(doc, cert);  // retry this doc once
          return;
        } catch (cancel) {
          patch(doc.id, { status: 'error', error: 'Signature annulée (PIN requis)' });
          return;
        }
      }
      patch(doc.id, { status: 'error', error: (e as Error).message });
    }
  }

  async function signAll() {
    try { await ensureUnlocked(); } catch { return; }
    const cert = certificates.find((c) => c.keyId === selectedKeyId) ?? certificates[0];
    if (!cert) return;
    setBusy(true);
    for (const doc of docs) {
      if (doc.status !== 'signed') await signOne(doc, cert);
    }
    setBusy(false);
  }

  async function signSingle(doc: SignDoc) {
    try { await ensureUnlocked(); } catch { return; }
    const cert = certificates.find((c) => c.keyId === selectedKeyId) ?? certificates[0];
    if (!cert) return;
    setBusy(true);
    await signOne(doc, cert);
    setBusy(false);
  }

  const signedDocs = docs.filter((d) => d.status === 'signed' && d.signed);
  const pendingCount = docs.filter((d) => d.status !== 'signed').length;
  const canSign = agentStatus === 'available' && pendingCount > 0 && !busy;

  return (
    <div>
      <div className="card">
        <h2>1. Agent local (clé USB)</h2>
        {agentStatus === 'checking' && <div className="status info">Vérification…</div>}
        {agentStatus === 'unavailable' && (
          <div className="status warn">
            <strong>Agent local non joignable.</strong> Première utilisation : l'agent tourne en HTTPS avec un certificat auto-signé qu'il faut accepter une fois.
            <ol style={{ margin: '8px 0 0 18px' }}>
              <li>Lance l'agent local (clé USB branchée, PIN saisi).</li>
              <li>Ouvre <a href="https://localhost:9795/rest/health" target="_blank" rel="noreferrer">https://localhost:9795/rest/health</a> et accepte le certificat de l'agent.</li>
              <li>Reviens ici et <button onClick={checkAgent} style={{ marginLeft: 2 }}>recharger</button>.</li>
            </ol>
          </div>
        )}
        {agentStatus === 'available' && status?.unlocked && certificates.length === 0 && (
          <div className="status warn">Agent OK mais aucun certificat. Vérifie la clé USB et le PIN.</div>
        )}
        {agentStatus === 'available' && certificates.length > 0 && (
          <>
            <div className="status ok">
              Agent connecté{certificates.length > 0 ? `, ${certificates.length} certificat(s)` : ''}.{' '}
              {status?.unlocked
                ? <>🔓 déverrouillé{status.expiresInSeconds != null ? ` (${status.expiresInSeconds}s)` : ''} <button onClick={() => void lockNow()}>Verrouiller</button></>
                : <>🔒 verrouillé <button onClick={() => void ensureUnlocked()}>Déverrouiller</button></>}
            </div>
            <label>
              Certificat :{' '}
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
        {agentStatus === 'available' && !status?.unlocked && certificates.length === 0 && (
          <div className="status ok">
            Agent connecté.{' '}
            🔒 verrouillé <button onClick={() => void ensureUnlocked()}>Déverrouiller</button>
          </div>
        )}
      </div>

      <div className="card">
        <h2>2. Documents</h2>
        <input
          type="file"
          multiple
          accept=".pdf,.docx,.xlsx,.pptx,.odt,.ods,.odp,.odg,.txt,.xml"
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <p className="muted">PDF → PAdES ; bureautique &amp; autres → conteneur ASiC-E (.asice). Un document déjà signé sera contre-signé.</p>
        {docs.length > 0 && (
          <table>
            <thead>
              <tr><th>Document</th><th>Signatures</th><th>État</th><th></th></tr>
            </thead>
            <tbody>
              {docs.map((doc) => (
                <tr key={doc.id}>
                  <td>{doc.file.name} <span className="muted">({(doc.file.size / 1024).toFixed(1)} KB)</span></td>
                  <td>
                    {doc.existingSignatures === null
                      ? <span className="muted">…</span>
                      : doc.existingSignatures > 0
                        ? <span className="badge">déjà signé : {doc.existingSignatures}</span>
                        : <span className="muted">non signé</span>}
                  </td>
                  <td>
                    {doc.status === 'pending' && <span className="muted">en attente</span>}
                    {doc.status === 'signing' && <span className="status-inline info">signature…</span>}
                    {doc.status === 'signed' && <span className="status-inline ok">✓ signé</span>}
                    {doc.status === 'error' && <span className="status-inline error" title={doc.error}>✗ {doc.error}</span>}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {doc.status === 'signed' && doc.signed ? (
                      <button onClick={() => downloadBase64(doc.signed!.base64, doc.signed!.fileName, doc.signed!.mediaType)}>
                        Télécharger
                      </button>
                    ) : (
                      <button disabled={!canSign} onClick={() => void signSingle(doc)}>
                        {doc.existingSignatures && doc.existingSignatures > 0 ? 'Contre-signer' : 'Signer'}
                      </button>
                    )}{' '}
                    <button onClick={() => setDocs((d) => d.filter((x) => x.id !== doc.id))} disabled={busy}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>3. Métadonnées</h2>
        <label>Motif : <input value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: 300 }} /></label>
        <br />
        <label>Lieu : <input value={location} onChange={(e) => setLocation(e.target.value)} style={{ width: 300 }} /></label>
        <p className="muted">Niveau : BASELINE-T (avec horodatage).</p>
      </div>

      <div className="card">
        <button className="primary" disabled={!canSign} onClick={() => void signAll()}>
          {busy ? 'Signature en cours…' : `Signer tout (${pendingCount})`}
        </button>{' '}
        <button disabled={signedDocs.length === 0 || busy}
          onClick={() => downloadZip(signedDocs.map((d) => ({ name: d.signed!.fileName, base64: d.signed!.base64 })), 'documents-signes.zip')}>
          Tout télécharger (ZIP)
        </button>
      </div>

      <PinModal
        open={pinOpen}
        busy={pinBusy}
        errorMessage={pinError}
        onSubmit={(pin) => void submitPin(pin)}
        onCancel={cancelPin}
      />
    </div>
  );
}
