import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { mergeSettings } from '@shared/defaults'
import type { SearchConnection } from '@shared/types'
import { searchWeb } from './search'

const servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))) })

async function backend(status: number, suffix: string) {
  const requests: Array<{ auth: string | undefined; body: Record<string, unknown> }> = []
  const server = createServer(async (req, res) => {
    let text = ''; for await (const part of req) text += part
    requests.push({ auth: req.headers.authorization, body: JSON.parse(text) })
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
