const AGENT_BASE = 'https://localhost:9795/rest';

export interface AgentCertificate {
  keyId: string;
  certificateBase64: string;
  certificateChainBase64: string[];
  subjectDn: string;
  issuerDn: string;
  serialNumber: string;
  notBefore: string;
  notAfter: string;
}

async function agentGet<T>(path: string): Promise<T> {
  const res = await fetch(`${AGENT_BASE}${path}`, { credentials: 'omit' });
  if (!res.ok) throw new Error(`Agent ${path} → HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function agentPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${AGENT_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'omit',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Agent ${path} → HTTP ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export const agentApi = {
  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${AGENT_BASE}/health`, { credentials: 'omit' });
      return res.ok;
    } catch {
      return false;
    }
  },

  listCertificates: () => agentGet<{ certificates: AgentCertificate[] }>('/certificates'),

  signDigest: (keyId: string, digestBase64: string, digestAlgorithm: 'SHA256' | 'SHA384' | 'SHA512') =>
    agentPost<{ signatureValueBase64: string }>('/sign', {
      keyId,
      digestBase64,
      digestAlgorithm,
    }),
};
