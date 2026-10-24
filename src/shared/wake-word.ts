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
