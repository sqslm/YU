import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProviderSettings } from '@shared/types'
import { MIN_COMPRESS_BYTES, asWav, resetFfmpegProbe, toOggOpus } from './transcode'
import { resetAsrRuntime, transcribe } from '../providers/asr'
import { SAMPLE_RATE, encodeWav } from './wav'

/** Absolute path of the ffmpeg the machine happens to have, if any. */
const FFMPEG = process.env.TYPELESS_FFMPEG_TEST_BIN || 'ffmpeg'

function sineWav(seconds: number, frequency = 220): Uint8Array {
  const samples = Math.round(SAMPLE_RATE * seconds)
  const pcm = new Int16Array(samples)
  for (let i = 0; i < samples; i += 1) {
    pcm[i] = Math.round(Math.sin((2 * Math.PI * frequency * i) / SAMPLE_RATE) * 8000)
  }
  return encodeWav(pcm)
}

const saved = new Map<string, string | undefined>()

beforeEach(() => {
  for (const key of ['TYPELESS_FFMPEG', 'TYPELESS_ASR_UPLOAD', 'TYPELESS_ASR_WARMUP', 'TYPELESS_ASR_LOG']) {
    saved.set(key, process.env[key])
    delete process.env[key]
  }
  // No keep-alive probe and no perf spam: the capture must contain exactly the
  // one request under test.
  process.env.TYPELESS_ASR_WARMUP = 'off'
  process.env.TYPELESS_ASR_LOG = 'off'
  resetFfmpegProbe()
})

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  saved.clear()
  resetFfmpegProbe()
  resetAsrRuntime()
})

describe('toOggOpus', () => {
  it('refuses to spend a process on a clip that is already tiny', async () => {
    const outcome = await toOggOpus(new Uint8Array(1024))
    expect(outcome).toEqual({ ok: false, reason: 'too-small' })
    expect(MIN_COMPRESS_BYTES).toBeGreaterThan(1024)
  })

  it('honours the opt-out switch', async () => {
    const outcome = await toOggOpus(sineWav(1), { env: { TYPELESS_ASR_UPLOAD: 'wav' } })
    expect(outcome).toEqual({ ok: false, reason: 'disabled' })
  })

  it('reports a missing binary instead of throwing', async () => {
    const outcome = await toOggOpus(sineWav(1), {
      env: { TYPELESS_FFMPEG: 'definitely-not-ffmpeg-xyz' }
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(['no-ffmpeg', 'failed']).toContain(outcome.reason)
  })

  it('encodes speech-like audio to an Ogg stream smaller than the source', async () => {
    const wav = sineWav(1.5)
    const outcome = await toOggOpus(wav, { env: { TYPELESS_FFMPEG: FFMPEG } })
    if (!outcome.ok) {
      // A machine without ffmpeg must still pass: the fallback is the contract.
      expect(['no-ffmpeg', 'failed']).toContain(outcome.reason)
      return
    }
    expect(outcome.audio.contentType).toBe('audio/ogg')
    expect(outcome.audio.filename).toBe('audio.ogg')
    // "OggS" magic.
    expect(Array.from(outcome.audio.data.subarray(0, 4))).toEqual([0x4f, 0x67, 0x67, 0x53])
    expect(outcome.audio.data.byteLength).toBeLessThan(outcome.bytesBefore)
  })
})

describe('asWav', () => {
  it('passes the original bytes through untouched', () => {
    const wav = sineWav(0.2)
    const encoded = asWav(wav)
    expect(encoded.contentType).toBe('audio/wav')
    expect(encoded.data.byteLength).toBe(wav.byteLength)
    expect(encoded.data).toBe(wav)
  })
})

describe('transcribe with the opus path enabled', () => {
  it('uploads an ogg file when the encoder is available', async () => {
    const server = await captureServer()
    try {
      await transcribe(settings(server.baseUrl, 'opus'), { wav: sineWav(2) })
      const capture = server.captured[0]
      expect(capture).toBeDefined()
      if (capture?.filename === 'audio.ogg') {
        expect(capture.head).toContain('audio/ogg')
        expect(Array.from(capture.fileBytes.subarray(0, 4))).toEqual([0x4f, 0x67, 0x67, 0x53])
      } else {
        // No encoder on this host: the WAV fallback must still be a valid upload.
        expect(capture?.filename).toBe('audio.wav')
      }
    } finally {
      await server.close()
    }
  })

  it('uploads plain WAV unless the user opted in', async () => {
    const server = await captureServer()
    try {
      // No setting and no env: the safe default. Self-hosted gateways commonly
      // reject Ogg, and a rejected take is far worse than a larger upload.
      await transcribe(settings(server.baseUrl), { wav: sineWav(2) })
      expect(server.captured[0]?.filename).toBe('audio.wav')
    } finally {
      await server.close()
    }
  })

  it('retries the same take as WAV when the server rejects ogg', async () => {
    const server = await captureServer((capture, res, index) => {
      if (index === 0) {
        res.writeHead(415, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unsupported audio codec' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ text: '回退成功' }))
    })
    try {
      const logs: string[] = []
      const out = await transcribe(settings(server.baseUrl, 'opus'), {
        wav: sineWav(2),
        log: (line) => logs.push(line),
        encoded: { data: new Uint8Array(1024), contentType: 'audio/ogg' }
      })
      expect(out.text).toBe('回退成功')
      expect(server.captured.map((item) => item.filename)).toEqual(['audio.ogg', 'audio.wav'])
      expect(logs.some((line) => line.includes('opus rejected') && line.includes('415'))).toBe(true)
    } finally {
      await server.close()
    }
  })
})

interface Capture {
  head: string
  filename: string
  fileBytes: Buffer
}

async function captureServer(
  respond?: (capture: Capture, res: http.ServerResponse, index: number) => void
): Promise<{
  baseUrl: string
  captured: Capture[]
  close: () => Promise<void>
}> {
  const captured: Capture[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      const text = raw.toString('latin1')
      const marker = text.indexOf('\r\n\r\n')
      const head = marker >= 0 ? text.slice(0, marker) : text
      const name = /filename="([^"]+)"/.exec(head)?.[1] ?? ''
      const bodyStart = marker + 4
      const tail = text.lastIndexOf('\r\n--')
      const capture: Capture = {
        head,
        filename: name,
        fileBytes: raw.subarray(bodyStart, tail > bodyStart ? tail : raw.length)
      }
      const index = captured.length
      captured.push(capture)
      if (respond) {
        respond(capture, res, index)
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ text: 'ok' }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    captured,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
  }
}

function settings(baseUrl: string, upload?: 'wav' | 'opus'): ProviderSettings {
  const base = { baseUrl, apiKey: '', model: 'whisper-1' } as ProviderSettings
  return upload ? ({ ...base, upload } as ProviderSettings) : base
}
