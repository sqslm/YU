/**
 * Microphone capture for the recording bar.
 *
 * The AudioContext is created at 16 kHz so Chromium resamples the device stream
 * for us; the worklet then emits Int16 PCM blocks of ~64 ms, which is what the
 * ASR providers expect and keeps IPC chatter low (16 messages/second).
 *
 * Two details are load-bearing and were both absent:
 *
 *   - The worklet never emitted its *partial* block, so up to 64 ms of every take
 *     stayed in the audio thread. That is the last syllable of a sentence. It is
 *     now asked for explicitly on stop and the caller waits for it.
 *   - `start()` was guarded by `running`, which is only set after `getUserMedia`
 *     resolves. Two overlapping calls therefore opened two microphones, and the
 *     first graph was orphaned with the device still held open.
 */
import i18n from '../i18n'
import type { AudioProcessingMode } from '@shared/types'

const WORKLET_SOURCE = `
class TapProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.block = new Int16Array(1024)
    this.filled = 0
    this.active = false
    // The host asks for whatever is still buffered when the take ends. Without
    // this handshake the tail of every take never left the audio thread.
    this.port.onmessage = (event) => {
      if (event.data && event.data.active) {
        this.filled = 0
        this.active = true
      }
      if (event.data && event.data.flush) {
        this.active = false
        this.emit(true)
      }
    }
  }
  emit(final) {
    if (this.filled === 0) {
      // Answer a flush even with nothing buffered, so the caller does not have to
      // wait for its timeout.
      if (final) this.port.postMessage({ chunk: new Int16Array(0), final: true })
      return
    }
    const out = this.block.slice(0, this.filled)
    this.filled = 0
    this.port.postMessage({ chunk: out, final }, [out.buffer])
  }
  process(inputs) {
    if (!this.active) return true
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true
    for (let i = 0; i < channel.length; i++) {
      const sample = Math.max(-1, Math.min(1, channel[i]))
      this.block[this.filled++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
      if (this.filled === this.block.length) this.emit(false)
    }
    return true
  }
}
registerProcessor('pcm-tap', TapProcessor)
`

/** What the worklet posts: one PCM block, flagged when it is the drained tail. */
interface WorkletMessage {
  chunk: Int16Array
  final?: boolean
}

export interface CaptureHandlers {
  onChunk: (chunk: Int16Array) => void
  onLevel: (level: number) => void
  onError: (message: string) => void
  onDevices?: (devices: AudioDeviceInfo[]) => void
  /**
   * A second, compressed copy of the same take (REQ-11 without ffmpeg).
   *
   * Chromium already ships an Opus encoder, so recording a webm in parallel with
   * the PCM tap costs one `MediaRecorder` and gives the ASR upload a 64 kbps
   * stream without a native codec or subprocess.
   * Main keeps whichever form the provider ends up needing.
   */
  onEncoded?: (payload: { data: Uint8Array; contentType: string }) => void
  onFormat?: (settings: MediaTrackSettings) => void
}

export interface AudioDeviceInfo {
  deviceId: string
  label: string
}

/**
 * AudioContext states that mean the graph can no longer hear anything.
 *
 * `suspended` is deliberately absent: the browser suspends a context for reasons
 * that have nothing to do with the device, and treating that as a loss would stop
 * a healthy recording. Windows reports an unplugged endpoint as `interrupted`.
 */
const DEAF_CONTEXT_STATES = new Set<string>(['closed', 'interrupted'])

/** Labels are only exposed after the page has been granted microphone access. */
export async function listDevices(): Promise<AudioDeviceInfo[]> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices()
    return all
      .filter((device) => device.kind === 'audioinput')
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || i18n.t('麦克风 {{n}}', { n: index + 1 })
      }))
  } catch {
    return []
  }
}

/**
 * Constraints for dictation rather than for a call.
 *
 * Preserve speech by default. The optional call-style profile is useful in a
 * noisy room, but can colour consonants or conflict with sound-card processing.
 */
