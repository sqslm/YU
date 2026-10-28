import { createHash, createHmac } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { gunzipSync, gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import type { ProviderProfile } from '@shared/types'
import { SAMPLE_RATE, encodeWav } from '../../audio/wav'
import { resolveAsrAdapter } from './index'
import { REALTIME_SPECS, xfyunRtaJoin, xfyunRtaSigna } from './realtime'
import type { AsrAdapterContext, AsrAdapterInput } from './types'

// ---------------------------------------------------------------------------
// The three socket vendors disagree about the *framing* rather than about HTTP,
// and framing is exactly the part that fails silently: a wrong nested length, a
// missing gzip, an unsigned query parameter, and the take comes back empty with
// no error at all. So every case below runs against a real socket and inspects
// the bytes the adapter actually put on the wire.
// ---------------------------------------------------------------------------

interface Frame {
  binary: boolean
  payload: Buffer
}

interface WsSession {
  sendText: (text: string) => void
  sendBinary: (payload: Buffer) => void
  /** Close the way a real server ends a finished stream: close frame, then FIN. */
  close: () => void
}

interface WsHarness {
  port: number
  /** Full `ws://127.0.0.1:<port><path>` URL the server saw, signature included. */
  url: string
  host: string
  headers: Record<string, string>
  frames: Frame[]
  close: () => Promise<void>
}

async function listenWs(
  onFrame: (frame: Frame, session: WsSession) => void,
  onOpen?: (session: WsSession) => void
): Promise<WsHarness> {
  const sockets = new Set<Socket>()
  const harness: WsHarness = { port: 0, url: '', host: '', headers: {}, frames: [], close: async () => {} }
  const server = http.createServer((_req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' })
    res.end('upgrade required')
  })
  server.on('upgrade', (req, socket: Socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    const port = (server.address() as AddressInfo).port
    harness.url = `ws://127.0.0.1:${port}${req.url ?? ''}`
    harness.host = `127.0.0.1:${port}`
    harness.headers = Object.fromEntries(
      Object.entries(req.headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value ?? '')])
    )
    const accept = createHash('sha1')
      .update(`${String(req.headers['sec-websocket-key'] ?? '')}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    )
    const session: WsSession = {
      sendText: (text) => socket.write(serverFrame(Buffer.from(text, 'utf8'), 0x1)),
      sendBinary: (payload) => socket.write(serverFrame(payload, 0x2)),
      close: () => {
        socket.write(serverFrame(Buffer.alloc(0), 0x8))
        socket.end()
      }
    }
    readFrames(socket, (frame) => {
      harness.frames.push(frame)
      onFrame(frame, session)
    })
    onOpen?.(session)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  harness.port = (server.address() as AddressInfo).port
  harness.close = async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  return harness
}

/** One unmasked server-to-client frame. */
function serverFrame(payload: Buffer, opcode: number): Buffer {
  const length = payload.byteLength
  const header =
    length < 126
      ? Buffer.from([0x80 | opcode, length])
      : length < 65_536
        ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
        : (() => {
            const wide = Buffer.alloc(10)
            wide[0] = 0x80 | opcode
            wide[1] = 127
            wide.writeBigUInt64BE(BigInt(length), 2)
            return wide
          })()
  return Buffer.concat([header, payload])
}

function readFrames(socket: Socket, onFrame: (frame: Frame) => void): void {
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
      if (opcode === 0x1) onFrame({ binary: false, payload })
      if (opcode === 0x2) onFrame({ binary: true, payload })
    }
  })
}

/** 0.3 s of tone: three 100 ms frames, or two 200 ms packets. */
function wav(seconds = 0.3): { bytes: Uint8Array; pcm: Buffer } {
  const pcm = new Int16Array(Math.round(seconds * SAMPLE_RATE))
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(6000 * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE))
  return { bytes: encodeWav(pcm), pcm: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength) }
}

function spec(id: string) {
  const found = REALTIME_SPECS.find((item) => item.id === id)
  if (!found) throw new Error(`no spec ${id}`)
  return found
}

function context(baseUrl: string, fields: Record<string, string>, apiKey = ''): AsrAdapterContext {
  return {
    baseUrl,
    apiKey,
    signal: new AbortController().signal,
    log: () => {},
    fields
  }
}

function input(bytes: Uint8Array, model = ''): AsrAdapterInput {
  return { wav: bytes, ms: 300, model, language: 'auto', mime: 'audio/wav' }
}

const profile = (patch: Partial<ProviderProfile> = {}): ProviderProfile => ({
  id: 'p1',
  name: 'test',
  kind: 'asr',
  preset: '',
  baseUrl: 'wss://example.com/socket',
  apiKey: 'key',
  model: '',
  enabled: true,
  ...patch
})

// ---------------------------------------------------------------------------

describe('realtime spec table', () => {
  it('lists the four socket vendors and nothing else', () => {
    expect(REALTIME_SPECS.map((item) => item.id)).toEqual([
      'dashscope-realtime',
      'tencent-realtime',
      'volcengine-streaming',
      'xfyun-rta'
    ])
    for (const item of REALTIME_SPECS) {
      expect(item.hosts.length).toBeGreaterThan(0)
      expect(item.schemes).toEqual(['ws', 'wss'])
      // Tencent cannot work without its account fields. DashScope needs nothing
      // beyond the key, and Volcengine's key now fits in the ordinary API Key
      // field, so both of those carry no required field of their own.
      if (item.id === 'tencent-realtime') {
        expect(item.fields.some((presetField) => presetField.required === true)).toBe(true)
      }
      // None of them has a `/models` route, so each lists its model ids for the
      // "获取模型" button (Tencent uses an engine field instead, hence none).
      if (item.id === 'dashscope-realtime' || item.id === 'volcengine-streaming') {
        expect((item.models ?? []).length).toBeGreaterThan(0)
      }
    }
  })

  it('routes a wss DashScope profile to the socket adapter, not the file one', () => {
    // Same hostname, both real: the scheme is the only thing that tells them apart.
    expect(resolveAsrAdapter(profile({ baseUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference' }))?.id).toBe(
      'dashscope-realtime'
    )
    expect(
      resolveAsrAdapter(profile({ baseUrl: 'wss://llm-htx7kqge53767358.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference' }))?.id
    ).toBe('dashscope-realtime')
    expect(resolveAsrAdapter(profile({ baseUrl: 'https://dashscope.aliyuncs.com' }))?.id).toBe('aliyun')
  })

  it('routes the other two by host, and by preset when the host is a relay', () => {
    expect(resolveAsrAdapter(profile({ baseUrl: 'wss://asr.cloud.tencent.com/asr/v2' }))?.id).toBe('tencent-realtime')
    expect(resolveAsrAdapter(profile({ baseUrl: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel' }))?.id).toBe(
      'volcengine-streaming'
    )
    expect(resolveAsrAdapter(profile({ preset: 'aliyun-realtime-asr', baseUrl: 'wss://relay.internal/ws' }))?.id).toBe(
      'dashscope-realtime'
    )
    expect(resolveAsrAdapter(profile({ preset: 'volcengine-streaming-asr', baseUrl: 'wss://relay.internal/ws' }))?.id).toBe(
      'volcengine-streaming'
    )
  })
})

describe('dashscope realtime (run-task / finish-task)', () => {
  it('streams the take as PCM frames and joins the closed sentences', async () => {
    const take = wav()
    const actions: string[] = []
        const chunks: Buffer[] = []
    const server = await listenWs((frame, session) => {
      if (!frame.binary) {
        const message = JSON.parse(frame.payload.toString('utf8')) as {
          header: { action: string }
          payload: { model?: string; parameters?: { format?: string; sample_rate?: number } }
        }
        actions.push(message.header.action)
        if (message.header.action === 'run-task') {
          expect(message.payload.model).toBe('paraformer-realtime-v2')
          expect(message.payload.parameters?.format).toBe('pcm')
          expect(message.payload.parameters?.sample_rate).toBe(16_000)
          session.sendText(JSON.stringify({ header: { event: 'task-started' } }))
        }
        if (message.header.action === 'finish-task') {
          session.sendText(JSON.stringify({ header: { event: 'task-finished' } }))
        }
        return
      }
      chunks.push(frame.payload)
      if (chunks.length === 1) {
        session.sendText(
          JSON.stringify({ header: { event: 'result-generated' }, payload: { output: { sentence: { text: '你好', sentence_end: false } } } })
        )
      }
      if (chunks.length === 2) {
        session.sendText(
          JSON.stringify({
            header: { event: 'result-generated' },
            payload: { output: { sentence: { text: '你好世界。', sentence_end: true } } }
          })
        )
      }
    })

    try {
      const text = await spec('dashscope-realtime').run(
        context(`ws://127.0.0.1:${server.port}`, {}, 'sk-test'),
        input(take.bytes, 'paraformer-realtime-v2')
      )
      expect(text).toBe('你好世界。')
      expect(server.headers.authorization).toBe('bearer sk-test')
      expect(server.url.endsWith('/api-ws/v1/inference')).toBe(true)
      expect(actions).toEqual(['run-task', 'finish-task'])
      expect(Buffer.concat(chunks).equals(take.pcm)).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('surfaces task-failed as the vendor sentence', async () => {
    const take = wav()
    const server = await listenWs((frame, session) => {
      if (frame.binary) return
      session.sendText(
        JSON.stringify({ header: { event: 'task-failed', error_code: 'InvalidApiKey', error_message: 'Invalid API-key provided.' } })
      )
    })
    try {
      await expect(
        spec('dashscope-realtime').run(context(`ws://127.0.0.1:${server.port}`, {}, 'bad'), input(take.bytes))
      ).rejects.toThrow(/InvalidApiKey/)
    } finally {
      await server.close()
    }
  })
})

