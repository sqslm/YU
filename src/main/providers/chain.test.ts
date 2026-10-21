import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from '@shared/defaults'
import type { ProviderProfile, Settings } from '@shared/types'
import { chainFor, withFailover } from './chain'

function profile(over: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 'p1',
    name: '本地',
    kind: 'asr',
    preset: '',
    baseUrl: 'http://127.0.0.1:9991/v1',
    apiKey: '',
    model: 'whisper-1',
    enabled: true,
    ...over
  }
}

function settings(over: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...over }
}

describe('chainFor', () => {
  it('reports nothing configured when no profile exists', () => {
    // The empty default is the contract: no profile means no provider, so the
    // bar can say "add one" instead of a request failing against a made-up URL.
    expect(chainFor(settings(), 'asr')).toEqual([])
  })

  it('returns the chain in stored order, skipping disabled profiles', () => {
    const a = profile({ id: 'a' })
    const b = profile({ id: 'b', enabled: false })
    const c = profile({ id: 'c' })
    const s = settings({
      profiles: [a, b, c],
      chains: { asr: ['c', 'b', 'a'], llm: [], multimodal: [] }
    })
    expect(chainFor(s, 'asr').map((p) => p.id)).toEqual(['c', 'a'])
  })

  it('ignores profiles of another kind', () => {
    const asr = profile({ id: 'a' })
    const llm = profile({ id: 'b', kind: 'llm' })
    const s = settings({
      profiles: [asr, llm],
      chains: { asr: ['b'], llm: [], multimodal: [] }
    })
    expect(chainFor(s, 'asr').map((p) => p.id)).toEqual(['a'])
  })

  it('returns nothing when every profile of the kind is disabled', () => {
    const a = profile({ id: 'a', enabled: false })
    const s = settings({ profiles: [a], chains: { asr: ['a'], llm: [], multimodal: [] } })
    expect(chainFor(s, 'asr')).toEqual([])
  })

  it('appends enabled profiles the user saved but has not chained yet', () => {
    // A freshly added profile must work before anyone drags it into the chain.
    const a = profile({ id: 'a' })
    const fresh = profile({ id: 'fresh' })
    const s = settings({ profiles: [a, fresh], chains: { asr: ['a'], llm: [], multimodal: [] } })
    expect(chainFor(s, 'asr').map((p) => p.id)).toEqual(['a', 'fresh'])
  })

  it('keeps chain order ahead of insertion order', () => {
    const a = profile({ id: 'a' })
    const b = profile({ id: 'b' })
    const s = settings({ profiles: [a, b], chains: { asr: ['b'], llm: [], multimodal: [] } })
    expect(chainFor(s, 'asr').map((p) => p.id)).toEqual(['b', 'a'])
  })
})

describe('withFailover', () => {
  it('uses the first profile that answers', async () => {
    const calls: string[] = []
    const result = await withFailover(
      [profile({ id: 'a' }), profile({ id: 'b' })],
      async (p) => {
        calls.push(p.id)
        if (p.id === 'a') throw new Error('503')
        return `ok:${p.id}`
      }
    )
    expect(result.value).toBe('ok:b')
    expect(result.profile.id).toBe('b')
    expect(calls).toEqual(['a', 'b'])
    expect(result.failures.map((f) => f.profile.id)).toEqual(['a'])
  })

  it('stops at the first success instead of trying the rest', async () => {
    const calls: string[] = []
    await withFailover(
      [profile({ id: 'a' }), profile({ id: 'b' })],
      async (p) => {
        calls.push(p.id)
        return p.id
      }
    )
    expect(calls).toEqual(['a'])
  })

  it('rethrows the last error when every profile fails', async () => {
    await expect(
      withFailover([profile({ id: 'a' }), profile({ id: 'b' })], async (p) => {
        throw new Error(`boom-${p.id}`)
      })
    ).rejects.toThrow('boom-b')
  })

  it('refuses an empty chain with a readable message', async () => {
    await expect(withFailover([], async () => 'x')).rejects.toThrow('没有可用的提供商配置')
  })

  it('reports each failure with its index', async () => {
    const seen: Array<[string, number]> = []
    await withFailover(
      [profile({ id: 'a' }), profile({ id: 'b' })],
      async (p) => {
        if (p.id === 'a') throw new Error('x')
        return 'ok'
      },
      (p, _err, index) => seen.push([p.id, index])
    )
    expect(seen).toEqual([['a', 0]])
  })
})

describe('profiles survive a settings round-trip', () => {
  it('keeps a saved profile and its chain through mergeSettings', () => {
    const merged = mergeSettings({
      profiles: [profile({ id: 'a', name: '本地', model: 'whisper-1' })],
      chains: { asr: ['a', 'missing'], llm: [], multimodal: [] }
    } as never)
    expect(merged.profiles).toHaveLength(1)
    expect(merged.profiles[0]).toMatchObject({ id: 'a', kind: 'asr', enabled: true })
    // The dangling id is dropped once, so a deleted profile cannot leave a hole.
    expect(merged.chains.asr).toEqual(['a'])
  })

  it('keeps a half-filled profile so the form can be typed into', () => {
    const merged = mergeSettings({
      profiles: [{ id: 'new', kind: 'llm', name: '', preset: 'deepseek', baseUrl: '', apiKey: '', model: '' }]
    } as never)
    expect(merged.profiles[0]).toMatchObject({ id: 'new', name: 'deepseek', baseUrl: '' })
  })

  it('drops a profile with an unknown kind', () => {
    const merged = mergeSettings({
      profiles: [{ id: 'x', kind: 'audio', baseUrl: 'https://a.b' }]
    } as never)
    expect(merged.profiles).toEqual([])
  })

  it('defaults enabled to true and honours an explicit false', () => {
    const merged = mergeSettings({
      profiles: [
        { id: 'a', kind: 'asr', baseUrl: 'https://a.b', model: 'm' },
        { id: 'b', kind: 'asr', baseUrl: 'https://c.d', model: 'm', enabled: false }
      ]
    } as never)
    expect(merged.profiles.map((p) => p.enabled)).toEqual([true, false])
  })
})
