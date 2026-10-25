import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import {
  EVERYTHING_DEFAULT_PORT, EVERYTHING_TIMEOUT_MS, esCandidates, everythingPort, everythingUrl,
  isLoopbackHost, normalizeEverythingJson, searchEverything, type ChildLike, type EverythingOptions
} from './everything'

/** Just the parts of `Response` this module reads. */
const reply = (body: unknown, init: { status?: number; url?: string } = {}): Response => ({
  ok: (init.status ?? 200) < 400,
  status: init.status ?? 200,
  url: init.url ?? '',
  text: async () => typeof body === 'string' ? body : JSON.stringify(body)
}) as unknown as Response

const never = (): Promise<Response> => new Promise<Response>(() => {})

interface FakeChild extends EventEmitter {
  stdout: EventEmitter & { setEncoding: (encoding: string) => void }
  stderr: EventEmitter & { setEncoding: (encoding: string) => void }
}

const child = (lines: string[], code: number | null = 0, stderr = ''): FakeChild => {
  const fake = new EventEmitter() as FakeChild
  fake.stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} })
  fake.stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} })
  queueMicrotask(() => {
    if (stderr) fake.stderr.emit('data', stderr)
    for (const line of lines) fake.stdout.emit('data', `${line}\r\n`)
    fake.emit('close', code)
  })
  return fake
}

const spawner = (lines: string[], code: number | null = 0) =>
  vi.fn((_command: string, _args: string[], _options?: { windowsHide: boolean; signal?: AbortSignal }): ChildLike => child(lines, code) as unknown as ChildLike)

const page = (results: unknown[], total?: number): Response => reply({ totalResults: total ?? results.length, results })

describe('the one address this module may call', () => {
  it('builds the documented URL on loopback with an encoded query', () => {
    const url = everythingUrl('季度 报告', 80, 20)
    expect(url).toBe(`http://127.0.0.1:80/?search=${encodeURIComponent('季度 报告')}&json=1&path_column=1&count=20`)
    expect(url).toContain('%20')
    expect(url).not.toContain('+')
  })
  it('follows the configured port and clamps the count', () => {
    expect(everythingUrl('a', 8080, 999)).toContain('http://127.0.0.1:8080/')
    expect(everythingUrl('a', 8080, 999)).toContain('count=50')
    expect(everythingUrl('a', 'nonsense', 0)).toContain(`http://127.0.0.1:${EVERYTHING_DEFAULT_PORT}/`)
    expect(everythingPort(65_536)).toBe(EVERYTHING_DEFAULT_PORT)
    expect(everythingPort(0)).toBe(EVERYTHING_DEFAULT_PORT)
  })
  it('accepts only loopback hostnames', () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]', 'LOCALHOST']) expect(isLoopbackHost(host)).toBe(true)
    for (const host of ['example.com', '192.168.1.10', '127.0.0.1.evil.tld', '0.0.0.0', '']) expect(isLoopbackHost(host)).toBe(false)
  })
})

describe('field normalisation', () => {
  it('joins the folder column with the name and converts Everything FILETIME', () => {
    const hits = normalizeEverythingJson({
      results: [{ name: '预算.xlsx', path: 'C:\\Users\\me\\Documents', size: 2048, date_modified: '133000000000000000' }]
    }, 20)
    expect(hits).toEqual([{
      name: '预算.xlsx',
      path: join('C:\\Users\\me\\Documents', '预算.xlsx'),
      size: 2048,
      modifiedAt: new Date(1_655_526_400_000).toISOString()
    }])
  })
  it('keeps the whole path when the backend puts it in name', () => {
    const hits = normalizeEverythingJson({ results: [{ name: 'C:\\temp\\a.txt' }] }, 20)
    expect(hits[0]).toMatchObject({ name: 'a.txt', path: 'C:\\temp\\a.txt', size: 0, modifiedAt: '' })
  })
  it('ignores junk rows and honours the page size', () => {
    expect(normalizeEverythingJson(null, 5)).toEqual([])
    expect(normalizeEverythingJson({ results: 'nope' }, 5)).toEqual([])
    expect(normalizeEverythingJson({ results: [null, {}, { name: 'a' }] }, 5)).toHaveLength(1)
    expect(normalizeEverythingJson({ results: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }, 2)).toHaveLength(2)
  })
})

