import { useEffect, useState } from 'react';
import { agentApi, AgentCertificate, AgentError, AgentSessionStatus } from '../services/agentApi';
import { backendApi, SignatureParams } from '../services/backendApi';
import { downloadBase64, downloadZip, fileToBase64 } from '../services/fileUtils';
import { PinModal } from './PinModal';
import { PrerequisitesPanel } from './PrerequisitesPanel';

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
  const [pinResolver, setPinResolver] = useState<{ resolve: (certs: AgentCertificate[]) => void; reject: (e: Error) => void } | null>(null);

  useEffect(() => {
    void checkAgent();
  }, []);

  // Re-check when the user returns to the tab (e.g. after installing/launching the agent).
  useEffect(() => {
    const recheck = () => { if (!pinOpen && !busy) void checkAgent(); };
    window.addEventListener('focus', recheck);
    document.addEventListener('visibilitychange', recheck);
    return () => {
      window.removeEventListener('focus', recheck);
      document.removeEventListener('visibilitychange', recheck);
    };
  }, [pinOpen, busy]);

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

  async function loadCertificates(): Promise<AgentCertificate[]> {
    const { certificates } = await agentApi.listCertificates();
    setCertificates(certificates);
    if (certificates[0]) setSelectedKeyId(certificates[0].keyId);
    return certificates;
  }

  // Shows the modal and resolves with the cert list once the token is unlocked (or rejects on cancel).
  function promptUnlock(): Promise<AgentCertificate[]> {
    setPinError(undefined);
    setPinOpen(true);
    return new Promise<AgentCertificate[]>((resolve, reject) => setPinResolver({ resolve, reject }));
  }

  async function submitPin(pin: string) {
    setPinBusy(true);
    setPinError(undefined);
    try {
      const st = await agentApi.unlock(pin);
      setStatus(st);
      const certs = await loadCertificates();
      setPinOpen(false);
      pinResolver?.resolve(certs);
      setPinResolver(null);
    } catch (e) {
      if (e instanceof AgentError) {
        setPinError(
          e.code === 'pin_locked'
            ? 'Carte bloquée (trop d\'essais). Déblocage par PUK nécessaire.'
            : e.code === 'pin_incorrect'
              ? 'PIN incorrect.'
              : e.code === 'token_unavailable'
                ? 'Carte non détectée ou middleware ChamberSign manquant. Branche la carte / installe le middleware (voir la checklist Prérequis ci-dessous).'
                : (e.message || 'Échec du déverrouillage.'),
        );
      } else {
        setPinError((e as Error).message || 'Échec du déverrouillage.');
      }
    } finally {
      setPinBusy(false);
    }
  }

  function cancelPin() {
    setPinOpen(false);
    pinResolver?.reject(new Error('PIN annulé'));
    setPinResolver(null);
  }

  // Ensures unlocked before a signing operation; prompts if needed. Returns the cert list.
  async function ensureUnlocked(): Promise<AgentCertificate[]> {
    const st = await agentApi.getStatus().catch(() => null);
    setStatus(st);
    if (st?.unlocked) {
      return certificates.length > 0 ? certificates : await loadCertificates();
    }
    return await promptUnlock();
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

  async function signOne(doc: SignDoc, cert: AgentCertificate, retried = false) {
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
      if (e instanceof AgentError && e.code === 'locked' && !retried) {
        try {
          await promptUnlock();             // idle-locked mid-batch → re-prompt
          await signOne(doc, cert, true);   // retry this doc once
          return;
        } catch {
          patch(doc.id, { status: 'error', error: 'Signature annulée (PIN requis)' });
          return;
        }
      }
      patch(doc.id, { status: 'error', error: (e as Error).message });
    }
  }

  async function signAll() {
    let certs: AgentCertificate[];
    try { certs = await ensureUnlocked(); } catch { return; }
    const cert = certs.find((c) => c.keyId === selectedKeyId) ?? certs[0];
    if (!cert) return;
    setBusy(true);
    for (const doc of docs) {
      if (doc.status !== 'signed') await signOne(doc, cert);
    }
    setBusy(false);
  }

  async function signSingle(doc: SignDoc) {
    let certs: AgentCertificate[];
    try { certs = await ensureUnlocked(); } catch { return; }
    const cert = certs.find((c) => c.keyId === selectedKeyId) ?? certs[0];
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
        <PrerequisitesPanel
          agentStatus={agentStatus}
          status={status}
          hasCertificates={certificates.length > 0}
          onRecheck={() => void checkAgent()}
          onUnlock={() => void ensureUnlocked()}
          onLock={() => void lockNow()}
        />
        {agentStatus === 'available' && certificates.length > 0 && (
          <label style={{ display: 'block', marginTop: 8 }}>
            Certificat :{' '}
            <select value={selectedKeyId} onChange={(e) => setSelectedKeyId(e.target.value)}>
              {certificates.map((c) => (
                <option key={c.keyId} value={c.keyId}>
                  {c.subjectDn} (exp. {c.notAfter.slice(0, 10)})
                </option>
              ))}
            </select>
          </label>
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
