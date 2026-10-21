import { describe, expect, it } from 'vitest'
import {
  SEARCH_PROVIDER_CAVEAT,
  SEARCH_PROVIDER_ENDPOINT_HINT,
  SEARCH_PROVIDER_HINT,
  SEARCH_PROVIDER_KEY_HINT,
  SEARCH_PROVIDER_KEY_PLACEHOLDER,
  SEARCH_PROVIDER_LABEL,
  SEARCH_PROVIDER_NEEDS_ENDPOINT,
  SEARCH_PROVIDER_NEEDS_KEY,
  SEARCH_PROVIDERS,
  activeSearchEntry,
  defaultSearchEntry,
  defaultSearchProviders,
  isSearchProvider,
  normalizeSearchProviders
} from './searchProviders'
import type { SearchProvider, SearchSettings } from './types'

/** The four backends that existed before the catalogue grew. */
const LEGACY: SearchProvider[] = ['duckduckgo', 'tavily', 'brave', 'searxng']

describe('search provider catalogue', () => {
  it('keeps the legacy backends first so the menu order does not shuffle', () => {
    expect(SEARCH_PROVIDERS.slice(0, LEGACY.length)).toEqual(LEGACY)
    expect(SEARCH_PROVIDERS.length).toBeGreaterThan(LEGACY.length)
    expect(new Set(SEARCH_PROVIDERS).size).toBe(SEARCH_PROVIDERS.length)
  })

  it('describes every backend it offers', () => {
    // The settings screen renders straight out of these maps, so an empty string
    // would show up as a blank row rather than as a missing feature.
    for (const provider of SEARCH_PROVIDERS) {
      expect(SEARCH_PROVIDER_LABEL[provider].trim(), provider).not.toBe('')
      for (const table of [
        SEARCH_PROVIDER_HINT,
        SEARCH_PROVIDER_KEY_HINT,
        SEARCH_PROVIDER_KEY_PLACEHOLDER,
        SEARCH_PROVIDER_ENDPOINT_HINT
      ]) {
        expect(table[provider].trim(), provider).not.toBe('')
      }
    }
    const labels = SEARCH_PROVIDERS.map((provider) => SEARCH_PROVIDER_LABEL[provider])
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('asks for an endpoint wherever the address is not fixed', () => {
    // SearXNG names a self-hosted instance; Google's Custom Search carries its
    // `cx` in the same field, because the form has nowhere else to put a second
    // required credential. Every other backend has one official host.
    const required = SEARCH_PROVIDERS.filter((provider) => SEARCH_PROVIDER_NEEDS_ENDPOINT[provider])
    expect(required).toEqual(['searxng', 'google-cse'])
  })

  it('says so when a key is not needed instead of leaving the field blank', () => {
    const keyless = SEARCH_PROVIDERS.filter((provider) => !SEARCH_PROVIDER_NEEDS_KEY[provider])
    expect(keyless).toEqual(expect.arrayContaining(LEGACY.filter((provider) => provider !== 'tavily' && provider !== 'brave')))
    for (const provider of keyless) {
      expect(SEARCH_PROVIDER_KEY_HINT[provider], provider).toMatch(/不需要|可选/)
    }
  })

  it('offers no backend it cannot actually query', () => {
    // Every listed provider has an adapter in `main/providers/search.ts`, so a
    // caveat is a setup note ("also needs cx"), never an admission that the
    // backend is missing. A sentence creeping back into that vocabulary is the
    // regression this guards.
    for (const provider of SEARCH_PROVIDERS) {
      expect(SEARCH_PROVIDER_CAVEAT[provider] ?? '', provider).not.toMatch(
        /未接入|没有适配器|尚不支持|退回/
      )
    }
    expect(SEARCH_PROVIDER_CAVEAT['google-cse']).toMatch(/cx/)
    // A caveat for an id that is not on the menu would be invisible, dead text.
    for (const provider of Object.keys(SEARCH_PROVIDER_CAVEAT)) {
      expect(SEARCH_PROVIDERS).toContain(provider)
    }
  })

  it('ships DeepSeek as a first-class key-only backend', () => {
    // Key-only: the official host is baked in, so the address field stays out of
    // the way and the whole configuration is one API key.
    expect(SEARCH_PROVIDERS).toContain('deepseek')
    expect(SEARCH_PROVIDER_LABEL.deepseek).toBe('DeepSeek 搜索')
    expect(SEARCH_PROVIDER_NEEDS_KEY.deepseek).toBe(true)
    expect(SEARCH_PROVIDER_NEEDS_ENDPOINT.deepseek).toBe(false)
    expect(SEARCH_PROVIDER_CAVEAT.deepseek).toBeUndefined()
  })

  it('accepts exactly the menu values', () => {
    for (const provider of SEARCH_PROVIDERS) expect(isSearchProvider(provider)).toBe(true)
    expect(isSearchProvider('elasticsearch')).toBe(false)
    expect(isSearchProvider(undefined)).toBe(false)
  })
})

describe('search provider storage', () => {
  it('gives every backend its own blank slot', () => {
    const providers = defaultSearchProviders()
    expect(Object.keys(providers).sort()).toEqual([...SEARCH_PROVIDERS].sort())
    for (const provider of SEARCH_PROVIDERS) {
      expect(providers[provider]).toEqual({ apiKey: '', endpoint: '', maxResults: 5 })
    }
    // Shared objects would leak one backend's key into the next.
    providers.tavily.apiKey = 'tvly-leak'
    expect(defaultSearchProviders().tavily.apiKey).toBe('')
    expect(defaultSearchEntry('tavily')).toEqual({ apiKey: '', endpoint: '', maxResults: 5 })
  })

  it('upgrades settings that only knew the old four', () => {
    const saved = {
      tavily: { apiKey: 'tvly-1', endpoint: '', maxResults: 8 },
      brave: { apiKey: 'brave-1', endpoint: 'https://brave.example', maxResults: 3 },
      searxng: { apiKey: '', endpoint: 'http://127.0.0.1:8080', maxResults: 5 },
      duckduckgo: { apiKey: '', endpoint: '', maxResults: 5 }
    }
    const providers = normalizeSearchProviders(saved)
    // Old values survive untouched...
    expect(providers.tavily).toEqual(saved.tavily)
    expect(providers.brave).toEqual(saved.brave)
    expect(providers.searxng.endpoint).toBe('http://127.0.0.1:8080')
    // ...and the backends that setting never heard of arrive as blank slots.
    for (const provider of SEARCH_PROVIDERS.filter((item) => !(item in saved))) {
      expect(providers[provider]).toEqual(defaultSearchEntry(provider))
    }
  })

  it('repairs junk without dropping the slot', () => {
    const providers = normalizeSearchProviders({
      exa: { apiKey: 42, endpoint: null, maxResults: '99' },
      bing: { maxResults: 0 }
    })
    expect(providers.exa.apiKey).toBe('')
    expect(providers.exa.endpoint).toBe('')
    expect(providers.exa.maxResults).toBe(10)
    expect(providers.bing.maxResults).toBe(1)
    expect(normalizeSearchProviders(undefined).jina).toEqual(defaultSearchEntry('jina'))
  })

  it('reads the active slot, with a fallback for a provider the map lacks', () => {
    const providers = defaultSearchProviders()
    providers.serper.apiKey = 'serper-1'
    const settings = { provider: 'serper', providers } as unknown as SearchSettings
    expect(activeSearchEntry(settings).apiKey).toBe('serper-1')

    const broken = { provider: 'serper', providers: {} } as unknown as SearchSettings
    expect(activeSearchEntry(broken)).toEqual(defaultSearchEntry('serper'))
  })
})
