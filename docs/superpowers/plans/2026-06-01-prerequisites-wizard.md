# Prerequisites Wizard (SP1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An on-load prerequisites checklist panel on the Sign tab that detects agent/session state (via existing `/health`+`/status`), shows OS-aware download links for the agent + ChamberSign middleware, and reveals token/middleware guidance when an unlock fails.

**Architecture:** Pure front-end (`eu-dss-ui`), zero agent change. A new `prerequisites.ts` service (OS detection + per-OS link manifest) and a `PrerequisitesPanel.tsx` component replace the ad-hoc "first-run" body of the Sign tab's agent card. SignWorkspace re-checks on mount, on a "Revérifier" button, and on window focus/visibility change.

**Tech Stack:** Vite + React 19 + TypeScript. No UI test runner exists → the automated gate is `npm run build` (tsc typecheck + vite build) plus a manual smoke checklist. `detectOs()` is written as a pure, parameterizable function so it can be checked without a framework.

**Spec:** `docs/superpowers/specs/2026-06-01-prerequisites-wizard-design.md`

---

## File Structure

- `eu-dss-ui/src/services/prerequisites.ts` — CREATE: `detectOs()` + `PREREQ_MANIFEST` (per-OS links). One responsibility: OS → download links.
- `eu-dss-ui/src/components/PrerequisitesPanel.tsx` — CREATE: the checklist UI (agent / card-session / middleware items). Presentational; state comes via props.
- `eu-dss-ui/src/components/SignWorkspace.tsx` — MODIFY: render the panel in the agent card; add focus/visibility re-check; map `token_unavailable` in `submitPin`.

No new CSS (reuses existing `.status info|ok|warn` + `<button>` styles). No new dependency.

---

## Task 1: prerequisites.ts (OS detection + link manifest)

**Files:**
- Create: `eu-dss-ui/src/services/prerequisites.ts`

- [ ] **Step 1: Create the file**

```typescript
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
```

- [ ] **Step 2: Typecheck**

Run: `cd eu-dss-ui && npm run build` (then `cd ..`)
Expected: build succeeds (0 TS errors).

- [ ] **Step 3 (optional): sanity-check detectOs logic**

If `npx tsx` is available: `cd eu-dss-ui && npx tsx -e "import {detectOs} from './src/services/prerequisites.ts'; console.log(detectOs('Mozilla Windows NT 10.0'), detectOs('Mozilla Mac OS X'), detectOs('X11; Linux x86_64'), detectOs('weird'))"` → expect `windows macos linux other`. (If tsx is unavailable, skip — the build is the gate.) Then `cd ..`.

- [ ] **Step 4: Commit**

```bash
git add eu-dss-ui/src/services/prerequisites.ts
git commit -m "feat(ui): prerequisites service - detectOs + per-OS download link manifest"
```

---

## Task 2: PrerequisitesPanel.tsx (the checklist)

