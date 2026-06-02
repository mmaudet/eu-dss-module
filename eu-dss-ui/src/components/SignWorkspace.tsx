import { useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useAgent } from '../agent/AgentContext';
import { agentApi, AgentCertificate, AgentError } from '../services/agentApi';
import { backendApi, SignatureParams } from '../services/backendApi';
import { detectOs, PREREQ_MANIFEST } from '../services/prerequisites';
import { downloadBase64, downloadZip, fileToBase64 } from '../services/fileUtils';
import { Banner, Btn, Card, CertGrid, fileKind, Icon, Tag, TrustBadge } from './ui';

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

function fmtClock(s: number): string {
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${m}:${ss.toString().padStart(2, '0')}`;
}

/** Extract a single RDN value (CN / O) from an RFC-ish DN. Falls back to the raw DN. */
function dnPart(dn: string | undefined, key: 'CN' | 'O'): string {
  if (!dn) return '';
  // Split on commas not preceded by a backslash (escaped), then match KEY=value.
  const parts = dn.split(/(?<!\\),/);
  for (const raw of parts) {
    const seg = raw.trim();
    const eq = seg.indexOf('=');
    if (eq < 0) continue;
    if (seg.slice(0, eq).trim().toUpperCase() === key) {
      return seg
        .slice(eq + 1)
        .trim()
        .replace(/\\(.)/g, '$1'); // unescape \, \= etc.
    }
  }
  return '';
}

const cnOf = (dn: string | undefined): string => dnPart(dn, 'CN') || (dn ?? '');
const orgOf = (dn: string | undefined): string => dnPart(dn, 'O');
const issuerOf = (dn: string | undefined): string => dnPart(dn, 'CN') || dnPart(dn, 'O') || (dn ?? '');

const ACCEPT = '.pdf,.docx,.xlsx,.pptx,.odt,.ods,.odp,.odg,.txt,.xml';

interface SignWorkspaceProps {
  onGoVerify: () => void;
}

/* ====================================================================== */

export function SignWorkspace({ onGoVerify }: SignWorkspaceProps) {
  const agent = useAgent();
  const { status, selectedKeyId, selectedCert } = agent;

  const [docs, setDocs] = useState<SignDoc[]>([]);
  const [reason, setReason] = useState('Signature électronique');
  const [location, setLocation] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false); // success view
  const [signedSnapshot, setSignedSnapshot] = useState<SignDoc[]>([]); // docs targeted by the last batch
  const [signedAtIso, setSignedAtIso] = useState<string>('');

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

  async function signOne(doc: SignDoc, cert: AgentCertificate, retried = false): Promise<void> {
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
          await agent.ensureUnlocked(); // idle-locked mid-batch → re-prompt
          await signOne(doc, cert, true); // retry this doc once
          return;
        } catch {
          patch(doc.id, { status: 'error', error: 'Signature annulée (PIN requis)' });
          return;
        }
      }
      patch(doc.id, { status: 'error', error: (e as Error).message });
    }
  }

  async function runBatch(targets: SignDoc[]) {
    let certs: AgentCertificate[];
    try {
      certs = await agent.ensureUnlocked();
    } catch {
      return;
    }
    const cert = certs.find((c) => c.keyId === selectedKeyId) ?? certs[0];
    if (!cert) return;
    setSignedSnapshot(targets);
    setBusy(true);
    for (const doc of targets) {
      if (doc.status !== 'signed') await signOne(doc, cert);
    }
    setBusy(false);
    // Success only if every targeted doc ended up signed.
    setSignedAtIso(new Date().toISOString());
    setDone(true);
  }

  function signAll() {
    void runBatch(docs.filter((d) => d.status !== 'signed'));
  }

  const signedDocs = docs.filter((d) => d.status === 'signed' && d.signed);
  const pendingCount = docs.filter((d) => d.status !== 'signed').length;
  const available = status === 'available';
  const canSign = available && pendingCount > 0 && !busy;

  // ---- Success view: render once all targeted docs are signed and batch is finished.
  const allTargetedSigned =
    done && signedSnapshot.length > 0 && signedSnapshot.every((t) => docs.find((d) => d.id === t.id)?.status === 'signed');

  if (allTargetedSigned) {
    return (
      <SuccessView
        signedDocs={signedDocs}
        cert={selectedCert}
        reason={reason}
        location={location}
        signedAtIso={signedAtIso}
        onReset={() => {
          setDone(false);
          setSignedSnapshot([]);
          setDocs([]);
        }}
        onGoVerify={onGoVerify}
      />
    );
  }

  return (
    <div className="rise" key="sign">
      <AgentPanel />

      <DocumentsPanel docs={docs} addFiles={addFiles} setDocs={setDocs} busy={busy} />

      <Card no="3" title="Métadonnées" desc="Informations scellées dans la signature.">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div className="field">
            <label htmlFor="sign-reason">Motif de la signature</label>
            <input
              id="sign-reason"
              className="input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="sign-location">Lieu</label>
            <input
              id="sign-location"
              className="input"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="ex. Paris, France"
            />
          </div>
        </div>
        <div className="help" style={{ marginTop: 14, display: 'flex', gap: 8, alignItems: 'center' }}>
          <Tag kind="brand">PAdES-BASELINE-T</Tag> Niveau avancé avec horodatage qualifié (TSA) —
          conforme eIDAS.
        </div>
      </Card>

      <div className="action-bar">
        <div className="ab-info">
          {available ? (
            <>
              <b>{docs.length}</b> document{docs.length > 1 ? 's' : ''} prêt{docs.length > 1 ? 's' : ''}
              {selectedCert && (
                <>
                  {' '}· certificat <b>{cnOf(selectedCert.subjectDn)}</b>
                </>
              )}
            </>
          ) : (
            <>
              <Icon.alert size={15} /> Connectez l'agent pour signer
            </>
          )}
        </div>
        <div className="sp" />
        <Btn
          variant="ghost"
          size="lg"
          disabled={signedDocs.length === 0}
          icon={<Icon.download size={17} />}
          onClick={() =>
            downloadZip(
              signedDocs.map((d) => ({ name: d.signed!.fileName, base64: d.signed!.base64 })),
              'documents-signes.zip',
            )
          }
        >
          Tout télécharger (ZIP)
        </Btn>
        <Btn size="lg" disabled={!canSign} onClick={signAll} icon={<Icon.sign size={18} />}>
          Signer tout ({pendingCount})
        </Btn>
      </div>

      {busy && <SigningProgress docs={signedSnapshot.length > 0 ? signedSnapshot : docs} liveDocs={docs} />}
    </div>
  );
}

/* -------------------- Agent panel (all states) -------------------- */
function AgentPanel() {
  const {
    status,
    session,
    locked,
    secondsLeft,
    certificates,
    selectedKeyId,
    setSelectedKeyId,
    selectedCert,
    recheck,
    lock,
  } = useAgent();
  const prereq = PREREQ_MANIFEST[detectOs()];

  return (
    <Card
      no="1"
      title="Agent local (clé USB)"
      desc="Pont sécurisé entre le navigateur et votre carte cryptographique."
    >
      {status === 'unavailable' && (
        <>
          <Banner
            kind="warn"
            icon={<Icon.alert size={20} />}
            title="Agent local non détecté"
            links={
              <>
                <a className="linkbtn" href={prereq.docUrl} target="_blank" rel="noreferrer">
                  Guide d'installation (macOS / Windows)
                </a>
                <span className="dot-sep">·</span>
                <a className="linkbtn" href={prereq.agentInstaller.url} target="_blank" rel="noreferrer">
                  {prereq.agentInstaller.label}
                </a>
                <span className="dot-sep">·</span>
                <Btn variant="ghost" size="sm" onClick={() => void recheck()} icon={<Icon.refresh size={14} />}>
                  Revérifier
                </Btn>
              </>
            }
          >
            L'agent n'est pas lancé, pas installé, ou son certificat n'a pas encore été accepté. Il
            expose{' '}
            <span className="mono" style={{ fontSize: 12 }}>
              https://localhost:9795
            </span>
            .
          </Banner>

          <div className="banner info" style={{ marginTop: 12 }}>
            <span className="bi">
              <Icon.usb size={19} />
            </span>
            <div style={{ flex: 1 }}>
              Carte branchée + middleware <b>ChamberSign</b> requis.{' '}
              <a className="linkbtn" href={prereq.middleware.url} target="_blank" rel="noreferrer">
                {prereq.middleware.label}
              </a>{' '}
              <span className="dot-sep">·</span>{' '}
              <a className="linkbtn" href={prereq.docUrl} target="_blank" rel="noreferrer">
                Pilotes / PKCS#11
              </a>
            </div>
          </div>
        </>
      )}

      {status === 'checking' && (
        <div className="banner info">
          <span className="bi">
            <span className="spinner" />
          </span>
          <div style={{ flex: 1 }}>
            <b>Détection en cours…</b>
            <div style={{ marginTop: 3 }}>
              Contrôle de l'agent, de la carte et du middleware PKCS#11.
            </div>
          </div>
        </div>
      )}

      {status === 'error' && (
        <Banner
          kind="danger"
          icon={<Icon.alert size={20} />}
          title="Carte indisponible — token occupé"
          links={
            <Btn variant="ghost" size="sm" onClick={() => void recheck()} icon={<Icon.refresh size={14} />}>
              Réessayer
            </Btn>
          }
        >
          Une autre application monopolise la carte (par ex.{' '}
          <span className="mono" style={{ fontSize: 12 }}>
            LOCAL TRUST FORCE
          </span>
          ), ou le token n'est pas inséré. Fermez l'autre application puis réessayez.
        </Banner>
      )}

      {status === 'available' && (
        <div>
          <div className="agent-ok-head">
            <div className="ig">
              <Icon.checkCircle size={22} />
            </div>
            <div className="tt">
              <b>Agent connecté · carte reconnue</b>
              <span>middleware PKCS#11 actif · mode {session?.mode}</span>
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
              {locked ? (
                <Tag kind="warn">
                  <Icon.lock size={12} /> Verrouillée
                </Tag>
              ) : (
                <Tag kind="ok">
                  <Icon.unlock size={12} /> Déverrouillée
                </Tag>
              )}
            </div>
          </div>

          {certificates.length > 1 && (
            <div className="field" style={{ marginTop: 16 }}>
              <label htmlFor="cert-select">Certificat</label>
              <select
                id="cert-select"
                className="input"
                value={selectedKeyId}
                onChange={(e) => setSelectedKeyId(e.target.value)}
              >
                {certificates.map((c) => (
                  <option key={c.keyId} value={c.keyId}>
                    {cnOf(c.subjectDn)} (exp. {c.notAfter.slice(0, 10)})
                  </option>
                ))}
              </select>
            </div>
          )}

          {selectedCert && (
            <div style={{ marginTop: 16 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: 'var(--ink-3)',
                  marginBottom: 8,
                  letterSpacing: '.02em',
                }}
              >
                CERTIFICAT DE SIGNATURE QUALIFIÉ
              </div>
              <CertGrid
                items={[
                  { k: 'Titulaire', v: cnOf(selectedCert.subjectDn) },
                  { k: 'Organisation', v: orgOf(selectedCert.subjectDn) || '—' },
                  { k: 'Émetteur', v: issuerOf(selectedCert.issuerDn), mono: true },
                  {
                    k: 'Validité',
                    v: `${selectedCert.notBefore.slice(0, 7)} → ${selectedCert.notAfter.slice(0, 7)}`,
                  },
                  { k: 'Usage', v: 'Signature, non-répudiation' },
                  { k: 'N° série', v: selectedCert.serialNumber, mono: true },
                ]}
              />
            </div>
          )}

          {locked && secondsLeft === 0 && (
            <div className="help" style={{ marginTop: 12, display: 'flex', gap: 7, alignItems: 'center' }}>
              <Icon.lock size={14} /> La carte est verrouillée. Votre code PIN sera demandé au moment
              de signer.
            </div>
          )}

          {!locked && secondsLeft > 0 && (
            <div className="unlock-bar">
              <Icon.unlock size={18} />
              <div className="ut">Carte déverrouillée — session active</div>
              <span className="clock">{fmtClock(secondsLeft)}</span>
              <div style={{ flex: 1 }} />
              <Btn variant="ghost" size="sm" onClick={() => void lock()} icon={<Icon.lock size={14} />}>
                Verrouiller
              </Btn>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/* -------------------- Documents panel -------------------- */
interface DocumentsPanelProps {
  docs: SignDoc[];
  addFiles: (list: FileList | null) => void;
  setDocs: Dispatch<SetStateAction<SignDoc[]>>;
  busy: boolean;
}

function DocumentsPanel({ docs, addFiles, setDocs, busy }: DocumentsPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  return (
    <Card
      no="2"
      title="Documents"
      desc="PDF → PAdES · bureautique & autres → conteneur ASiC-E. Un document déjà signé sera contre-signé."
    >
      <div
        className="dropzone"
        style={dragOver ? { borderColor: 'var(--brand)', background: 'var(--brand-soft)' } : undefined}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        <div className="dz-ic">
          <Icon.upload size={22} />
        </div>
        <b>Déposer ou choisir des fichiers</b>
        <span className="dz-sub">PDF, DOCX, XLSX, images… — plusieurs fichiers acceptés</span>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          style={{ display: 'none' }}
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {docs.length > 0 && (
        <div style={{ marginTop: 16 }}>
          {docs.map((doc) => {
            const k = fileKind(doc.file.name);
            return (
              <div className="frow" key={doc.id}>
                <div className="fic">{k.ext}</div>
                <div className="fmeta">
                  <div className="fname">{doc.file.name}</div>
                  <div className="fsub">
                    <span>{(doc.file.size / 1024).toFixed(1)} Ko</span>
                    <span className="arrow">→</span>
                    <Tag kind="brand">{k.target}</Tag>
                    {doc.existingSignatures != null && doc.existingSignatures > 0 && (
                      <Tag kind="warn">déjà signé : {doc.existingSignatures}</Tag>
                    )}
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {doc.status === 'signing' && <span className="spinner" />}
                  {doc.status === 'signed' && doc.signed && (
                    <>
                      <Tag kind="ok">
                        <Icon.check size={11} /> signé
                      </Tag>
                      <Btn
                        variant="soft"
                        size="sm"
                        icon={<Icon.download size={15} />}
                        onClick={() =>
                          downloadBase64(doc.signed!.base64, doc.signed!.fileName, doc.signed!.mediaType)
                        }
                      >
                        Télécharger
                      </Btn>
                    </>
                  )}
                  {doc.status === 'error' && (
                    <span style={{ color: 'var(--danger)', fontSize: 12.5, fontWeight: 700 }} title={doc.error}>
                      ✗ {doc.error}
                    </span>
                  )}
                  <button
                    className="x-btn"
                    title="Retirer"
                    disabled={busy}
                    onClick={() => setDocs((x) => x.filter((y) => y.id !== doc.id))}
                  >
                    <Icon.x size={15} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/* -------------------- Signing progress modal -------------------- */
interface SigningProgressProps {
  docs: SignDoc[]; // the batch targets (snapshot)
  liveDocs: SignDoc[]; // current docs to read live status from
}

function SigningProgress({ docs, liveDocs }: SigningProgressProps) {
  const statusOf = (id: string): DocStatus => liveDocs.find((d) => d.id === id)?.status ?? 'pending';
  return (
    <div className="scrim">
      <div className="modal">
        <div className="modal-h">
          <div className="mi">
            <span className="spinner" />
          </div>
          <div>
            <h3>Signature en cours…</h3>
            <p>La carte calcule la signature de chaque document. Ne retirez pas le token.</p>
          </div>
        </div>
        <div className="modal-b">
          <div className="sign-prog">
            {docs.map((d) => {
              const st = statusOf(d.id);
              const rowCls = st === 'signed' ? 'done' : st === 'signing' ? 'active' : 'pending';
              return (
                <div className={'sp-row ' + rowCls} key={d.id}>
                  <div className="spi">
                    {st === 'signed' ? (
                      <Icon.check size={15} />
                    ) : st === 'signing' ? (
                      <span className="spinner" style={{ width: 13, height: 13 }} />
                    ) : (
                      <Icon.file size={14} />
                    )}
                  </div>
                  <span
                    style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                  >
                    {d.file.name}
                  </span>
                  <span style={{ marginLeft: 'auto' }}>
                    {st === 'signed' && <Tag kind="ok">signé</Tag>}
                    {st === 'error' && (
                      <span style={{ color: 'var(--danger)', fontSize: 12, fontWeight: 700 }}>échec</span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/* -------------------- Success view -------------------- */
interface SuccessViewProps {
  signedDocs: SignDoc[];
  cert: AgentCertificate | null;
  reason: string;
  location: string;
  signedAtIso: string;
  onReset: () => void;
  onGoVerify: () => void;
}

function SuccessView({ signedDocs, cert, reason, location, signedAtIso, onReset, onGoVerify }: SuccessViewProps) {
  const signer = cnOf(cert?.subjectDn);
  const issuer = issuerOf(cert?.issuerDn);
  const localStamp = signedAtIso ? new Date(signedAtIso).toLocaleString('fr-FR') : '';

  return (
    <div className="rise" key="success">
      <div className="card">
        <div className="card-b" style={{ paddingTop: 30 }}>
          <div className="success-hero">
            <div className="seal">
              <Icon.shieldCheck size={40} />
            </div>
            <h2>
              {signedDocs.length} document{signedDocs.length > 1 ? 's' : ''} signé
              {signedDocs.length > 1 ? 's' : ''}
            </h2>
            <p>
              Signature électronique avancée appliquée avec horodatage qualifié. Les fichiers signés
              sont prêts à être téléchargés.
            </p>
            <div className="trust-row" style={{ justifyContent: 'center', marginTop: 16 }}>
              <TrustBadge kind="ok" icon={<Icon.shieldCheck size={14} />}>
                PAdES-BASELINE-T
              </TrustBadge>
              <TrustBadge kind="solid" icon={<Icon.euro size={14} />}>
                Conforme eIDAS
              </TrustBadge>
              <TrustBadge icon={<Icon.clock size={14} />}>Horodaté {localStamp}</TrustBadge>
            </div>
          </div>

          <div
            style={{ marginTop: 26, display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}
          >
            <Btn
              size="lg"
              icon={<Icon.download size={18} />}
              disabled={signedDocs.length === 0}
              onClick={() =>
                downloadZip(
                  signedDocs.map((d) => ({ name: d.signed!.fileName, base64: d.signed!.base64 })),
                  'documents-signes.zip',
                )
              }
            >
              Tout télécharger (ZIP)
            </Btn>
            <Btn variant="ghost" size="lg" icon={<Icon.sign size={18} />} onClick={onReset}>
              Signer d'autres documents
            </Btn>
          </div>
        </div>
      </div>

      <Card title="Documents signés" desc="Fichiers scellés, prêts à archiver ou transmettre.">
        {signedDocs.map((d) => {
          const k = fileKind(d.file.name);
          return (
            <div className="frow" key={d.id}>
              <div className="fic" style={{ background: 'var(--ok-soft)', color: 'var(--ok)' }}>
                <Icon.fileCheck size={18} />
              </div>
              <div className="fmeta">
                <div className="fname">{d.signed!.fileName}</div>
                <div className="fsub">
                  <Tag kind="ok">
                    <Icon.check size={11} /> Signé
                  </Tag>
                  <span className="arrow">·</span>
                  <span>{k.target}</span>
                  {signer && (
                    <>
                      <span className="arrow">·</span>
                      <span>{signer}</span>
                    </>
                  )}
                </div>
              </div>
              <Btn
                variant="soft"
                size="sm"
                icon={<Icon.download size={15} />}
                onClick={() => downloadBase64(d.signed!.base64, d.signed!.fileName, d.signed!.mediaType)}
              >
                Télécharger
              </Btn>
            </div>
          );
        })}
      </Card>

      <Card title="Détails de la signature" desc="Métadonnées scellées dans chaque document.">
        <CertGrid
          items={[
            { k: 'Signataire', v: signer || '—' },
            { k: 'Niveau', v: 'PAdES-BASELINE-T', mono: true },
            { k: 'Horodatage (TSA)', v: signedAtIso || '—', mono: true },
            { k: 'Autorité', v: issuer || '—' },
            { k: 'Motif', v: reason || '—' },
            { k: 'Lieu', v: location || '—' },
          ]}
        />
        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <button className="linkbtn muted" onClick={onGoVerify}>
            Vérifier une signature →
          </button>
        </div>
      </Card>
    </div>
  );
}
