// Local-only SenseVoice comparison. No credentials, uploads, model downloads or history writes.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
const require = createRequire(import.meta.url)
const [audioDir, modelDir, output] = process.argv.slice(2)
if (!audioDir || !modelDir || !output) throw Error('Usage: node scripts/evaluate-entities.mjs AUDIO_DIR SENSEVOICE_DIR OUTPUT_JSON')
const sherpa = require('sherpa-onnx-node')
const started = performance.now()
const recognizer = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: { tokens: path.join(modelDir, 'tokens.txt'), numThreads: 4, provider: 'cpu', debug: 0,
    modelType: 'sense_voice', senseVoice: { model: path.join(modelDir, 'model.int8.onnx'), language: 'auto', useInverseTextNormalization: 1 } }
})
const loadMs = performance.now() - started
const files = fs.readdirSync(audioDir).filter(name => /\.(?:m4a|wav|mp3|ogg|flac)$/i.test(name)).sort()
const rows = []
for (const name of files) {
  console.log('Transcribing local sample:', name)
  const bytes = execFileSync(process.env.TYPELESS_FFMPEG || 'ffmpeg', ['-v', 'error', '-i', path.join(audioDir, name), '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1'], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
  const samples = new Float32Array(Math.floor(bytes.length / 2))
  for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2) / 32768
  const run = () => {
    const stream = recognizer.createStream(), at = performance.now()
    stream.acceptWaveform({ sampleRate: 16000, samples }); recognizer.decode(stream)
    const text = (recognizer.getResult(stream).text ?? '').trim()
    return { text, ms: Math.round((performance.now() - at) * 100) / 100 }
  }
  // The existing SenseVoice binding exposes no hotword/context setter. Both
  // runs intentionally use the same verified API; differences are not gains.
  const baseline = run(), enhancementEnabled = run()
  rows.push({ file: name, durationMs: samples.length / 16, baseline, enhancementEnabled,
    nativeEnhancementSupported: false, sameTranscript: baseline.text === enhancementEnabled.text })
}
const stats = key => {
  const times = rows.map(row => row[key].ms).sort((a, b) => a - b)
  return { averageMs: times.reduce((a, b) => a + b, 0) / Math.max(1, times.length), p95Ms: times[Math.max(0, Math.ceil(times.length * .95) - 1)] ?? null }
}
fs.mkdirSync(path.dirname(output), { recursive: true })
fs.writeFileSync(output, JSON.stringify({ model: 'SenseVoice Small int8', date: new Date().toISOString(), loadMs,
  nativeEnhancementSupported: false, correctionAccuracy: null, errorCorrectionRate: null, falseCorrectionRate: null,
  limitation: 'No native hotwords in the current binding. No LLM or verified reference transcript was used. These are real ASR outputs and paired warm timings, not an accuracy claim or a latency improvement claim.',
  baseline: stats('baseline'), enhancementEnabled: stats('enhancementEnabled'), rows }, null, 2))
console.log(JSON.stringify({ samples: rows.length, loadMs: Math.round(loadMs), identicalTranscripts: rows.filter(row => row.sameTranscript).length, baseline: stats('baseline'), enhancementEnabled: stats('enhancementEnabled'), output }))