export function captureConstraints(mode: AudioProcessingMode): MediaTrackConstraints {
  return {
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48000 },
    echoCancellation: mode === 'voice',
    noiseSuppression: mode === 'voice',
    autoGainControl: mode === 'voice'
  }
}

export class MicCapture {
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: AudioWorkletNode | null = null
  private workletUrl: string | null = null
  private running = false
  private active = false
  private deviceId = ''
  private processing: AudioProcessingMode = 'fidelity'
  private appliedKey = ''
  private changing: Promise<void> | null = null
  private draining = false
  private deactivating: Promise<void> | null = null
  /** In-flight `start()`, so a second warm-up joins it instead of opening a second device. */
  private starting: Promise<void> | null = null
  /** Resolves when the worklet has handed over its partial block. */
  private tailWaiter: (() => void) | null = null
  /** A cancelled take drains its tail too, but that audio must not reach main. */
  private discardTail = false
  /** Set once a device loss was reported, so the teardown cannot report it twice. */
  private lost = false
  /** Parallel Opus recording of the same take; null when the codec is missing. */
  private recorder: MediaRecorder | null = null
  private parts: Blob[] = []

  /**
   * `devicechange` also fires when a microphone is *plugged in*, which must never
   * disturb a live take, so the handler waits until the open track has really
   * ended before it reports anything (ACC-12 step 4).
   */
  private readonly onDeviceChange = (): void => {
    if (!this.running) return
    const tracks = this.stream?.getAudioTracks() ?? []
    if (tracks.length === 0) return
    if (tracks.some((track) => track.readyState === 'live')) return
    this.reportLoss('device removed')
  }

  constructor(private readonly handlers: CaptureHandlers) {}

  get isRunning(): boolean {
    return this.running
  }

  get isActive(): boolean {
    return this.active
  }

  /**
   * Switching microphones means tearing the graph down and warming it again.
   * Called on every settings change, so it no-ops when nothing moved.
   */
  async setDevice(deviceId: string, processing: AudioProcessingMode = this.processing): Promise<void> {
    const next = deviceId ?? ''
    this.deviceId = next
    this.processing = processing
    await this.refreshDevice()
  }

  private refreshDevice(): Promise<void> {
    if (!this.running || this.active || this.draining || this.appliedKey === `${this.deviceId}|${this.processing}`) return Promise.resolve()
    if (this.changing) return this.changing
    this.changing = (async () => {
      do {
        await this.stop()
        await this.start()
      } while (this.running && !this.active && this.appliedKey !== `${this.deviceId}|${this.processing}`)
    })().finally(() => { this.changing = null })
    return this.changing
  }

  /**
   * Opens or closes the tap gate. Closing it waits for the worklet to hand over
   * the samples it has not filled a block with yet: those ~64 ms are the last
   * syllable of the take, and dropping them made short words disappear.
   *
   * `keepTail: false` is for a cancelled take — the block is still drained so the
   * next take cannot inherit it, but it is not forwarded.
   */
  async setActive(active: boolean, keepTail = true): Promise<void> {
    if (active) {
      if (this.deactivating) await this.deactivating
      if (this.changing) await this.changing
      await this.refreshDevice()
      if (this.active) return
      this.active = true
      this.discardTail = false
      this.node?.port.postMessage({ active: true })
      this.armRecorder()
      return
    }
    if (!keepTail) this.discardTail = true
    if (this.deactivating) return this.deactivating
    if (!this.active) return
    this.active = false
    this.draining = true
    // Request the PCM tail before waiting for the encoder; a slow encoder must
    // not let whole speech blocks fall through the now-closed recording gate.
    this.deactivating = Promise.all([this.drainTail(), this.stopRecorder(keepTail)])
      .then(async () => { this.draining = false; await this.refreshDevice() })
      .finally(() => { this.draining = false; this.deactivating = null })
    return this.deactivating
  }

