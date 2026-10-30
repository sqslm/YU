/**
 * The egress contract: what gets pushed into Chromium, what gets logged, and what
 * the settings page is told.
 *
 * `electron` is mocked because the module under test is the *adapter* around the
 * session; the interesting logic (proxy-rule mapping, probe shaping, advice) is
 * pure and must be testable without a browser. No test here touches the network:
 * every request goes through an injected `fetchImpl`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '@shared/types'

const mocks = vi.hoisted(() => ({
  setProxy: vi.fn(async (_config: unknown) => undefined),
  resolveProxy: vi.fn(async (_url: string) => 'PROXY 127.0.0.1:7897'),
  sessionFetch: vi.fn(async (_input: unknown, _init?: unknown) => new Response('ok')),
  netFetch: vi.fn(async (_input: unknown, _init?: unknown) => new Response('ok'))
}))

vi.mock('electron', () => ({
  net: { fetch: mocks.netFetch },
  session: {
    defaultSession: {
      setProxy: mocks.setProxy,
      resolveProxy: mocks.resolveProxy,
      fetch: mocks.sessionFetch
    }
  }
}))

import {
  PROXY_BYPASS_RULES,
  applyEgress,
  diagnoseEgress,
  egressFetch,
  normalizeProxyUrl,
  proxyEgressActive,
  proxyRulesFor,
  setEgressFetchForTests,
  setEgressLog,
  setEgressNetworkForTests
} from './egress'

function network(mode: 'system' | 'direct' | 'custom', proxyUrl = '') {
  return { mode, proxyUrl }
}

function settingsFixture(patch: Partial<Settings> = {}): Settings {
  return {
    network: network('system'),
    search: { provider: 'tavily', providers: { tavily: { apiKey: 'tvly-secret-key', endpoint: '', maxResults: 5 } } },
    polish: { baseUrl: '', apiKey: '', authHeader: 'bearer', extraHeaders: '' },
    ...patch
  } as unknown as Settings
}

function jsonResponse(status = 200): Response {
  return new Response('{}', { status })
}

beforeEach(() => {
  mocks.setProxy.mockClear()
  mocks.resolveProxy.mockClear()
  mocks.sessionFetch.mockClear()
  mocks.netFetch.mockClear()
  setEgressLog(null)
  setEgressFetchForTests(null)
  setEgressNetworkForTests(null)
})

describe('normalizeProxyUrl', () => {
  it('adds http:// to a bare host:port', () => {
    expect(normalizeProxyUrl('127.0.0.1:7897')).toBe('http://127.0.0.1:7897')
  })

  it('keeps http, https and socks5 intact', () => {
    expect(normalizeProxyUrl('http://127.0.0.1:7897')).toBe('http://127.0.0.1:7897')
    expect(normalizeProxyUrl('https://proxy.example.com:8443')).toBe('https://proxy.example.com:8443')
    expect(normalizeProxyUrl('socks5://127.0.0.1:1080')).toBe('socks5://127.0.0.1:1080')
  })

  it('refuses what is not an address', () => {
    expect(normalizeProxyUrl('')).toBeNull()
    expect(normalizeProxyUrl('   ')).toBeNull()
    expect(normalizeProxyUrl('not a proxy')).toBeNull()
    expect(normalizeProxyUrl('ftp://127.0.0.1:21')).toBeNull()
    expect(normalizeProxyUrl('http://127.0.0.1:7897/typo')).toBeNull()
    expect(normalizeProxyUrl('http://user:pass@127.0.0.1:7897')).toBeNull()
  })
})

describe('proxyRulesFor', () => {
  it('passes `system` through so Chromium reads the OS proxy and PAC', () => {
    expect(proxyRulesFor(network('system'))).toEqual({ mode: 'system' })
  })

  it('maps `direct` to no proxy at all', () => {
    expect(proxyRulesFor(network('direct', 'http://127.0.0.1:7897'))).toEqual({ mode: 'direct' })
  })

  it('turns a schemeless custom address into fixed_servers rules with loopback bypassed', () => {
    expect(proxyRulesFor(network('custom', '127.0.0.1:7897'))).toEqual({
      mode: 'fixed_servers',
      proxyRules: '127.0.0.1:7897',
      proxyBypassRules: PROXY_BYPASS_RULES
    })
  })

  it('keeps socks5 as a socks rule instead of pretending it is http', () => {
    expect(proxyRulesFor(network('custom', 'socks5://127.0.0.1:1080'))).toEqual({
      mode: 'fixed_servers',
      proxyRules: 'socks5://127.0.0.1:1080',
      proxyBypassRules: PROXY_BYPASS_RULES
    })
  })

  it('falls back to the system proxy when the custom address does not parse', () => {
    expect(proxyRulesFor(network('custom', '7897'))).toEqual({ mode: 'system' })
    expect(proxyRulesFor(network('custom', ''))).toEqual({ mode: 'system' })
  })
})

describe('applyEgress', () => {
  it('pushes the rules into the default session and logs what they resolve to', async () => {
    const lines: string[] = []
    setEgressLog(line => lines.push(line))
    await applyEgress(settingsFixture({ network: network('custom', '127.0.0.1:7897') }))

    expect(mocks.setProxy).toHaveBeenCalledWith({
      mode: 'fixed_servers',
      proxyRules: '127.0.0.1:7897',
      proxyBypassRules: PROXY_BYPASS_RULES
    })
    expect(mocks.resolveProxy).toHaveBeenCalledWith('https://www.bing.com')
    expect(lines.some(line => line.startsWith('[net] mode=custom') && line.includes('resolved="PROXY 127.0.0.1:7897"'))).toBe(
      true
    )
  })

  it('remembers the mode so safe-fetch knows whether a proxy is in play', async () => {
    await applyEgress(settingsFixture({ network: network('direct') }))
    expect(proxyEgressActive()).toBe(false)
    await applyEgress(settingsFixture({ network: network('system') }))
    expect(proxyEgressActive()).toBe(true)
  })

  it('never logs an API key', async () => {
    const lines: string[] = []
    setEgressLog(line => lines.push(line))
    await applyEgress(settingsFixture())
    expect(lines.join('\n')).not.toContain('tvly-secret-key')
  })
})

describe('egressFetch', () => {
  it('uses the Chromium session transport, not global fetch', async () => {
    await egressFetch('https://www.bing.com/robots.txt', { redirect: 'manual' })
    expect(mocks.sessionFetch).toHaveBeenCalledTimes(1)
    expect(mocks.sessionFetch.mock.calls[0]?.[1]).toEqual({ redirect: 'manual' })
  })

  it('lets a test replace the transport', async () => {
    const fake = vi.fn(async () => new Response('stub'))
    setEgressFetchForTests(fake as unknown as typeof fetch)
    await egressFetch('https://example.com/')
    expect(fake).toHaveBeenCalledTimes(1)
    expect(mocks.sessionFetch).not.toHaveBeenCalled()
  })
})

describe('diagnoseEgress', () => {
  it('shapes the report the settings page renders', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200)) as unknown as typeof fetch
    const report = await diagnoseEgress(settingsFixture({ polish: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret', authHeader: 'bearer', extraHeaders: '' } } as never), {
      fetchImpl,
      resolveProxy: async () => 'PROXY 127.0.0.1:7897',
      env: { HTTPS_PROXY: 'http://127.0.0.1:7897' } as NodeJS.ProcessEnv
    })

    expect(report.mode).toBe('system')
    expect(report.effective).toBe('system')
    expect(report.resolved).toBe('PROXY 127.0.0.1:7897')
    expect(report.envProxy.https).toBe('http://127.0.0.1:7897')
    // Bing + DuckDuckGo + the configured search backend + the polish host.
    expect(report.probes.map(probe => probe.url)).toEqual([
      'https://www.bing.com/robots.txt',
      'https://html.duckduckgo.com/html/?q=ping',
      'https://api.tavily.com/robots.txt',
      'https://api.example.com/v1/models'
    ])
    expect(report.probes.every(probe => probe.ok && probe.status === 200)).toBe(true)
    expect(report.advice.length).toBeGreaterThan(0)
    expect(JSON.stringify(report)).not.toContain('sk-secret')
    expect(JSON.stringify(report)).not.toContain('tvly-secret-key')
  })

  it('reports a transport failure per probe instead of throwing', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND www.bing.com')
    }) as unknown as typeof fetch
    const report = await diagnoseEgress(settingsFixture(), { fetchImpl, resolveProxy: async () => 'DIRECT', env: {} })

    expect(report.probes.every(probe => !probe.ok && (probe.error ?? '').includes('ENOTFOUND'))).toBe(true)
    // DIRECT + system mode is the Clash-TUN-off signature: the advice has to name it.
    expect(report.advice.join('\n')).toContain('系统代理')
    expect(report.envProxy).toEqual({ http: undefined, https: undefined, noProxy: undefined })
  })

  it('marks an unusable custom address as a fallback instead of claiming it works', async () => {
    const report = await diagnoseEgress(settingsFixture({ network: network('custom', '7897') }), {
      fetchImpl: (async () => jsonResponse(204)) as unknown as typeof fetch,
      resolveProxy: async () => 'PROXY 127.0.0.1:7897',
      env: {}
    })
    expect(report.mode).toBe('custom')
    expect(report.effective).toBe('system')
    expect(report.advice.join('\n')).toContain('自定义代理地址无效')
  })
})
