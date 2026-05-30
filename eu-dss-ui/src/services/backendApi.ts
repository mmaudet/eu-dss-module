const BASE = '/api';

export type DigestAlgo = 'SHA256' | 'SHA384' | 'SHA512';
export type SignatureLevel = 'BASELINE_B' | 'BASELINE_T' | 'BASELINE_LT' | 'BASELINE_LTA';

export interface SignatureParams {
  certificateChainBase64: string[];
  digestAlgorithm: DigestAlgo;
  signingTimeEpochMs: number;
  signatureLevel?: SignatureLevel;
  signatureReason?: string;
  signatureLocation?: string;
  signerName?: string;
}

export interface PrepareResponse {
  dataToSignBase64: string;
  dataToSignDigestBase64: string;
}

export interface AssembleResponse {
  signedDocumentBase64: string;
  signedFileName: string;
  mediaType: string;
}

export interface SignatureSummary {
  signatureId: string;
  signatureFormat: string | null;
  indication: string;
  subIndication: string | null;
  signedBy: string | null;
  signingDate: string | null;
}

export interface ValidationResponse {
  signatureCount: number;
  signatures: SignatureSummary[];
  simpleReportXml: string | null;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${path} → HTTP ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export const backendApi = {
  prepare: (documentBase64: string, documentName: string, params: SignatureParams) =>
    postJson<PrepareResponse>('/sign/prepare', { documentBase64, documentName, params }),

  assemble: (
    documentBase64: string,
    documentName: string,
    params: SignatureParams,
    signatureValueBase64: string,
  ) => postJson<AssembleResponse>('/sign/assemble', { documentBase64, documentName, params, signatureValueBase64 }),

  validate: (documentBase64: string) =>
    postJson<ValidationResponse>('/validate', { documentBase64 }),
};
