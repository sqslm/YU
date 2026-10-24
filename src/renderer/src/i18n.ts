/**
 * Minimal i18n bootstrap (REQ-14).
 *
 * The hub used to hard-code Simplified Chinese. `i18next` and `react-i18next`
 * were already dependencies but nothing ever initialised them, so the language
 * setting was a dead field. This module is the single place that owned keys are
 * registered; every user-visible string that has been migrated calls `t()`.
 *
 * Scope note: the dictionary below covers navigation, the shared button verbs
 * and the first-run tour. Strings that are still literal Chinese in the source
 * are intentionally out of scope for this pass — shipping half-translated keys
 * would look like a broken build, so the tour and chrome come first.
 */
import { setMainLanguage } from '@shared/mainI18n'
import { productName } from '@shared/brand'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import enUS from './locales/en-US.json'
import zhCN from './locales/zh-CN.json'

export type UiLanguage = 'zh' | 'en'

const RESOURCES = {
  zh: { translation: zhCN },
  en: { translation: enUS }
} as const

void i18n.use(initReactI18next).init({
  resources: RESOURCES,
  lng: 'zh',
  fallbackLng: 'zh',
  supportedLngs: ['zh', 'en'],
  interpolation: { escapeValue: false },
  returnNull: false
})

// Shared modules (provider field labels, model blurbs) build their copy with
// `mt()`, so the language has to reach that helper wherever it is imported.
i18n.on('languageChanged', (language) => setMainLanguage(language))

/** Maps a settings value onto a supported UI language. */
export function normalizeUiLanguage(language: string | undefined): UiLanguage {
  return language === 'en' ? 'en' : 'zh'
}

/** Current language as the settings vocabulary spells it. */
export function currentUiLanguage(): UiLanguage {
  return normalizeUiLanguage(i18n.resolvedLanguage ?? i18n.language)
}

/**
 * Applies `settings.language`. Called on mount and whenever the setting changes,
 * so flipping the hub language re-renders every `t()` consumer immediately.
 */
export function applyUiLanguage(language: string | undefined): UiLanguage {
  const next = normalizeUiLanguage(language)
  if (typeof document !== 'undefined') { document.documentElement.lang = next === 'en' ? 'en' : 'zh-CN'; document.title = productName(next) }
  setMainLanguage(next)
  if (i18n.resolvedLanguage !== next) void i18n.changeLanguage(next)
  return next
}

export default i18n
