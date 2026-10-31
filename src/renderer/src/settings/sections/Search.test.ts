/**
 * Regression coverage for "the optional API-key field cannot be typed into".
 *
 * The section itself is React + MUI, and the repo's vitest config runs in the
 * node environment and only collects TypeScript test files, so the
 * editable/validation rules are exported as pure functions and asserted here
 * without a DOM.
 */
import { describe, expect, it } from 'vitest'
import type { SearchConnection, SearchProvider } from '@shared/types'
import { SEARCH_PROVIDER_NEEDS_ENDPOINT, SEARCH_PROVIDER_NEEDS_KEY, SEARCH_PROVIDERS } from '@shared/searchProviders'
import { apiKeyHelperText, clampMaxResults, effectiveModeLabel, endpointHelperText, keyFieldDisabled, moveConnection, resultsLabel } from './Search'

describe('API-key field editability', () => {
  it('never locks a selectable provider, optional or required', () => {
    for (const provider of SEARCH_PROVIDERS) {
      expect(keyFieldDisabled(provider)).toBe(false)
    }
  })

  it('keeps the optional providers (SearXNG, DuckDuckGo, Jina, 百度) typeable', () => {
    const optional = SEARCH_PROVIDERS.filter((provider) => !SEARCH_PROVIDER_NEEDS_KEY[provider])
    // Which backends are keyless is `searchProviders.test.ts`'s business; what
    // matters here is that none of them becomes read-only.
    expect(optional).toEqual(expect.arrayContaining(['duckduckgo', 'searxng']))
    for (const provider of optional) {
      expect(keyFieldDisabled(provider)).toBe(false)
    }
  })

  it('still locks a provider id that is not offered by the menu', () => {
    expect(keyFieldDisabled('elasticsearch' as SearchProvider)).toBe(true)
  })
})

describe('API-key validation copy', () => {
  it('explains an empty required key instead of disabling the input', () => {
    expect(apiKeyHelperText('tavily', '')).toContain('需要 API Key')
    expect(apiKeyHelperText('brave', '   ')).toContain('需要 API Key')
  })

  it('stays quiet once a required key is filled in', () => {
    expect(apiKeyHelperText('tavily', 'tvly-abc')).toBeUndefined()
    expect(apiKeyHelperText('brave', 'token')).toBeUndefined()
  })

  it('never marks an optional key as missing', () => {
    expect(apiKeyHelperText('searxng', '')).toBeUndefined()
    expect(apiKeyHelperText('duckduckgo', '')).toBeUndefined()
  })
})

describe('endpoint validation copy', () => {
  it('requires an address wherever the host is not fixed', () => {
    const required = SEARCH_PROVIDERS.filter((provider) => SEARCH_PROVIDER_NEEDS_ENDPOINT[provider])
    // Google's Custom Search has no second field for its `cx`, so it needs the
    // address box for a credential rather than for a host.
    expect(required).toEqual(['searxng', 'google-cse'])
    expect(endpointHelperText('searxng', '')).toBe('必填：填好这一项后才能检索')
    expect(endpointHelperText('searxng', '  ')).toBe('必填：填好这一项后才能检索')
    expect(endpointHelperText('searxng', 'http://127.0.0.1:8080')).toBeUndefined()
    expect(endpointHelperText('google-cse', '')).toBe('必填：填好这一项后才能检索')
    expect(endpointHelperText('google-cse', 'cx=abc')).toBeUndefined()
  })

  it('leaves the other backends on their official host', () => {
    expect(endpointHelperText('tavily', '')).toBeUndefined()
    expect(endpointHelperText('brave', '')).toBeUndefined()
    expect(endpointHelperText('duckduckgo', '')).toBeUndefined()
  })
})

describe('network egress copy', () => {
  it('names the mode Chromium is really running with', () => {
    // "custom but the address did not parse" is reported by main as system; the
    // page must not claim a custom proxy in that case.
    expect(effectiveModeLabel('system')).toBe('跟随系统')
    expect(effectiveModeLabel('direct')).toBe('直连')
    expect(effectiveModeLabel('fixed_servers')).toBe('自定义代理')
  })
})

/** Four saved connections in a fixed order; the array order *is* the call order. */
function listOf(...ids: string[]): SearchConnection[] {
  return ids.map(id => ({ id, name: id.toUpperCase(), provider: 'tavily' as const, apiKey: '', endpoint: '', maxResults: 5, enabled: true }))
}

const idsOf = (rows: SearchConnection[]): string[] => rows.map(row => row.id)

describe('connection drag ordering', () => {
  const list = listOf('a', 'b', 'c', 'd')

  it('drops above the target when the pointer is in its top half', () => {
    expect(idsOf(moveConnection(list, 'd', 'b', false))).toEqual(['a', 'd', 'b', 'c'])
  })

  it('drops below the target when the pointer is in its bottom half', () => {
    expect(idsOf(moveConnection(list, 'a', 'c', true))).toEqual(['b', 'c', 'a', 'd'])
  })

  it('counts the index after removing the dragged row, so downward drags land one short', () => {
    // The classic off-by-one: 'a' dropped right below 'b' must replace its own slot,
    // not skip past 'b' to sit after 'c'.
    expect(idsOf(moveConnection(list, 'a', 'b', true))).toEqual(['b', 'a', 'c', 'd'])
    expect(idsOf(moveConnection(list, 'b', 'c', false))).toEqual(['a', 'b', 'c', 'd'])
  })

  it('leaves the order alone when a row is dropped on itself', () => {
    expect(idsOf(moveConnection(list, 'b', 'b', true))).toEqual(['a', 'b', 'c', 'd'])
    expect(idsOf(moveConnection(list, 'b', 'b', false))).toEqual(['a', 'b', 'c', 'd'])
  })

  it('leaves the order alone for ids that are gone (deleted in another window)', () => {
    expect(idsOf(moveConnection(list, 'ghost', 'b', true))).toEqual(['a', 'b', 'c', 'd'])
    expect(idsOf(moveConnection(list, 'a', 'ghost', true))).toEqual(['a', 'b', 'c', 'd'])
  })

  it('moves the very same objects instead of rebuilding them', () => {
    // Only the order may change: a rebuilt row would drop `apiKeyEnc` and the
    // probe cache keyed on it.
    const moved = moveConnection(list, 'a', 'd', true)
    expect(moved[3]).toBe(list[0])
    expect(moved).toHaveLength(list.length)
  })
})

describe('result count input', () => {
  it('keeps 0 as "unlimited" instead of the old 1 floor', () => {
    expect(clampMaxResults(0)).toBe(0)
    expect(clampMaxResults(-4)).toBe(0)
    expect(clampMaxResults('0')).toBe(0)
  })

  it('tops out at 50', () => {
    expect(clampMaxResults(50)).toBe(50)
    expect(clampMaxResults(51)).toBe(50)
    expect(clampMaxResults(999)).toBe(50)
  })

  it('rounds to a whole row count and repairs junk with the old default', () => {
    expect(clampMaxResults(2.6)).toBe(3)
    expect(clampMaxResults('7')).toBe(7)
    expect(clampMaxResults('')).toBe(5)
    expect(clampMaxResults('  ')).toBe(5)
    expect(clampMaxResults('many')).toBe(5)
    expect(clampMaxResults(undefined)).toBe(5)
    expect(clampMaxResults(Number.NaN)).toBe(5)
  })

  it('labels 0 as 不限 and everything else as the number itself', () => {
    expect(resultsLabel(0)).toBe('不限')
    expect(resultsLabel(5)).toBe('5')
    expect(resultsLabel(51)).toBe('50')
  })
})
