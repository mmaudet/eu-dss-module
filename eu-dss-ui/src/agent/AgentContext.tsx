import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  agentApi,
  AgentCertificate,
  AgentError,
  AgentSessionStatus,
} from '../services/agentApi';
import { useT } from '../i18n';

/**
 * `error` is a distinct status for the case where a token error (e.g. token_unavailable)
 * occurred: the agent process answers on localhost but the card itself is busy/absent.
 * It drives the "Carte indisponible — token occupé" UI.
 */
export type AgentStatus = 'checking' | 'available' | 'unavailable' | 'error';

export interface AgentContextValue {
  status: AgentStatus;
  session: AgentSessionStatus | null;
  /** Convenience: locked === card is NOT unlocked (or no session yet). */
  locked: boolean;
  /** Live countdown seeded from session.expiresInSeconds; 0 once the session lapses. */
  secondsLeft: number;

  certificates: AgentCertificate[];
  selectedKeyId: string;
  setSelectedKeyId: (keyId: string) => void;
  /** The currently selected certificate, falling back to the first one. */
  selectedCert: AgentCertificate | null;

  /** Probe the agent: isAvailable → getStatus → (if unlocked) load certificates. */
  recheck: () => Promise<void>;
  /** Ensure the token is unlocked before a signing op; prompts for PIN if needed. */
  ensureUnlocked: () => Promise<AgentCertificate[]>;
  /** Lock the token now. */
  lock: () => Promise<void>;

  // PIN modal state (the modal itself is rendered once, near the app root).
  pinOpen: boolean;
  pinBusy: boolean;
  pinError: string | undefined;
  submitPin: (pin: string) => Promise<void>;
  cancelPin: () => void;
}

const AgentContext = createContext<AgentContextValue | null>(null);

export function AgentProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [status, setStatus] = useState<AgentStatus>('checking');
  const [session, setSession] = useState<AgentSessionStatus | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  // True once the live countdown lapses while the server still reports unlocked — keeps the UI
  // "locked" (no dead-zone between unlock-bar and locked-hint) until the next authoritative status.
  const [expired, setExpired] = useState(false);
  const [certificates, setCertificates] = useState<AgentCertificate[]>([]);
  const [selectedKeyId, setSelectedKeyId] = useState('');

  const [pinOpen, setPinOpen] = useState(false);
  const [pinBusy, setPinBusy] = useState(false);
  const [pinError, setPinError] = useState<string | undefined>();
  // Resolver for the unlock promise a signing flow awaits.
  const [pinResolver, setPinResolver] = useState<{
    resolve: (certs: AgentCertificate[]) => void;
    reject: (e: Error) => void;
  } | null>(null);

  const checkingRef = useRef(false); // anti-rafale: ignore a re-check while one is in flight

  const locked = !session?.unlocked || expired;

  // Keep the live countdown in sync with the most recent session.
  // Re-seeds (and clears any prior expiry) whenever a fresh status arrives.
  useEffect(() => {
    setExpired(false);
    if (session?.unlocked && session.expiresInSeconds != null) {
      setSecondsLeft(session.expiresInSeconds);
    } else {
      setSecondsLeft(0);
    }
  }, [session]);

  // Tick the countdown once per second while unlocked; mark expired (→ locked) when it hits 0.
  useEffect(() => {
    if (!session?.unlocked || secondsLeft <= 0) return;
    const id = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          setExpired(true); // countdown lapsed → treat as locked in the UI
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [session?.unlocked, secondsLeft]);

  const loadCertificates = useCallback(async (): Promise<AgentCertificate[]> => {
    const { certificates: certs } = await agentApi.listCertificates();
    setCertificates(certs);
    setSelectedKeyId((prev) =>
      prev && certs.some((c) => c.keyId === prev) ? prev : certs[0]?.keyId ?? '',
    );
    return certs;
  }, []);

  const recheck = useCallback(async (): Promise<void> => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    try {
      setStatus('checking');
      const ok = await agentApi.isAvailable();
      if (!ok) {
        setStatus('unavailable');
        return;
      }
      setStatus('available'); // clears a previous 'error' on success
      try {
        const st = await agentApi.getStatus();
        setSession(st);
        if (st.unlocked) await loadCertificates();
      } catch {
        setSession(null);
      }
    } finally {
      checkingRef.current = false;
    }
  }, [loadCertificates]);

  // Probe on mount + whenever the user returns to the tab (e.g. after launching the agent).
  useEffect(() => {
    void recheck();
  }, [recheck]);

  useEffect(() => {
    const onFocus = () => {
      if (!pinOpen && !document.hidden) void recheck();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [pinOpen, recheck]);

  // Shows the modal and resolves with the cert list once unlocked (or rejects on cancel).
  const promptUnlock = useCallback((): Promise<AgentCertificate[]> => {
    setPinError(undefined);
    setPinOpen(true);
    return new Promise<AgentCertificate[]>((resolve, reject) =>
      setPinResolver({ resolve, reject }),
    );
  }, []);

  const submitPin = useCallback(
    async (pin: string): Promise<void> => {
      setPinBusy(true);
      setPinError(undefined);
      try {
        const st = await agentApi.unlock(pin);
        setSession(st);
        const certs = await loadCertificates();
        setPinOpen(false);
        pinResolver?.resolve(certs);
        setPinResolver(null);
      } catch (e) {
        if (e instanceof AgentError) {
          if (e.code === 'token_unavailable') setStatus('error');
          setPinError(
            e.code === 'pin_locked'
              ? t('pinerr.lockedPuk')
              : e.code === 'pin_incorrect'
                ? t('pinerr.incorrect')
                : e.code === 'token_unavailable'
                  ? t('pinerr.tokenUnavailable')
                  : (e.message || t('pinerr.unlockFailed')),
          );
        } else {
          setPinError((e as Error).message || t('pinerr.unlockFailed'));
        }
      } finally {
        setPinBusy(false);
      }
    },
    [loadCertificates, pinResolver, t],
  );

  const cancelPin = useCallback((): void => {
    setPinOpen(false);
    pinResolver?.reject(new Error(t('pinerr.cancelled')));
    setPinResolver(null);
  }, [pinResolver, t]);

  // Ensures unlocked before a signing operation; prompts if needed. Returns the cert list.
  const ensureUnlocked = useCallback(async (): Promise<AgentCertificate[]> => {
    const st = await agentApi.getStatus().catch(() => null);
    setSession(st);
    if (st?.unlocked) {
      return certificates.length > 0 ? certificates : await loadCertificates();
    }
    return await promptUnlock();
  }, [certificates, loadCertificates, promptUnlock]);

  const lock = useCallback(async (): Promise<void> => {
    try {
      await agentApi.lock();
    } catch {
      /* ignore */
    }
    setSession(await agentApi.getStatus().catch(() => null));
  }, []);

  const selectedCert =
    certificates.find((c) => c.keyId === selectedKeyId) ?? certificates[0] ?? null;

  const value: AgentContextValue = {
    status,
    session,
    locked,
    secondsLeft,
    certificates,
    selectedKeyId,
    setSelectedKeyId,
    selectedCert,
    recheck,
    ensureUnlocked,
    lock,
    pinOpen,
    pinBusy,
    pinError,
    submitPin,
    cancelPin,
  };

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}

export function useAgent(): AgentContextValue {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error('useAgent must be used within an <AgentProvider>');
  return ctx;
}
