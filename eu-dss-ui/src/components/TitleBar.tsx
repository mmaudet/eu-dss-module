// TitleBar.tsx — custom titlebar for the EU-DSS Sign app shell.
// Windows/Linux: decorations:false + custom min/max/close controls (right side).
// macOS: native traffic lights via titleBarStyle:"Overlay" (see tauri.macos.conf.json) —
//        so we do NOT draw window controls here, and we pad the brand to clear the lights.
// Dragging works via data-tauri-drag-region (requires core:window:allow-start-dragging in the capability).

const isMacOS = typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent);

function isTauri(): boolean {
  return '__TAURI_INTERNALS__' in window;
}

async function wMinimize() {
  if (!isTauri()) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  getCurrentWindow().minimize();
}

async function wMaximize() {
  if (!isTauri()) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  getCurrentWindow().toggleMaximize();
}

async function wClose() {
  if (!isTauri()) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  getCurrentWindow().close();
}

export function TitleBar() {
  return (
    <div className={`titlebar${isMacOS ? ' titlebar--mac' : ''}`} data-tauri-drag-region>
      {/* Logo mark + app name */}
      <div className="titlebar-brand" data-tauri-drag-region>
        <span className="titlebar-mark">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
            <path d="m9.2 12.1 1.9 1.9 3.8-3.9" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span className="titlebar-title">EU-DSS Sign</span>
      </div>

      {/* Drag region fills the center */}
      <div className="titlebar-drag" data-tauri-drag-region />

      {/* Window controls — Windows/Linux only; macOS uses native traffic lights */}
      {!isMacOS && (
        <div className="titlebar-controls">
          <button className="wc wc-min" onClick={wMinimize} aria-label="Réduire" tabIndex={-1} type="button">
            <svg width="13" height="13" viewBox="0 0 24 24">
              <path d="M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
          <button className="wc wc-max" onClick={wMaximize} aria-label="Agrandir" tabIndex={-1} type="button">
            <svg width="11" height="11" viewBox="0 0 24 24">
              <rect x="5" y="5" width="14" height="14" rx="2.5" fill="none" stroke="currentColor" strokeWidth="2" />
            </svg>
          </button>
          <button className="wc wc-close" onClick={wClose} aria-label="Fermer" tabIndex={-1} type="button">
            <svg width="12" height="12" viewBox="0 0 24 24">
              <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
