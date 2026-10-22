import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { AsrAdapterContext, AsrAdapterInput, AsrAdapterSpec } from './types'
import { WEST_SPECS } from './west'

// ---------------------------------------------------------------------------
// One local stand-in per vendor, because every adapter below is defined by its
// wire shape: raw bytes vs multipart, `Token` vs `api-key`, one request vs a job
// that has to be polled. Mocking `fetch` would assert our own model of the wire
// format; talking to a real socket asserts the bytes that leave the process.
// ---------------------------------------------------------------------------

/** Bytes that are not a real WAV: the adapters forward them untouched, which is the point. */
const AUDIO = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45])

interface FormPart {
  name: string
  filename?: string
  data: Buffer
  value: string
}

interface Captured {
  method: string
  path: string
  query: URLSearchParams
  headers: http.IncomingHttpHeaders
  body: Buffer
  json: unknown
  /** Text parts of a multipart body, keyed by field name. */
  fields: Record<string, string>
  /** File part, if the request was multipart with a file. */
  file: Buffer | null
  filename: string
}

type Handler = (call: Captured, res: http.ServerResponse) => void
type Closer = () => Promise<void>

const servers: Closer[] = []

function parseMultipart(
  body: Buffer,
  contentType: string | undefined
): { fields: Record<string, string>; file: Buffer | null; filename: string; parts: FormPart[] } {
  const match = /boundary=(.+)$/.exec(contentType ?? '')
  if (!match) return { fields: {}, file: null, filename: '', parts: [] }
  const boundary = Buffer.from(`--${match[1]}`)
  const fields: Record<string, string> = {}
  const parts: FormPart[] = []
  let file: Buffer | null = null
  let filename = ''
  let index = body.indexOf(boundary)
  while (index >= 0) {
    const next = body.indexOf(boundary, index + boundary.length)
    if (next < 0) break
    const part = body.subarray(index + boundary.length + 2, next - 2)
    const split = part.indexOf('\r\n\r\n')
    if (split > 0) {
      const head = part.subarray(0, split).toString('utf8')
      const data = part.subarray(split + 4)
      const name = /name="([^"]+)"/.exec(head)?.[1] ?? ''
      const asFile = /filename="([^"]*)"/.exec(head)
      if (asFile) {
        file = data
        filename = asFile[1]
      } else {
        fields[name] = data.toString('utf8')
      }
      parts.push({ name, filename: asFile?.[1], data, value: asFile ? '' : data.toString('utf8') })
    }
    index = next
  }
  return { fields, file, filename, parts }
}

function parseJson(body: Buffer): unknown {
  try {
    return body.length > 0 ? JSON.parse(body.toString('utf8')) : null
  } catch {
    return null
  }
}

