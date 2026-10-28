export const MIN_WAKE_CONFIDENCE = 0.1
export const MAX_WAKE_CONFIDENCE = 0.99

export interface WakeTraining {
  phrase: string
  variants: Array<{ text: string; phones: string }>
  sampleCount: number
  trainedAt: number
}
export interface WakeTrainingSample { text: string; phones: string; targetPhones: string; confidence: number }

export function normalizeWakeTraining(value: unknown, phrase: string): WakeTraining | undefined {
  if (!value || typeof value !== 'object') return undefined
  const row = value as Partial<WakeTraining>
  if (row.phrase !== phrase || !Array.isArray(row.variants) || row.variants.length < 1 || row.variants.length > 3 || !Number.isFinite(row.trainedAt)) return undefined
  const variants = row.variants.filter(item => typeof item?.text === 'string' && item.text.length >= 2 && item.text.length <= 80 && typeof item.phones === 'string' && item.phones.length > 0 && item.phones.length <= 240)
  if (variants.length !== row.variants.length) return undefined
  return { phrase, variants, sampleCount: Math.min(3, Math.max(2, row.sampleCount ?? 3)), trainedAt: row.trainedAt! }
}

function similarity(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1]
    for (let j = 0; j < b.length; j++) next.push(Math.min(next[j] + 1, previous[j + 1] + 1, previous[j] + (a[i] === b[j] ? 0 : 1)))
    previous = next
  }
  return 1 - previous[b.length] / Math.max(1, a.length, b.length)
}

/** Learn the same offline recognizer's consistent pronunciation errors, not arbitrary aliases. */
export function learnWakeTraining(phrase: string, samples: WakeTrainingSample[], confidence: number): { training: WakeTraining; confidence: number } {
  if (samples.length !== 3) throw new Error('请录制三次唤醒词')
  const letters = phrase.replace(/[^\p{L}\p{N}]/gu, '')
  const valid = samples.filter(sample => sample.text?.replace(/[^\p{L}\p{N}]/gu, '').length >= Math.ceil(letters.length * 0.8) && sample.phones?.length <= 240 && sample.targetPhones &&
    Number.isFinite(sample.confidence) && sample.confidence > 0 && similarity(sample.phones, sample.targetPhones) >= 0.6)
  const consistent = valid.filter(sample => valid.some(other => other !== sample && similarity(sample.phones, other.phones) >= 0.7))
  if (consistent.length < 2) throw new Error('未识别到两次一致的完整唤醒词，请在安静环境中重新录制')
  const variants = [...new Map(consistent.map(sample => [sample.phones, { text: sample.text, phones: sample.phones }])).values()]
  return { training: { phrase, variants, sampleCount: consistent.length, trainedAt: Date.now() },
    confidence: normalizeWakeConfidence(Math.min(confidence, Math.min(...consistent.map(sample => sample.confidence)) * 0.8), phrase) }
}

export function isShortWakePhrase(phrase: string): boolean {
  const letters = phrase.replace(/[^\p{L}\p{N}]/gu, '')
  return /[\u3400-\u9fff]/u.test(letters) ? letters.length < 4 : phrase.trim().split(/\s+/).length < 2
}

/** Keep the former stricter default for short phrases when upgrading old settings. */
export function normalizeWakeConfidence(value: unknown, phrase: string): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.min(MAX_WAKE_CONFIDENCE, Math.max(MIN_WAKE_CONFIDENCE, value)) * 100) / 100
    : isShortWakePhrase(phrase) ? 0.94 : 0.8
}

export interface WakeWordStatus {
  phase: 'off' | 'starting' | 'listening' | 'paused' | 'error'
  /** A stable error key; translated by the UI. */
  error?: 'language' | 'microphone' | 'unavailable'
  /**
   * A stable notice key, not a sentence: the UI translates it. Set when the
   * recogniser had to fall back to the default input, so the fallback is visible
   * instead of silently listening to a different microphone than the one chosen.
   */
  deviceNotice?: 'device-missing'
  /** Matching phrase rejected by the user's threshold; contains no spoken text/audio. */
  lastMatchConfidence?: number
  audioLevel?: number
  deviceName?: string
}
