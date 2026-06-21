import { useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useAgent } from '../agent/AgentContext';
import { AgentCertificate, AgentError } from '../services/agentApi';
import { backendApi, SignatureForm, SignatureParams } from '../services/backendApi';
import { signDocumentToBase64 } from '../services/signFlow';
import { detectOs, PREREQ_MANIFEST } from '../services/prerequisites';
import { downloadBase64, downloadZip, fileToBase64 } from '../services/fileUtils';
import { history } from '../services/history';
import { Banner, Btn, Card, CertGrid, fileKind, Icon, Tag } from './ui';
import { useToast } from './Toast';
import { useLang, useT, type TFunction, type TKey } from '../i18n';

type DocStatus = 'pending' | 'signing' | 'signed' | 'error';

interface SignDoc {
  id: string;
  file: File;
  status: DocStatus;
  existingSignatures: number | null; // null until detected
  /** Explicit signature form; undefined = auto-detect by file type (default). */
  signatureForm?: SignatureForm;
  signed?: { base64: string; fileName: string; mediaType: string };
  error?: string;
}

/** Selectable signature-form options for the per-document picker. */
const FORM_OPTIONS: { value: SignatureForm | ''; labelKey: TKey; pdfOnly?: boolean }[] = [
  { value: '', labelKey: 'sign.form.auto' },
  { value: 'PADES', labelKey: 'sign.form.pades', pdfOnly: true },
  { value: 'ASIC_E', labelKey: 'sign.form.asice' },
  { value: 'XADES_ENVELOPING', labelKey: 'sign.form.xadesEnv' },
  { value: 'XADES_DETACHED', labelKey: 'sign.form.xadesDet' },
];

let counter = 0;
const nextId = () => `doc-${++counter}`;