async function serve(handler: Handler): Promise<{ origin: string; calls: Captured[] }> {
  const calls: Captured[] = []
  const sockets = new Set<import('node:net').Socket>()
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const url = new URL(req.url ?? '/', 'http://placeholder')
      const parsed = parseMultipart(body, req.headers['content-type'])
      const call: Captured = {
        method: req.method ?? '',
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body,
        json: parseJson(body),
        fields: parsed.fields,
        file: parsed.file,
        filename: parsed.filename
      }
      calls.push(call)
      handler(call, res)
    })
  })
  server.on('connection', (socket: import('node:net').Socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  servers.push(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return { origin: `http://127.0.0.1:${port}`, calls }
}

afterEach(async () => {
  while (servers.length > 0) {
    const close = servers.pop()
    if (close) await close()
  }
})

function json(res: http.ServerResponse, payload: unknown, status = 200): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function text(res: http.ServerResponse, payload: string, status = 200): void {
  res.writeHead(status, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

interface ContextOptions {
  baseUrl: string
  apiKey?: string
  fields?: Record<string, string>
  extraHeaders?: string
  signal?: AbortSignal
  logs?: string[]
}

function context(options: ContextOptions): AsrAdapterContext {
  const logs = options.logs ?? []
  return {
    baseUrl: options.baseUrl,
    apiKey: options.apiKey ?? 'test-key',
    extraHeaders: options.extraHeaders,
    signal: options.signal ?? new AbortController().signal,
    log: (line) => logs.push(line),
    fields: options.fields ?? {}
  }
}

function input(overrides: Partial<AsrAdapterInput> = {}): AsrAdapterInput {
  return { wav: AUDIO, ms: 1_000, model: '', language: '', mime: 'audio/wav', ...overrides }
}

function spec(id: string): AsrAdapterSpec {
  const found = WEST_SPECS.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`no adapter spec for ${id}`)
  return found
}

/** Runs an adapter and returns the thrown error, so a test can assert on its message. */
async function failure(run: Promise<string>): Promise<Error> {
  const error = await run.then(
    (value) => new Error(`expected a failure, got ${JSON.stringify(value)}`),
    (reason: Error) => reason
  )
  return error
}

// ---------------------------------------------------------------------------

describe('west spec catalogue', () => {
  it('lists every vendor exactly once with a label, hosts and a run function', () => {
    expect(WEST_SPECS.map((entry) => entry.id)).toEqual([
      'deepgram',
      'assemblyai',
      'elevenlabs',
      'gladia',
      'speechmatics',
      'revai',
      'azure-openai',
      'cohere',
      'minimax',
      'replicate',
      'fal',
      'deepinfra',
      'openrouter'
    ])
    for (const entry of WEST_SPECS) {
      expect(entry.label.length).toBeGreaterThan(0)
      expect(entry.hosts.length).toBeGreaterThan(0)
      expect(typeof entry.run).toBe('function')
      expect(Array.isArray(entry.fields)).toBe(true)
    }
    // Only Azure needs vendor fields; the rest are key-and-go.
    expect(WEST_SPECS.filter((entry) => entry.fields.length > 0).map((entry) => entry.id)).toEqual([
      'azure-openai'
    ])
  })
})

describe('deepgram', () => {
  it('posts raw audio bytes with the model in the query and Token auth', async () => {
    const server = await serve((_call, res) => {
      json(res, { results: { channels: [{ alternatives: [{ transcript: ' 你好世界 ' }] }] } })
    })
    const text = await spec('deepgram').run(context({ baseUrl: server.origin }), input({ language: 'zh' }))

    expect(text).toBe('你好世界')
    const call = server.calls[0]
    expect(call.method).toBe('POST')
    expect(call.path).toBe('/v1/listen')
    expect(call.query.get('model')).toBe('nova-3')
    expect(call.query.get('language')).toBe('zh')
    expect(call.query.get('smart_format')).toBe('true')
    expect(call.query.get('punctuate')).toBe('true')
    // `Token`, not `Bearer`; and no multipart at all — the body is the file.
    expect(call.headers.authorization).toBe('Token test-key')
    expect(call.headers['content-type']).toBe('audio/wav')
    expect(call.body.equals(Buffer.from(AUDIO))).toBe(true)
  })

  it('omits language when the profile says auto', async () => {
    const server = await serve((_call, res) => {
      json(res, { results: { channels: [{ alternatives: [{ transcript: 'hi' }] }] } })
    })
    await spec('deepgram').run(context({ baseUrl: server.origin }), input({ language: 'auto' }))
    expect(server.calls[0].query.get('language')).toBeNull()
  })

  it('surfaces the vendor error sentence on a 4xx', async () => {
    const server = await serve((_call, res) => json(res, { err_msg: 'BAD_KEY: invalid credentials' }, 401))
    const error = await failure(spec('deepgram').run(context({ baseUrl: server.origin }), input()))
    expect(error.name).toBe('ProviderError')
    expect(error.message).toContain('HTTP 401')
    expect(error.message).toContain('BAD_KEY: invalid credentials')
  })
})

describe('assemblyai', () => {
  it('uploads the bytes, creates a job without Bearer, then polls to completed', async () => {
    let polls = 0
    const server = await serve((call, res) => {
      if (call.path === '/v2/upload') {
        json(res, { upload_url: 'https://cdn.assemblyai.test/audio.wav' })
        return
      }
      if (call.method === 'POST') {
        json(res, { id: 'job1' })
        return
      }
      polls += 1
      if (polls === 1) {
        json(res, { status: 'queued' })
        return
      }
      json(res, { status: 'completed', text: ' 你好 ' })
    })

    const text = await spec('assemblyai').run(context({ baseUrl: server.origin }), input({ language: 'zh' }))
    expect(text).toBe('你好')

    const upload = server.calls[0]
    expect(upload.path).toBe('/v2/upload')
    // AssemblyAI's header has no scheme in front of the key.
    expect(upload.headers.authorization).toBe('test-key')
    expect(upload.body.equals(Buffer.from(AUDIO))).toBe(true)

    const created = server.calls[1]
    expect(created.path).toBe('/v2/transcript')
    expect(created.json).toEqual({
      audio_url: 'https://cdn.assemblyai.test/audio.wav',
      speech_models: ['universal-3-5-pro', 'universal-2'],
      language_code: 'zh'
    })

    const gets = server.calls.filter((call) => call.method === 'GET')
    expect(gets.map((call) => call.path)).toEqual(['/v2/transcript/job1', '/v2/transcript/job1'])
  })

  it('throws the job error field instead of polling until the budget ends', async () => {
    const server = await serve((call, res) => {
      if (call.path === '/v2/upload') {
        json(res, { upload_url: 'https://cdn.assemblyai.test/audio.wav' })
        return
      }
      if (call.method === 'POST') {
        json(res, { id: 'job2' })
        return
      }
      json(res, { status: 'error', error: 'audio duration too short' })
    })
    const error = await failure(spec('assemblyai').run(context({ baseUrl: server.origin }), input()))
    expect(error.message).toContain('AssemblyAI 转写失败')
    expect(error.message).toContain('audio duration too short')
  })
})

describe('elevenlabs', () => {
  it('posts multipart with model_id and language_code under xi-api-key', async () => {
    const server = await serve((_call, res) => json(res, { text: ' 你好 ', language_code: 'zh' }))
    const parsed = await spec('elevenlabs').run(context({ baseUrl: server.origin }), input({ language: 'zh' }))
    expect(parsed).toBe('你好')

    const call = server.calls[0]
    expect(call.path).toBe('/v1/speech-to-text')
    expect(call.headers['xi-api-key']).toBe('test-key')
    expect(call.headers.authorization).toBeUndefined()
    expect(call.fields).toEqual({ model_id: 'scribe_v1', language_code: 'zh' })
    expect(call.filename).toBe('audio.wav')
    expect(call.file?.equals(Buffer.from(AUDIO))).toBe(true)
  })
})

describe('gladia', () => {
  it('uploads first, creates the job from the returned url, and joins the utterances', async () => {
    let polls = 0
    const server = await serve((call, res) => {
      const host = `http://${call.headers.host}`
      if (call.path === '/v2/upload') {
        json(res, { audio_url: 'https://cdn.gladia.test/audio.wav' })
        return
      }
      if (call.method === 'POST') {
        json(res, { result_url: `${host}/v2/pre-recorded/r1` })
        return
      }
      polls += 1
      if (polls === 1) {
        json(res, { status: 'processing' })
        return
      }
      json(res, {
        status: 'done',
        result: { transcription: { utterances: [{ text: '你好' }, { text: '世界' }] } }
      })
    })

    const parsed = await spec('gladia').run(context({ baseUrl: server.origin }), input({ language: 'zh' }))
    expect(parsed).toBe('你好 世界')

    const upload = server.calls[0]
    expect(upload.path).toBe('/v2/upload')
    expect(upload.headers['x-gladia-key']).toBe('test-key')
    expect(upload.fields).toEqual({})
    expect(upload.file?.equals(Buffer.from(AUDIO))).toBe(true)

    const created = server.calls[1]
    expect(created.path).toBe('/v2/pre-recorded')
    expect(created.json).toEqual({
      audio_url: 'https://cdn.gladia.test/audio.wav',
      language_config: { languages: ['zh'] },
      diarization: false
    })

    // The poll URL is the one the vendor handed back, not a guessed path.
    expect(server.calls[2].path).toBe('/v2/pre-recorded/r1')
  })

  it('falls back to full_transcript when diarization produced no utterances', async () => {
    const server = await serve((call, res) => {
      const host = `http://${call.headers.host}`
      if (call.path === '/v2/upload') {
        json(res, { file_url: 'https://cdn.gladia.test/audio.wav' })
        return
      }
      if (call.method === 'POST') {
        json(res, { result_url: `${host}/v2/pre-recorded/r2` })
        return
      }
      json(res, {
        status: 'done',
        result: { transcription: { utterances: [], full_transcript: '整段文本' } }
      })
    })
    const parsed = await spec('gladia').run(context({ baseUrl: server.origin }), input())
    expect(parsed).toBe('整段文本')
  })
})

describe('speechmatics', () => {
  it('sends data_file plus a JSON config and joins the word results', async () => {
    const server = await serve((_call, res) => {
      json(res, {
        results: [
          { type: 'word', alternatives: [{ content: '你好' }] },
          { type: 'punctuation', alternatives: [{ content: '，' }] },
          { type: 'word', alternatives: [{ content: '世界' }] }
        ]
      })
    })
    const parsed = await spec('speechmatics').run(context({ baseUrl: server.origin }), input({ language: 'zh' }))
    expect(parsed).toBe('你好 世界')

    const call = server.calls[0]
    expect(call.path).toBe('/v2/jobs')
    expect(call.headers.authorization).toBe('Bearer test-key')
    expect(call.filename).toBe('audio.wav')
    expect(call.file?.equals(Buffer.from(AUDIO))).toBe(true)
    expect(JSON.parse(call.fields.config)).toEqual({
      type: 'transcription',
      transcription_config: { language: 'zh', enable_partials: false }
    })
  })

  it('polls the Job-ID header when the response carries no inline results', async () => {
    const server = await serve((call, res) => {
      if (call.method === 'POST') {
        res.writeHead(201, { 'Job-ID': 'job-42', 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      text(res, ' 你好 世界 ')
    })
    const parsed = await spec('speechmatics').run(context({ baseUrl: server.origin }), input())
    expect(parsed).toBe('你好 世界')

    const poll = server.calls[1]
    expect(poll.method).toBe('GET')
    expect(poll.path).toBe('/v2/jobs/job-42/transcript')
    expect(poll.query.get('format')).toBe('txt')
    // No language in the profile: Speechmatics needs a concrete code, not `auto`.
    expect(JSON.parse(server.calls[0].fields.config).transcription_config.language).toBe('en')
  })
})

describe('revai', () => {
  it('submits media with ?language, waits for transcribed, then glues the elements', async () => {
    const server = await serve((call, res) => {
      if (call.method === 'POST') {
        json(res, { id: 'rev1' })
        return
      }
      if (call.path === '/v1/jobs/rev1') {
        json(res, { status: 'transcribed' })
        return
      }
      json(res, {
        monologues: [
          {
            elements: [
              { type: 'text', value: '你好' },
              { type: 'punct', value: '，' },
              { type: 'text', value: '世界' },
              { type: 'punct', value: '。' }
            ]
          }
        ]
      })
    })
    const parsed = await spec('revai').run(context({ baseUrl: server.origin }), input({ language: 'zh' }))
    expect(parsed).toBe('你好，世界。')

    const submit = server.calls[0]
    expect(submit.path).toBe('/v1/jobs')
    expect(submit.query.get('language')).toBe('zh')
    expect(submit.headers.authorization).toBe('Bearer test-key')
    expect(submit.headers.accept).toBe('application/vnd.rev.transcript.v1.0+json')
    expect(submit.fields).toEqual({})
    expect(submit.file?.equals(Buffer.from(AUDIO))).toBe(true)

    expect(server.calls[1].path).toBe('/v1/jobs/rev1')
    expect(server.calls[2].path).toBe('/v1/jobs/rev1/transcript')
  })
})

describe('azure-openai', () => {
  it('names the missing deployment in the error instead of posting to a broken path', async () => {
    const error = await failure(
      spec('azure-openai').run(context({ baseUrl: 'http://127.0.0.1:1' }), input())
    )
    expect(error.name).toBe('ProviderError')
    // Both the human label and the vendor key, so the message is actionable.
    expect(error.message).toContain('Azure 部署名')
    expect(error.message).toContain('deployment')
  })

  it('dedupes the /openai prefix, adds api-version and uses the api-key header', async () => {
    const server = await serve((_call, res) => json(res, { text: ' 你好 ' }))
    const parsed = await spec('azure-openai').run(
      context({
        baseUrl: `${server.origin}/openai/deployments/placeholder`,
        fields: { deployment: 'whisper', apiVersion: '2024-10-21' }
      }),
      input({ model: 'whisper-1' })
    )
    expect(parsed).toBe('你好')

    const call = server.calls[0]
    // Not `/openai/deployments/placeholder/openai/...`: the template segment is replaced.
    expect(call.path).toBe('/openai/deployments/whisper/audio/transcriptions')
    expect(call.query.get('api-version')).toBe('2024-10-21')
    expect(call.headers['api-key']).toBe('test-key')
    expect(call.headers.authorization).toBeUndefined()
    expect(call.fields).toEqual({ model: 'whisper-1' })
    expect(call.file?.equals(Buffer.from(AUDIO))).toBe(true)
  })

  it('falls back to the standard path on an OpenAI-compatible host that is not Azure', async () => {
    const server = await serve((_call, res) => json(res, { text: 'ok' }))
    await spec('azure-openai').run(
      context({ baseUrl: server.origin, fields: { deployment: 'whisper' } }),
      input()
    )
    const call = server.calls[0]
    expect(call.path).toBe('/audio/transcriptions')
    expect(call.query.get('api-version')).toBeNull()
    expect(call.headers['api-key']).toBe('test-key')
  })
})

describe('cohere', () => {
  it('keeps the compatibility base intact and puts the file after all required form fields', async () => {
    const server = await serve((_call, res) => json(res, { text: 'verified' }))
    expect(await spec('cohere').run(context({ baseUrl: server.origin + '/compatibility/v1' }), input({ language: 'zh' }))).toBe('verified')
    expect(server.calls[0].path).toBe('/compatibility/v1/audio/transcriptions')
  })

  it('explains the required language instead of sending a request that cannot succeed', async () => {
    await expect(spec('cohere').run(context({ baseUrl: 'https://api.cohere.com/v2' }), input({ language: 'auto' }))).rejects.toThrow('指定识别语言')
  })
  it('posts multipart file + model to the v2 endpoint with Bearer auth', async () => {
    const server = await serve((_call, res) => json(res, { text: ' 你好 ' }))
    const parsed = await spec('cohere').run(context({ baseUrl: server.origin }), input({ language: 'zh' }))
    expect(parsed).toBe('你好')

    const call = server.calls[0]
    expect(call.path).toBe('/v2/audio/transcriptions')
    expect(call.headers.authorization).toBe('Bearer test-key')
    // Cohere requires a language, so a known one is always sent.
    expect(call.fields).toEqual({ model: 'cohere-transcribe-03-2026', language: 'zh' })
    expect(call.file?.equals(Buffer.from(AUDIO))).toBe(true)
  })
})

describe('minimax', () => {
  it('reads data.text when the flat text field is absent', async () => {
    const server = await serve((_call, res) => json(res, { data: { text: ' 你好 ' } }))
    const parsed = await spec('minimax').run(context({ baseUrl: server.origin }), input({ language: 'zh' }))
    expect(parsed).toBe('你好')

    const call = server.calls[0]
    expect(call.path).toBe('/v1/speech_to_text')
    expect(call.headers.authorization).toBe('Bearer test-key')
    expect(call.headers.language).toBe('zh')
    expect(call.fields).toEqual({ model: 'asr-1.0' })
  })
})

describe('deepinfra', () => {
  it.each(['/v1/openai', '/v1/inference'])('uses the native model route and audio field from %s', async root => {
    const server = await serve((_call, res) => json(res, { text: ' verified ' }))
    expect(await spec('deepinfra').run(context({ baseUrl: server.origin + root }), input({ model: 'openai/whisper-large-v3' }))).toBe('verified')
    const call = server.calls[0]
    expect(call.path).toBe('/v1/inference/openai/whisper-large-v3')
    expect(call.headers.authorization).toBe('Bearer test-key')
    expect(call.body.toString()).toContain('name="audio"')
    expect(call.body.toString()).not.toContain('name="file"')
    expect(call.body.toString()).not.toContain('name="model"')
  })
})

describe('openrouter', () => {
  it('sends JSON base64 audio and a language hint, without multipart', async () => {
    const server = await serve((_call, res) => json(res, { text: ' verified ' }))
    expect(await spec('openrouter').run(context({ baseUrl: server.origin + '/api/v1' }), input({ model: 'elevenlabs/scribe-v2', language: 'zh' }))).toBe('verified')
    expect(server.calls[0].path).toBe('/api/v1/audio/transcriptions')
    expect(server.calls[0].headers.authorization).toBe('Bearer test-key')
    expect(server.calls[0].json).toEqual({ model: 'elevenlabs/scribe-v2', language: 'zh', input_audio: { data: Buffer.from(AUDIO).toString('base64'), format: 'wav' } })
  })
})

describe('replicate', () => {
  it('addresses owner/name, waits inline, and sends the audio as a data URI', async () => {
    const server = await serve((_call, res) => json(res, { status: 'succeeded', output: ' 你好 ' }))
    const parsed = await spec('replicate').run(context({ baseUrl: server.origin }), input())
    expect(parsed).toBe('你好')

    const call = server.calls[0]
    expect(call.path).toBe('/v1/models/openai/whisper/predictions')
    expect(call.headers.authorization).toBe('Bearer test-key')
    expect(call.headers.prefer).toBe('wait=60')
    const body = call.json as { input: { audio: string } }
    expect(body.input.audio.startsWith('data:audio/wav;base64,')).toBe(true)
    expect(Buffer.from(body.input.audio.split(',')[1], 'base64').equals(Buffer.from(AUDIO))).toBe(true)
  })

  it('polls urls.get while the prediction is still starting and reads an array output', async () => {
    const server = await serve((call, res) => {
      const host = `http://${call.headers.host}`
      if (call.method === 'POST') {
        json(res, { status: 'starting', urls: { get: `${host}/v1/predictions/p1` } })
        return
      }
      json(res, { status: 'succeeded', output: [{ text: '你好' }, { text: '世界' }] })
    })
    const parsed = await spec('replicate').run(context({ baseUrl: server.origin }), input())
    expect(parsed).toBe('你好 世界')
    expect(server.calls[1].path).toBe('/v1/predictions/p1')
    expect(server.calls[1].headers.authorization).toBe('Bearer test-key')
  })

  it('rejects a model id that is not owner/name before spending a request', async () => {
    const error = await failure(
      spec('replicate').run(context({ baseUrl: 'http://127.0.0.1:1' }), input({ model: 'whisper' }))
    )
    expect(error.message).toContain('owner/name')
    expect(error.message).toContain('whisper')
  })
})

describe('fal', () => {
  it('puts the model in the path, uses Key auth and a JSON data URI body', async () => {
    const server = await serve((_call, res) => json(res, { text: ' 你好 ' }))
    const parsed = await spec('fal').run(context({ baseUrl: server.origin }), input())
    expect(parsed).toBe('你好')

    const call = server.calls[0]
    expect(call.path).toBe('/fal-ai/whisper')
    expect(call.headers.authorization).toBe('Key test-key')
    const body = call.json as { audio_url: string }
    expect(body.audio_url.startsWith('data:audio/wav;base64,')).toBe(true)
  })

  it('joins chunks[].text when the deployment returns segments instead of text', async () => {
    const server = await serve((_call, res) => json(res, { chunks: [{ text: '你好' }, { text: '世界' }] }))
    const parsed = await spec('fal').run(context({ baseUrl: server.origin }), input({ model: 'fal-ai/whisper-large' }))
    expect(parsed).toBe('你好 世界')
    expect(server.calls[0].path).toBe('/fal-ai/whisper-large')
  })
})
