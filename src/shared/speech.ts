/**
 * Read-aloud (TTS) contract shared by the main process, the settings page and
 * the model-facing tool.
 *
 * A synthesizer reads what it is given, literally: `**粗体**` comes out as
 * "asterisk asterisk …", a URL as a minute of letters, a code fence as
 * punctuation soup. {@link speechText} therefore rewrites a rendered answer
 * into text that only makes sense to an ear. Everything here is pure, so the
 * cleanup rules are unit-testable without Electron and without an audio device.
 */

/** Longer answers are cut at a sentence boundary; a spoken monologue is unusable. */
export const MAX_SPEECH_CHARS = 1200

export interface TtsSettings {
  /** Off by default: reading a whole answer out loud unprompted is intrusive. */
  enabled: boolean
  /** Installed voice name; empty means "let the system pick". */
  voice: string
  /** SAPI rate: -10 slowest, 0 normal, 10 fastest. */
  rate: number
  /** Playback volume, percent. */
  volume: number
  provider: TtsProvider
  baseUrl: string
  apiKey: string
  apiKeyEnc?: string
  model: string
  apiVoice: string
  /** API voices use a playback speed multiplier; the SAPI rate stays separate. */
  speed: number
  /** Saved connections let switching providers retain each provider's own credentials. */
  connections?: Partial<Record<TtsProvider, TtsConnection>>
}
export interface TtsConnection { baseUrl: string; apiKey: string; apiKeyEnc?: string; model: string; apiVoice: string }

