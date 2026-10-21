/**
 * Utility-process entry for the built-in recogniser.
 *
 * The engine lives out of process for two reasons, both measured:
 *
 * 1. **Releasing has to mean something.** onnxruntime owns the weights through a
 *    native handle, so dropping the JS reference in the main process left the
 *    228 MB resident (Task Manager showed 425 MB before and after 释放内存). A
 *    child process can simply be killed, and the OS takes the pages back.
 * 2. **A recogniser fault must not be fatal.** A malformed model or a native
 *    crash kills this child; the app keeps running, the page shows the error and
 *    dictation falls back to the provider.
 */
import { cpus } from 'node:os'
import type { LocalModelKind } from '@shared/local-asr'

interface LoadMessage {
  type: 'load'
  dir: string
  kind: LocalModelKind
  tokens: string
  model: string
  encoder?: string
  decoder?: string
  language: string
  numThreads?: number
}

interface WavMessage {
  type: 'wav'
  id: number
  wav: Uint8Array
}

interface ExitMessage {
  type: 'exit'
}

type ParentMessage = LoadMessage | WavMessage | ExitMessage

interface ParentPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  postMessage(message: unknown): void
}

/**
 * Minimal shape of what `sherpa-onnx-node` gives us. Typed loosely on purpose:
 * the package ships no declarations, and the addon is external to the bundle.
 */
interface Stream {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void
}

interface Recognizer {
  createStream(): Stream
  decode(stream: Stream): void
  getResult(stream: Stream): { text?: string }
}

interface Sherpa {
  OfflineRecognizer: new (config: unknown) => Recognizer
}

const parent = (process as unknown as { parentPort?: ParentPort }).parentPort

/** Turns the PCM16 that the recorder produces into the float samples the model wants. */
export function toSamples(pcm: Int16Array): Float32Array {
  const samples = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768
  return samples
}

/** Reads the 16-bit mono data chunk out of a RIFF/WAVE buffer. */
export function wavToSamples(wav: Uint8Array): Float32Array {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  let offset = 12
  while (offset + 8 <= wav.byteLength) {
    const id = String.fromCharCode(wav[offset], wav[offset + 1], wav[offset + 2], wav[offset + 3])
    const size = view.getUint32(offset + 4, true)
    if (id === 'data') {
      const start = offset + 8
      const length = Math.min(size, wav.byteLength - start)
      const pcm = new Int16Array(Math.floor(length / 2))
      for (let i = 0; i < pcm.length; i++) pcm[i] = view.getInt16(start + i * 2, true)
      return toSamples(pcm)
    }
    offset += 8 + size + (size % 2)
  }
  throw new Error('wav has no data chunk')
}

function buildConfig(message: LoadMessage): unknown {
  const threads = message.numThreads ?? Math.min(4, cpus().length || 2)
  const base = {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      tokens: message.tokens,
      numThreads: threads,
      provider: 'cpu',
      debug: 0 as const
    }
  }
  if (message.kind === 'sense-voice') {
    return {
      ...base,
      modelConfig: {
        ...base.modelConfig,
        modelType: 'sense_voice' as const,
        senseVoice: {
          model: message.model,
          language: message.language,
          useInverseTextNormalization: 1
        }
      }
    }
  }
  if (message.kind === 'paraformer') {
    return {
      ...base,
      modelConfig: {
        ...base.modelConfig,
        modelType: 'paraformer' as const,
        paraformer: { model: message.model }
      }
    }
  }
  return {
    ...base,
    modelConfig: {
      ...base.modelConfig,
      modelType: 'whisper' as const,
      whisper: {
        encoder: message.encoder,
        decoder: message.decoder,
        language: message.language === 'auto' ? 'en' : message.language,
        task: 'transcribe' as const,
        tailPaddings: 1000
      }
    }
  }
}

if (parent) {
  let recognizer: Recognizer | null = null

  parent.on('message', (event) => {
    const message = event?.data as ParentMessage | undefined
    if (!message) return

    if (message.type === 'exit') {
      recognizer = null
      process.exit(0)
    }

    if (message.type === 'load') {
      const started = Date.now()
      try {
        const sherpa = require('sherpa-onnx-node') as Sherpa
        recognizer = new sherpa.OfflineRecognizer(buildConfig(message))
        parent.postMessage({ type: 'loaded', ms: Date.now() - started })
      } catch (error) {
        recognizer = null
        parent.postMessage({
          type: 'failed',
          message: error instanceof Error ? error.message : String(error)
        })
      }
      return
    }

    if (message.type === 'wav') {
      const started = Date.now()
      try {
        if (!recognizer) throw new Error('no recogniser loaded')
        const stream = recognizer.createStream()
        stream.acceptWaveform({ sampleRate: 16000, samples: wavToSamples(message.wav) })
        recognizer.decode(stream)
        const text = (recognizer.getResult(stream).text ?? '').trim()
        parent.postMessage({ type: 'text', id: message.id, text, ms: Date.now() - started })
      } catch (error) {
        parent.postMessage({
          type: 'fail',
          id: message.id,
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }
  })

  parent.postMessage({ type: 'ready' })
}
