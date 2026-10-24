export interface WakeWordStatus {
  phase: 'off' | 'starting' | 'listening' | 'paused' | 'error'
  /** A stable error key; translated by the UI. */
  error?: 'language' | 'microphone' | 'unavailable'
}
