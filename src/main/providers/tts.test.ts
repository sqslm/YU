import { createServer, type Server } from 'node:http'
import { randomInt } from 'node:crypto'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { DEFAULT_TTS_SETTINGS, TTS_PRESETS, type TtsProvider } from '@shared/speech'
import { synthesizeSpeech } from './tts'

let server: Server, baseUrl: string
const calls: Array<{ url: string; headers: Record<string, unknown>; body: string }> = []
let respond: (url: string) => { status?: number; mime?: string; headers?: Record<string, string>; body: string | Buffer }
const mp3 = Buffer.from('ID3-test-audio')
beforeEach(async () => {
  calls.length = 0
  respond = () => ({ mime: 'audio/mpeg', body: mp3 })
  server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    calls.push({ url: req.url!, headers: req.headers, body })
    const reply = respond(req.url!)
    res.writeHead(reply.status ?? 200, { 'Content-Type': reply.mime ?? 'application/json', ...reply.headers })
    res.end(reply.body)
  })
  // This host allocates ephemeral ports below 10,000 too, including Fetch's
  // forbidden ports. Use an unblocked range without changing the real client.
  await new Promise<void>((resolve, reject) => {
    let attempts = 0
    const listen = (): void => {
      const failed = (error: NodeJS.ErrnoException): void => {
        if (error.code === 'EADDRINUSE' && attempts < 5) listen()
        else reject(error)
      }
      attempts++
      server.once('error', failed)
      server.listen(randomInt(20000, 60000), '127.0.0.1', () => { server.removeListener('error', failed); resolve() })
    }
    listen()
  })
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
const config = (provider: TtsProvider) => ({ ...DEFAULT_TTS_SETTINGS, ...TTS_PRESETS[provider], provider, apiKey: 'test-key', baseUrl: baseUrl + '/tts' })

it.each(['openai', 'siliconflow', 'custom'] as const)('uses the %s speech protocol and receives binary audio', async provider => {
  const audio = await synthesizeSpeech({ ...config(provider), model: 'tts', apiVoice: 'voice', baseUrl: baseUrl + '/v1' }, '你好')
  expect(Buffer.from(audio.bytes)).toEqual(mp3)
  expect(calls[0]).toMatchObject({ url: '/v1/audio/speech', headers: { authorization: 'Bearer test-key' } })
  expect(JSON.parse(calls[0].body)).toEqual({ model: 'tts', input: '你好', voice: 'voice', response_format: 'mp3' })
})
it('decodes MiniMax hex audio and checks business errors even on HTTP 200', async () => {
  respond = () => ({ body: JSON.stringify({ base_resp: { status_code: 0 }, data: { audio: mp3.toString('hex') } }) })
  expect(Buffer.from((await synthesizeSpeech(config('minimax'), 'hello')).bytes)).toEqual(mp3)
  expect(JSON.parse(calls[0].body)).toMatchObject({ text: 'hello', stream: false, output_format: 'hex', voice_setting: { voice_id: 'male-qn-qingse' } })
  respond = () => ({ body: JSON.stringify({ base_resp: { status_code: 1004, status_msg: 'unauthorized' } }) })
  await expect(synthesizeSpeech(config('minimax'), 'hello')).rejects.toThrow('unauthorized')
})
it('downloads Qwen audio without forwarding the provider credential', async () => {
  respond = url => url === '/audio' ? { body: mp3, mime: 'audio/wav' } : { body: JSON.stringify({ output: { audio: { url: baseUrl + '/audio' } } }) }
  expect((await synthesizeSpeech(config('dashscope'), 'hello')).mime).toBe('audio/wav')
  expect(JSON.parse(calls[0].body)).toMatchObject({ input: { text: 'hello', voice: 'Cherry' } })
  expect(calls[1].headers.authorization).toBeUndefined()
})
it('combines Doubao SSE chunks and refuses a later business failure', async () => {
  respond = () => ({ mime: 'text/event-stream', body: `event: audio\ndata: {"code":0,"data":"${mp3.toString('base64')}"}\n\ndata: {"code":20000000}\n\n` })
  expect(Buffer.from((await synthesizeSpeech(config('volcengine'), 'hello')).bytes)).toEqual(mp3)
  expect(calls[0].headers).toMatchObject({ 'x-api-key': 'test-key', 'x-api-resource-id': 'seed-tts-2.0' })
  expect(calls[0].headers.authorization).toBeUndefined()
  respond = () => ({ body: 'data: {"code":45000000,"message":"speaker denied"}\n' })
  await expect(synthesizeSpeech(config('volcengine'), 'hello')).rejects.toThrow('speaker denied')
})
it('uses ElevenLabs voice paths and its own authentication', async () => {
  await synthesizeSpeech(config('elevenlabs'), 'hello')
  expect(calls[0]).toMatchObject({ url: '/tts/JBFqnCBsd6RMkjVDRZzb?output_format=mp3_44100_128', headers: { 'xi-api-key': 'test-key' } })
  expect(JSON.parse(calls[0].body)).toMatchObject({ model_id: 'eleven_multilingual_v2', text: 'hello' })
})
it('escapes Azure SSML and uses subscription-key authentication', async () => {
  await synthesizeSpeech(config('azure'), 'A < B & "C"')
  expect(calls[0].body).toContain('A &lt; B &amp; &quot;C&quot;')
  expect(calls[0].headers).toMatchObject({ 'ocp-apim-subscription-key': 'test-key', 'content-type': 'application/ssml+xml' })
})
it('permits keyless local compatible services and refuses empty/non-audio responses', async () => {
  const settings = { ...config('custom'), model: 'tts', apiVoice: 'local', apiKey: '' }
  await synthesizeSpeech(settings, 'hello')
  expect(calls[0].headers.authorization).toBeUndefined()
  respond = () => ({ body: JSON.stringify({ error: 'no voice' }) })
  await expect(synthesizeSpeech(settings, 'hello')).rejects.toThrow('non-audio')
  respond = () => ({ body: '', mime: 'audio/mpeg' })
  await expect(synthesizeSpeech(settings, 'hello')).rejects.toThrow('no audio')
})
it('reports HTTP errors without echoing the key and never follows a credentialed redirect', async () => {
  respond = () => ({ status: 401, body: 'invalid test-key' })
  await expect(synthesizeSpeech(config('openai'), 'hello')).rejects.toThrow('401: invalid [redacted]')
  respond = () => ({ status: 302, headers: { Location: baseUrl + '/redirected' }, body: '' })
  await expect(synthesizeSpeech(config('openai'), 'hello')).rejects.toThrow()
  expect(calls.some(call => call.url === '/redirected')).toBe(false)
  const controller = new AbortController(); controller.abort()
  const count = calls.length
  await expect(synthesizeSpeech(config('openai'), 'hello', controller.signal)).rejects.toThrow()
  expect(calls).toHaveLength(count)
})
