import type { Settings } from '@shared/types'
import { mt } from '@shared/mainI18n'
import { decodeWavPcm16, isSilent } from './audio/wav'
import { transcribe } from './providers/asr'
import { chainFor, withFailover } from './providers/chain'
import { generateFromAudio } from './providers/gemini'
import { randomUUID } from 'node:crypto'
const ASK_TRANSCRIBE_PROMPT = 'Transcribe the audio exactly. Return only the spoken words, without answering the question.'

/** A card recording has its own cancellation scope; it must not reset the Ask thread. */
export class CardVoice {
  private controller: AbortController | null = null
  private submitting = false
  private id = ''
  constructor(private deps: {
    settings(): Settings
    changed(): void
    local(wav: Uint8Array, signal: AbortSignal): Promise<string>
    recognize?: (wav: Uint8Array, signal: AbortSignal) => Promise<string>
    log(message: string): void
  }) {}
  get active(): boolean { return this.controller !== null }
  begin(): string | null {
    if (this.active) return null
    this.id = randomUUID()
    this.controller = new AbortController()
    this.deps.changed()
    return this.id
  }
  cancel(id?: string): void {
    if (id !== undefined && id !== this.id) return
    this.controller?.abort()
    this.controller = null
    this.submitting = false
    this.deps.changed()
  }
  async finish(id: string, wav: Uint8Array): Promise<string> {
    const controller = this.controller
    if (!controller || id !== this.id || this.submitting) throw new Error(mt('当前没有可提交的语音追问'))
    this.submitting = true
    try {
      if (!(wav instanceof Uint8Array) || wav.byteLength > 2_000_000) throw new Error(mt('语音追问最长 60 秒'))
      const audio = decodeWavPcm16(wav)
      if (!audio || audio.sampleRate !== 16000 || audio.pcm.length > 16000 * 60) throw new Error(mt('无效的录音格式'))
      if (audio.pcm.length < 4800 || isSilent(audio.pcm)) throw new Error(mt('没有听到清晰的语音，请重试'))
      const signal = controller.signal
      const text = this.deps.recognize ? await this.deps.recognize(wav, signal) : await this.recognize(wav, signal)
      signal.throwIfAborted()
      if (!text.trim()) throw new Error(mt('没有听到清晰的语音，请重试'))
      return text.trim()
    } finally {
      // A cancelled old request must never release a newer recording's microphone lock.
      if (this.controller === controller) this.cancel()
    }
  }
  private async recognize(wav: Uint8Array, signal: AbortSignal): Promise<string> {
    const settings = this.deps.settings()
    if (settings.localAsr.enabled) {
      try { const text = await this.deps.local(wav, signal); signal.throwIfAborted(); if (text.trim()) return text }
      catch (error) { signal.throwIfAborted(); this.deps.log(`[card-voice] local recognition failed: ${String(error)}`) }
    }
    const asr = chainFor(settings, 'asr')
    if (!asr.length && settings.pipelineMode === 'multimodal') {
      const { value } = await withFailover(chainFor(settings, 'multimodal'), profile => generateFromAudio({ ...settings.multimodal, ...profile }, { wav, prompt: ASK_TRANSCRIBE_PROMPT, temperature: 0, signal }))
      return value
    }
    const { value } = await withFailover(asr, profile => transcribe({ ...settings.asr, ...profile }, { wav, signal, language: settings.language || undefined }))
    return value.text
  }
}
