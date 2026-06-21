/**
 * Toast.tsx — lightweight, dependency-free toast notifications for EU-DSS Sign.
 *
 * Provides a <ToastProvider> (mount once at the app root) and a useToast() hook
 * returning { success, error, info }. Toasts stack in a fixed bottom-right
 * container, auto-dismiss after ~4s, can be closed manually, and follow the app
 * design tokens (light + dark via the [data-theme="dark"] CSS overrides).
 *
 * Styling lives in styles.css under the "Toasts" section (.toast-*).
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Icon } from './ui';

type ToastVariant = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  variant: ToastVariant;
  message: string;
}

export interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Auto-dismiss delay, in milliseconds. */
const TOAST_TTL = 4000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  // Monotonic id source — survives re-renders without re-allocating.
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (variant: ToastVariant, message: string) => {
      const id = nextId.current++;
      setToasts((list) => [...list, { id, variant, message }]);
      window.setTimeout(() => dismiss(id), TOAST_TTL);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (message) => push('success', message),
      error: (message) => push('error', message),
      info: (message) => push('info', message),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

/** Access the toast API. Must be used within a <ToastProvider>. */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a <ToastProvider>');
  return ctx;
}

// ── Viewport + items ─────────────────────────────────────────────────────────

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-viewport" role="region" aria-live="polite" aria-label="Notifications">
      {toasts.map((t) => (
        <ToastRow key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastRow({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: number) => void }) {
  const icon =
    toast.variant === 'success' ? (
      <Icon.checkCircle size={18} />
    ) : toast.variant === 'error' ? (
      <Icon.alert size={18} />
    ) : (
      <Icon.shield size={18} />
    );

  return (
    <div className={`toast toast--${toast.variant}`} role="status">
      <span className="toast-icon">{icon}</span>
      <span className="toast-msg">{toast.message}</span>
      <button
        type="button"
        className="toast-close"
        aria-label="Fermer"
        onClick={() => onDismiss(toast.id)}
      >
        <Icon.x size={15} />
      </button>
    </div>
  );
}