export const TTS_PRESETS = {
  windows: { label: 'Windows', baseUrl: '', model: '', apiVoice: '' },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1/audio/speech', model: 'gpt-4o-mini-tts', apiVoice: 'alloy' },
  siliconflow: { label: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1/audio/speech', model: 'FunAudioLLM/CosyVoice2-0.5B', apiVoice: 'FunAudioLLM/CosyVoice2-0.5B:alex' },
  minimax: { label: 'MiniMax', baseUrl: 'https://api.minimax.cn/v1/t2a_v2', model: 'speech-2.8-hd', apiVoice: 'male-qn-qingse' },
  dashscope: { label: '阿里云百炼 / Qwen', baseUrl: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', model: 'qwen3-tts-flash', apiVoice: 'Cherry' },
  volcengine: { label: '火山引擎 / 豆包', baseUrl: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse', model: 'seed-tts-2.0', apiVoice: 'zh_female_vv_uranus_bigtts' },
  elevenlabs: { label: 'ElevenLabs', baseUrl: 'https://api.elevenlabs.io/v1/text-to-speech', model: 'eleven_multilingual_v2', apiVoice: 'JBFqnCBsd6RMkjVDRZzb' },
  azure: { label: 'Azure Speech', baseUrl: 'https://eastasia.tts.speech.microsoft.com/cognitiveservices/v1', model: '', apiVoice: 'zh-CN-XiaoxiaoNeural' },
  custom: { label: '自定义 OpenAI 兼容', baseUrl: '', model: '', apiVoice: '' }
} as const
export type TtsProvider = keyof typeof TTS_PRESETS

export const DEFAULT_TTS_SETTINGS: TtsSettings = {
  enabled: false, voice: '', rate: 0, volume: 100,
  provider: 'windows', baseUrl: '', apiKey: '', model: '', apiVoice: '', speed: 1
}

export interface SpeechAudio { bytes: Uint8Array; mime: string }
export interface SpeechPlaybackRequest { id: string; action: 'play' | 'pause' | 'resume' | 'stop'; audio?: SpeechAudio; volume?: number; speed?: number }
export interface SpeechPlaybackReply { id: string; event: 'started' | 'ended' | 'control' | 'error'; error?: string }

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

/** Settings files are hand-editable, so a numeric field can come back as a string. */
function toNumber(input: unknown, fallback: number): number {
  if (typeof input === 'number' && Number.isFinite(input)) return input
  if (typeof input === 'string' && input.trim()) {
    const parsed = Number(input)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

/**
 * Coerces whatever the settings file held into a usable voice configuration.
 *
 * Rate and volume are rounded because SAPI exposes them as integers: passing
 * 2.5 would be converted silently somewhere inside PowerShell, and a rounding
 * rule we write down beats one we discover later.
 */
export function normalizeTtsSettings(input: unknown): TtsSettings {
  const source: Record<string, unknown> = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {}
  const connection = (value: Record<string, unknown>): TtsConnection => ({
    baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl.trim() : '',
    apiKey: typeof value.apiKey === 'string' ? value.apiKey.trim() : '',
    ...(typeof value.apiKeyEnc === 'string' ? { apiKeyEnc: value.apiKeyEnc } : {}),
    model: typeof value.model === 'string' ? value.model.trim() : '',
    apiVoice: typeof value.apiVoice === 'string' ? value.apiVoice.trim() : ''
  })
  const connections: TtsSettings['connections'] = {}
  if (source.connections && typeof source.connections === 'object') {
    for (const [key, value] of Object.entries(source.connections)) {
      if (Object.hasOwn(TTS_PRESETS, key) && key !== 'windows' && value && typeof value === 'object') connections[key as TtsProvider] = connection(value as Record<string, unknown>)
    }
  }
  return {
    // Strict `true`: a stored "false" string must never switch reading on.
    enabled: source.enabled === true,
    voice: typeof source.voice === 'string' ? source.voice.trim() : '',
    rate: Math.round(clamp(toNumber(source.rate, DEFAULT_TTS_SETTINGS.rate), -10, 10)),
    volume: Math.round(clamp(toNumber(source.volume, DEFAULT_TTS_SETTINGS.volume), 0, 100)),
    provider: typeof source.provider === 'string' && Object.hasOwn(TTS_PRESETS, source.provider) ? source.provider as TtsProvider : 'windows',
    ...connection(source),
    speed: clamp(toNumber(source.speed, 1), 0.5, 2),
    ...(Object.keys(connections).length ? { connections } : {})
  }
}

/** Emoji, skin-tone modifiers and flags. */
let pictographic: RegExp | null = null
try {
  pictographic = new RegExp('[\\p{Extended_Pictographic}\\p{Emoji_Modifier}\\p{Regional_Indicator}]', 'gu')
} catch {
  // Property escapes need a Unicode-aware engine; the block list below is the
  // portable subset and keeps the function working on an older runtime.
  pictographic = null
}

const PICTOGRAPHIC_BLOCKS = new RegExp('[\\u{1F000}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{2B00}-\\u{2BFF}\\u3030\\u303D\\u3297\\u3299]', 'gu')

/** Control and zero-width codepoints: never audible, sometimes visible as boxes. */
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\u20E3\uFEFF\uFE0E\uFE0F]/g

const ORDERED_MARKER = /^\d{1,2}[.)]\s+/
const BULLET_MARKER = /^[-*+]\s+/
const HEADING_MARKER = /^#{1,6}\s+/
/** A table separator row (`|---|---|`) or a horizontal rule (`---`): no words in it. */
const RULE_OR_SEPARATOR = /^[|\s:-]{3,}$/

function stripEmojiAndInvisible(text: string): string {
  // Invisible codepoints vanish so they cannot split a word; a pictograph
  // becomes a space so the words on both sides do not fuse into one.
  const withoutInvisible = text.replace(INVISIBLE, '')
  return pictographic ? withoutInvisible.replace(pictographic, ' ') : withoutInvisible.replace(PICTOGRAPHIC_BLOCKS, ' ')
}

/**
 * Removes the Markdown scaffolding while keeping the words a listener needs.
 *
 * Link text survives because that is what a person would read out; the target
 * is dropped. Inline code keeps its content (usually an identifier the listener
 * asked about) while code fences go entirely — nobody wants a script recited.
 */
function stripMarkdown(source: string): string {
  let text = source.replace(/\r\n?/g, '\n')
  text = text.replace(/```[\s\S]*?```/g, ' ').replace(/~~~[\s\S]*?~~~/g, ' ')
  // An unterminated fence runs to the end of the message; there is no closing
  // marker to trust, so the remainder is treated as code as well.
  text = text.replace(/(?:```|~~~)[\s\S]*$/, ' ')
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  text = text.replace(/!\[[^\]]*\]\[[^\]]*\]/g, ' ')
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  text = text.replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
  text = text.replace(/\[\^[^\]]*\]/g, ' ')
  text = text.replace(/<!--[\s\S]*?-->/g, ' ')
  text = text.replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
  // Bare URLs are noise by ear. Chinese punctuation ends the match so a URL
  // glued to a sentence does not swallow the words after it.
  text = text.replace(/(?:https?:\/\/|www\.)[^\s<>"'，。、；：！？）】」』]+/gi, ' ')
  text = text.replace(/`+([^`\n]+)`+/g, '$1')

  const lines: string[] = []
  for (const raw of text.split('\n')) {
    let line = raw.trim()
    if (RULE_OR_SEPARATOR.test(line) && line.includes('-')) continue
    line = line.replace(HEADING_MARKER, '')
    line = line.replace(/^>\s?/, '')
    line = line.replace(/^>\s?/, '')
    line = line.replace(BULLET_MARKER, '')
    // Ordered numbers go too: SAPI reads "1." as "one" and the number then
    // interrupts the sentence it belongs to.
    line = line.replace(ORDERED_MARKER, '')
    line = line.replace(/\[[ xX]\]\s*/g, '')
    lines.push(line.replace(/\|/g, ' '))
  }
  text = lines.join('\n')

  text = text.replace(/\*\*([^*\n]+)\*\*/g, '$1')
  text = text.replace(/__([^_\n]+)__/g, '$1')
  text = text.replace(/~~([^~\n]+)~~/g, '$1')
  // Single markers only when they wrap a whole word: `snake_case` must survive.
  text = text.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, '$1')
  text = text.replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, '$1')
  // Whatever is left is a marker with nothing to wrap; it would be spoken.
  text = text.replace(/[*~`]/g, ' ')
  text = text.replace(/(?<![A-Za-z0-9])#+/g, ' ')
  text = text.replace(/(?<![A-Za-z0-9])_+|_+(?![A-Za-z0-9])/g, ' ')
  return text
}

/** Collapses layout whitespace and repeated punctuation without eating 句读. */
function tidy(text: string): string {
  let out = text.replace(/\s+/g, ' ')
  out = out.replace(/\s+([，。、；：！？）】》」』”’,.!?;:)])/g, '$1')
  out = out.replace(/([（【《「『“‘(])\s+/g, '$1')
  // "！！！！" is one exclamation to a reader; four of them are four pauses.
  out = out.replace(/([!?！？。，、；：,.;:])\1+/g, '$1')
  out = out.replace(/…{3,}/g, '……')
  return out.trim()
}

/** Sentence enders a cut may land after; a decimal point is not one. */
const SENTENCE_END = /[。！？!?；;…]|\.(?=\s|$)/g

function shorten(text: string, limit: number): string {
  // One character is reserved for the ellipsis, so the result honours `limit`.
  const window = text.slice(0, limit - 1)
  let cut = -1
  for (const match of window.matchAll(SENTENCE_END)) cut = match.index + match[0].length
  // A cut that throws away most of the budget sounds like the answer was
  // dropped; below half, a mid-sentence cut is the better trade.
  const hard = cut < window.length / 2
  let body = (hard ? window : window.slice(0, cut)).trimEnd()
  if (hard) body = body.replace(/[，,、；;：:\s]+$/, '')
  return `${body}…`
}

/**
 * The text to hand a synthesizer, or `''` when there is nothing to say.
 *
 * `''` is the caller's signal to skip: the tool layer reports the skip honestly
 * instead of letting the model pretend the answer was read out.
 */
export function speechText(input: unknown, limit?: number): string {
  if (typeof input !== 'string') return ''
  const text = tidy(stripEmojiAndInvisible(stripMarkdown(input)))
  if (!text) return ''
  const max = Math.max(1, Math.floor(limit ?? MAX_SPEECH_CHARS))
  return text.length > max ? shorten(text, max) : text
}
