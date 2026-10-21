import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProviderSettings } from '@shared/types'
import { ProviderError, joinUrl, parseHeaderLines, resetAsrRuntime, transcribe } from './asr'
import { SAMPLE_RATE, encodeWav } from '../audio/wav'

// ---------------------------------------------------------------------------
// A tiny OpenAI-compatible stand-in so the wire format and the pool behaviour
// are asserted against a real socket instead of a mocked fetch.
// ---------------------------------------------------------------------------

interface Captured {
  path: string
  headers: http.IncomingHttpHeaders
  body: Buffer
  fields: Record<string, string>
  file: Buffer | null
  fileBytes: number
  connection: number
}

function parseMultipart(body: Buffer, contentType: string | undefined): { fields: Record<string, string>; file: Buffer | null } {
  const match = /boundary=(.+)$/.exec(contentType ?? '')
  if (!match) return { fields: {}, file: null }
  const boundary = Buffer.from(`--${match[1]}`)
  const fields: Record<string, string> = {}
  let file: Buffer | null = null
  let index = body.indexOf(boundary)
  while (index >= 0) {
    const next = body.indexOf(boundary, index + boundary.length)
    if (next < 0) break
    const part = body.subarray(index + boundary.length + 2, next - 2) // strip CRLFs
    const split = part.indexOf('\r\n\r\n')
    if (split > 0) {
      const head = part.subarray(0, split).toString('utf8')
      const data = part.subarray(split + 4)
      const name = /name="([^"]+)"/.exec(head)?.[1] ?? ''
      if (/filename="[^"]*"/.test(head)) file = data
      else fields[name] = data.toString('utf8')
    }
    index = next
  }
  return { fields, file }
}

type Responder = (captured: Captured, res: http.ServerResponse, socket: import('node:net').Socket) => void

async function startServer(respond: Responder): Promise<{
  baseUrl: string
  captured: Captured[]
  connections: () => number
  close: () => Promise<void>
}> {
  const captured: Captured[] = []
  const sockets = new Set<import('node:net').Socket>()
  let connectionCount = 0
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const parsed = parseMultipart(body, req.headers['content-type'])
      const item: Captured = {
        path: req.url ?? '',
        headers: req.headers,
        body,
        fields: parsed.fields,
        file: parsed.file,
        fileBytes: parsed.file?.byteLength ?? 0,
        connection: connectionCount
      }
      captured.push(item)
      respond(item, res, req.socket)
    })
  })
  server.on('connection', (socket: import('node:net').Socket) => {
    connectionCount++
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    captured,
    connections: () => connectionCount,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

function json(res: http.ServerResponse, payload: unknown, status = 200): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function speech(seconds = 0.5): Int16Array {
  const pcm = new Int16Array(Math.round(seconds * SAMPLE_RATE))
  pcm.fill(9000)
  return pcm
}

function settings(baseUrl: string): ProviderSettings {
  return { baseUrl, apiKey: 'local', model: 'test-model' }
}

const TOUCHED_ENV = [
  'TYPELESS_ASR_WARMUP',
  'TYPELESS_ASR_WARM_INTERVAL_MS',
  'TYPELESS_ASR_TIMEOUT_MS',
  'TYPELESS_ASR_TRIM',
  'TYPELESS_ASR_LOG',
  'TYPELESS_ASR_UPLOAD'
] as const
const savedEnv = new Map<string, string | undefined>()

beforeEach(() => {
  for (const key of TOUCHED_ENV) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
  process.env.TYPELESS_ASR_WARMUP = 'off'
  process.env.TYPELESS_ASR_LOG = 'off'
  // These cases are about the wire shape and the socket pool, so they pin the
  // upload to the source bytes. `asrOpus.test.ts` covers the compressed path.
  process.env.TYPELESS_ASR_UPLOAD = 'wav'
  resetAsrRuntime()
})

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  savedEnv.clear()
  resetAsrRuntime()
})

// ---------------------------------------------------------------------------

describe('url + header helpers (imported by llm.ts)', () => {
  it('joins base urls without duplicating slashes', () => {
    expect(joinUrl('http://127.0.0.1:9931/v1', 'audio/transcriptions')).toBe(
      'http://127.0.0.1:9931/v1/audio/transcriptions'
    )
    expect(joinUrl('http://host/v1/', '/audio/transcriptions')).toBe('http://host/v1/audio/transcriptions')
  })

  it('parses extra header lines', () => {
    expect(parseHeaderLines('X-A: 1\nBroken\nX-B:two')).toEqual({ 'X-A': '1', 'X-B': 'two' })
    expect(parseHeaderLines(undefined)).toEqual({})
  })
})

