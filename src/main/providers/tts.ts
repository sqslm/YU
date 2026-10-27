import { randomUUID } from 'node:crypto'
import type { SpeechAudio, TtsSettings } from '@shared/speech'
import { mt } from '@shared/mainI18n'

const MAX_RESPONSE_BYTES = 24 * 1024 * 1024

function endpoint(value: string): string {
  const url = new URL(value)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw Error('Invalid TTS endpoint')
  return url.toString()
}

async function read(response: Response): Promise<Buffer> {
  if (!response.body) throw Error('TTS returned an empty response')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > MAX_RESPONSE_BYTES) throw Error('TTS response is too large')
      chunks.push(value)
    }
  } catch (error) { await reader.cancel().catch(() => undefined); throw error }
  return Buffer.concat(chunks)
}

function xml(text: string): string {
  return text.replace(/[<>&"']/g, value => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[value]!)
}

/** Provider credentials stay in main; Chromium receives only the resulting audio bytes. */
export async function synthesizeSpeech(settings: TtsSettings, text: string, signal?: AbortSignal): Promise<SpeechAudio> {
  if (!settings.baseUrl) throw Error(mt('请配置 TTS 接口地址'))
  if (!settings.apiVoice) throw Error(mt('请配置 TTS 音色 ID'))
  if (settings.provider !== 'azure' && !settings.model) throw Error(mt('请配置 TTS 模型'))
  if (settings.provider !== 'custom' && !settings.apiKey) throw Error(mt('请配置 TTS API Key'))
  let url = endpoint(settings.baseUrl)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`
  let body: unknown = { model: settings.model, input: text, voice: settings.apiVoice, response_format: 'mp3' }
  switch (settings.provider) {
    case 'minimax':
      body = { model: settings.model, text, stream: false, output_format: 'hex', voice_setting: { voice_id: settings.apiVoice, speed: 1, vol: 1 }, audio_setting: { format: 'mp3', sample_rate: 32000, channel: 1 } }
      break
    case 'dashscope':
      body = { model: settings.model, input: { text, voice: settings.apiVoice, language_type: 'Auto' } }
      break
    case 'volcengine':
      delete headers.Authorization
      headers['X-Api-Key'] = settings.apiKey
      headers['X-Api-Resource-Id'] = settings.model
      headers['X-Api-Request-Id'] = randomUUID()
      body = { user: { uid: 'yu' }, req_params: { text, speaker: settings.apiVoice, audio_params: { format: 'mp3', sample_rate: 24000 } } }
      break
    case 'elevenlabs':
      delete headers.Authorization
      headers['xi-api-key'] = settings.apiKey
      url = `${url.replace(/\/$/, '')}/${encodeURIComponent(settings.apiVoice)}?output_format=mp3_44100_128`
      body = { text, model_id: settings.model }
      break
    case 'azure':
      delete headers.Authorization
      headers['Ocp-Apim-Subscription-Key'] = settings.apiKey
      headers['Content-Type'] = 'application/ssml+xml'
      headers['X-Microsoft-OutputFormat'] = 'audio-24khz-48kbitrate-mono-mp3'
      headers['User-Agent'] = 'YU'
      body = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${xml(settings.apiVoice.split('-').slice(0, 2).join('-'))}"><voice name="${xml(settings.apiVoice)}">${xml(text)}</voice></speak>`
      break
    default: {
      const parsed = new URL(url)
      if (/\/(?:v1\/?)?$/.test(parsed.pathname)) {
        parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}/audio/speech`
        url = parsed.toString()
      }
    }
  }
  const timeout = AbortSignal.timeout(120_000)
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  const fetchBytes = async (target: string, options: RequestInit): Promise<{ bytes: Buffer; mime: string }> => {
    const response = await fetch(target, { ...options, signal: requestSignal, redirect: 'error' })
    const bytes = await read(response)
    if (!response.ok) {
      const message = bytes.toString('utf8').slice(0, 500)
      throw Error(`TTS HTTP ${response.status}: ${settings.apiKey ? message.replaceAll(settings.apiKey, '[redacted]') : message}`)
    }
    return { bytes, mime: response.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream' }
  }
  const result = await fetchBytes(url, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })
  let audio: SpeechAudio
  if (settings.provider === 'minimax') {
    const data = JSON.parse(result.bytes.toString())
    if (data.base_resp?.status_code !== 0) throw Error(`MiniMax: ${data.base_resp?.status_msg ?? 'Invalid response'}`)
    const hex = data.data?.audio
    if (typeof hex !== 'string' || !/^(?:[a-f\d]{2})+$/i.test(hex)) throw Error('MiniMax returned no audio')
    audio = { bytes: Buffer.from(hex, 'hex'), mime: 'audio/mpeg' }
  } else if (settings.provider === 'dashscope') {
    const data = JSON.parse(result.bytes.toString())
    const audioUrl = data.output?.audio?.url
    if (typeof audioUrl !== 'string') throw Error(`Qwen: ${data.message ?? 'No audio URL returned'}`)
    // Never send the API key to the object storage URL returned by Qwen.
    audio = await fetchBytes(endpoint(audioUrl), { method: 'GET' })
  } else if (settings.provider === 'volcengine') {
    const chunks: Buffer[] = []
    for (const line of result.bytes.toString().split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      const data = JSON.parse(line.slice(5).trim())
      if (data.code !== 0 && data.code !== 20000000) throw Error(`Doubao: ${data.message ?? data.code}`)
      if (typeof data.data === 'string' && data.data) chunks.push(Buffer.from(data.data, 'base64'))
    }
    audio = { bytes: Buffer.concat(chunks), mime: 'audio/mpeg' }
  } else audio = result
  if (!audio.bytes.length) throw Error('TTS returned no audio')
  if (!audio.mime.startsWith('audio/') && audio.mime !== 'application/octet-stream') throw Error('TTS returned a non-audio response')
  return audio
}