describe('tier 1: the HTTP service', () => {
  it('returns the hits with the reported total', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request) => page([{ name: 'a.txt', path: 'C:\\x', size: '7' }], 40))
    const result = await searchEverything('a', { fetchImpl })
    expect(result).toMatchObject({ available: true, backend: 'http', query: 'a', total: 40, truncated: true, reason: '' })
    expect(result.hits[0]).toMatchObject({ name: 'a.txt', size: 7 })
    expect(fetchImpl.mock.calls[0]?.[0]).toContain('json=1')
  })
  it('refuses to follow a bounce off loopback', async () => {
    const fetchImpl = vi.fn(async () => reply({ results: [{ name: 'a' }] }, { url: 'http://192.168.0.9/steal' }))
    const result = await searchEverything('a', { fetchImpl, fileExists: () => false, pathValue: '', env: {} })
    expect(result.available).toBe(false)
    expect(result.backend).toBe('none')
    expect(result.reason).toContain('无法连接 Everything 查询接口')
  })
  it('degrades when the service answers an error or HTML', async () => {
    for (const fetchImpl of [
      vi.fn(async () => reply('boom', { status: 500 })),
      vi.fn(async () => reply('<html>not json</html>'))
    ]) {
      const result = await searchEverything('a', { fetchImpl, fileExists: () => false, pathValue: '', env: {} })
      expect(result.available).toBe(false)
      expect(result.backend).toBe('none')
    }
  })
  it('gives up inside the connect budget so the caller is never stalled', async () => {
    const started = Date.now()
    const result = await searchEverything('a', { fetchImpl: never, timeoutMs: 20, fileExists: () => false, pathValue: '', env: {} })
    expect(result.available).toBe(false)
    expect(Date.now() - started).toBeLessThan(EVERYTHING_TIMEOUT_MS)
    expect(result.reason).toContain('毫秒内没有响应')
  })
})

describe('tier 2: es.exe', () => {
  const cli: EverythingOptions = { pathValue: 'C:\\Tools', env: {}, fileExists: path => path === join('C:\\Tools', 'es.exe') }

  it('finds es.exe on PATH and runs it without a shell', async () => {
    const spawnImpl = spawner(['C:\\Users\\me\\Documents\\预算.xlsx'])
    const result = await searchEverything('预算', {
      ...cli, fetchImpl: vi.fn(async () => { throw new Error('ECONNREFUSED') }), spawnImpl,
      statImpl: async () => ({ size: 4096, mtimeMs: 1_700_000_000_000 })
    })
    expect(result).toMatchObject({ available: true, backend: 'cli', total: 1, reason: '' })
    expect(result.hits[0]).toMatchObject({ name: '预算.xlsx', size: 4096, modifiedAt: '2023-11-14T22:13:20.000Z' })
    expect(spawnImpl).toHaveBeenCalledExactlyOnceWith(join('C:\\Tools', 'es.exe'), ['-n', '20', '预算'], expect.objectContaining({ windowsHide: true }))
  })
  it('still reports a hit whose file vanished since indexing', async () => {
    const result = await searchEverything('gone', {
      ...cli, fetchImpl: async () => { throw new Error('off') }, spawnImpl: spawner(['C:\\x\\gone.txt']),
      statImpl: async () => { throw new Error('ENOENT') }
    })
    expect(result.hits[0]).toMatchObject({ name: 'gone.txt', size: 0, modifiedAt: '' })
  })
  it('reports unavailable when es.exe is missing or fails', async () => {
    const missing = await searchEverything('a', { ...cli, fileExists: () => false, fetchImpl: async () => { throw new Error('off') } })
    expect(missing).toMatchObject({ available: false, backend: 'none', hits: [] })
    expect(missing.reason).toContain('es.exe')
    const failed = await searchEverything('a', { ...cli, fetchImpl: async () => { throw new Error('off') }, spawnImpl: spawner([], 1) })
    expect(failed.available).toBe(false)
    expect(failed.reason).toContain('es.exe')
  })
  it('lists candidates from PATH and the usual install folders without duplicates', () => {
    const list = esCandidates({
      pathValue: '"C:\\Tools";C:\\Tools;',
      env: { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' }
    })
    expect(list).toEqual([
      join('C:\\Tools', 'es.exe'),
      join('C:\\Program Files', 'Everything', 'es.exe'),
      join('C:\\Program Files (x86)', 'Everything', 'es.exe')
    ])
  })
})

describe('tier 3: honest absence', () => {
  it('skips tier 1 entirely when the service is switched off', async () => {
    const fetchImpl = vi.fn(async () => page([]))
    const result = await searchEverything('a', { http: false, fetchImpl, fileExists: () => false, pathValue: '', env: {} })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(result.available).toBe(false)
    expect(result.reason).toContain('已按设置关闭')
  })
  it('reports an unavailable query interface without claiming fallback already ran', async () => {
    const result = await searchEverything('a', { fetchImpl: async () => { throw new Error('off') }, fileExists: () => false, pathValue: '', env: {} })
    expect(result).toEqual({
      available: false, backend: 'none', query: 'a', hits: [], total: 0, truncated: false,
      reason: expect.stringContaining('无法连接 Everything 查询接口')
    })
    expect(result.reason).not.toContain('已改用')
  })
  it('refuses an empty query without touching the network', async () => {
    const fetchImpl = vi.fn(async () => page([]))
    const result = await searchEverything('  ', { fetchImpl })
    expect(result.available).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it('propagates a caller cancellation instead of retrying the next tier', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(searchEverything('a', {
      signal: controller.signal, fetchImpl: async () => { throw new Error('aborted') }, fileExists: () => false, pathValue: '', env: {}
    })).rejects.toThrow()
  })
})

/** Nothing installed anywhere: the three tier-1 outcomes are what is under test. */
const noEverything: EverythingOptions = { fileExists: () => false, pathValue: '', env: {} }

describe('degradation wording names the real cause', () => {
  it('blames the port occupant, not a firewall, when the answer is not Everything JSON', async () => {
    const html = await searchEverything('a', { ...noEverything, fetchImpl: async () => reply('<html>router login</html>') })
    expect(html.reason).toContain('不是 Everything 的 JSON')
    expect(html.reason).not.toContain('端口没有响应')
    const busy = await searchEverything('a', { ...noEverything, fetchImpl: async () => reply('boom', { status: 500 }) })
    expect(busy.reason).toContain('有服务在应答')
  })
  it('still says the port did not answer when the connection never opened', async () => {
    const result = await searchEverything('a', { ...noEverything, fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
    expect(result.reason).toContain('端口没有响应')
    expect(result.reason).not.toContain('不是 Everything 的 JSON')
  })
  it('separates a missing es.exe from one that failed to run', async () => {
    const missing = await searchEverything('a', { ...noEverything, fetchImpl: async () => { throw new Error('off') } })
    expect(missing.reason).toContain('没有找到 es.exe')
    const installed: EverythingOptions = {
      pathValue: 'C:\\Tools', env: {}, fileExists: path => path === join('C:\\Tools', 'es.exe'),
      fetchImpl: async () => { throw new Error('off') }, spawnImpl: spawner([], 1)
    }
    const failed = await searchEverything('a', installed)
    expect(failed.reason).toContain('es.exe 运行失败')
    expect(failed.reason).not.toContain('没有找到 es.exe')
  })
})

/** A body that arrives row by row and then stalls, so only a deadline ends it. */
const streamed = (chunks: string[]): Response => {
  let index = 0
  return {
    ok: true,
    status: 200,
    url: '',
    body: {
      getReader: () => ({
        read: async (): Promise<{ done: boolean; value?: Uint8Array }> => index < chunks.length
          ? { done: false, value: new TextEncoder().encode(chunks[index++]) }
          : new Promise<{ done: boolean; value?: Uint8Array }>(() => {})
      })
    }
  } as unknown as Response
}

/** Cuts the stream mid-line, exactly like a real timeout does. */
const stalledSpawner = (text: string) => vi.fn((): ChildLike => {
  const fake = new EventEmitter() as FakeChild
  fake.stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} })
  fake.stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} })
  queueMicrotask(() => fake.stdout.emit('data', text))
  return fake as unknown as ChildLike
})

