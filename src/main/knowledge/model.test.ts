import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { ProviderProfile, Settings } from '@shared/types'

import { complete as providerComplete } from '../providers/llm'
import { createKnowledgeCompleter, selectProfile } from './model'

type Complete = typeof providerComplete

function profile(over: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 'p1',
    name: '本地',
    kind: 'llm',
    preset: '',
    baseUrl: 'http://127.0.0.1:9991/v1',
    apiKey: '',
    model: 'llm-model',
    enabled: true,
    ...over
  }
}

function settings(over: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...over }
}

function configured(profiles: ProviderProfile[], chain: string[] = profiles.map((p) => p.id)): Settings {
  return settings({ profiles, chains: { asr: [], llm: chain, multimodal: [] } })
}

function spy(text = '答案') {
  const fn = vi.fn(async () => text)
  return { fn, complete: fn as unknown as Complete }
}

const signal = new AbortController().signal

describe('selectProfile', () => {
  it('falls back to the first enabled profile when the helper names none', () => {
    const s = configured([profile({ id: 'a' }), profile({ id: 'b' })], ['b', 'a'])
    expect(selectProfile(s, '')?.id).toBe('b')
  })

  it('uses the pinned profile when it is enabled', () => {
    const s = configured([profile({ id: 'a' }), profile({ id: 'b' })], ['b', 'a'])
    expect(selectProfile(s, 'a')?.id).toBe('a')
  })

  it('ignores a pinned profile that is disabled or unknown', () => {
    const s = configured([profile({ id: 'a', enabled: false }), profile({ id: 'b' })])
    expect(selectProfile(s, 'a')?.id).toBe('b')
    expect(selectProfile(s, 'nope')?.id).toBe('b')
  })

  it('reports nothing when no llm profile is enabled', () => {
    expect(selectProfile(settings(), '')).toBeUndefined()
    expect(selectProfile(configured([profile({ enabled: false })]), '')).toBeUndefined()
  })
})

describe('createKnowledgeCompleter', () => {
  it('sends the callback through the shared complete call on the chosen profile', async () => {
    const { fn, complete } = spy()
    const completer = createKnowledgeCompleter({ settings: () => configured([profile()]), complete })
    const messages = [{ role: 'user' as const, content: '合成内容' }]

    await expect(completer({ profileId: '', effort: 'high', messages, maxTokens: 128, signal })).resolves.toBe('答案')

    expect(fn).toHaveBeenCalledTimes(1)
    const [settingsArg, request] = fn.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, unknown>]
    expect(settingsArg.baseUrl).toBe('http://127.0.0.1:9991/v1')
    expect(settingsArg.model).toBe('llm-model')
    expect(request.messages).toEqual(messages)
    expect(request.maxTokens).toBe(128)
    expect(request.effort).toBe('high')
    expect(request.signal).toBe(signal)
  })

  it('thinks by default instead of inheriting the dictation override', async () => {
    const { fn, complete } = spy()
    const completer = createKnowledgeCompleter({
      settings: () => settings({ ...configured([profile()]), polish: { ...DEFAULT_SETTINGS.polish, effort: 'off' } }),
      complete
    })
    await completer({ profileId: '', effort: '', messages: [{ role: 'user', content: 'x' }], signal })
    const [, request] = fn.mock.calls[0] as unknown as [unknown, Record<string, unknown>]
    expect(request.effort).toBe('high')
  })

  it('rejects with model_unavailable when no profile is enabled', async () => {
    const { fn, complete } = spy()
    const completer = createKnowledgeCompleter({ settings: () => settings(), complete })
    await expect(
      completer({ profileId: '', effort: 'high', messages: [{ role: 'user', content: 'x' }], signal })
    ).rejects.toMatchObject({ code: 'model_unavailable' })
    expect(fn).not.toHaveBeenCalled()
  })

  it('propagates a cancellation through the caller signal', async () => {
    const controller = new AbortController()
    const fn = vi.fn(async () => {
      controller.abort()
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    })
    const completer = createKnowledgeCompleter({
      settings: () => configured([profile()]),
      complete: fn as unknown as Complete
    })
    await expect(
      completer({ profileId: '', effort: 'high', messages: [{ role: 'user', content: 'x' }], signal: controller.signal })
    ).rejects.toThrow('aborted')
  })
})
