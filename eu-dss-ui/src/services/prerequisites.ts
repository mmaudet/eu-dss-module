export type AgentOs = 'windows' | 'macos' | 'linux' | 'other';

/** Pure + parameterizable (args default to the live navigator) so it is testable without a runner. */
export function detectOs(
  ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : '',
  platform: string | undefined =
    typeof navigator !== 'undefined'
      ? (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
      : undefined,
): AgentOs {
  const s = `${platform ?? ''} ${ua}`.toLowerCase();
  if (s.includes('win')) return 'windows';
  if (s.includes('mac')) return 'macos';
  if (s.includes('linux') || s.includes('x11')) return 'linux';
  return 'other';
}

export interface PrereqLinks {
  agentInstaller: { url: string; label: string };
  middleware: { url: string; label: string };
  docUrl: string;
}

const CHAMBERSIGN_URL = 'https://support.chambersign.fr/pilotes/';
const INSTALL_DOC_URL = 'https://github.com/mmaudet/twake-eu-dss-module/blob/eu-dss/docs/INSTALL.md';
// Set to the published GitHub Release asset URL once the MSI is released (see Task 4).
// While empty, the Windows agent link falls back to the install guide (no dead 404).
const WINDOWS_AGENT_MSI_URL = '';

const MIDDLEWARE = { url: CHAMBERSIGN_URL, label: 'Télécharger le middleware ChamberSign' };

export const PREREQ_MANIFEST: Record<AgentOs, PrereqLinks> = {
  windows: {
    agentInstaller: WINDOWS_AGENT_MSI_URL
      ? { url: WINDOWS_AGENT_MSI_URL, label: "Télécharger l'agent (MSI)" }
      : { url: INSTALL_DOC_URL, label: "Guide d'installation de l'agent (Windows)" },
    middleware: MIDDLEWARE,
    docUrl: INSTALL_DOC_URL,
  },
  macos: {
    agentInstaller: { url: INSTALL_DOC_URL, label: "Guide d'installation de l'agent (macOS)" },
    middleware: MIDDLEWARE,
    docUrl: INSTALL_DOC_URL,
  },
  linux: {
    agentInstaller: { url: INSTALL_DOC_URL, label: "Guide d'installation de l'agent (Linux)" },
    middleware: MIDDLEWARE,
    docUrl: INSTALL_DOC_URL,
  },
  other: {
    agentInstaller: { url: INSTALL_DOC_URL, label: "Guide d'installation" },
    middleware: MIDDLEWARE,
    docUrl: INSTALL_DOC_URL,
  },
};