describe('a deadline keeps the rows that already arrived', () => {
  it('answers with the rows a slow HTTP service managed to send', async () => {
    const started = Date.now()
    const result = await searchEverything('a', {
      ...noEverything,
      timeoutMs: 40,
      fetchImpl: async () => streamed([
        '{"totalResults":9,"results":[{"name":"first.txt","path":"C:\\\\x"}',
        ',{"name":"second.txt","path":"C:\\\\x"},'
      ])
    })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(result).toMatchObject({ available: true, backend: 'http', truncated: true, failure: 'timeout' })
    expect(result.hits.map(hit => hit.name)).toEqual(['first.txt', 'second.txt'])
    expect(result.reason).toContain('只拿到 2 条')
  })
  it('answers with the paths es.exe printed before the deadline', async () => {
    const result = await searchEverything('a', {
      pathValue: 'C:\\Tools',
      env: {},
      fileExists: path => path === join('C:\\Tools', 'es.exe'),
      fetchImpl: async () => { throw new Error('off') },
      cliTimeoutMs: 30,
      spawnImpl: stalledSpawner('C:\\x\\one.txt\r\nC:\\x\\two.txt\r\nC:\\x\\three'),
      statImpl: async () => ({ size: 3, mtimeMs: 0 })
    })
    expect(result).toMatchObject({ available: true, backend: 'cli', truncated: true, failure: 'timeout' })
    // The cut last line is not a path yet, so it must not become a hit.
    expect(result.hits.map(hit => hit.name)).toEqual(['one.txt', 'two.txt'])
  })
  it('stays unavailable when the deadline caught nothing at all', async () => {
    const result = await searchEverything('a', { ...noEverything, timeoutMs: 20, fetchImpl: never })
    expect(result.available).toBe(false)
    expect(result.truncated).toBe(false)
    expect(result.failure).toBeUndefined()
  })
})
