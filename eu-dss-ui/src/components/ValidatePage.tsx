import { useRef, useState } from 'react';
import { backendApi, ValidationResponse, SignatureSummary } from '../services/backendApi';
import { fileToBase64 } from '../services/fileUtils';
import { history } from '../services/history';
import { Icon, Btn, Banner, fileKind } from './ui';

/* ---- Report action buttons ---- */

function ReportActions({ xml }: { xml: string | null }) {
  const [copied, setCopied] = useState(false);

  if (!xml) return null;

  function handleDownload() {
    const blob = new Blob([xml as string], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'rapport-validation-dss.xml';
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleCopy() {
    navigator.clipboard.writeText(xml as string).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="vd-report-actions">
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={handleDownload}
        aria-label="Télécharger le rapport XML DSS"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 3v13M7 12l5 5 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M5 20h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        Télécharger le rapport XML
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={handleCopy}
        aria-label={copied ? 'Rapport XML copié dans le presse-papiers' : 'Copier le rapport XML dans le presse-papiers'}
      >
        {copied ? (
          <>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="m5 13 4 4L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Copié ✓
          </>
        ) : (
          <>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="1.8" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" strokeWidth="1.8" />
            </svg>
            Copier
          </>
        )}
      </button>
    </div>
  );
}

/* ---- helpers ---- */

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

/* ---- Verdict helpers — driven strictly off report fields ---- */

/**
 * Maps s.indication to a visual variant.
 * Reads: s.indication (string from DSS: "TOTAL_PASSED" | "TOTAL_FAILED" | "INDETERMINATE" | other)
 */
function indicationVariant(indication: string): 'ok' | 'danger' | 'warn' {
  if (indication === 'TOTAL_PASSED') return 'ok';
  if (indication === 'TOTAL_FAILED') return 'danger';
  return 'warn'; // INDETERMINATE and any other value
}

/**
 * Overall verdict across all signatures: worst-case aggregation.
 * Reads: result.signatureCount, result.signatures[*].indication
 */
function overallVariant(result: ValidationResponse): 'ok' | 'danger' | 'warn' | 'nosig' {
  if (result.signatureCount === 0) return 'nosig';
  const inds = result.signatures.map((s) => s.indication);
  if (inds.some((i) => i === 'TOTAL_FAILED')) return 'danger';
  if (inds.every((i) => i === 'TOTAL_PASSED')) return 'ok';
  return 'warn';
}

/* ---- Verdict banner ---- */

function VerdictBanner({ result }: { result: ValidationResponse }) {
  const variant = overallVariant(result);

  if (variant === 'nosig') {
    return (
      <div className="vd-banner vd-banner--warn" style={{ marginBottom: 18 }}>
        <span className="vd-banner-icon vd-banner-icon--warn">
          <Icon.alert size={28} />
        </span>
        <div className="vd-banner-body">
          <div className="vd-banner-title">Aucune signature détectée</div>
          <div className="vd-banner-sub">
            Aucune signature numérique n'a été trouvée dans ce document.
          </div>
        </div>
      </div>
    );
  }

  if (variant === 'ok') {
    return (
      <div className="vd-banner vd-banner--ok" style={{ marginBottom: 18 }}>
        <span className="vd-banner-icon vd-banner-icon--ok">
          {/* Circle check icon matching design */}
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9.5" fill="#1FA463" fillOpacity=".12" />
            <path d="m7.8 12.3 2.7 2.7 5.7-5.9" stroke="#18794E" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <div className="vd-banner-body">
          <div className="vd-banner-row">
            <div className="vd-banner-title">Signature valide</div>
            <span className="vd-code-tag vd-code-tag--ok">TOTAL_PASSED</span>
          </div>
          <div className="vd-banner-sub">
            Le document n'a pas été modifié depuis la signature. Certificat reconnu par la liste de confiance.
          </div>
        </div>
      </div>
    );
  }

  if (variant === 'danger') {
    return (
      <div className="vd-banner vd-banner--danger" style={{ marginBottom: 18 }}>
        <span className="vd-banner-icon vd-banner-icon--danger">
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9.5" fill="#C2362F" fillOpacity=".10" />
            <path d="M9 9l6 6M15 9l-6 6" stroke="#C2362F" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
        </span>
        <div className="vd-banner-body">
          <div className="vd-banner-row">
            <div className="vd-banner-title">Signature invalide</div>
            <span className="vd-code-tag vd-code-tag--danger">TOTAL_FAILED</span>
          </div>
          <div className="vd-banner-sub">
            Le document a été modifié après la signature ou le certificat n'est pas reconnu.
          </div>
        </div>
      </div>
    );
  }

  // INDETERMINATE / mixed
  return (
    <div className="vd-banner vd-banner--warn" style={{ marginBottom: 18 }}>
      <span className="vd-banner-icon vd-banner-icon--warn">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="9.5" fill="#9A6213" fillOpacity=".10" />
          <path d="M9.2 9.4c.5-1.7 4.8-1.9 4.8.4 0 1.7-2.1 1.5-2.1 3.2M11.9 16.5h.01" stroke="#9A6213" strokeWidth="1.9" strokeLinecap="round" />
        </svg>
      </span>
      <div className="vd-banner-body">
        <div className="vd-banner-row">
          <div className="vd-banner-title">Validité indéterminée</div>
          <span className="vd-code-tag vd-code-tag--warn">INDETERMINATE</span>
        </div>
        <div className="vd-banner-sub">
          Impossible de vérifier la révocation du certificat ou ancre de confiance absente.
        </div>
      </div>
    </div>
  );
}

/* ---- Signataire card ---- */

function SignataireCard({ s }: { s: SignatureSummary }) {
  return (
    <div className="vd-sig-card">
      <div className="vd-sig-card-label">SIGNATAIRE</div>
      <div className="vd-sig-card-hero">
        <span className="vd-sig-avatar-tile">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path d="M12 12.5a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8Z" stroke="var(--brand)" strokeWidth="1.6" />
            <path d="M5.6 19a6.4 6.4 0 0 1 12.8 0" stroke="var(--brand)" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </span>
        <div className="vd-sig-name-block">
          <div className="vd-sig-name">{s.signedBy ?? 'Signataire inconnu'}</div>
          <div className="vd-sig-id">{s.signatureId}</div>
        </div>
      </div>
      <div className="vd-sig-row">
        <span className="vd-sig-key">Format</span>
        <span className="vd-sig-val mono">{s.signatureFormat ?? '—'}</span>
      </div>
      <div className="vd-sig-row">
        <span className="vd-sig-key">Horodaté le</span>
        <span className="vd-sig-val mono">{s.signingDate ?? '—'}</span>
      </div>
      <div className="vd-sig-row">
        <span className="vd-sig-key">Indication</span>
        <span className={`vd-sig-val vd-ind-tag vd-ind-tag--${indicationVariant(s.indication)}`}>
          {s.indication}{s.subIndication ? ' · ' + s.subIndication : ''}
        </span>
      </div>
    </div>
  );
}

/* ---- Checks card ---- */

/** Derives a check state from the overall indication for this signature.
 * Reads: s.indication — "TOTAL_PASSED" / "TOTAL_FAILED" / "INDETERMINATE"
 * Note: DSS simpleReport does not expose individual check-level breakdown per signature
 * in the SignatureSummary shape. We show the overall outcome per check-line to avoid
 * over-claiming fine-grained results we don't have. */
function CheckRow({ label, sub, passed, warn }: { label: string; sub: string; passed: boolean; warn?: boolean }) {
  const color = passed ? '#18794E' : warn ? '#9A6213' : '#C2362F';
  const fill = passed ? '#E7F6EE' : warn ? '#FBF0DA' : '#FDEEEE';
  return (
    <div className="vd-check-row">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" style={{ flex: 'none' }}>
        <circle cx="12" cy="12" r="9.4" fill={fill} />
        {passed
          ? <path d="m8.4 12.2 2.3 2.3 4.7-4.9" stroke={color} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
          : warn
          ? <path d="M12 8.5v4M12 15.5h.01" stroke={color} strokeWidth="1.9" strokeLinecap="round" />
          : <path d="M9 9l6 6M15 9l-6 6" stroke={color} strokeWidth="1.9" strokeLinecap="round" />
        }
      </svg>
      <div style={{ flex: 1 }}>
        <div className="vd-check-title">{label}</div>
        <div className="vd-check-sub">{sub}</div>
      </div>
    </div>
  );
}

function ChecksCard({ s }: { s: SignatureSummary }) {
  const passed = s.indication === 'TOTAL_PASSED';
  const failed = s.indication === 'TOTAL_FAILED';

  return (
    <div className="vd-checks-card">
      <div className="vd-checks-header">
        <div className="vd-checks-title">Rapport de validation DSS</div>
        {/* indication sourced from s.indication */}
        <span className={`vd-code-tag vd-code-tag--${indicationVariant(s.indication)}`} style={{ fontSize: 10.5 }}>
          {s.indication}
        </span>
      </div>
      {passed ? (
        <>
          {/* PASS: DSS SignatureSummary does not expose individual check breakdown —
              but TOTAL_PASSED means all checks passed, so these rows are accurate. */}
          <CheckRow
            label="Intégrité du document"
            sub="L'empreinte signée correspond au contenu"
            passed={true}
          />
          <CheckRow
            label="Chaîne de certification"
            sub="Remonte jusqu'à une AC racine de confiance"
            passed={true}
          />
          <CheckRow
            label="Statut de révocation"
            sub="Certificat non révoqué (OCSP / CRL)"
            passed={true}
          />
          <CheckRow
            label="Format de signature"
            sub={s.signatureFormat ? `Format : ${s.signatureFormat}` : 'Format non reconnu'}
            passed={true}
          />
        </>
      ) : (
        /* FAILED / INDETERMINATE: DSS does not expose per-check breakdown in SignatureSummary.
           Do not assert which specific check failed — show a neutral referral instead. */
        <div className="vd-check-row">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" style={{ flex: 'none' }}>
            <circle cx="12" cy="12" r="9.4" fill={failed ? '#FDEEEE' : '#FBF0DA'} />
            {failed
              ? <path d="M9 9l6 6M15 9l-6 6" stroke="#C2362F" strokeWidth="1.9" strokeLinecap="round" />
              : <path d="M12 8.5v4M12 15.5h.01" stroke="#9A6213" strokeWidth="1.9" strokeLinecap="round" />
            }
          </svg>
          <div style={{ flex: 1 }}>
            <div className="vd-check-title">
              {failed ? 'Signature invalide' : 'Validité indéterminée'}
            </div>
            <div className="vd-check-sub">
              {failed
                ? 'Signature invalide — consultez le rapport XML pour le détail.'
                : 'Validité indéterminée — consultez le rapport XML pour le détail.'}
            </div>
          </div>
        </div>
      )}
    </div>
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
      // ── Record in local history (additive; never breaks validation flow) ───
      try {
        history.add({
          kind: 'verify',
          name: file.name,
          format: res.signatures?.[0]?.signatureFormat ?? '',
          sizeBytes: file.size,
          verdict: overallVariant(res) === 'ok' ? 'TOTAL_PASSED' : res.signatures?.[0]?.indication ?? '',
          atIso: new Date().toISOString(),
        });
      } catch {
        // logging failure must never propagate
      }
    } catch (e) {
      setError((e as Error).message ?? 'Erreur inconnue');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="verifier-root rise" key="verify">
      {/* ── Page header ── */}
      <div className="verifier-header">
        <h2 className="signer-title">Vérifier</h2>
        <p className="signer-subtitle">Contrôle de validité eIDAS et rapport de la bibliothèque EU DSS.</p>
      </div>

      {/* hidden file input */}
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.asice,.asics,.p7s,.p7m,.xml,.scs"
        style={{ display: 'none' }}
        onChange={(e) => pickFile(e.target.files?.[0])}
      />

      {/* ── Drop / file row ── */}
      {!file ? (
        <div
          className={`vd-dropzone${dragOver ? ' vd-dropzone--over' : ''}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            pickFile(e.dataTransfer.files?.[0]);
          }}
        >
          <span className="vd-dz-icon-tile">
            <Icon.upload size={20} />
          </span>
          <div className="vd-dz-text">
            <div className="vd-dz-title">Déposer un document signé, ou le choisir</div>
            <div className="vd-dz-hint">PDF (PAdES), conteneur ASiC, XML (XAdES)…</div>
          </div>
          <button
            className="vd-dz-btn"
            onClick={(e) => { e.stopPropagation(); inputRef.current?.click(); }}
            tabIndex={-1}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
              <path d="M4 7a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
            </svg>
            Choisir un fichier
          </button>
        </div>
      ) : (
        /* ── File chosen row ── */
        <div className="vd-file-row">
          <div className="fic">{fileKind(file.name).ext}</div>
          <div className="fmeta">
            <div className="fname">{file.name}</div>
            <div className="fsub">
              <span>{formatBytes(file.size)} · prêt à vérifier</span>
            </div>
          </div>
          <div className="vd-file-actions">
            <Btn
              onClick={validate}
              disabled={busy}
              icon={busy ? <span className="spinner" /> : <Icon.shieldCheck size={16} />}
            >
              {busy ? 'Vérification…' : 'Vérifier'}
            </Btn>
            {result !== null && (
              <Btn
                variant="ghost"
                onClick={() => { setResult(null); setError(null); }}
                icon={<Icon.refresh size={15} />}
              >
                Réinitialiser
              </Btn>
            )}
            <button className="x-btn" title="Retirer" onClick={clearFile}>
              <Icon.x size={15} />
            </button>
          </div>
        </div>
      )}

      {/* ── Error banner ── */}
      {error && (
        <Banner kind="danger" icon={<Icon.alert size={20} />} title="Échec de la vérification">
          {error}
        </Banner>
      )}

      {/* ── Result section ── */}
      {result !== null && (
        <div className="vd-result rise">
          {/* Verdict banner — driven off result.signatures[*].indication */}
          <VerdictBanner result={result} />

          {result.signatures.length > 0 && (
            result.signatures.map((s) => (
              <div key={s.signatureId} className="vd-sig-block">
                <div className="vd-sig-cols">
                  {/* Left: signataire — reads s.signedBy, s.signatureId, s.signatureFormat, s.signingDate, s.indication */}
                  <SignataireCard s={s} />
                  {/* Right: checks — reads s.indication, s.subIndication, s.signatureFormat */}
                  <ChecksCard s={s} />
                </div>
              </div>
            ))
          )}

          {/* Count + date */}
          <div className="vd-footer-note">
            <span>
              <b>{result.signatureCount}</b> signature(s) · contrôle eIDAS effectué le {todayFR()}
            </span>
          </div>

          {/* Download / copy report XML */}
          <ReportActions xml={result.simpleReportXml} />

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
      )}
    </div>
  );
}
