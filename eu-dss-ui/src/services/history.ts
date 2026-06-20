/**
 * Local activity history for EU-DSS Sign.
 *
 * Backed by localStorage (namespaced "eudss.", JSON, try/catch), using the
 * same store.get / store.set primitives as store.ts so storage failures
 * degrade silently and never break the app.
 *
 * Cap: 50 entries, most-recent first.
 */

import { store } from './store';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HistoryEntry {
  id: string;
  name: string;
  kind: 'sign' | 'verify';
  format: string;
  sizeBytes: number;
  verdict?: string;  // only for verify; 'TOTAL_PASSED' = ok
  atIso: string;
}

// ─── Key ─────────────────────────────────────────────────────────────────────

const KEY = 'eudss.history';
const MAX = 50;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function load(): HistoryEntry[] {
  return store.get<HistoryEntry[]>(KEY, []);
}

function save(entries: HistoryEntry[]): void {
  store.set(KEY, entries);
}

// ─── Public API ──────────────────────────────────────────────────────────────

export const history = {
  /**
   * Prepend a new entry (without id) to the history, capped at MAX entries.
   * id is generated deterministically as `${atIso}-${name}`.
   */
  add(e: Omit<HistoryEntry, 'id'>): void {
    try {
      const id = `${e.atIso}-${e.name}`;
      const entry: HistoryEntry = { id, ...e };
      const current = load();
      const updated = [entry, ...current].slice(0, MAX);
      save(updated);
    } catch {
      // storage failure must never propagate
    }
  },

  /** Return all entries, most-recent first. */
  list(): HistoryEntry[] {
    try {
      return load();
    } catch {
      return [];
    }
  },

  /** Count kind==='sign' entries in the current calendar month. */
  signedThisMonth(): number {
    try {
      const now = new Date();
      const year = now.getFullYear();
      const month = now.getMonth(); // 0-based
      return load().filter((e) => {
        if (e.kind !== 'sign') return false;
        const d = new Date(e.atIso);
        return d.getFullYear() === year && d.getMonth() === month;
      }).length;
    } catch {
      return 0;
    }
  },

  /** Among all verify entries: { ok: TOTAL_PASSED count, total: all verify count }. */
  verifyCounts(): { ok: number; total: number } {
    try {
      const verifies = load().filter((e) => e.kind === 'verify');
      const ok = verifies.filter((e) => e.verdict === 'TOTAL_PASSED').length;
      return { ok, total: verifies.length };
    } catch {
      return { ok: 0, total: 0 };
    }
  },
};