describe('transcribe wire format', () => {
  it('honors a WAV preference even when Chromium captured a compressed copy', async () => {
    delete process.env.TYPELESS_ASR_UPLOAD
    const server = await startServer((_item, res) => json(res, { text: 'ok' }))
    try {
      await transcribe({ ...settings(server.baseUrl), upload: 'wav' } as ProviderSettings, {
        wav: encodeWav(speech()), encoded: { data: new Uint8Array(1024), contentType: 'audio/webm' }
      })
      expect(server.captured[0].body.toString('latin1')).toContain('filename="audio.wav"')
    } finally { await server.close() }
  })

  it.each([200, 415])('retries WAV when compressed audio gets an HTML response (%i)', async (status) => {
    process.env.TYPELESS_ASR_UPLOAD = 'opus'
    let requests = 0
    const server = await startServer((_item, res) => {
      if (requests++ === 0) {
        res.writeHead(status, { 'content-type': 'text/html' })
        res.end('<html>unsupported format</html>')
      } else json(res, { text: 'recovered' })
    })
    try {
      const result = await transcribe(settings(server.baseUrl), {
        wav: encodeWav(speech()), encoded: { data: new Uint8Array(1024), contentType: 'audio/webm' }
      })
      expect(result.text).toBe('recovered')
      expect(server.captured).toHaveLength(2)
      expect(server.captured[1].body.toString('latin1')).toContain('filename="audio.wav"')
    } finally { await server.close() }
  })

  it('posts one multipart wav with the cheapest response format', async () => {
    const server = await startServer((_item, res) => json(res, { text: '  你好  ' }))
    try {
      const wav = encodeWav(speech())
      const logs: string[] = []
      const out = await transcribe(settings(server.baseUrl), {
        wav,
        language: 'zh',
        log: (line) => logs.push(line)
      })

      expect(out).toEqual({ text: '你好', model: 'test-model' })
      expect(server.captured).toHaveLength(1)
      const sent = server.captured[0]
      expect(sent.path).toBe('/v1/audio/transcriptions')
      expect(sent.headers.authorization).toBe('Bearer local')
      expect(sent.headers['content-length']).toBe(String(sent.body.byteLength))
      expect(sent.headers['transfer-encoding']).toBeUndefined()
      // No `temperature`: gateways that reject unknown multipart fields (StepFun)
      // would 400 on it, and greedy decoding is already the default everywhere.
      expect(sent.fields).toEqual({ model: 'test-model', response_format: 'json', language: 'zh' })
      expect(sent.file?.equals(Buffer.from(wav))).toBe(true)

      expect(logs[0]).toMatch(
        /^\[perf\] asr bytes=\d+ ms=\d+ rtf=\d+\.\d{2} audio=\d+ms trim=\d+ms ttfb=\d+ms conn=(new|reuse) codec=audio\/wav$/
      )
    } finally {
      await server.close()
    }
  })

  it('uploads the captured opus copy without asking for ffmpeg', async () => {
    // Compression is opt-in even when Chromium already encoded this take.
    process.env.TYPELESS_ASR_UPLOAD = 'opus'
    const server = await startServer((_item, res) => json(res, { text: '你好' }))
    try {
      const wav = encodeWav(speech())
      const captured = new Uint8Array(4096).fill(7)
      const logs: string[] = []
      await transcribe(settings(server.baseUrl), {
        wav,
        encoded: { data: captured, contentType: 'audio/webm;codecs=opus' },
        log: (line) => logs.push(line)
      })
      // Prefer the captured copy without an ffmpeg probe or a second encode.
      expect(server.captured[0].file?.equals(Buffer.from(captured))).toBe(true)
      expect(logs.some((line) => line.includes('captured opus'))).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('honours a custom request path (Azure-style deployments)', async () => {
    const server = await startServer((_item, res) => json(res, { text: 'ok' }))
    try {
      const wav = encodeWav(speech())
      await transcribe(
        {
          ...settings(server.baseUrl),
          requestPath: '/openai/deployments/whisper/audio/transcriptions'
        },
        { wav }
      )
      // A hard-coded path would silently post to the wrong endpoint and 404.
      expect(server.captured[0].path).toBe('/v1/openai/deployments/whisper/audio/transcriptions')
    } finally {
      await server.close()
    }
  })

  it('trims long head/tail silence before uploading', async () => {
    const server = await startServer((_item, res) => json(res, { text: 'ok' }))
    try {
      const padded = new Int16Array(SAMPLE_RATE * 3)
      padded.set(speech(1), SAMPLE_RATE)
      const wav = encodeWav(padded)
      const logs: string[] = []
      await transcribe(settings(server.baseUrl), { wav, log: (line) => logs.push(line) })

      const sent = server.captured[0]
      expect(sent.fileBytes).toBeLessThan(wav.byteLength)
      expect(sent.fileBytes).toBe(44 + (16000 + 1920 + 3840) * 2)
      expect(logs[0]).toContain('audio=1360ms')
      expect(logs[0]).toContain('trim=1640ms')

      // The uploaded file is still a valid wav the server can decode.
      expect(sent.file?.subarray(0, 4).toString('latin1')).toBe('RIFF')
    } finally {
      await server.close()
    }
  })

  it('keeps the audio untouched when TYPELESS_ASR_TRIM=0', async () => {
    process.env.TYPELESS_ASR_TRIM = '0'
    const server = await startServer((_item, res) => json(res, { text: 'ok' }))
    try {
      const padded = new Int16Array(SAMPLE_RATE * 3)
      padded.set(speech(1), SAMPLE_RATE)
      const wav = encodeWav(padded)
      await transcribe(settings(server.baseUrl), { wav })
      expect(server.captured[0].fileBytes).toBe(wav.byteLength)
    } finally {
      await server.close()
    }
  })

  it('rejects a non-2xx response with the status and body', async () => {
    const server = await startServer((_item, res) => json(res, { error: 'model not found' }, 400))
    try {
      await expect(transcribe(settings(server.baseUrl), { wav: encodeWav(speech()) })).rejects.toMatchObject({
        name: 'ProviderError',
        message: 'ASR HTTP 400',
        status: 400,
        body: '{"error":"model not found"}'
      })
    } finally {
      await server.close()
    }
  })

  it('accepts a plain text body from servers that ignore response_format', async () => {
    const server = await startServer((_item, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(' raw text ')
    })
    try {
      const out = await transcribe(settings(server.baseUrl), { wav: encodeWav(speech()) })
      expect(out.text).toBe('raw text')
    } finally {
      await server.close()
    }
  })

  it('rejects an empty configuration', async () => {
    await expect(transcribe({ baseUrl: '', apiKey: '', model: 'm' }, { wav: encodeWav(speech()) })).rejects.toBeInstanceOf(
      ProviderError
    )
    await expect(transcribe({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: '', model: '' }, { wav: encodeWav(speech()) })).rejects.toBeInstanceOf(
      ProviderError
    )
  })
})

describe('transcribe connection reuse', () => {
  it('keeps one socket alive across takes', async () => {
    const server = await startServer((_item, res) => json(res, { text: 'hi' }))
    try {
      const cfg = settings(server.baseUrl)
      const wav = encodeWav(speech())
      await transcribe(cfg, { wav })
      await transcribe(cfg, { wav })
      await transcribe(cfg, { wav })
      expect(server.captured).toHaveLength(3)
      expect(server.connections()).toBe(1)
      expect(server.captured[2].headers.connection).toBe('keep-alive')
    } finally {
      await server.close()
    }
  })

  it('retries once on a fresh socket when the server dropped the pooled one', async () => {
    // Several local ASR shims answer and then close the connection; reusing the
    // socket then fails with ECONNRESET. The second request must still succeed.
    const server = await startServer((item, res, socket) => {
      if (server.captured.length === 2) {
        socket.destroy()
        return
      }
      json(res, { text: `take-${server.captured.length}` })
    })
    try {
      const cfg = settings(server.baseUrl)
      const wav = encodeWav(speech())
      expect((await transcribe(cfg, { wav })).text).toBe('take-1')
      expect((await transcribe(cfg, { wav })).text).toBe('take-3')
      expect(server.captured).toHaveLength(3)
    } finally {
      await server.close()
    }
  })
})

describe('transcribe timeouts and cancellation', () => {
  it('fails fast with a readable message instead of hanging', async () => {
    const server = await startServer(() => {
      /* never respond */
    })
    try {
      const started = Date.now()
      await expect(
        transcribe(settings(server.baseUrl), { wav: encodeWav(speech()), timeoutMs: 200 })
      ).rejects.toThrow('ASR timed out after 200 ms (set TYPELESS_ASR_TIMEOUT_MS to raise it)')
      expect(Date.now() - started).toBeLessThan(3000)
    } finally {
      await server.close()
    }
  })

  it('honours an external abort signal', async () => {
    const server = await startServer(() => {
      /* never respond */
    })
    try {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 50)
      await expect(
        transcribe(settings(server.baseUrl), { wav: encodeWav(speech()), signal: controller.signal })
      ).rejects.toThrow('ASR request cancelled')
    } finally {
      await server.close()
    }
  })
})

describe('keep-warm', () => {
  /** Polls the mock server so timer-driven assertions do not depend on sleeps. */
  async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!check()) {
      if (Date.now() > deadline) throw new Error('waitFor timed out')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  it('never puts a warm-up in front of a take, then keeps the model loaded while idle', async () => {
    process.env.TYPELESS_ASR_WARMUP = 'local'
    process.env.TYPELESS_ASR_WARM_INTERVAL_MS = '40'
    // A warm-up carries no language field, the take does: that is how the test
    // tells them apart and proves the warm transcript is discarded.
    const server = await startServer((item, res) => json(res, { text: item.fields.language ? 'real' : 'warm noise' }))
    try {
      const logs: string[] = []
      const out = await transcribe(settings(server.baseUrl), {
        wav: encodeWav(speech()),
        language: 'zh',
        log: (line) => logs.push(line)
      })

      // The take is sent first and alone: no round trip was spent warming.
      expect(out.text).toBe('real')
      expect(server.captured).toHaveLength(1)
      expect(server.captured[0].fields.language).toBe('zh')
      expect(logs.filter((line) => line.startsWith('[perf] asr warm'))).toHaveLength(0)

      // Only afterwards, once idle, does the resident-model request go out.
      await waitFor(() => server.captured.length === 2)
      const warmRequest = server.captured[1]
      expect(warmRequest.fileBytes).toBeLessThan(20000) // ~0.3 s of audio
      expect(warmRequest.fields.response_format).toBe('json')
      expect(warmRequest.fields.language).toBeUndefined()
      await waitFor(() => logs.some((line) => /^\[perf\] asr warm ms=\d+ model=test-model$/.test(line)))
    } finally {
      await server.close()
    }
  })

  it('a take inside the idle window pushes the warm-up back', async () => {
    process.env.TYPELESS_ASR_WARMUP = 'local'
    process.env.TYPELESS_ASR_WARM_INTERVAL_MS = '150'
    const server = await startServer((_item, res) => json(res, { text: 'x' }))
    try {
      const cfg = settings(server.baseUrl)
      await transcribe(cfg, { wav: encodeWav(speech()), language: 'zh' })
      await new Promise((resolve) => setTimeout(resolve, 60))
      await transcribe(cfg, { wav: encodeWav(speech()), language: 'zh' })
      // 60 ms of silence is inside the 150 ms window: still no warm-up request.
      expect(server.captured).toHaveLength(2)
      await waitFor(() => server.captured.length === 3)
      expect(server.captured[2].fields.language).toBeUndefined()
    } finally {
      await server.close()
    }
  })

  it('stays silent when disabled, and never on a non-local endpoint', async () => {
    process.env.TYPELESS_ASR_WARM_INTERVAL_MS = '20'
    const server = await startServer((_item, res) => json(res, { text: 'x' }))
    try {
      await transcribe(settings(server.baseUrl), { wav: encodeWav(speech()) })
      await new Promise((resolve) => setTimeout(resolve, 80))
      expect(server.captured).toHaveLength(1)
    } finally {
      await server.close()
    }
    process.env.TYPELESS_ASR_WARMUP = 'local'
    // No request can reach this host; the point is that no warm-up is attempted
    // (it would be a stray request to a machine that is not this one).
    const out = await transcribe({ baseUrl: 'http://203.0.113.9:9/v1', apiKey: '', model: 'm' }, { wav: encodeWav(speech()), timeoutMs: 150 })
      .catch((err: Error) => err)
    expect(out).toBeInstanceOf(Error)
    await new Promise((resolve) => setTimeout(resolve, 80))
  })

  it('a failed warm-up never fails a take and never logs a warm line', async () => {
    process.env.TYPELESS_ASR_WARMUP = 'local'
    process.env.TYPELESS_ASR_WARM_INTERVAL_MS = '30'
    let calls = 0
    const server = await startServer((item, res) => {
      calls += 1
      if (!item.fields.language) {
        json(res, { error: 'cold' }, 503)
        return
      }
      json(res, { text: 'survived' })
    })
    try {
      const logs: string[] = []
      const out = await transcribe(settings(server.baseUrl), {
        wav: encodeWav(speech()),
        language: 'zh',
        log: (line) => logs.push(line)
      })
      expect(out.text).toBe('survived')
      await waitFor(() => calls >= 2)
      expect(logs.some((line) => line.startsWith('[perf] asr warm'))).toBe(false)
      // The idle loop gives up instead of hammering a broken endpoint.
      await waitFor(() => calls >= 2)
    } finally {
      await server.close()
    }
  })
})
