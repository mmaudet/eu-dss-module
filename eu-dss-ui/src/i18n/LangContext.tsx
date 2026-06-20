/**
 * LangContext — in-house i18n (no external dependency).
 *
 * Holds the current language, persists it via the store, and exposes a typed
 * translation function. Wrap the app in <LangProvider>; read with useLang()
 * (lang + setLang) or useT() (the translate function).
 *
 * Translation resolution:
 *   1. look up the key in the current locale's dictionary;
 *   2. on a miss, fall back to the French value — a raw key is never rendered;
 *   3. interpolate `{param}` tokens from the optional params object.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { store, type LangPref } from '../services/store'
import { dictionaries, fr, type TKey } from './dict'

/** Params for `{token}` interpolation; values are stringified. */
export type TParams = Record<string, string | number>

/** The translate function: `t('nav.home')`, `t('sign.btn.signN', { n, s })`. */
export type TFunction = (key: TKey, params?: TParams) => string

interface LangContextValue {
  lang: LangPref
  setLang: (l: LangPref) => void
  t: TFunction
}

const LangContext = createContext<LangContextValue | null>(null)

/** Replace `{token}` occurrences in `template` with values from `params`. */
function interpolate(template: string, params?: TParams): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  )
}

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<LangPref>(() => store.getLang())

  const setLang = useCallback((l: LangPref) => {
    store.setLang(l)
    setLangState(l)
  }, [])

  // Rebuild `t` only when the language changes, so consumers re-render on toggle.
  const t = useMemo<TFunction>(() => {
    const dict = dictionaries[lang]
    return (key, params) => {
      // Fallback chain: current locale → French source → (never) raw key.
      const raw = dict[key] ?? fr[key]
      return interpolate(raw, params)
    }
  }, [lang])

  const value = useMemo<LangContextValue>(() => ({ lang, setLang, t }), [lang, setLang, t])

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>
}

function useLangContext(): LangContextValue {
  const ctx = useContext(LangContext)
  if (!ctx) throw new Error('useLang/useT must be used within a <LangProvider>')
  return ctx
}

/** Current language + a setter that persists and re-renders the app. */
export function useLang(): { lang: LangPref; setLang: (l: LangPref) => void } {
  const { lang, setLang } = useLangContext()
  return { lang, setLang }
}

/** The translate function for the current language. */
export function useT(): TFunction {
  return useLangContext().t
}
