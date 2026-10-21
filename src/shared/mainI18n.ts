import { MAIN_MESSAGES } from './mainMessages'

export type MainLanguage = 'zh' | 'en'

/**
 * The language of main-process copy.
 *
 * Defaults to Chinese on purpose: tests and any caller that never wires the
 * setting keep the exact strings they assert on, and a window opened before the
 * settings file loads cannot flash English.
 */
let language: MainLanguage = 'zh'

export function setMainLanguage(value: string | undefined): void {
  language = value === 'en' ? 'en' : 'zh'
}

export function mainLanguage(): MainLanguage {
  return language
}

/**
 * Translates one main-process sentence.
 *
 * `params` fills `{{name}}` holes; the Chinese template stays the source of
 * truth so the two versions cannot drift into different sentences.
 */
export function mt(template: string, params?: Record<string, string | number>): string {
  const text = language === 'en' ? (MAIN_MESSAGES[template] ?? template) : template
  if (!params) return text
  return text.replace(/\{\{(\w+)\}\}/g, (all, name: string) =>
    name in params ? String(params[name]) : all
  )
}
