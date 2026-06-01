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

export interface AgentSessionStatus {
  unlocked: boolean;
  expiresInSeconds: number | null;
  mode: 'interactive' | 'headless';
}

/** Carries the agent's structured error code so the UI can react (locked → prompt PIN). */
export class AgentError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = 'AgentError';
  }
}

async function parseError(res: Response, path: string): Promise<AgentError> {
  let code = 'http_' + res.status;
  let message = `Agent ${path} → HTTP ${res.status}`;
  try {
    const body = await res.json();
    if (body && typeof body.error === 'string') code = body.error;
    if (body && typeof body.message === 'string') message = body.message;
  } catch {
    /* non-JSON body */
  }
  return new AgentError(res.status, code, message);
}

async function agentGet<T>(path: string): Promise<T> {
  const res = await fetch(`${AGENT_BASE}${path}`, { credentials: 'omit' });
  if (!res.ok) throw await parseError(res, path);
  return res.json() as Promise<T>;
}

async function agentPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${AGENT_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'omit',
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await parseError(res, path);
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

  getStatus: () => agentGet<AgentSessionStatus>('/status'),

  unlock: (pin: string) => agentPost<AgentSessionStatus>('/unlock', { pin }),

  lock: () => agentPost<{ status: string }>('/lock', {}),

  listCertificates: () => agentGet<{ certificates: AgentCertificate[] }>('/certificates'),

  signDigest: (keyId: string, digestBase64: string, digestAlgorithm: 'SHA256' | 'SHA384' | 'SHA512') =>
    agentPost<{ signatureValueBase64: string }>('/sign', { keyId, digestBase64, digestAlgorithm }),
};