  /**
   * Starts the parallel Opus recording. Failure is silent on purpose: the PCM
   * path is the one that makes dictation work, and a browser without the codec
   * simply uploads WAV like before.
   */
  private armRecorder(): void {
    const stream = this.stream
    if (!stream || this.recorder || !this.handlers.onEncoded) return
    if (typeof MediaRecorder === 'undefined') return
    const type = 'audio/webm;codecs=opus'
    if (typeof MediaRecorder.isTypeSupported !== 'function') return
    if (!MediaRecorder.isTypeSupported(type)) return
    try {
      const recorder = new MediaRecorder(stream, { mimeType: type, audioBitsPerSecond: 64_000 })
      const parts: Blob[] = []
      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) parts.push(event.data)
      }
      // A timeslice keeps the chunks small enough that a 10-minute take never
      // holds one multi-megabyte Blob in memory before it is handed over.
      recorder.start(500)
      this.recorder = recorder
      this.parts = parts
    } catch {
      this.recorder = null
      this.parts = []
    }
  }

  /** Stops the parallel recording and hands the bytes over when it kept them. */
  private async stopRecorder(keep: boolean): Promise<void> {
    const recorder = this.recorder
    const parts = this.parts
    this.recorder = null
    this.parts = []
    if (!recorder) return
    const blob = await new Promise<Blob>((resolve) => {
      if (recorder.state === 'inactive') {
        resolve(new Blob(parts, { type: recorder.mimeType || 'audio/webm' }))
        return
      }
      // `onstop` is the only point where the encoder has flushed its final page;
      // reading `parts` before it loses the tail of the take.
      recorder.onstop = () => resolve(new Blob(parts, { type: recorder.mimeType || 'audio/webm' }))
      try {
        recorder.stop()
      } catch {
        resolve(new Blob(parts, { type: recorder.mimeType || 'audio/webm' }))
      }
    })
    if (!keep || this.discardTail || blob.size < 512) return
    try {
      const data = new Uint8Array(await blob.arrayBuffer())
      this.handlers.onEncoded?.({ data, contentType: blob.type || 'audio/webm' })
    } catch {
      // Reading the blob back is a memory operation that can fail on a huge take;
      // the WAV path still has the audio.
    }
  }

  async start(): Promise<void> {
    if (this.running) return
    // Joining the in-flight attempt is what keeps two overlapping warm-ups from
    // opening two microphones; the first graph used to be orphaned with the
    // device still held, which showed up as "the mic is always on".
    if (this.starting) return this.starting
    this.starting = this.open().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async open(): Promise<void> {
    try {
      const { stream, fellBack, key } = await this.acquire()
      this.stream = stream
      this.appliedKey = key
      if (fellBack) this.handlers.onDevices?.(await listDevices())
      // An unplugged device ends its track instead of throwing, so without this
      // the warm stream stays "open" and the bar records silence forever.
      for (const track of stream.getTracks()) {
        track.onended = () => this.reportLoss('track ended')
        track.contentHint = key.endsWith('|voice') ? 'speech' : 'speech-recognition'
      }
      this.handlers.onFormat?.(stream.getAudioTracks()[0]?.getSettings() ?? {})

      const context = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' })
      this.context = context
      if (!this.workletUrl) {
        const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' })
        this.workletUrl = URL.createObjectURL(blob)
      }
      await context.audioWorklet.addModule(this.workletUrl)

      const source = context.createMediaStreamSource(stream)
      const node = new AudioWorkletNode(context, 'pcm-tap', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelCountMode: 'explicit'
      })
      this.node = node

      node.port.onmessage = (event: MessageEvent<WorkletMessage>) => {
        const payload = event.data
        if (!payload || !(payload.chunk instanceof Int16Array)) return
        const tail = payload.final === true
        // A tail block arrives after `active` went false; it is the last bit of
        // the sentence and the reason `setActive(false)` is awaited.
        if (!this.active && !this.draining && !tail) return
        if (this.discardTail) {
          // A cancelled take still drains so the next one starts clean, but its
          // audio belongs to nothing the user asked for.
          if (tail) this.settleTail()
          return
        }
        if (payload.chunk.length > 0) {
          this.handlers.onChunk(payload.chunk)
          let sum = 0
          for (let i = 0; i < payload.chunk.length; i++) sum += Math.abs(payload.chunk[i])
          this.handlers.onLevel(Math.min(1, sum / payload.chunk.length / 3200))
        }
        if (tail) this.settleTail()
      }

      // Keep the graph alive without echoing anything to the speakers.
      const mute = context.createGain()
      mute.gain.value = 0
      source.connect(node)
      node.connect(mute)
      mute.connect(context.destination)

      await context.resume()
      this.running = true
      this.lost = false
      if (this.active) {
        node.port.postMessage({ active: true })
        this.armRecorder()
      }
      // A vanished endpoint can surface as a dead context rather than a dead
      // track; either signal must reach main, which classifies it as mic_missing.
      context.onstatechange = () => {
        if (!this.running) return
        if (DEAF_CONTEXT_STATES.has(context.state)) this.reportLoss(`audio context ${context.state}`)
      }
      navigator.mediaDevices.addEventListener('devicechange', this.onDeviceChange)
      this.handlers.onDevices?.(await listDevices())
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.handlers.onError(`microphone unavailable: ${message}`)
      await this.stop()
    }
  }

  /**
   * Opens the microphone, falling back to the system default when the remembered
   * device is gone.
   *
   * A stale `deviceId` used to make every take fail with `OverconstrainedError`
   * until the user manually picked "system default" again — an unplugged USB
   * headset could silently disable dictation.
   */
  private async acquire(): Promise<{ stream: MediaStream; fellBack: boolean; key: string }> {
    const deviceId = this.deviceId
    const processing = this.processing
    const constraints = captureConstraints(processing)
    if (!deviceId) {
      return { stream: await navigator.mediaDevices.getUserMedia({ audio: constraints }), fellBack: false, key: `|${processing}` }
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { ...constraints, deviceId: { exact: deviceId } }
      })
      return { stream, fellBack: false, key: `${deviceId}|${processing}` }
    } catch (err) {
      // `exact` means "this device or nothing". Nothing is not an option for a
      // dictation app, so the pin is dropped and the default endpoint is used.
      if (this.deviceId === deviceId) this.deviceId = ''
      console.warn('[capture] pinned device unavailable, using the default:', err)
      return { stream: await navigator.mediaDevices.getUserMedia({ audio: constraints }), fellBack: true, key: `|${processing}` }
    }
  }

  /** Asks the worklet for its partial block and waits (bounded) for the answer. */
  private drainTail(): Promise<void> {
    const node = this.node
    if (!node) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.tailWaiter = null
        resolve()
      }, 200)
      this.tailWaiter = () => {
        clearTimeout(timer)
        resolve()
      }
      node.port.postMessage({ flush: true })
    })
  }

  private settleTail(): void {
    const waiter = this.tailWaiter
    this.tailWaiter = null
    waiter?.()
  }

  /**
   * One place for "the device went away": reports exactly once through the
   * existing `onError` channel, then tears the graph down so no silent chunk can
   * reach the pipeline and turn a hardware problem into an empty transcription.
   */
  private reportLoss(reason: string): void {
    if (!this.running || this.lost) return
    this.lost = true
    this.handlers.onError(`microphone lost: ${reason}`)
    void this.stop()
  }

  async stop(): Promise<void> {
    this.running = false
    this.discardTail = true
    // A tail waiter must not hang a stop: nothing will answer it any more.
    const waiter = this.tailWaiter
    this.tailWaiter = null
    waiter?.()
    // A warm-up teardown is not a take: drop whatever the encoder still holds.
    await this.stopRecorder(false)
    navigator.mediaDevices.removeEventListener('devicechange', this.onDeviceChange)
    if (this.context) this.context.onstatechange = null
    this.node?.port.close()
    this.node?.disconnect()
    this.node = null
    if (this.workletUrl) URL.revokeObjectURL(this.workletUrl)
    this.workletUrl = null
    // Detach before stopping the tracks: `stop()` does not fire `ended`, but a
    // device that disappears mid-teardown would otherwise report a second loss.
    for (const track of this.stream?.getTracks() ?? []) track.onended = null
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
    if (this.context) {
      await this.context.close().catch(() => undefined)
      this.context = null
    }
  }
}
