import { afterEach, expect, it, vi } from 'vitest'
import { probeConnection, probeMultimodalConnection } from './connection-probe'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it.each([
  { run: probeConnection, timeout: 8000 },
  { run: probeMultimodalConnection, timeout: 12000 }
])('ends a connection test when headers arrive but the body stalls ($timeout ms)', async ({ run, timeout }) => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => ({
    ok: true, status: 200,
    text: () => new Promise<string>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('request aborted')), { once: true })
    })
  })))
  let result: unknown
  void run({ baseUrl: 'https://gw/v1', apiKey: 'test-only', model: 'model' }).then(value => { result = value })
  await vi.advanceTimersByTimeAsync(timeout + 1)
  expect(result).toMatchObject({ ok: false })
  expect(result).toMatchObject({ message: expect.stringContaining('超时') })
})

it('retains the model-list request headers and HTTP verdict', async () => {
  const fetchMock = vi.fn(async () => new Response('denied', { status: 401 }))
  vi.stubGlobal('fetch', fetchMock)
  expect(await probeConnection({ baseUrl: 'https://gw/v1/', apiKey: 'test-only', extraHeaders: 'X-Org: workspace' })).toMatchObject({ ok: false, status: 401 })
  expect(fetchMock).toHaveBeenCalledWith('https://gw/v1/models', expect.objectContaining({ headers: { Authorization: 'Bearer test-only', 'X-Org': 'workspace' } }))
})
