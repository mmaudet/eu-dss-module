/**
 * Typed localStorage persistence service.
 *
 * Rationale: localStorage persists in BOTH the browser and the Tauri WKWebView
 * (Tauri stores webview localStorage in the app data dir, so it survives restarts),
 * so small preferences like theme and language need no native plugin.
 *
 * All access is wrapped in try/catch so a disabled or full localStorage degrades
 * gracefully to the provided fallback instead of throwing — the app must never
 * crash because storage is unavailable.
 *
 * All keys are namespaced under the prefix "eudss." and values are serialised as JSON.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OnboardingState {
  passed: boolean
  date?: string
}

export type ThemePref = 'light' | 'dark'
export type LangPref = 'fr' | 'en'

// ─── Keys ────────────────────────────────────────────────────────────────────

const PREFIX = 'eudss.'
const KEY_ONBOARDING = `${PREFIX}onboarding`
const KEY_THEME = `${PREFIX}theme`
const KEY_LANG = `${PREFIX}lang`

// ─── Store ───────────────────────────────────────────────────────────────────

export const store = {
  // ── Generic primitives ──────────────────────────────────────────────────

  /** Read a JSON-serialised value from localStorage, returning `fallback` on any error. */
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key)
      if (raw === null) return fallback
      return JSON.parse(raw) as T
    } catch {
      return fallback
    }
  },

  /** Write a value to localStorage as JSON, silently ignoring any storage error. */
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // storage unavailable or quota exceeded — degrade silently
    }
  },

  // ── Onboarding ──────────────────────────────────────────────────────────

  getOnboarding(): OnboardingState {
    return store.get<OnboardingState>(KEY_ONBOARDING, { passed: false })
  },

  setOnboardingPassed(dateIso: string): void {
    store.set(KEY_ONBOARDING, { passed: true, date: dateIso })
  },

  resetOnboarding(): void {
    store.set(KEY_ONBOARDING, { passed: false })
  },

  // ── Theme ────────────────────────────────────────────────────────────────

  getTheme(): ThemePref {
    return store.get<ThemePref>(KEY_THEME, 'light')
  },

  setTheme(t: ThemePref): void {
    store.set(KEY_THEME, t)
  },

  // ── Language ─────────────────────────────────────────────────────────────

  getLang(): LangPref {
    return store.get<LangPref>(KEY_LANG, 'fr')
  },

  setLang(l: LangPref): void {
    store.set(KEY_LANG, l)
  },
}
