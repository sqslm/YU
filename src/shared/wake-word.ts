export const MIN_WAKE_CONFIDENCE = 0.5
export const MAX_WAKE_CONFIDENCE = 0.99

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
}
