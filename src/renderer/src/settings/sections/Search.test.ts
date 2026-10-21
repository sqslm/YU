/**
 * Regression coverage for "the optional API-key field cannot be typed into".
 *
 * The section itself is React + MUI, and the repo's vitest config runs in the
 * node environment and only collects TypeScript test files, so the
 * editable/validation rules are exported as pure functions and asserted here
 * without a DOM.
 */
import { describe, expect, it } from 'vitest'
import type { SearchProvider } from '@shared/types'
import { SEARCH_PROVIDER_NEEDS_ENDPOINT, SEARCH_PROVIDER_NEEDS_KEY, SEARCH_PROVIDERS } from '@shared/searchProviders'
import { apiKeyHelperText, endpointHelperText, keyFieldDisabled } from './Search'

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