describe('tencent realtime (signed URL, binary PCM, end frame)', () => {
  it('signs host+path+raw query with HMAC-SHA1 and sends the take as binary frames', async () => {
    const take = wav()
    const chunks: Buffer[] = []
    let ended = false
    const server = await listenWs((frame, session) => {
      if (!frame.binary) {
        const message = JSON.parse(frame.payload.toString('utf8')) as { type?: string }
        if (message.type === 'end') {
          ended = true
          session.sendText(JSON.stringify({ code: 0, final: 1, result: { slice_type: 2, voice_text_str: '' } }))
        }
        return
      }
      chunks.push(frame.payload)
      if (chunks.length === 1) {
        session.sendText(JSON.stringify({ code: 0, result: { slice_type: 0, voice_text_str: '今天下午' } }))
      }
      if (chunks.length === 2) {
        session.sendText(JSON.stringify({ code: 0, result: { slice_type: 1, voice_text_str: '今天下午三点开会' } }))
      }
      if (chunks.length === 3) {
        session.sendText(JSON.stringify({ code: 0, result: { slice_type: 2, voice_text_str: '今天下午三点开会。' } }))
      }
    }, (session) => {
      // Tencent acks the handshake before any frame is sent; audio before it is dropped.
      session.sendText(JSON.stringify({ code: 0, message: 'success', voice_id: 'test' }))
    })

    try {
      const port = server.port
      const text = await spec('tencent-realtime').run(
        context(`ws://127.0.0.1:${port}/asr/v2`, {
          appId: '1250000000',
          secretId: 'AKIDtest',
          secretKey: 'secret',
          engine: '16k_zh'
        }),
        input(take.bytes)
      )
      expect(text).toBe('今天下午三点开会。')
      expect(ended).toBe(true)
      expect(Buffer.concat(chunks).equals(take.pcm)).toBe(true)

      const url = new URL(server.url)
      expect(url.pathname).toBe('/asr/v2/1250000000')
      expect(url.searchParams.get('engine_model_type')).toBe('16k_zh')
      expect(url.searchParams.get('voice_format')).toBe('1')
      expect(url.searchParams.get('needvad')).toBe('1')
      expect(url.searchParams.get('secretid')).toBe('AKIDtest')
      expect(Number(url.searchParams.get('expired'))).toBeGreaterThan(Number(url.searchParams.get('timestamp')))
      expect(url.searchParams.get('voice_id')).toMatch(/^[0-9a-f]{32}$/)

      // Recompute the signature the documented way: sorted raw pairs, no encoding.
      const pairs = [...url.searchParams.entries()]
        .filter(([key]) => key !== 'signature')
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([key, value]) => `${key}=${value}`)
        .join('&')
      const expected = createHmac('sha1', 'secret').update(`${server.host}/asr/v2/1250000000?${pairs}`).digest('base64')
      expect(url.searchParams.get('signature')).toBe(expected)
    } finally {
      await server.close()
    }
  })

  it('explains an auth failure instead of just quoting the code', async () => {
    const server = await listenWs(
      () => {},
      (session) => {
        session.sendText(JSON.stringify({ code: 4002, message: 'auth failed' }))
      }
    )
    try {
      await expect(
        spec('tencent-realtime').run(
          context(`ws://127.0.0.1:${server.port}/asr/v2`, {
            appId: '1250000000',
            secretId: 'AKIDtest',
            secretKey: 'secret'
          }),
          input(wav().bytes)
        )
      ).rejects.toThrow(/鉴权失败/)
    } finally {
      await server.close()
    }
  })
})