**Files:**
- Create: `eu-dss-ui/src/components/PrerequisitesPanel.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { AgentSessionStatus } from '../services/agentApi';
import { detectOs, PREREQ_MANIFEST } from '../services/prerequisites';

interface PrerequisitesPanelProps {
  agentStatus: 'checking' | 'available' | 'unavailable';
  status: AgentSessionStatus | null;
  hasCertificates: boolean;
  onRecheck: () => void;
  onUnlock: () => void;
  onLock: () => void;
}

export function PrerequisitesPanel({
  agentStatus,
  status,
  hasCertificates,
  onRecheck,
  onUnlock,
  onLock,
}: PrerequisitesPanelProps) {
  const links = PREREQ_MANIFEST[detectOs()];

  return (
    <div>
      {/* 1. Agent local */}
      {agentStatus === 'checking' && <div className="status info">Vérification de l'agent…</div>}
      {agentStatus === 'unavailable' && (
        <div className="status warn">
          <strong>✗ Agent local non détecté.</strong>
          <div className="muted" style={{ margin: '4px 0' }}>
            L'agent n'est pas lancé, pas installé, ou son certificat n'a pas encore été accepté.
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 6, alignItems: 'center' }}>
            <a href={links.agentInstaller.url} target="_blank" rel="noreferrer">{links.agentInstaller.label}</a>
            <a href="https://localhost:9795/rest/health" target="_blank" rel="noreferrer">Accepter le certificat de l'agent</a>
            <button onClick={onRecheck}>Revérifier</button>
          </div>
        </div>
      )}
      {agentStatus === 'available' && <div className="status ok">✓ Agent connecté.</div>}

      {/* 2. Carte / session */}
      {agentStatus === 'available' && (
        status?.unlocked ? (
          <div className="status ok">
            🔓 Carte déverrouillée{status.expiresInSeconds != null ? ` (re-verrou ~${status.expiresInSeconds}s)` : ''}{' '}
            <button onClick={onLock}>Verrouiller</button>
          </div>
        ) : (
          <div className="status info">
            🔒 Carte verrouillée — clique « Signer » et saisis ton PIN.{' '}
            <button onClick={onUnlock}>Déverrouiller</button>
          </div>
        )
      )}
      {agentStatus === 'available' && status?.unlocked && !hasCertificates && (
        <div className="status warn">Agent déverrouillé mais aucun certificat. Vérifie la clé USB.</div>
      )}

      {/* 3. Middleware & token (info passive; le besoin réel se révèle au unlock via token_unavailable) */}
      <div className="status info" style={{ marginTop: 6 }}>
        Carte branchée + middleware ChamberSign requis.{' '}
        <a href={links.middleware.url} target="_blank" rel="noreferrer">{links.middleware.label}</a>
        {' · '}
        <a href={links.docUrl} target="_blank" rel="noreferrer">Guide d'installation</a>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Build**

Run: `cd eu-dss-ui && npm run build` (then `cd ..`)
Expected: build succeeds (0 TS errors).

- [ ] **Step 3: Commit**

```bash
git add eu-dss-ui/src/components/PrerequisitesPanel.tsx
git commit -m "feat(ui): PrerequisitesPanel - on-load checklist (agent/session/middleware) with OS-aware links"
```

---

## Task 3: Integrate the panel into SignWorkspace

**Files:**
- Modify: `eu-dss-ui/src/components/SignWorkspace.tsx`

- [ ] **Step 1: Add the import**

After the existing `import { PinModal } from './PinModal';` line, add:

```tsx
import { PrerequisitesPanel } from './PrerequisitesPanel';
```

- [ ] **Step 2: Add focus/visibility re-check**

Immediately after the existing mount effect:

```tsx
  useEffect(() => {
    void checkAgent();
  }, []);
