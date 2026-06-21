import { agentApi } from './agentApi';
import { backendApi, type SignatureForm, type SignatureParams } from './backendApi';

/**
 * Canonical 3-round-trip signing sequence shared by every signing entry point
 * (the multi-doc Sign button AND the eudss:// deep-link flow).
 *
 *   1. backendApi.prepare → data-to-sign digest
 *   2. agentApi.signDigest → the token signs the digest (PIN must already be unlocked)
 *   3. backendApi.assemble → the final signed document
 *
 * The SAME `params` object MUST go to both prepare and assemble, otherwise the
 * assembled signature is corrupted (DSS contract). Callers are responsible for
 * unlocking the token first (e.g. via AgentContext.ensureUnlocked()).
 */
export interface SignDocumentInput {
  documentBase64: string;
  fileName: string;
  params: SignatureParams;
  /** The selected certificate's key id (cert.keyId). */
  keyId: string;
}

export async function signDocumentToBase64({
  documentBase64,
  fileName,
  params,
  keyId,
}: SignDocumentInput): Promise<{
  signedDocumentBase64: string;
  signedFileName: string;
  mediaType: string;
}> {
  const prepared = await backendApi.prepare(documentBase64, fileName, params);
  const { signatureValueBase64 } = await agentApi.signDigest(
    keyId,
    prepared.dataToSignDigestBase64,
    'SHA256',
  );
  const assembled = await backendApi.assemble(documentBase64, fileName, params, signatureValueBase64);
  return {
    signedDocumentBase64: assembled.signedDocumentBase64,
    signedFileName: assembled.signedFileName,
    mediaType: assembled.mediaType,
  };
}

/** Pre-select the most appropriate signature form based on file name/type.
 *  PDF → PAdES; everything else → ASiC-E (matches backend auto-detect logic).
 *  Mirrors SignWorkspace.defaultForm without importing the component. */
export function defaultSignatureForm(name: string): SignatureForm {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return ext === 'pdf' ? 'PADES' : 'ASIC_E';
}