describe('volcengine streaming (binary envelope + gzip)', () => {
  /** A server frame in the SAUC shape: header, optional sequence, length, payload. */
  function reply(body: unknown, flags: number, sequence = 0): Buffer {
    const payload = gzipSync(Buffer.from(JSON.stringify(body)))
    const header = Buffer.from([0x11, (0x0b << 4) | flags, 0x11, 0x00])
    const size = Buffer.alloc(4)
    size.writeUInt32BE(payload.byteLength)
    const parts = [header]
    if ((flags & 0x01) !== 0) {
      const seq = Buffer.alloc(4)
      seq.writeInt32BE(sequence)
      parts.push(seq)
    }
    parts.push(size, payload)
    return Buffer.concat(parts)
  }

  it('sends a gzip JSON greeting, gzip PCM packets, and accepts a flagged last packet', async () => {
    const take = wav()
    const packets: Buffer[] = []
    const flagsSeen: number[] = []
    let greeting: { audio?: { rate?: number }; request?: { model_name?: string } } | null = null
    const server = await listenWs((frame, session) => {
      if (!frame.binary) return
      const type = frame.payload[1] >> 4
      const flags = frame.payload[1] & 0x0f
      const size = frame.payload.readUInt32BE(4)
      const body = gunzipSync(frame.payload.subarray(8, 8 + size))
      if (type === 0x1) {
        greeting = JSON.parse(body.toString('utf8')) as typeof greeting
        session.sendBinary(reply({ result: { text: '' } }, 0x01, 1))
        return
      }
      packets.push(body)
      flagsSeen.push(flags)
      if (flags !== 0x02) {
        session.sendBinary(reply({ result: { text: '今天下午' } }, 0x01, packets.length))
        return
      }
      session.sendBinary(reply({ result: { text: '今天下午三点开会。' } }, 0x03, -2))
    })

    try {
      const text = await spec('volcengine-streaming').run(
        context(`ws://127.0.0.1:${server.port}`, {
          appId: 'app-1',
          accessKey: 'token-1',
          resourceId: 'volc.seedasr.sauc.duration'
        }),
        input(take.bytes)
      )
      expect(text).toBe('今天下午三点开会。')
      expect(server.headers['x-api-app-key']).toBe('app-1')
      expect(server.headers['x-api-access-key']).toBe('token-1')
      expect(server.headers['x-api-resource-id']).toBe('volc.seedasr.sauc.duration')
      // Read through a fresh binding: the handshake is stored from inside the
      // server callback, which the compiler cannot see, so `greeting` is still
      // narrowed to `null` at this point.
      const greeted = greeting as { audio?: { rate?: number }; request?: { model_name?: string } } | null
      expect(greeted?.audio?.rate).toBe(16_000)
      expect(greeted?.request?.model_name).toBe('bigmodel')
      // 0.3 s in 200 ms packets: two of them, the second one flagged as last.
      expect(packets).toHaveLength(2)
      expect(Buffer.concat(packets).equals(take.pcm)).toBe(true)
      expect(flagsSeen).toEqual([0x00, 0x02])
    } finally {
      await server.close()
    }
  })

  it('sends the new-console API key as X-Api-Key and defaults Resource Id to 2.0', async () => {
    const take = wav()
    const server = await listenWs((frame, session) => {
      if (!frame.binary) return
      if ((frame.payload[1] >> 4) === 0x1) {
        session.sendBinary(reply({ result: { text: '' } }, 0x01, 1))
        return
      }
      if ((frame.payload[1] & 0x0f) !== 0x02) return
      session.sendBinary(reply({ result: { text: '收到了。' } }, 0x03, -2))
    })

    try {
      const text = await spec('volcengine-streaming').run(
        context(`ws://127.0.0.1:${server.port}`, {}, 'api-key-from-new-console'),
        input(take.bytes, 'bigmodel')
      )
      expect(text).toBe('收到了。')
      expect(server.headers['x-api-key']).toBe('api-key-from-new-console')
      // The old-console pair must not ride along: the service rejects the mix.
      expect(server.headers['x-api-app-key']).toBeUndefined()
      expect(server.headers['x-api-access-key']).toBeUndefined()
      expect(server.headers['x-api-resource-id']).toBe('volc.seedasr.sauc.duration')
    } finally {
      await server.close()
    }
  })

  it('says which credential it needs when the profile has neither', async () => {
    await expect(
      spec('volcengine-streaming').run(context('ws://127.0.0.1:1', {}), input(wav().bytes))
    ).rejects.toThrow(/API Key/)
  })
})