```

add a second effect:

```tsx
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
```

- [ ] **Step 3: Map `token_unavailable` in submitPin**

In `submitPin`, replace the `if (e instanceof AgentError) { ... }` block with:

```tsx
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
```

- [ ] **Step 4: Replace the agent-card body with the panel**

In the first `<div className="card">` (the `<h2>1. Agent local (clé USB)</h2>` card), replace EVERYTHING between the `</h2>` and the card's closing `</div>` (i.e. all five current conditional blocks: `checking`, `unavailable`, the two `available …` blocks, and the locked-no-cert block) with:

```tsx
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
```

(The `<h2>1. Agent local (clé USB)</h2>` stays. The cert `<select>` is kept here because it is signing config, not a prerequisite. `agentStatus`, `status`, `certificates`, `selectedKeyId`, `checkAgent`, `ensureUnlocked`, `lockNow` all already exist in the component.)

- [ ] **Step 5: Build**

Run: `cd eu-dss-ui && npm run build` (then `cd ..`)
Expected: build succeeds (0 TS errors). No unused-symbol errors (the old inline JSX that referenced `status`/`lockNow`/`ensureUnlocked` is now inside the panel call + the kept select; all still referenced).

- [ ] **Step 6: Manual smoke (with the local stack)**

With the agent stopped: load the UI → the agent card shows "✗ Agent local non détecté" + a download link whose label matches your OS + "Accepter le certificat" + "Revérifier". With the agent up + locked: "✓ Agent connecté" + "🔒 Carte verrouillée". Click Signer on a doc → PIN modal → on success the card flips to "🔓 déverrouillée". Switch away and back to the tab → it re-checks automatically. (Optional: with no token, unlocking shows the middleware message.)

- [ ] **Step 7: Commit**

```bash
git add eu-dss-ui/src/components/SignWorkspace.tsx
git commit -m "feat(ui): render PrerequisitesPanel on Sign tab + focus re-check + token_unavailable guidance"
```

---

## Task 4 (ops, can be deferred): publish the Windows MSI as a GitHub Release

**Files:** none (release + one constant edit)

- [ ] **Step 1: Download the latest successful MSI artifact**

```bash
gh run download 26748527116 -R mmaudet/twake-eu-dss-module -n eu-dss-agent-msi -D /tmp/eudss-msi-release
ls -lh /tmp/eudss-msi-release/
```
(If that run's artifact has expired, list recent runs with `gh run list --workflow windows-installer.yml -R mmaudet/twake-eu-dss-module -L 5` and download the newest successful one.)

- [ ] **Step 2: Create the release with the MSI asset**

```bash
gh release create eu-dss-agent-v0.1.0 -R mmaudet/twake-eu-dss-module \
  --target eu-dss --title "EU-DSS Agent 0.1.0" \
  --notes "Local PKCS#11 signing agent (Windows MSI, x64). PIN at signing time." \
  "/tmp/eudss-msi-release/EU-DSS Agent-0.1.0.msi"
```

- [ ] **Step 3: Wire the URL into the manifest**

Get the asset URL: `gh release view eu-dss-agent-v0.1.0 -R mmaudet/twake-eu-dss-module --json assets --jq '.assets[].url'`
Set `WINDOWS_AGENT_MSI_URL` in `eu-dss-ui/src/services/prerequisites.ts` to that download URL (e.g. `https://github.com/mmaudet/twake-eu-dss-module/releases/download/eu-dss-agent-v0.1.0/EU-DSS%20Agent-0.1.0.msi`), then `cd eu-dss-ui && npm run build` (expect green), `cd ..`.

- [ ] **Step 4: Commit**

```bash
git add eu-dss-ui/src/services/prerequisites.ts
git commit -m "chore(ui): point Windows agent link at the published MSI release"
```

---

## Self-Review (completed by plan author)

- **Spec coverage:** detection pure-UI via `/health`+`/status` → Task 3 uses existing `checkAgent`/`getStatus` (no agent change ✓). Per-OS manifest + publish MSI → Task 1 (`PREREQ_MANIFEST`) + Task 4 (release). Inline checklist on Sign tab, non-blocking, re-check on mount/button/focus → Task 2 (panel) + Task 3 (focus effect + `onRecheck`). `token_unavailable` reveal → Task 3 Step 3. OS detection → Task 1 `detectOs`. Acceptance #1–8 covered (build gate + manual smoke; #6 detectOs via the optional tsx check + the function's purity). ✓
- **Placeholder scan:** none. `WINDOWS_AGENT_MSI_URL = ''` is complete code with a fallback (not an incomplete instruction); Task 4 fills it. The doc/middleware URLs are real (ChamberSign live; `docs/INSTALL.md` exists on the branch).
- **Type consistency:** `AgentSessionStatus` (fields `unlocked`/`expiresInSeconds`) used by the panel matches `agentApi.ts`. `agentStatus` union `'checking'|'available'|'unavailable'` matches SignWorkspace. `AgentError.code === 'token_unavailable'` matches the agent's `mapTokenError` output. Panel prop names (`onRecheck`/`onUnlock`/`onLock`) consistent between Task 2 (definition) and Task 3 (call site). ✓
