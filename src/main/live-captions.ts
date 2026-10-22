import { audibleRange, concatPcm, isSilent } from './audio/wav'

/** A bounded preview of recent speech. Final dictation owns the complete audio. */
export class LiveCaptions {
  private chunks: Int16Array[] = []
  private samples = 0
  private totalSamples = 0
  private lead = new Int16Array(0)
  private started = false
  private revision = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private stopped = false
  private abort = new AbortController()

  constructor(private readonly options: {
    transcribe: (pcm: Int16Array, signal: AbortSignal) => Promise<string>
    onText: (text: string) => void
    onOpeningText?: (text: string) => void
    openingOnly?: boolean
    onError: (error: unknown) => void
  }) {}

  push(pcm: Int16Array): void {
    if (this.stopped || !pcm.length) return
    if (!this.started) {
      const opening = concatPcm([this.lead, pcm])
      const range = audibleRange(opening)
      if (!range) {
        // Only a short pre-roll is retained while waiting. Silence does not
        // consume the six-second keyword window or cause an ASR request.
        this.lead = opening.slice(-3200)
        return
      }
      pcm = opening.subarray(Math.max(0, range.start - 1920))
      this.lead = new Int16Array(0)
      this.started = true
    }
    if (this.options.openingOnly) pcm = pcm.subarray(0, Math.max(0, 96_000 - this.totalSamples))
    if (!pcm.length) return
    this.totalSamples += pcm.length
    this.chunks.push(pcm)
    this.samples += pcm.length
    // Six seconds at 16 kHz: slow requests never build up a second recording.
    while (this.samples > 96_000) {
      const excess = this.samples - 96_000
      const first = this.chunks[0]
      if (first.length <= excess) { this.chunks.shift(); this.samples -= first.length }
      else { this.chunks[0] = first.subarray(excess); this.samples -= excess }
    }
    this.revision++
    this.schedule()
  }

  stop(): void {
    this.stopped = true
    this.abort.abort()
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.chunks = []
    this.lead = new Int16Array(0)
    this.samples = 0
  }

  private schedule(): void {
    if (this.stopped || this.running || this.timer) return
    this.timer = setTimeout(() => { this.timer = null; void this.tick() }, this.options.openingOnly ? 1000 : 100)
    this.timer.unref?.()
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.samples < 16_000) return
    const pcm = concatPcm(this.chunks)
    const fromStart = this.totalSamples <= 96_000
    if (isSilent(pcm)) return
    const revision = this.revision
    this.running = true
    try {
      const text = await this.options.transcribe(pcm, this.abort.signal)
      if (!this.stopped && text.trim()) {
        if (fromStart) this.options.onOpeningText?.(text.trim())
        this.options.onText(Array.from(text.trim()).slice(-120).join(''))
      }
    } catch (error) {
      if (!this.stopped) {
        // Do not repeatedly charge a failing provider just to draw a preview.
        this.stop()
        this.options.onError(error)
      }
    } finally {
      this.running = false
      if (revision !== this.revision) this.schedule()
    }
  }
}