// ---------------------------------------------------------------------------
// 讯飞 实时语音转写 (RTASR)
//
// Two things here are worth pinning down rather than trusting: the signature
// (the doc ships a worked example, so the casing of the MD5 is checkable) and
// the assembly rule (finals carry the whole sentence, so appending every frame
// repeats the text).
// ---------------------------------------------------------------------------

describe('xfyun rta signature', () => {
  it('reproduces the worked example from the API doc', () => {
    // appid 595f23df + ts 1512041814 → md5 0829d4012497c14a30e7e72aeebe565e
    expect(xfyunRtaSigna('595f23df', '1512041814', 'd9f4aa7ea6d94faca62cd88a28fd5234')).toBe(
      'IrrzsJeOFk1NGfJHW6SkHUoN9CU='
    )
  })
})

describe('xfyun rta assembly', () => {
  it('appends each final sentence once, in segment order', () => {
    expect(
      xfyunRtaJoin([
        { seg: 0, text: '今天下午三点', final: false },
        { seg: 1, text: '今天下午三点开会', final: true },
        { seg: 2, text: '请把纪要发我', final: true }
      ])
    ).toBe('今天下午三点开会请把纪要发我')
  })

  it('keeps the longest interim when the take ends mid-sentence', () => {
    expect(
      xfyunRtaJoin([
        { seg: 0, text: '提醒我明天', final: true },
        { seg: 1, text: '上午', final: false },
        { seg: 2, text: '上午要提交周报', final: false }
      ])
    ).toBe('提醒我明天上午要提交周报')
  })

  it('reads the string form of the sentence type', () => {
    expect(xfyunRtaJoin([{ seg: 0, text: '一句话', final: true }])).toBe('一句话')
  })
})

