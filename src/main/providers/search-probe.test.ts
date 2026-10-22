import { afterEach, describe, expect, it, vi } from 'vitest'
import { probeSearch } from './search-probe'

afterEach(() => vi.restoreAllMocks())
describe('individual search connection test', () => {
  it('uses the supplied key and endpoint for one real-sized request without fallback or persistence', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ results: [{ title: 'one', url: 'https://one.test', content: 'test' }] })))
    const input = { provider: 'tavily' as const, apiKey: 'draft-key', endpoint: 'http://127.0.0.1:8787/search' }
    const before = structuredClone(input)
    const result = await probeSearch(input)
    expect(result).toMatchObject({ ok: true, count: 1 })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][0]).toBe(input.endpoint)
    expect(fetch.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer draft-key' })
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ max_results: 1 })
    expect(input).toEqual(before)
  })
  it('reports quota failure without trying another provider', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('exhausted', { status: 432 }))
    expect(await probeSearch({ provider: 'tavily', apiKey: 'bad-key', endpoint: '' })).toMatchObject({ ok: false, message: 'Tavily HTTP 432' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('distinguishes an empty successful response from an invalid credential or unsupported provider', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"results":[]}'))
    expect(await probeSearch({ provider: 'tavily', apiKey: 'key', endpoint: '' })).toMatchObject({ ok: true, count: 0 })
    expect(await probeSearch({ provider: 'tavily', apiKey: '', endpoint: '' })).toMatchObject({ ok: false })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
