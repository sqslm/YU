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
    expect(result.reason).toContain('这台机器没有 Everything')
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
  it('says the machine has no Everything so the caller can fall back', async () => {
    const result = await searchEverything('a', { fetchImpl: async () => { throw new Error('off') }, fileExists: () => false, pathValue: '', env: {} })
    expect(result).toEqual({
      available: false, backend: 'none', query: 'a', hits: [], total: 0, truncated: false,
      reason: expect.stringContaining('已改用内置文件搜索')
    })
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
