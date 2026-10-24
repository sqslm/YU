import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mergeSettings } from '@shared/defaults'
import type { SearchConnection } from '@shared/types'
import { searchWeb, searchDeadlineMs } from './search'

const servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))) })

async function backend(status: number, suffix: string, delayMs = 0) {
  const requests: Array<{ auth: string | undefined; body: Record<string, unknown> }> = []
  const server = createServer(async (req, res) => {
    let text = ''; for await (const part of req) text += part
    requests.push({ auth: req.headers.authorization, body: JSON.parse(text) })
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs))
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(status === 200 ? { results: [
      { title: suffix, url: `https://${suffix}.example/story`, content: suffix },
      { title: 'Shared report', url: 'https://shared.example/story', content: 'same source' }
    ] } : { detail: 'unavailable' }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server)
  return { requests, endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}` }
}
const connection = (id: string, endpoint: string, apiKey: string): SearchConnection => ({ id, name: id, provider: 'tavily', enabled: true, endpoint, apiKey, maxResults: 2 })

describe('saved search connections', () => {
  it('keeps a bounded full deadline for each sequential backup', () => {
    const cfg = mergeSettings({}).search
    cfg.strategy = 'fallback'; cfg.connections = Array.from({ length: 8 }, (_, index) => connection(String(index), '', 'key'))
    expect(searchDeadlineMs(cfg)).toBe(24000)
    cfg.strategy = 'aggregate'; expect(searchDeadlineMs(cfg)).toBe(8000)
  })
  it('tries a healthy backup after a stalled primary uses its own deadline', async () => {
    vi.useFakeTimers()
    const started = Date.now(), times: number[] = []
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init: RequestInit) => {
      times.push(Date.now() - started)
      if (times.length === 1) return new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
      return Promise.resolve(new Response(JSON.stringify({ results: [{ title: 'Backup result', url: 'https://example.com/backup', content: 'Actual backup' }] })))
    }))
    try {
      const cfg = mergeSettings({}).search
      cfg.strategy = 'fallback'; cfg.connections = [connection('one', 'https://example.com/one', 'one'), connection('two', 'https://example.com/two', 'two'), connection('three', 'https://example.com/three', 'three')]
      const result = searchWeb(cfg, 'test')
      await vi.advanceTimersByTimeAsync(8001)
      expect((await result)[0].title).toBe('Backup result')
      expect(times).toEqual([0, 8000])
    } finally { vi.useRealTimers(); vi.unstubAllGlobals() }
  })
  it('does not divide a healthy primary request deadline by the number of backup accounts', async () => {
    const first = await backend(200, 'primary', 100), unused = await backend(200, 'unused')
    const cfg = mergeSettings({}).search
    cfg.strategy = 'fallback'; cfg.connections = [connection('one', first.endpoint, 'one'), connection('two', unused.endpoint, 'two'), connection('three', unused.endpoint, 'three')]
    expect(await searchWeb(cfg, 'test', undefined, { timeoutMs: 240 })).toHaveLength(2)
    expect(first.requests).toHaveLength(1); expect(unused.requests).toHaveLength(0)
  })
  it('lets the healthy backup use the time left after an immediate quota error', async () => {
    const failed = await backend(432, 'quota'), good = await backend(200, 'backup', 100), unused = await backend(200, 'unused')
    const cfg = mergeSettings({}).search
    cfg.strategy = 'fallback'; cfg.connections = [connection('one', failed.endpoint, 'one'), connection('two', good.endpoint, 'two'), connection('three', unused.endpoint, 'three')]
    expect(await searchWeb(cfg, 'test', undefined, { timeoutMs: 240 })).toHaveLength(2)
    expect(good.requests).toHaveLength(1); expect(unused.requests).toHaveLength(0)
  })
  it('fails over exhausted credentials without changing saved keys or querying the remaining healthy fallback', async () => {
    const first = await backend(432, 'first'), second = await backend(200, 'second'), unused = await backend(200, 'unused')
    const cfg = mergeSettings({}).search
    cfg.strategy = 'fallback'; cfg.connections = [connection('one', first.endpoint, 'key-one'), connection('two', second.endpoint, 'key-two'), connection('three', unused.endpoint, 'key-three')]
    const hits = await searchWeb(cfg, 'test')
    expect(hits).toHaveLength(2)
    expect(first.requests[0].auth).toBe('Bearer key-one')
    expect(second.requests[0].auth).toBe('Bearer key-two')
    expect(unused.requests).toHaveLength(0)
    expect(cfg.connections.map(item => item.apiKey)).toEqual(['key-one', 'key-two', 'key-three'])
  })
  it('merges different connections and removes duplicate pages without a global page-size cutoff', async () => {
    const one = await backend(200, 'cedar'), two = await backend(200, 'maple')
    const cfg = mergeSettings({}).search
    cfg.strategy = 'aggregate'; cfg.maxResults = 1; cfg.connections = [connection('one', one.endpoint, 'one'), connection('two', two.endpoint, 'two')]
    const hits = await searchWeb(cfg, 'test')
    expect(hits).toHaveLength(3)
    expect(one.requests[0].body.max_results).toBe(2)
    expect(two.requests[0].body.max_results).toBe(2)
    await searchWeb(cfg, 'news', undefined, { maxResults: 10 })
    expect(one.requests[1].body.max_results).toBe(10)
  })
  it('does not shorten parallel healthy connections merely because another source is queued', async () => {
    const one = await backend(200, 'cedar', 100), two = await backend(200, 'maple', 100), three = await backend(200, 'pine')
    const cfg = mergeSettings({}).search
    cfg.strategy = 'aggregate'; cfg.connections = [connection('one', one.endpoint, 'one'), connection('two', two.endpoint, 'two'), connection('three', three.endpoint, 'three')]
    const hits = await searchWeb(cfg, 'test', undefined, { timeoutMs: 180 })
    expect(hits.map(hit => hit.title)).toEqual(expect.arrayContaining(['cedar', 'maple', 'pine']))
    expect(hits.filter(hit => hit.url === 'https://shared.example/story')).toHaveLength(1)
    expect(one.requests[0].auth).toBe('Bearer one'); expect(two.requests[0].auth).toBe('Bearer two')
  })
  it('retains completed aggregate results if another source reaches the overall deadline', async () => {
    const good = await backend(200, 'good'), slow = await backend(200, 'slow', 200)
    const cfg = mergeSettings({}).search
    cfg.strategy = 'aggregate'; cfg.connections = [connection('good', good.endpoint, 'one'), connection('slow', slow.endpoint, 'two')]
    const hits = await searchWeb(cfg, 'test', undefined, { timeoutMs: 60 })
    expect(hits.map(hit => hit.title)).toContain('good')
    expect(hits.map(hit => hit.title)).not.toContain('slow')
  })
  it('reports all failed aggregate connections rather than presenting an empty success', async () => {
    const one = await backend(432, 'quota'), two = await backend(503, 'unavailable')
    const cfg = mergeSettings({}).search
    cfg.strategy = 'aggregate'; cfg.connections = [connection('quota', one.endpoint, 'one'), connection('offline', two.endpoint, 'two')]
    await expect(searchWeb(cfg, 'test')).rejects.toThrow(/quota.*offline/)
  })
  it('cancels active aggregate requests without returning partial results as a completed search', async () => {
    const slow = await backend(200, 'slow', 200)
    const cfg = mergeSettings({}).search
    cfg.strategy = 'aggregate'; cfg.connections = [connection('one', slow.endpoint, 'one'), connection('two', slow.endpoint, 'two')]
    const controller = new AbortController()
    const result = searchWeb(cfg, 'test', controller.signal)
    const assertion = expect(result).rejects.toThrow('取消')
    await vi.waitFor(() => expect(slow.requests).toHaveLength(2))
    controller.abort(); await assertion
  })
  it('retains healthy results when another connection fails and skips disabled connections', async () => {
    const failed = await backend(503, 'failed'), good = await backend(200, 'good'), disabled = await backend(200, 'disabled')
    const cfg = mergeSettings({}).search
    cfg.strategy = 'aggregate'; cfg.connections = [connection('failed', failed.endpoint, 'a'), connection('good', good.endpoint, 'b'), { ...connection('disabled', disabled.endpoint, 'c'), enabled: false }]
    expect(await searchWeb(cfg, 'test')).toHaveLength(2)
    expect(disabled.requests).toHaveLength(0)
  })
  it('reports an empty active pool and honours cancellation before starting a request', async () => {
    const cfg = mergeSettings({}).search; cfg.strategy = 'fallback'; cfg.connections = []
    await expect(searchWeb(cfg, 'test')).rejects.toThrow('没有启用的搜索连接')
    const server = await backend(200, 'unused'); cfg.connections = [connection('one', server.endpoint, 'key')]
    const controller = new AbortController(); controller.abort()
    await expect(searchWeb(cfg, 'test', controller.signal)).rejects.toThrow('取消')
    expect(server.requests).toHaveLength(0)
  })
})