describe('xfyun rta socket', () => {
  it('signs the query, streams raw PCM, and closes the session with the exact end frame', async () => {
    const take = wav()
    let voice = 0
    let endBytes: Buffer | null = null
    const result = (seg: number, type: string, text: string): string =>
      JSON.stringify({
        action: 'result',
        code: '0',
        desc: 'success',
        data: JSON.stringify({ seg_id: seg, cn: { st: { type, rt: [{ ws: [{ cw: [{ w: text }] }] }] } } })
      })
    const server = await listenWs((frame, session) => {
      if (!frame.binary) return
      // The end marker must be the doc's exact bytes, binary frame included.
      if (frame.payload.equals(Buffer.from('{"end": true}'))) {
        endBytes = frame.payload
        // 讯飞 only flushes the trailing sentence after the marker, then closes.
        session.sendText(result(1, '0', '。'))
        session.close()
        return
      }
      voice += 1
      if (voice > 1) return
      session.sendText(result(0, '1', '你好'))
      session.sendText(result(0, '0', '你好。'))
    })

    try {
      const text = await spec('xfyun-rta').run(
        context(`ws://127.0.0.1:${server.port}`, { appId: '595f23df' }, 'api-key-only'),
        input(take.bytes)
      )
      // The interim repeated the final, and both were dropped once each: two
      // segments, not the concatenation of every frame the server sent.
      expect(text).toBe('你好。。')
      const url = new URL(server.url)
      expect(url.pathname).toBe('/v1/ws')
      expect(url.searchParams.get('appid')).toBe('595f23df')
      const ts = String(url.searchParams.get('ts'))
      expect(url.searchParams.get('signa')).toBe(xfyunRtaSigna('595f23df', ts, 'api-key-only'))
      expect(endBytes).toEqual(Buffer.from('{"end": true}'))
    } finally {
      await server.close()
    }
  })

  it('names the credential when the profile has none', async () => {
    await expect(spec('xfyun-rta').run(context('ws://127.0.0.1:1', { appId: 'ab' }), input(wav().bytes))).rejects.toThrow(
      /APIKey/
    )
  })
})
