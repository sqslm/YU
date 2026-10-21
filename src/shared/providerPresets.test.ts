import { describe, expect, it } from 'vitest'
import {
  CUSTOM_PRESET_ID,
  allPresets,
  customPreset,
  findPreset,
  presetsFor,
  presetDraft
} from './providerPresets'

const KINDS = ['asr', 'llm', 'multimodal'] as const

/** `localhost`/loopback presets are the only ones allowed to speak plain http. */
function isLoopback(url: string): boolean {
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(url)
}

describe('custom preset', () => {
  it('is the first entry for every kind', () => {
    for (const kind of KINDS) {
      const list = presetsFor(kind)
      expect(list[0]?.id).toBe(CUSTOM_PRESET_ID)
      expect(list[0]?.kind).toBe(kind)
      expect(list[0]?.dropIn).toBe(true)
    }
  })

  it('starts blank so the user owns the connection', () => {
    const preset = customPreset('asr')
    expect(preset.baseUrl).toBe('')
    expect(preset.model).toBe('')
    expect(preset.notes).toContain('留空')
  })

  it('is not a stored preset id', () => {
    expect(findPreset(CUSTOM_PRESET_ID)).toBeUndefined()
  })
})

describe('presets', () => {
  it('offers a local server for asr and llm', () => {
    const asrLocal = presetsFor('asr').find((item) => item.id === 'local')
    const llmLocal = presetsFor('llm').find((item) => item.id === 'local')
    expect(asrLocal?.baseUrl).toContain('127.0.0.1')
    expect(llmLocal?.baseUrl).toContain('127.0.0.1')
    expect(asrLocal?.notes).toContain('llama.cpp')
  })

  it('has no duplicate id within a kind', () => {
    // `id` is what gets persisted, so a repeat inside one kind would make the
    // saved profile resolve to whichever entry happened to come last.
    const seen = new Set<string>()
    for (const preset of allPresets()) {
      const key = `${preset.kind}:${preset.id}`
      expect(seen.has(key), `duplicate preset ${key}`).toBe(false)
      seen.add(key)
    }
  })

  it('every preset is a callable connection', () => {
    for (const preset of allPresets()) {
      const label = `${preset.kind}:${preset.id}`
      expect(preset.name.trim(), label).not.toBe('')
      expect(preset.baseUrl.trim(), label).not.toBe('')
      // Plain http only for something on this machine; a public vendor over
      // http would be a key sent in the clear.
      if (!isLoopback(preset.baseUrl)) expect(preset.baseUrl, label).toMatch(/^https:\/\//)
    }
  })

  it('drop-in presets only promise what the client can send', () => {
    for (const preset of allPresets()) {
      if (!preset.dropIn) continue
      const label = `${preset.kind}:${preset.id}`
      // Either we know a working default model, or the UI is told to fetch one
      // ("获取模型列表") / that it must be typed by hand.
      const modelKnown = preset.model.trim() !== ''
      const saysHow = /获取模型列表|手填|留空/.test(preset.notes ?? '')
      expect(modelKnown || saysHow, `${label} has no model and no hint`).toBe(true)
      // A drop-in entry with default models that omit the default model is a
      // menu whose first item does not exist.
      if (modelKnown && preset.models?.length) {
        expect(preset.models, label).toContain(preset.model)
      }
    }
  })

  it('every preset is callable, with an adapter when a key is not enough', () => {
    for (const preset of allPresets()) {
      const label = `${preset.kind}:${preset.id}`
      // Two honest ways to be callable: the client can drive the vendor itself,
      // or the main process has an adapter for its request shape.
      expect(preset.dropIn || Boolean(preset.asrAdapter), label).toBe(true)
      if (preset.asrAdapter) {
        // An adapter id without a note leaves the user with no idea why the
        // fields below base URL changed shape.
        expect(preset.notes?.trim(), label).toBeTruthy()
      }
    }
  })

  it('never labels a preset as unusable', () => {
    for (const preset of allPresets()) {
      expect(preset.name, `${preset.kind}:${preset.id}`).not.toContain('〔暂不可直连〕')
    }
  })

  it('lists the adapter-backed ASR vendors', () => {
    const asr = presetsFor('asr')
    const dropIn = asr.filter((item) => item.dropIn).map((item) => item.id)
    expect(dropIn).toEqual(expect.arrayContaining(['fireworks', 'deepinfra']))
    // Fireworks names its models with the full `accounts/...` path.
    expect(asr.find((item) => item.id === 'fireworks')?.model).toContain('/models/')
    // Every vendor that is not OpenAI multipart carries its adapter id, which is
    // what survives a later edit of the base URL or a move behind a proxy.
    const adapters: Record<string, string> = {
      deepgram: 'deepgram',
      elevenlabs: 'elevenlabs',
      assemblyai: 'assemblyai',
      gladia: 'gladia',
      speechmatics: 'speechmatics',
      revai: 'revai',
      'cohere-transcribe': 'cohere',
      'minimax-asr': 'minimax',
      'azure-openai': 'azure-openai',
      'aliyun-asr': 'aliyun',
      'tencent-asr': 'tencent',
      iflytek: 'xfyun',
      'baidu-asr': 'baidu',
      replicate: 'replicate',
      fal: 'fal'
    }
    for (const [id, adapter] of Object.entries(adapters)) {
      const preset = asr.find((item) => item.id === id)
      expect(preset?.dropIn, id).toBe(true)
      expect(preset?.asrAdapter, id).toBe(adapter)
    }
  })

  it('keeps transcription-only ids from shadowing the chat ones', () => {
    // `findPreset(id)` is kind-agnostic, so a transcription entry that reused a
    // chat id would show chat notes on a dictation profile. The original ASR
    // list shares ids with chat on purpose (one endpoint serves both), so those
    // stay; anything added purely for transcription gets its own id.
    const llm = new Set(presetsFor('llm').map((item) => item.id))
    const shared = presetsFor('asr')
      .map((item) => item.id)
      .filter((id) => llm.has(id))
    for (const id of ['cohere-transcribe', 'minimax-asr', 'aliyun-asr']) {
      expect(shared, id).not.toContain(id)
    }
  })

  it('fills base url and model but never the key', () => {
    const openai = presetsFor('asr').find((item) => item.id === 'openai')
    const draft = presetDraft(openai!)
    expect(draft.baseUrl).toBe('https://api.openai.com/v1')
    expect(draft.model).toBe('gpt-transcribe')
    expect(draft).not.toHaveProperty('apiKey')
})
})
