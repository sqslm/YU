import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProviderProfile, ProviderSettings } from '@shared/types'
import { transcribe } from '../asr'
import { ASR_ADAPTERS, adapterFieldsFor, findAsrAdapter, resolveAsrAdapter, runAsrAdapter } from './index'

const base = (patch: Partial<ProviderProfile> = {}): ProviderProfile => ({
  id: 'p1',
  name: 'test',
  kind: 'asr',
  preset: '',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'key',
  model: 'whisper-1',
  enabled: true,
  ...patch
})

/** A 1 ms-per-2-bytes WAV: 44-byte header plus `ms * 32` bytes of PCM. */
function wav(ms: number): Uint8Array {
  const pcm = ms * 32
  const out = new Uint8Array(44 + pcm)
  out.set([0x52, 0x49, 0x46, 0x46], 0)
  out.set([0x57, 0x41, 0x56, 0x45], 8)
  out.fill(0x01, 44)
  return out
}

describe('adapter registry', () => {
  it('has one spec per vendor and no duplicate ids', () => {
    const ids = ASR_ADAPTERS.map((spec) => spec.id)
    expect(new Set(ids).size).toBe(ids.length)
    // The two families the presets point at.
    for (const id of ['deepgram', 'assemblyai', 'azure-openai', 'aliyun', 'tencent', 'xfyun', 'baidu']) {
      expect(ids, id).toContain(id)
    }
  })

  it('resolves by explicit adapter id first, preset second, host last', () => {
    expect(resolveAsrAdapter(base({ asrAdapter: 'deepgram' }))?.id).toBe('deepgram')
    // A preset id that differs from the adapter id still resolves.
    expect(resolveAsrAdapter(base({ preset: 'iflytek' }))?.id).toBe('xfyun')
    expect(resolveAsrAdapter(base({ preset: 'tencent-asr' }))?.id).toBe('tencent')
    // A hand-written profile with no preset: the host is the only signal left.
    expect(resolveAsrAdapter(base({ baseUrl: 'https://api.deepgram.com' }))?.id).toBe('deepgram')
    expect(resolveAsrAdapter(base({ baseUrl: 'https://RESOURCE.openai.azure.com' }))?.id).toBe('azure-openai')
  })

  it('leaves OpenAI-shaped profiles on the multipart path', () => {
    expect(resolveAsrAdapter(base())).toBeNull()
    expect(findAsrAdapter(undefined)).toBeNull()
    expect(findAsrAdapter('nope')).toBeNull()
  })

  it('merges the form fields with the adapter fields without duplicates', () => {
    const azure = adapterFieldsFor('azure-openai')
    const keys = azure.map((item) => item.key)
    // `deployment` is declared in both places; it must appear once.
    expect(keys.filter((key) => key === 'deployment')).toHaveLength(1)
    expect(keys).toEqual(expect.arrayContaining(['deployment', 'apiVersion']))
    expect(adapterFieldsFor('')).toEqual([])
  })
})

describe('runAsrAdapter', () => {
  let server: Server
  let origin = ''
  let lastRequest: { url: string; auth: string; contentType: string; bytes: number } | null = null

  beforeEach(async () => {
    lastRequest = null
    server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(chunk as Buffer))
      req.on('end', () => {
        lastRequest = {
          url: req.url ?? '',
          auth: String(req.headers.authorization ?? ''),
          contentType: String(req.headers['content-type'] ?? ''),
          bytes: Buffer.concat(chunks).length
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            results: { channels: [{ alternatives: [{ transcript: ' 你好 ' }] }] }
          })
        )
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    origin = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('derives the duration from the WAV length and passes it through', async () => {
    let seenMs = 0
    const text = await runAsrAdapter(
      {
        id: 'probe',
        label: 'probe',
        hosts: [],
        fields: [],
        run: async (_ctx, input) => {
          seenMs = input.ms
          return 'ok'
        }
      },
      base() as ProviderSettings,
      wav(1200),
      { model: '', log: () => undefined }
    )
    expect(text).toBe('ok')
    // 1200 ms of 16 kHz mono PCM16 is 1200 * 32 bytes.
    expect(seenMs).toBe(1200)
  })

  it('runs the real Deepgram spec through transcribe()', async () => {
    const cfg = base({ baseUrl: origin, asrAdapter: 'deepgram', model: 'nova-3', apiKey: 'dg-key' })
    const result = await transcribe(cfg, { wav: wav(500), log: () => undefined })
    // The adapter's own trimming is what the pipeline sees.
    expect(result.text).toBe('你好')
    expect(lastRequest?.url).toContain('/v1/listen')
    expect(lastRequest?.url).toContain('model=nova-3')
    // Not Bearer: Deepgram wants `Token`.
    expect(lastRequest?.auth).toBe('Token dg-key')
    expect(lastRequest?.contentType).toContain('audio/wav')
    expect(lastRequest?.bytes).toBe(wav(500).length)
  })

  it('surfaces the vendor sentence instead of a bare status', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'BAD_KEY: invalid credentials' }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0

    await expect(
      transcribe(
        base({ baseUrl: `http://127.0.0.1:${port}`, asrAdapter: 'deepgram', model: 'nova-3' }),
        { wav: wav(300), log: () => undefined }
      )
    ).rejects.toThrow(/BAD_KEY/)
  })
})
