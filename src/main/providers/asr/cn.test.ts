import { createHash, createHmac } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { describe, expect, it } from 'vitest'
import { SAMPLE_RATE, encodeWav } from '../../audio/wav'
import { CN_SPECS, tc3Authorization, xfyunAuth, xfyunFrames, xfyunJoin } from './cn'
import type { AsrAdapterContext, AsrAdapterInput } from './types'

// ---------------------------------------------------------------------------
// These four adapters disagree about everything except that they are all HTTP
// or WebSocket endpoints, so each case is asserted against a real socket: the
// signature, the base64 body and the poll URL are the parts that break silently
// when they are wrong.
// ---------------------------------------------------------------------------

interface Seen {
  method: string
  path: string
  headers: http.IncomingHttpHeaders
  body: Buffer
}

interface Harness {
  baseUrl: string
  seen: Seen[]
  close: () => Promise<void>
}

type Handler = (seen: Seen, res: http.ServerResponse) => void

async function listen(handle: Handler): Promise<Harness> {
  const seen: Seen[] = []
  const sockets = new Set<Socket>()
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const item: Seen = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks)
      }
      seen.push(item)
      handle(item, res)
    })
  })
  server.on('connection', (socket: Socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    seen,
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

/** 0.2 s of tone, i.e. five IAT frames once split. */
function wav(seconds = 0.2): { bytes: Uint8Array; pcm: Int16Array } {
  const pcm = new Int16Array(Math.round(seconds * SAMPLE_RATE))
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(6000 * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE))
  return { bytes: encodeWav(pcm), pcm }
}

function spec(id: string) {
  const found = CN_SPECS.find((item) => item.id === id)
  if (!found) throw new Error(`no spec ${id}`)
  return found
}

function context(
  baseUrl: string,
  fields: Record<string, string>,
  options: { apiKey?: string; signal?: AbortSignal } = {}
): AsrAdapterContext {
  return {
    baseUrl,
    apiKey: options.apiKey ?? '',
    signal: options.signal ?? new AbortController().signal,
    log: () => {},
    fields
  }
}

function input(bytes: Uint8Array, model = '', language = ''): AsrAdapterInput {
  return { wav: bytes, ms: 200, model, language, mime: 'audio/wav' }
}

const BASE64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')

// ---------------------------------------------------------------------------

describe('spec table', () => {
  it('lists the four vendors with the fields each one really needs', () => {
    expect(CN_SPECS.map((item) => item.id)).toEqual(['aliyun', 'tencent', 'xfyun', 'baidu'])
    for (const item of CN_SPECS) {
      expect(item.label).not.toContain('暂不可直连')
      expect(item.hosts.length).toBeGreaterThan(0)
      expect(item.fields.some((presetField) => presetField.required === true)).toBe(true)
    }
    expect(spec('aliyun').fields.find((item) => item.key === 'uploadUrl')?.required).toBe(true)
    expect(spec('tencent').fields.find((item) => item.key === 'region')?.value).toBe('ap-shanghai')
  })
})

describe('aliyun (DashScope async recording)', () => {
  it('PUTs the bytes to uploadUrl, submits, polls twice and downloads the transcript', async () => {
    let base = ''
    let polls = 0
    const server = await listen((seen, res) => {
      if (seen.method === 'PUT') {
        res.writeHead(200)
        res.end()
        return
      }
      if (seen.path === '/api/v1/services/audio/asr/transcription') {
        json(res, { output: { task_id: 'task-1', task_status: 'PENDING' } })
        return
      }
      if (seen.path === '/api/v1/tasks/task-1') {
        polls += 1
        if (polls === 1) {
          json(res, { output: { task_id: 'task-1', task_status: 'RUNNING' } })
          return
        }
        json(res, {
          output: {
            task_id: 'task-1',
            task_status: 'SUCCEEDED',
            results: [{ subtask_status: 'SUCCEEDED', transcription_url: `${base}/result.json` }]
          }
        })
        return
      }
      if (seen.path === '/result.json') {
        json(res, { transcripts: [{ text: '  今天天气不错  ' }] })
        return
      }
      json(res, { error: 'unexpected path' }, 500)
    })
    base = server.baseUrl
    try {
      const { bytes } = wav()
      const text = await spec('aliyun').run(
        context(base, { uploadUrl: `${base}/upload.wav`, workspace: 'ws-1' }, { apiKey: 'sk-test' }),
        input(bytes, '', 'zh-CN')
      )
      expect(text).toBe('今天天气不错')

      const [put, submit] = server.seen
      expect(put.method).toBe('PUT')
      expect(put.path).toBe('/upload.wav')
      expect(put.headers['content-type']).toBe('audio/wav')
      expect(put.body.equals(Buffer.from(bytes))).toBe(true)

      expect(submit.method).toBe('POST')
      expect(submit.path).toBe('/api/v1/services/audio/asr/transcription')
      expect(submit.headers.authorization).toBe('Bearer sk-test')
      // DashScope answers synchronously without it, which refuses anything long.
      expect(submit.headers['x-dashscope-async']).toBe('enable')
      expect(submit.headers['x-dashscope-workspace']).toBe('ws-1')
      expect(JSON.parse(submit.body.toString('utf8'))).toEqual({
        model: 'paraformer-v2',
        input: { file_urls: [`${base}/upload.wav`] },
        parameters: { language_hints: ['zh'] }
      })

      expect(server.seen[2].path).toBe('/api/v1/tasks/task-1')
      expect(server.seen[2].headers.authorization).toBe('Bearer sk-test')
      expect(server.seen[3].path).toBe('/api/v1/tasks/task-1')
      // The result document is a pre-signed object URL: no Bearer there.
      expect(server.seen[4].path).toBe('/result.json')
      expect(server.seen[4].headers.authorization).toBeUndefined()
      expect(polls).toBe(2)
    } finally {
      await server.close()
    }
  })

  it('surfaces output.message when the task fails', async () => {
    const server = await listen((seen, res) => {
      if (seen.method === 'PUT') {
        res.writeHead(200)
        res.end()
        return
      }
      if (seen.path.endsWith('/transcription')) {
        json(res, { output: { task_id: 'task-2' } })
        return
      }
      json(res, { output: { task_id: 'task-2', task_status: 'FAILED', message: '音频格式不支持' } })
    })
    try {
      await expect(
        spec('aliyun').run(
          context(server.baseUrl, { uploadUrl: `${server.baseUrl}/a.wav` }, { apiKey: 'sk-test' }),
          input(wav().bytes)
        )
      ).rejects.toThrow('音频格式不支持')
    } finally {
      await server.close()
    }
  })

  it('refuses to run without an upload URL, naming the field', async () => {
    await expect(
      spec('aliyun').run(context('http://127.0.0.1:1', {}, { apiKey: 'sk-test' }), input(wav().bytes))
    ).rejects.toThrow('uploadUrl')
  })
})

describe('tencent (TC3-HMAC-SHA256)', () => {
  it('signs the request and posts the wav as base64 with the action in a header', async () => {
    const server = await listen((_seen, res) => json(res, { Response: { Result: '你好世界', RequestId: 'r-1' } }))
    try {
      const { bytes } = wav()
      const text = await spec('tencent').run(
        context(server.baseUrl, { secretId: 'AKIDtest', secretKey: 'secret', region: 'ap-beijing', token: 'tmp' }),
        input(bytes)
      )
      expect(text).toBe('你好世界')

      const sent = server.seen[0]
      expect(sent.method).toBe('POST')
      expect(sent.path).toBe('/')
      expect(sent.headers.authorization).toMatch(
        /^TC3-HMAC-SHA256 Credential=AKIDtest\/\d{4}-\d{2}-\d{2}\/asr\/tc3_request, SignedHeaders=content-type;host, Signature=[0-9a-f]{64}$/
      )
      expect(sent.headers['x-tc-action']).toBe('SentenceRecognition')
      expect(sent.headers['x-tc-version']).toBe('2019-06-14')
      expect(sent.headers['x-tc-region']).toBe('ap-beijing')
      expect(sent.headers['x-tc-token']).toBe('tmp')
      expect(Number(sent.headers['x-tc-timestamp'])).toBeGreaterThan(1_600_000_000)

      const body = JSON.parse(sent.body.toString('utf8'))
      expect(body).toMatchObject({ EngSerViceType: '16k_zh', SourceType: 1, VoiceFormat: 'wav', ProjectId: 0 })
      // The bytes travel inside JSON: Tencent never sees a multipart upload.
      expect(body.Data).toBe(BASE64(bytes))
    } finally {
      await server.close()
    }
  })

  it('produces the signature the documented recipe produces', async () => {
    const server = await listen((_seen, res) => json(res, { Response: { Result: '好' } }))
    try {
      const secretKey = 'secret'
      await spec('tencent').run(
        context(server.baseUrl, { secretId: 'AKIDtest', secretKey }),
        input(wav().bytes)
      )
      const sent = server.seen[0]
      const timestamp = Number(sent.headers['x-tc-timestamp'])
      const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
      const host = new URL(server.baseUrl).host
      const payload = sent.body.toString('utf8')
      // Written out from the spec, not imported: the point is that the two
      // independent derivations agree on the same 64 hex characters.
      const canonical = [
        'POST',
        '/',
        '',
        'content-type:application/json; charset=utf-8',
        `host:${host}`,
        '',
        'content-type;host',
        createHash('sha256').update(payload, 'utf8').digest('hex')
      ].join('\n')
      const scope = `${date}/asr/tc3_request`
      const toSign = [
        'TC3-HMAC-SHA256',
        String(timestamp),
        scope,
        createHash('sha256').update(canonical, 'utf8').digest('hex')
      ].join('\n')
      const kDate = createHmac('sha256', `TC3${secretKey}`).update(date, 'utf8').digest()
      const kService = createHmac('sha256', kDate).update('asr', 'utf8').digest()
      const kSigning = createHmac('sha256', kService).update('tc3_request', 'utf8').digest()
      const signature = createHmac('sha256', kSigning).update(toSign, 'utf8').digest('hex')

      expect(sent.headers.authorization).toContain(`Signature=${signature}`)
      expect(tc3Authorization({ secretId: 'AKIDtest', secretKey, host, payload, timestamp })).toBe(
        sent.headers.authorization
      )
    } finally {
      await server.close()
    }
  })

  it('reports Response.Error.Message instead of a bare status', async () => {
    const server = await listen((_seen, res) =>
      json(res, { Response: { Error: { Code: 'FailedOperation.Silent', Message: '未检测到有效语音' } } })
    )
    try {
      await expect(
        spec('tencent').run(context(server.baseUrl, { secretId: 'AKIDtest', secretKey: 'k' }), input(wav().bytes))
      ).rejects.toThrow('未检测到有效语音')
    } finally {
      await server.close()
    }
  })
})

describe('xfyun (IAT frames)', () => {
  it('splits 16 kHz PCM16 into 40 ms frames and opens/closes the session', () => {
    const frames = xfyunFrames(new Uint8Array(80 * 32))
    // 80 ms at 16 kHz mono 16-bit = 2560 bytes = two 1280-byte frames.
    expect(frames.map((frame) => frame.status)).toEqual([0, 2])
    expect(frames.map((frame) => frame.audio.byteLength)).toEqual([1280, 1280])

    const short = xfyunFrames(new Uint8Array(320))
    // A clip shorter than one frame still needs an opener and a terminator.
    expect(short.map((frame) => frame.status)).toEqual([0, 2])
    expect(short[0].audio.byteLength).toBe(320)
    expect(short[1].audio.byteLength).toBe(0)

    expect(xfyunFrames(new Uint8Array(0)).map((frame) => frame.status)).toEqual([2])
  })

  it('joins result pieces in sn order and skips lost frames', () => {
    expect(xfyunJoin(['你好', '，世界', '。'])).toBe('你好，世界。')
    expect(xfyunJoin(['你好', undefined, '世界'])).toBe('你好世界')
    expect(xfyunJoin([undefined, ''])).toBe('')
  })

  it('signs host + date + request line, and the signature is independently reproducible', () => {
    const date = 'Tue, 21 Oct 2026 04:26:45 GMT'
    const credential = Buffer.from(xfyunAuth('key-1', 'secret-1', 'iat-api.xfyun.cn', date), 'base64').toString('utf8')
    const expected = createHmac('sha256', 'secret-1')
      .update(`host: iat-api.xfyun.cn\ndate: ${date}\nGET /v2/iat HTTP/1.1`, 'utf8')
      .digest('base64')
    expect(credential).toContain('api_key="key-1"')
    expect(credential).toContain('algorithm="hmac-sha256"')
    expect(credential).toContain('headers="host date request-line"')
    expect(credential).toContain(`signature="${expected}"`)
  })

  it('streams the frames over a real WebSocket and joins the result', async () => {
    const received: Array<Record<string, unknown>> = []
    const server = await listenWs((message, session) => {
      received.push(message)
      const data = message.data as { status?: number } | undefined
      if (data?.status !== 2) return
      session.send({ code: 0, data: { status: 1, result: { sn: 1, ws: [{ cw: [{ w: '你好' }] }] } } })
      session.send({
        code: 0,
        data: { status: 1, result: { sn: 2, ws: [{ cw: [{ w: '世界' }] }, { cw: [{ w: '。' }] }] } }
      })
      session.send({ code: 0, data: { status: 2, result: { sn: 3, ws: [] } } })
    })
    try {
      const text = await spec('xfyun').run(
        context(server.baseUrl, { appId: 'app-1', apiKey: 'key-1', apiSecret: 'secret-1' }),
        input(wav().bytes)
      )
      expect(text).toBe('你好世界。')

      // The signed query is the whole credential: there are no headers to carry it.
      const url = new URL(server.url)
      expect(url.pathname).toBe('/v2/iat')
      const host = url.searchParams.get('host') ?? ''
      const date = url.searchParams.get('date') ?? ''
      expect(host).toBe(new URL(server.baseUrl).host)
      expect(date).toMatch(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/)
      const credential = Buffer.from(url.searchParams.get('authorization') ?? '', 'base64').toString('utf8')
      const expected = createHmac('sha256', 'secret-1')
        .update(`host: ${host}\ndate: ${date}\nGET /v2/iat HTTP/1.1`, 'utf8')
        .digest('base64')
      expect(credential).toContain(`signature="${expected}"`)

      // First frame carries the vendor metadata; the rest carry audio only.
      const first = received[0] as {
        common?: { app_id?: string }
        business?: { domain?: string; language?: string }
        data?: { status?: number; encoding?: string; format?: string; audio?: string }
      }
      expect(first.common?.app_id).toBe('app-1')
      expect(first.business).toMatchObject({ language: 'zh_cn', domain: 'iat', accent: 'mandarin' })
      expect(first.data?.status).toBe(0)
      expect(first.data?.encoding).toBe('raw')
      expect(first.data?.format).toBe('audio/L16;rate=16000')
      expect(Buffer.from(first.data?.audio ?? '', 'base64').byteLength).toBe(1280)
      const middle = received[1] as { common?: unknown; data?: { status?: number } }
      expect(middle.common).toBeUndefined()
      expect(middle.data?.status).toBe(1)
      expect(received.at(-1)?.data).toMatchObject({ status: 2 })
    } finally {
      await server.close()
    }
  })

  it('rejects with the vendor code when the session reports an error', async () => {
    const server = await listenWs((message, session) => {
      const data = (message as { data?: { status?: number } }).data
      if (data?.status !== 2) return
      session.send({ code: 10165, message: 'invalid appid' })
    })
    try {
      await expect(
        spec('xfyun').run(context(server.baseUrl, { appId: 'app-1', apiKey: 'k', apiSecret: 's' }), input(wav().bytes))
      ).rejects.toThrow('invalid appid')
    } finally {
      await server.close()
    }
  })
})

describe('baidu (OAuth token then base64 JSON)', () => {
  it('mints a token with both keys, then posts the audio with an explicit len', async () => {
    const server = await listen((seen, res) => {
      if (seen.path.startsWith('/oauth/2.0/token')) {
        json(res, { access_token: 'tok-1', expires_in: 2_592_000 })
        return
      }
      json(res, { err_no: 0, err_msg: 'success.', result: ['你好。'] })
    })
    try {
      const { bytes } = wav()
      const text = await spec('baidu').run(
        context(server.baseUrl, { apiKey: 'ak', secretKey: 'sk' }),
        input(bytes)
      )
      expect(text).toBe('你好。')

      const tokenCall = server.seen[0]
      expect(tokenCall.method).toBe('POST')
      // Credentials travel in the form body: a query string would put the secret
      // key into every access log and error message on the way.
      expect(tokenCall.path).not.toContain('client_secret')
      const tokenForm = tokenCall.body.toString('utf8')
      expect(tokenForm).toContain('grant_type=client_credentials')
      expect(tokenForm).toContain('client_id=ak')
      expect(tokenForm).toContain('client_secret=sk')

      const recognize = server.seen[1]
      expect(recognize.path).toBe('/server_api')
      expect(recognize.headers['content-type']).toBe('application/json')
      const body = JSON.parse(recognize.body.toString('utf8'))
      expect(body).toMatchObject({ format: 'wav', rate: 16000, channel: 1, cuid: 'typeless', token: 'tok-1' })
      expect(body.len).toBe(bytes.byteLength)
      expect(body.speech).toBe(BASE64(bytes))
    } finally {
      await server.close()
    }
  })

  it('reports err_msg when err_no is not zero', async () => {
    const server = await listen((seen, res) => {
      if (seen.path.startsWith('/oauth/2.0/token')) {
        json(res, { access_token: 'tok-1' })
        return
      }
      json(res, { err_no: 3301, err_msg: 'speech quality error.', result: [] })
    })
    try {
      await expect(
        spec('baidu').run(context(server.baseUrl, { apiKey: 'ak', secretKey: 'sk' }), input(wav().bytes))
      ).rejects.toThrow('speech quality error.')
    } finally {
      await server.close()
    }
  })

  it('reports why the token exchange failed', async () => {
    const server = await listen((_seen, res) =>
      json(res, { error: 'invalid_client', error_description: 'unknown client id' })
    )
    try {
      await expect(
        spec('baidu').run(context(server.baseUrl, { apiKey: 'ak', secretKey: 'sk' }), input(wav().bytes))
      ).rejects.toThrow('unknown client id')
    } finally {
      await server.close()
    }
  })
})

// ---------------------------------------------------------------------------
// A hand-rolled RFC 6455 server: the only WebSocket dependency this repo would
// otherwise need for one test. Text frames in, text frames out, close on demand.
// ---------------------------------------------------------------------------

interface WsSession {
  send: (payload: unknown) => void
}

interface WsHarness {
  baseUrl: string
  url: string
  close: () => Promise<void>
}

async function listenWs(
  onText: (message: Record<string, unknown>, session: WsSession) => void
): Promise<WsHarness> {
  const sockets = new Set<Socket>()
  let requested = ''
  const server = http.createServer((_req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' })
    res.end('upgrade required')
  })
  server.on('upgrade', (req, socket: Socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    requested = req.url ?? ''
    const accept = createHash('sha1')
      .update(`${String(req.headers['sec-websocket-key'] ?? '')}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    )
    const session: WsSession = { send: (payload) => sendText(socket, JSON.stringify(payload)) }
    readText(socket, (text) => onText(JSON.parse(text) as Record<string, unknown>, session))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    get url() {
      return `ws://127.0.0.1:${port}${requested}`
    },
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

function sendText(socket: Socket, text: string): void {
  const payload = Buffer.from(text, 'utf8')
  if (payload.byteLength > 65_535) throw new Error('test frame too large')
  const header =
    payload.byteLength < 126
      ? Buffer.from([0x81, payload.byteLength])
      : Buffer.from([0x81, 126, payload.byteLength >> 8, payload.byteLength & 0xff])
  socket.write(Buffer.concat([header, payload]))
}

function readText(socket: Socket, onText: (text: string) => void): void {
  let buffer = Buffer.alloc(0)
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      if (buffer.byteLength < 2) return
      const opcode = buffer[0] & 0x0f
      const masked = (buffer[1] & 0x80) !== 0
      let length = buffer[1] & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffer.byteLength < offset + 2) return
        length = buffer.readUInt16BE(offset)
        offset += 2
      } else if (length === 127) {
        if (buffer.byteLength < offset + 8) return
        length = Number(buffer.readBigUInt64BE(offset))
        offset += 8
      }
      const maskLength = masked ? 4 : 0
      if (buffer.byteLength < offset + maskLength + length) return
      const mask = masked ? buffer.subarray(offset, offset + 4) : null
      offset += maskLength
      const payload = Buffer.from(buffer.subarray(offset, offset + length))
      if (mask) for (let i = 0; i < payload.byteLength; i++) payload[i] ^= mask[i % 4]
      buffer = buffer.subarray(offset + length)
      if (opcode === 0x8) {
        socket.end()
        return
      }
      if (opcode === 0x1 || opcode === 0x0) onText(payload.toString('utf8'))
    }
  })
}
