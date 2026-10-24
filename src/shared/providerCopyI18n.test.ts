import { afterEach, describe, expect, it } from 'vitest'
import { MAIN_MESSAGES } from './mainMessages'
import { setMainLanguage } from './mainI18n'
import { allPresets, customPreset, findPreset } from './providerPresets'
import { PRESET_FIELDS } from './providerFields'
import {
  SEARCH_PROVIDER_CAVEAT,
  SEARCH_PROVIDER_ENDPOINT_HINT,
  SEARCH_PROVIDER_HINT,
  SEARCH_PROVIDER_KEY_HINT,
  SEARCH_PROVIDER_KEY_PLACEHOLDER,
  SEARCH_PROVIDER_LABEL,
  SEARCH_PROVIDERS
} from './searchProviders'
import { LOCAL_MODELS } from './local-asr'
import { effortUnavailable } from './effort'

/**
 * Translated copy that lives in `shared` has to be translated when it is *read*.
 *
 * These tables (preset notes, vendor field labels, search backend blurbs) are
 * built while the module graph loads, and the renderer only calls
 * `setMainLanguage('en')` from an effect after the first paint. Every one of them
 * used to hold `mt()` results captured at import time, so an English UI kept
 * describing providers in Chinese for the whole session. Each assertion below
 * flips the language *after* the constants already exist and demands the new text:
 * a value captured at module scope cannot pass.
 */

afterEach(() => {
  setMainLanguage('zh')
})

/**
 * What an English build must show for a Chinese source line.
 *
 * `null` means "this line is not translated copy" — brand names such as
 * `DuckDuckGo` are intentionally verbatim, and demanding they change would be
 * demanding a translation that should not exist.
 */
function englishFor(source: string | null | undefined): string | null {
  if (!source) return null
  const entry = MAIN_MESSAGES[source]
  return entry && entry !== source ? entry : null
}

/**
 * Asserts one field is live, and returns whether it actually had a translation to
 * check — the caller counts them so a dictionary accident cannot make the suite
 * pass by checking nothing.
 */
function expectLive(label: string, read: () => string | null | undefined): boolean {
  setMainLanguage('zh')
  const chinese = read()
  const english = englishFor(chinese)
  if (english === null) return false
  setMainLanguage('en')
  expect(read(), label).toBe(english)
  setMainLanguage('zh')
  expect(read(), label).toBe(chinese)
  return true
}

describe('preset notes', () => {
  it('follows the language instead of the import-time one', () => {
    let live = 0
    for (const preset of allPresets()) {
      if (!preset.notes) continue
      live += Number(expectLive(`preset ${preset.id}`, () => preset.notes))
    }
    // 40+ presets carry a caveat; anything less means the loop stopped checking.
    expect(live).toBeGreaterThan(40)
  })

  it('re-translates one preset twice in the same test', () => {
    const preset = findPreset('deepseek', 'llm')!
    setMainLanguage('zh')
    const chinese = preset.notes!
    setMainLanguage('en')
    expect(preset.notes).not.toBe(chinese)
    expect(preset.notes).toBe(MAIN_MESSAGES[chinese])
    expect(preset.notes).not.toContain('国内直连')
  })

  it('keeps the factory-built preset live too', () => {
    // `customPreset()` re-runs `mt()` per call, which was already correct; this
    // pins it so a future refactor cannot hoist the string out of the factory.
    setMainLanguage('zh')
    const chinese = customPreset('llm').notes
    const english = englishFor(chinese)
    expect(english).not.toBeNull()
    setMainLanguage('en')
    expect(customPreset('llm').notes).toBe(english)
  })
})

describe('vendor field labels', () => {
  it('re-translates labels and hints for every preset field', () => {
    let live = 0
    for (const [presetId, fields] of Object.entries(PRESET_FIELDS)) {
      for (const field of fields) {
        const label = `${presetId}.${field.key}`
        live += Number(expectLive(`${label} label`, () => field.label))
        live += Number(expectLive(`${label} hint`, () => field.hint))
      }
    }
    // The Azure deployment field is the one the bug report named.
    expect(live).toBeGreaterThan(10)
    const deployment = PRESET_FIELDS['azure-openai'].find((field) => field.key === 'deployment')!
    setMainLanguage('en')
    expect(deployment.label).toBe(MAIN_MESSAGES['部署名'])
    expect(deployment.hint).toBe(MAIN_MESSAGES['Azure 门户里那个部署名称，不是模型名'])
  })
})

describe('search provider copy', () => {
  it('re-translates labels, hints, key hints and endpoint hints', () => {
    let live = 0
    for (const provider of SEARCH_PROVIDERS) {
      live += Number(expectLive(`${provider} label`, () => SEARCH_PROVIDER_LABEL[provider]))
      live += Number(expectLive(`${provider} hint`, () => SEARCH_PROVIDER_HINT[provider]))
      live += Number(expectLive(`${provider} key hint`, () => SEARCH_PROVIDER_KEY_HINT[provider]))
      live += Number(
        expectLive(`${provider} key placeholder`, () => SEARCH_PROVIDER_KEY_PLACEHOLDER[provider])
      )
      live += Number(
        expectLive(`${provider} endpoint hint`, () => SEARCH_PROVIDER_ENDPOINT_HINT[provider])
      )
    }
    expect(live).toBeGreaterThan(25)
  })

  it('re-translates the caveat map built from the same table', () => {
    expect(expectLive('google-cse caveat', () => SEARCH_PROVIDER_CAVEAT['google-cse'])).toBe(true)
    setMainLanguage('en')
    expect(SEARCH_PROVIDER_CAVEAT['google-cse']).toBe(
      MAIN_MESSAGES['这家除了 API Key 还要 cx（搜索引擎 ID），写在自定义地址里即可。']
    )
  })

  it('keeps the provider list itself language-free', () => {
    // Guards the accessor refactor: `Object.keys` over the derived tables must
    // still enumerate every backend.
    expect(Object.keys(SEARCH_PROVIDER_LABEL).sort()).toEqual([...SEARCH_PROVIDERS].sort())
    expect(Object.keys(SEARCH_PROVIDER_CAVEAT)).toEqual(['google-cse'])
  })
})

describe('other shared copy', () => {
  it('re-translates local model hints', () => {
    let live = 0
    for (const model of LOCAL_MODELS) live += Number(expectLive(model.id, () => model.hint))
    expect(live).toBe(LOCAL_MODELS.length)
  })

  it('re-translates the reasoning-effort hint', () => {
    expect(expectLive('effort hint', () => effortUnavailable(null))).toBe(true)
    setMainLanguage('en')
    expect(effortUnavailable(null)).toBe(MAIN_MESSAGES['该模型不支持关闭思考'])
  })

  it('restores Chinese at the end so later assertions see the source strings', () => {
    setMainLanguage('en')
    expect(findPreset('openai', 'llm')!.notes).not.toBe('国内需代理。')
    setMainLanguage('zh')
    expect(findPreset('openai', 'llm')!.notes).toBe('国内需代理。')
  })
})