function fmtClock(s: number): string {
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${m}:${ss.toString().padStart(2, '0')}`;
}

/** Pre-select the most appropriate signature form based on file name/type.
 *  PDF → PAdES; everything else → ASiC-E (matches backend auto-detect logic). */
function defaultForm(name: string): SignatureForm {
  return fileKind(name).asic ? 'ASIC_E' : 'PADES';
}

/** The form actually applied to a doc, resolving "auto" to the backend default. */
function effectiveForm(doc: SignDoc): SignatureForm {
  if (doc.signatureForm) return doc.signatureForm;
  return fileKind(doc.file.name).asic ? 'ASIC_E' : 'PADES'; // auto-detect mirror
}

/** Short label for the resolved output format (used on the signed-state pill).
 *  Format names are standard identifiers; only "XAdES détaché" is localised. */
function formLabel(form: SignatureForm, t: TFunction): string {
  switch (form) {
    case 'PADES':
      return 'PAdES‑B‑T';
    case 'ASIC_E':
      return 'ASiC‑E';
    case 'XADES_ENVELOPING':
      return 'XAdES';
    case 'XADES_DETACHED':
      return t('sign.form.xadesDet');
  }
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
  const t = useT();
  const toast = useToast();
  const { status, selectedKeyId, selectedCert } = agent;

  const [docs, setDocs] = useState<SignDoc[]>([]);
  // reason/location are sealed into each signature via signOne; setters available for future UI
  const [reason, _setReason] = useState(() => t('sign.reasonDefault'));
  const [location, _setLocation] = useState('');
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
      signatureForm: defaultForm(file.name),
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
      // Same params (incl. signatureForm) MUST go to BOTH prepare and assemble,
      // otherwise the assembled signature is corrupted. undefined → backend auto-detect.
      const params: SignatureParams = {
        certificateChainBase64: cert.certificateChainBase64,
        digestAlgorithm: 'SHA256',
        signingTimeEpochMs: Date.now(),
        signatureLevel: 'BASELINE_T',
        signatureForm: doc.signatureForm,
        signatureReason: reason || undefined,
        signatureLocation: location || undefined,
        signerName: cert.subjectDn,
      };
      const assembled = await signDocumentToBase64({
        documentBase64,
        fileName: doc.file.name,
        params,
        keyId: cert.keyId,
      });
      patch(doc.id, {
        status: 'signed',
        signed: {
          base64: assembled.signedDocumentBase64,
          fileName: assembled.signedFileName,
          mediaType: assembled.mediaType,
        },
      });
      // ── Record in local history (additive; never breaks signing flow) ──────
      try {
        history.add({
          kind: 'sign',
          name: doc.file.name,
          format: fileKind(doc.file.name).target,
          sizeBytes: doc.file.size,
          atIso: new Date().toISOString(),
        });
      } catch {
        // logging failure must never propagate
      }
    } catch (e) {
      if (e instanceof AgentError && e.code === 'locked' && !retried) {
        try {
          await agent.ensureUnlocked(); // idle-locked mid-batch → re-prompt
          await signOne(doc, cert, true); // retry this doc once
          return;
        } catch {
          patch(doc.id, { status: 'error', error: t('sign.cancelledPin') });
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

  /* ── Main Signer view ── */
  const signerName = selectedCert ? cnOf(selectedCert.subjectDn) : '';
  const caName = selectedCert ? issuerOf(selectedCert.issuerDn) : '';
  const { locked } = agent;

  return (
    <div className="signer-root rise" key="sign">
      {/* Page header */}
      <div className="signer-header">
        <div>
          <h2 className="signer-title">{t('sign.title')}</h2>
          <p className="signer-subtitle">{t('sign.subtitle')}</p>
        </div>
        <div className="eidas-pill">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
            <path d="M12 3.5 5.5 6v5c0 4 2.7 7.3 6.5 8.5 3.8-1.2 6.5-4.5 6.5-8.5V6L12 3.5Z" stroke="#2D63E8" strokeWidth="1.6" strokeLinejoin="round"/>
            <path d="m9.5 11.8 1.7 1.7 3.4-3.5" stroke="#2D63E8" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          {t('sign.eidasPill')}
        </div>
      </div>

      {/* Two-column body */}
      <div className="signer-cols">
        {/* LEFT: documents */}
        <div className="signer-left">
          <DocumentsPanel docs={docs} addFiles={addFiles} setDocs={setDocs} busy={busy} />
        </div>

        {/* RIGHT: signature panel */}
        <div className="signer-right">
          {/* Paramètres de signature */}
          <div className="sig-params-card">
            <div className="sig-params-title">{t('sign.params.title')}</div>
            <div className="sig-param-row sig-param-row--border">
              <span className="sig-param-label">{t('sign.params.level')}</span>
              <span className="sig-param-value mono">B‑T</span>
            </div>
            <div className="sig-param-row sig-param-row--border">
              <span className="sig-param-label">{t('sign.params.digest')}</span>
              <span className="sig-param-value mono">SHA‑256</span>
            </div>
            <div className="sig-param-row">
              <span className="sig-param-label">{t('sign.params.tsa')}</span>
              <span className="sig-toggle on" role="img" aria-label={t('sign.params.enabled')}>
                <span className="sig-toggle-knob" />
              </span>
            </div>
          </div>

          {/* Cert hero card */}
          <div className="cert-hero">
            <div className="cert-hero-glow" />
            <div className="cert-hero-body">
              <div className="cert-hero-top">
                <div className="cert-hero-key-tile">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                    <circle cx="8" cy="13" r="3.4" stroke="#9FC0FF" strokeWidth="1.7"/>
                    <path d="m10.5 10.5 8-8M15 5l2.5 2.5M18.5 8 21 5.5" stroke="#9FC0FF" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
                <div className="cert-hero-info">
                  {available ? (
                    <div className="cert-hero-status-pill">
                      <span className="cert-hero-dot" />
                      {t('sign.cert.connected')}
                    </div>
                  ) : (
                    <div className="cert-hero-status-pill cert-hero-status-pill--off">
                      <span className="cert-hero-dot cert-hero-dot--off" />
                      {status === 'checking' ? t('sign.cert.detecting') : t('sign.cert.notConnected')}
                    </div>
                  )}
                  <div className="cert-hero-name">
                    {signerName || t('sign.cert.awaiting')}
                  </div>
                  <div className="cert-hero-ca">
                    {caName || t('sign.cert.insertKey')}
                  </div>
                </div>
              </div>

              <div className="cert-hero-lock-row">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
                  <rect x="5" y="11" width="14" height="9" rx="2" stroke="#F0C46B" strokeWidth="1.7"/>
                  <path d="M8 11V8a4 4 0 0 1 8 0v3" stroke="#F0C46B" strokeWidth="1.7"/>
                </svg>
                <div className="cert-hero-lock-text">
                  {!available ? (
                    t('sign.cert.connectAgent')
                  ) : locked ? (
                    <span dangerouslySetInnerHTML={{ __html: t('sign.cert.lockedPinPrompt') }} />
                  ) : (
                    t('sign.cert.unlockedSession', { clock: fmtClock(agent.secondsLeft) })
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Spacer */}
          <div style={{ flex: 1 }} />

          {/* Sign button */}
          <button
            className="sign-btn"
            disabled={!canSign}
            onClick={signAll}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M3 17c3-1 4-7 7-7s2 4 5 3 4-6 6-6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            {pendingCount > 0
              ? t('sign.btn.signN', { n: pendingCount, s: pendingCount > 1 ? 's' : '' })
              : t('sign.btn.sign')}
          </button>

          {/* Bulk ZIP download — shown when some docs are signed but not all (partial batch) */}
          {signedDocs.length > 0 && (
            <Btn
              variant="ghost"
              icon={<Icon.download />}
              onClick={() => {
                try {
                  downloadZip(
                    signedDocs.map((d) => ({ name: d.signed!.fileName, base64: d.signed!.base64 })),
                    'documents-signes.zip',
                  );
                  toast.success(t('download.zipOk', { n: signedDocs.length }));
                } catch {
                  toast.error(t('download.error'));
                }
              }}
            >
              {t('common.downloadAllZip')}
            </Btn>
          )}

          {/* Agent unavailable banner (compact, below button) */}
          {(status === 'checking' || status === 'unavailable' || status === 'error') && (
            <AgentPanel />
          )}
        </div>
      </div>

      {busy && <SigningProgress docs={signedSnapshot.length > 0 ? signedSnapshot : docs} liveDocs={docs} />}
    </div>
  );
}

/* -------------------- Agent panel (all states) -------------------- */
function AgentPanel() {
  const t = useT();
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
      title={t('sign.agent.cardTitle')}
      desc={t('sign.agent.cardDesc')}
    >
      {status === 'unavailable' && (
        <>
          <Banner
            kind="warn"
            icon={<Icon.alert size={20} />}
            title={t('sign.agent.notDetectedTitle')}
            links={
              <Btn variant="ghost" size="sm" onClick={() => void recheck()} icon={<Icon.refresh size={14} />}>
                {t('sign.agent.recheck')}
              </Btn>
            }
          >
            {t('sign.agent.notDetectedBody')}
          </Banner>

          <div className="banner info" style={{ marginTop: 12 }}>
            <span className="bi">
              <Icon.usb size={19} />
            </span>
            <div style={{ flex: 1 }}>
              <span dangerouslySetInnerHTML={{ __html: t('sign.agent.cardMiddleware') }} />{' '}
              <a className="linkbtn" href={prereq.middleware.url} target="_blank" rel="noreferrer">
                {t('sign.agent.drivers')}
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
            <b>{t('sign.agent.detectingTitle')}</b>
            <div style={{ marginTop: 3 }}>
              {t('sign.agent.detectingBody')}
            </div>
          </div>
        </div>
      )}

      {status === 'error' && (
        <Banner
          kind="danger"
          icon={<Icon.alert size={20} />}
          title={t('sign.agent.busyTitle')}
          links={
            <Btn variant="ghost" size="sm" onClick={() => void recheck()} icon={<Icon.refresh size={14} />}>
              {t('common.retry')}
            </Btn>
          }
        >
          {t('sign.agent.busyBody', { app: 'LOCAL TRUST FORCE' })}
        </Banner>
      )}

      {status === 'available' && (
        <div>
          <div className="agent-ok-head">
            <div className="ig">
              <Icon.checkCircle size={22} />
            </div>
            <div className="tt">
              <b>{t('sign.agent.okHead')}</b>
              <span>{t('sign.agent.okSub', { mode: session?.mode ?? '' })}</span>
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
              {locked ? (
                <Tag kind="warn">
                  <Icon.lock size={12} /> {t('sign.agent.locked')}
                </Tag>
              ) : (
                <Tag kind="ok">
                  <Icon.unlock size={12} /> {t('sign.agent.unlocked')}
                </Tag>
              )}
            </div>
          </div>

          {certificates.length > 1 && (
            <div className="field" style={{ marginTop: 16 }}>
              <label htmlFor="cert-select">{t('sign.agent.certLabel')}</label>
              <select
                id="cert-select"
                className="input"
                value={selectedKeyId}
                onChange={(e) => setSelectedKeyId(e.target.value)}
              >
                {certificates.map((c) => (
                  <option key={c.keyId} value={c.keyId}>
                    {cnOf(c.subjectDn)} ({t('sign.agent.certExp')} {c.notAfter.slice(0, 10)})
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
                {t('sign.agent.certHeading')}
              </div>
              <CertGrid
                items={[
                  { k: t('cert.holder'), v: cnOf(selectedCert.subjectDn) },
                  { k: t('cert.org'), v: orgOf(selectedCert.subjectDn) || '—' },
                  { k: t('cert.issuer'), v: issuerOf(selectedCert.issuerDn), mono: true },
                  {
                    k: t('cert.validity'),
                    v: `${selectedCert.notBefore.slice(0, 7)} → ${selectedCert.notAfter.slice(0, 7)}`,
                  },
                  { k: t('cert.usage'), v: t('cert.usageValue') },
                  { k: t('cert.serial'), v: selectedCert.serialNumber, mono: true },
                ]}
              />
            </div>
          )}

          {locked && secondsLeft === 0 && (
            <div className="help" style={{ marginTop: 12, display: 'flex', gap: 7, alignItems: 'center' }}>
              <Icon.lock size={14} /> {t('sign.agent.lockedHint')}
            </div>
          )}

          {!locked && secondsLeft > 0 && (
            <div className="unlock-bar">
              <Icon.unlock size={18} />
              <div className="ut">{t('sign.agent.sessionActive')}</div>
              <span className="clock">{fmtClock(secondsLeft)}</span>
              <div style={{ flex: 1 }} />
              <Btn variant="ghost" size="sm" onClick={() => void lock()} icon={<Icon.lock size={14} />}>
                {t('sign.agent.lockNow')}
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
  const t = useT();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  return (
    <div className="doc-panel">
      {/* Dropzone */}
      <div
        className={`dropzone-new${dragOver ? ' dropzone-new--over' : ''}`}
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
        <span className="dz-icon-tile">
          <svg width="23" height="23" viewBox="0 0 24 24" fill="none">
            <path d="M12 16V5m0 0L8 9m4-4 4 4" stroke="#2D63E8" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M5 15v3a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3" stroke="#2D63E8" strokeWidth="1.9" strokeLinecap="round"/>
          </svg>
        </span>
        <div className="dz-title">{t('sign.dropzone.title')}</div>
        <div className="dz-hint">{t('sign.dropzone.hint')}</div>
        <button
          className="dz-choose-btn"
          onClick={(e) => { e.stopPropagation(); inputRef.current?.click(); }}
          type="button"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
            <path d="M4 7a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/>
          </svg>
          {t('sign.dropzone.choose')}
        </button>
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

      {/* Doc count row */}
      {docs.length > 0 && (
        <div className="doc-count-row">
          <span className="doc-count-label">
            {t('sign.docs.readyCount', { n: docs.length, s: docs.length > 1 ? 's' : '' })}
          </span>
          <span className="doc-count-hint">{t('sign.docs.formatHint')}</span>
        </div>
      )}

      {/* Document rows */}
      {docs.length > 0 && (
        <div className="doc-list">
          {docs.map((doc) => {
            const k = fileKind(doc.file.name);
            const isPdf = !k.asic;
            const sizeFmt = doc.file.size >= 1024 * 1024
              ? `${(doc.file.size / (1024 * 1024)).toFixed(1)} ${t('size.mega')}`
              : `${(doc.file.size / 1024).toFixed(0)} ${t('size.kilo')}`;
            const typeLabel = isPdf ? t('sign.docs.typePdf') : t('sign.docs.typeOther', { ext: k.ext });
            return (
              <div className="doc-row" key={doc.id}>
                {/* Type icon tile */}
                <span className={`doc-type-tile${isPdf ? ' doc-type-tile--pdf' : ' doc-type-tile--office'}`}>
                  {isPdf ? (
                    <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
                      <path d="M7 3h7l4 4v14H7V3Z" stroke="#D8514F" strokeWidth="1.6" strokeLinejoin="round"/>
                      <path d="M14 3v4h4" stroke="#D8514F" strokeWidth="1.6" strokeLinejoin="round"/>
                    </svg>
                  ) : (
                    <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
                      <path d="M7 3h7l4 4v14H7V3Z" stroke="#2D63E8" strokeWidth="1.6" strokeLinejoin="round"/>
                      <path d="M14 3v4h4" stroke="#2D63E8" strokeWidth="1.6" strokeLinejoin="round"/>
                    </svg>
                  )}
                </span>

                {/* Name + meta */}
                <div className="doc-row-meta">
                  <div className="doc-row-name">{doc.file.name}</div>
                  <div className="doc-row-sub">
                    {doc.status === 'signed' && doc.signed
                      ? <Tag kind="ok"><Icon.check size={11} /> {t('sign.docs.signed')}</Tag>
                      : doc.status === 'signing'
                      ? <span className="spinner" style={{ width: 13, height: 13 }} />
                      : doc.status === 'error'
                      ? <span style={{ color: 'var(--danger)', fontSize: 12, fontWeight: 600 }} title={doc.error}>✗ {doc.error}</span>
                      : null
                    }
                    {doc.status !== 'error' && (
                      <span>{sizeFmt} · {typeLabel}</span>
                    )}
                    {doc.existingSignatures != null && doc.existingSignatures > 0 && (
                      <Tag kind="warn">{t('sign.docs.alreadySigned', { n: doc.existingSignatures })}</Tag>
                    )}
                  </div>
                  {doc.signatureForm === 'XADES_DETACHED' && (
                    <div className="doc-detached-note">
                      <Icon.alert size={12} />
                      {t('sign.docs.detachedNote')}
                    </div>
                  )}
                </div>

                {/* Signature-format selector (per document); read-only pill once signed */}
                {doc.status === 'signed' && doc.signed ? (
                  <div className="doc-format-pill">
                    <span className="mono">{formLabel(effectiveForm(doc), t)}</span>
                  </div>
                ) : (
                  <select
                    className="doc-format-select"
                    aria-label={t('sign.docs.formatAria', { name: doc.file.name })}
                    value={doc.signatureForm ?? ''}
                    disabled={busy || doc.status === 'signing'}
                    onChange={(e) => {
                      const v = e.target.value;
                      const form = v === '' ? undefined : (v as SignatureForm);
                      setDocs((x) => x.map((y) => (y.id === doc.id ? { ...y, signatureForm: form } : y)));
                    }}
                  >
                    {FORM_OPTIONS.filter((o) => !o.pdfOnly || isPdf).map((o) => (
                      <option key={o.value || 'auto'} value={o.value}>
                        {t(o.labelKey)}
                      </option>
                    ))}
                  </select>
                )}

                {/* Download if signed */}
                {doc.status === 'signed' && doc.signed && (
                  <Btn
                    variant="soft"
                    size="sm"
                    icon={<Icon.download size={15} />}
                    onClick={() => {
                      try {
                        downloadBase64(doc.signed!.base64, doc.signed!.fileName, doc.signed!.mediaType);
                        toast.success(t('download.ok', { filename: doc.signed!.fileName }));
                      } catch {
                        toast.error(t('download.error'));
                      }
                    }}
                  >
                    {t('common.download')}
                  </Btn>
                )}

                {/* Remove button */}
                <button
                  className="doc-remove-btn"
                  title={t('sign.docs.remove')}
                  disabled={busy}
                  onClick={() => setDocs((x) => x.filter((y) => y.id !== doc.id))}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" style={{ color: 'var(--ink-5)' }}>
                    <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* -------------------- Signing progress modal -------------------- */
interface SigningProgressProps {
  docs: SignDoc[]; // the batch targets (snapshot)
  liveDocs: SignDoc[]; // current docs to read live status from
}

function SigningProgress({ docs, liveDocs }: SigningProgressProps) {
  const t = useT();
  const statusOf = (id: string): DocStatus => liveDocs.find((d) => d.id === id)?.status ?? 'pending';

  const doneCount = docs.filter((d) => {
    const st = statusOf(d.id);
    return st === 'signed' || st === 'error';
  }).length;
  const progressPct = docs.length > 0 ? Math.round((doneCount / docs.length) * 100) : 0;

  // Find the currently active doc (signing state)
  const activeDocs = docs.filter((d) => statusOf(d.id) === 'signing');
  const activeDoc = activeDocs[0] ?? docs[doneCount] ?? null;
  const activeIdx = activeDoc ? docs.indexOf(activeDoc) + 1 : doneCount + 1;

  return (
    <div className="scrim">
      <div className="sign-modal-card">
        {/* Ring spinner with key icon */}
        <div className="ring-spinner" style={{ margin: '0 auto 18px' }}>
          <div className="ring-spinner-track" />
          <div className="ring-spinner-arc" />
          <div className="ring-spinner-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <circle cx="8" cy="13" r="3.2" stroke="currentColor" strokeWidth="1.8"/>
              <path d="m10.4 10.6 8-8M15 5l2.5 2.5M18.5 8 21 5.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
        </div>

        <h3 className="sign-modal-title">{t('sign.progress.title')}</h3>
        {activeDoc && (
          <p className="sign-modal-sub">
            {t('sign.progress.docOf', { i: activeIdx, total: docs.length, name: activeDoc.file.name })}
          </p>
        )}

        {/* Progress bar */}
        <div className="sign-prog-bar-wrap">
          <div className="sign-prog-bar-fill" style={{ width: `${progressPct}%` }} />
        </div>
        <div className="sign-prog-bar-labels">
          <span>{t('sign.progress.hashSigned')}</span>
          <span>{progressPct}&nbsp;%</span>
        </div>

        {/* Per-doc step list */}
        {docs.length > 1 && (
          <div className="sign-prog" style={{ marginTop: 18, textAlign: 'left' }}>
            {docs.map((d) => {
              const st = statusOf(d.id);
              const rowCls =
                st === 'signed' ? 'done'
                : st === 'signing' ? 'active'
                : st === 'error' ? 'error'
                : 'pending';
              return (
                <div className={`sp-row ${rowCls}`} key={d.id}>
                  <div className="spi">
                    {st === 'signed' ? (
                      <Icon.check size={14} />
                    ) : st === 'signing' ? (
                      <span className="spinner" style={{ width: 13, height: 13 }} />
                    ) : st === 'error' ? (
                      <Icon.x size={13} />
                    ) : (
                      <Icon.file size={13} />
                    )}
                  </div>
                  <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>
                    {d.file.name}
                  </span>
                  <span style={{ flexShrink: 0 }}>
                    {st === 'signed' && <Tag kind="ok">{t('sign.progress.signedTag')}</Tag>}
                    {st === 'error' && (
                      <span style={{ color: 'var(--danger)', fontSize: 11, fontWeight: 700 }}>{t('sign.progress.failTag')}</span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Caution notice */}
        <div className="sign-modal-caution">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
            <path d="M12 9v4m0 3h.01M10.3 4.3 2.6 18a1.5 1.5 0 0 0 1.3 2.2h16.2a1.5 1.5 0 0 0 1.3-2.2L13.7 4.3a1.5 1.5 0 0 0-2.6 0Z" stroke="#E2A53A" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          {t('sign.progress.dontRemove')}
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
  const t = useT();
  const toast = useToast();
  const { lang } = useLang();
  const signer = cnOf(cert?.subjectDn);
  const issuer = issuerOf(cert?.issuerDn);
  const localStamp = signedAtIso
    ? new Date(signedAtIso).toLocaleString(lang === 'en' ? 'en-GB' : 'fr-FR', { dateStyle: 'long', timeStyle: 'short' })
    : '';
  // Distinct resolved formats across the batch (e.g. "PAdES‑B‑T" or "ASiC‑E + XAdES détaché").
  const distinctForms = Array.from(new Set(signedDocs.map((d) => formLabel(effectiveForm(d), t))));
  const formatSummary = distinctForms.length ? distinctForms.join(' + ') : '—';

  return (
    <div className="rise" key="success" style={{ flex: 1, overflowY: 'auto' }}>
      <div className="sv-root">
        {/* Hero */}
        <div className="sv-hero">
          <div className="sv-hero-icon">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none">
              <path d="m6.5 12.4 3.2 3.2L18 7.2" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <h2>
            {t('sign.success.titleN', { n: signedDocs.length, s: signedDocs.length > 1 ? 's' : '' })}
          </h2>
          <p
            className="sv-hero-sub"
            dangerouslySetInnerHTML={{
              __html: signer
                ? t('sign.success.subWithSigner', { signer, stamp: localStamp })
                : t('sign.success.subNoSigner', { stamp: localStamp }),
            }}
          />
        </div>

        {/* Signed files list */}
        <div className="sv-files-card">
          {signedDocs.map((d) => {
            const k = fileKind(d.file.name);
            const isPdf = !k.asic;
            const sizeFmt = d.file.size >= 1024 * 1024
              ? `${(d.file.size / (1024 * 1024)).toFixed(1)} ${t('size.mega')}`
              : `${(d.file.size / 1024).toFixed(0)} ${t('size.kilo')}`;
            return (
              <div className="sv-file-row" key={d.id}>
                <span className={`sv-file-icon ${isPdf ? 'sv-file-icon--pdf' : 'sv-file-icon--office'}`}>
                  {isPdf ? (
                    <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
                      <path d="M7 3h7l4 4v14H7V3Z" stroke="#D8514F" strokeWidth="1.6" strokeLinejoin="round"/>
                      <path d="M14 3v4h4" stroke="#D8514F" strokeWidth="1.6" strokeLinejoin="round"/>
                    </svg>
                  ) : (
                    <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
                      <path d="M7 3h7l4 4v14H7V3Z" stroke="#2D63E8" strokeWidth="1.6" strokeLinejoin="round"/>
                      <path d="M14 3v4h4" stroke="#2D63E8" strokeWidth="1.6" strokeLinejoin="round"/>
                    </svg>
                  )}
                </span>
                <div className="sv-file-meta">
                  <div className="sv-file-name">{d.signed!.fileName}</div>
                  <div className="sv-file-sub">
                    <span className="sv-file-sub-check">
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none">
                        <path d="m8.5 12.2 2.3 2.3 4.6-4.8" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </span>
                    <span>{t('sign.success.fileSigned', { format: formLabel(effectiveForm(d), t), size: sizeFmt })}</span>
                  </div>
                </div>
                <Btn
                  variant="soft"
                  size="sm"
                  icon={<Icon.download size={14} />}
                  onClick={() => {
                    try {
                      downloadBase64(d.signed!.base64, d.signed!.fileName, d.signed!.mediaType);
                      toast.success(t('download.ok', { filename: d.signed!.fileName }));
                    } catch {
                      toast.error(t('download.error'));
                    }
                  }}
                >
                  {t('common.download')}
                </Btn>
              </div>
            );
          })}
        </div>

        {/* Action buttons */}
        <div className="sv-actions">
          <Btn
            size="lg"
            icon={<Icon.download size={16} />}
            disabled={signedDocs.length === 0}
            onClick={() => {
              try {
                downloadZip(
                  signedDocs.map((d) => ({ name: d.signed!.fileName, base64: d.signed!.base64 })),
                  'documents-signes.zip',
                );
                toast.success(t('download.zipOk', { n: signedDocs.length }));
              } catch {
                toast.error(t('download.error'));
              }
            }}
          >
            {t('common.downloadAllZip')}
          </Btn>
          <Btn variant="ghost" size="lg" icon={<Icon.shieldCheck size={16} />} onClick={onGoVerify}>
            {t('common.verify')}
          </Btn>
          <Btn variant="ghost" size="lg" onClick={onReset}>
            {t('sign.success.newSignature')}
          </Btn>
        </div>

        {/* Signature details */}
        <div className="sv-details-card">
          <div className="sv-details-header">
            <Icon.doc2 size={15} />
            {t('sign.success.detailsHeader')}
          </div>
          {[
            { k: t('sign.success.signer'), v: signer || '—' },
            { k: t('sign.success.format'), v: formatSummary, mono: true },
            { k: t('sign.success.tsa'), v: signedAtIso || '—', mono: true },
            { k: t('sign.success.authority'), v: issuer || '—' },
            { k: t('sign.success.reason'), v: reason || '—' },
            { k: t('sign.success.place'), v: location || '—' },
          ].map(({ k, v, mono }) => (
            <div className="sv-detail-row" key={k}>
              <span className="sv-detail-key">{k}</span>
              <span className={`sv-detail-val${mono ? ' mono' : ''}`}>{v}</span>
            </div>
          ))}
        </div>

        <div style={{ textAlign: 'center' }}>
          <button className="linkbtn muted" onClick={onGoVerify}>
            {t('sign.success.goVerify')}
          </button>
        </div>
      </div>
    </div>
  );
}
