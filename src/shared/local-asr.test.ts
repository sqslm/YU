import { describe, expect, it } from 'vitest'
import {
  LOCAL_MODELS,
  DEFAULT_LOCAL_MODEL,
  downloadUrl,
  findModel,
  formatBytes,
  missingFiles,
  modelBytes,
  modelFiles,
  modelFolder,
  modelFolderName,
  progressOf
} from './local-asr'

describe('local model catalogue', () => {
  it('offers ids that all resolve and a default that exists', () => {
    for (const model of LOCAL_MODELS) {
      expect(findModel(model.id)?.name).toBe(model.name)
      expect(model.languages[0]).toBeTruthy()
    }
    expect(findModel(DEFAULT_LOCAL_MODEL)).toBeDefined()
    expect(findModel('nope')).toBeUndefined()
  })

  it('sums the declared size and lists every file', () => {
    const model = findModel('whisper-tiny')!
    expect(modelFiles(model)).toEqual([
      'tiny-encoder.int8.onnx',
      'tiny-decoder.int8.onnx',
      'tiny-tokens.txt'
    ])
    expect(modelBytes(model)).toBeGreaterThan(90 * 1024 * 1024)
  })

  it('names the folder after the repository so foreign downloads are found', () => {
    const model = findModel('sense-voice-small')!
    expect(modelFolderName(model)).toBe('sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17')
    expect(modelFolderName(model)).toContain('sherpa-onnx')
  })

  it('reports only the files that are really absent', () => {
    const model = findModel('sense-voice-small')!
    expect(missingFiles(model, ['model.int8.onnx', 'tokens.txt'])).toEqual([])
    expect(missingFiles(model, ['model.int8.onnx'])).toEqual(['tokens.txt'])
    expect(missingFiles(model, [])).toEqual(['model.int8.onnx', 'tokens.txt'])
    // Unrelated files in the folder must not confuse the check.
    expect(missingFiles(model, ['tokens.txt', 'README.md'])).toEqual(['model.int8.onnx'])
  })

  it('switches host with the mirror and keeps one path shape', () => {
    const model = findModel('paraformer-zh')!
    expect(downloadUrl(model, 'tokens.txt', 'cn')).toBe(
      `https://hf-mirror.com/${model.repo}/resolve/main/tokens.txt?download=true`
    )
    expect(downloadUrl(model, 'tokens.txt', 'official')).toContain('https://huggingface.co/')
  })

  it('formats sizes the way the page shows them', () => {
    expect(formatBytes(0)).toBe('0 MB')
    expect(formatBytes(-5)).toBe('0 MB')
    expect(formatBytes(300 * 1024)).toBe('0.3 MB')
    expect(formatBytes(230 * 1024 * 1024)).toBe('230 MB')
    expect(formatBytes(1.2 * 1024 * 1024 * 1024)).toBe('1.2 GB')
  })

  it('clamps download progress into 0..1 and survives a missing length', () => {
    expect(progressOf('m', 'f', 0, 2, 50, 100).ratio).toBe(0.5)
    expect(progressOf('m', 'f', 0, 2, 500, 100).ratio).toBe(1)
    expect(progressOf('m', 'f', 0, 2, -5, 100).ratio).toBe(0)
    expect(progressOf('m', 'f', 0, 2, 10, 0).ratio).toBe(0)
  })
})

describe('model folders', () => {
  it('gives every model its own readable folder', () => {
    const folders = LOCAL_MODELS.map((model) => modelFolder(model))
    expect(folders).toEqual(['SenseVoice-Small', 'Paraformer-ZH', 'Whisper-Tiny'])
    // Two models sharing a folder would overwrite each other's weights.
    expect(new Set(folders).size).toBe(LOCAL_MODELS.length)
    for (const folder of folders) expect(folder).not.toContain('/')
  })

  it('still knows the repository folder name for folders made by other tools', () => {
    expect(modelFolderName(findModel('sense-voice-small')!)).toBe(
      'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17'
    )
  })
})
