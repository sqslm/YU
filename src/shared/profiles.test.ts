import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { ProviderProfile, Settings } from '@shared/types'
import {
  moveProfile,
  newProfileId,
  profilesOf,
  removeProfile,
  setProfileEnabled,
  uniqueProfileName,
  upsertProfile
} from './profiles'

function profile(over: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 'a',
    name: 'A',
    kind: 'llm',
    preset: '',
    baseUrl: 'https://a.test/v1',
    apiKey: '',
    model: 'm',
    enabled: true,
    ...over
  }
}

function settings(over: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    profiles: [profile({ id: 'a' }), profile({ id: 'b' }), profile({ id: 'c' })],
    chains: { asr: [], llm: ['a', 'b', 'c'], multimodal: [] },
    ...over
  }
}

describe('profilesOf', () => {
  it('returns chain order first', () => {
    const s = settings({ chains: { asr: [], llm: ['c', 'a', 'b'], multimodal: [] } })
    expect(profilesOf(s, 'llm').map((p) => p.id)).toEqual(['c', 'a', 'b'])
  })

  it('appends profiles that are not chained yet', () => {
    const s = settings({ chains: { asr: [], llm: ['b'], multimodal: [] } })
    expect(profilesOf(s, 'llm').map((p) => p.id)).toEqual(['b', 'a', 'c'])
  })

  it('only returns the requested kind', () => {
    const s = settings({
      profiles: [profile({ id: 'a' }), profile({ id: 'x', kind: 'asr' })],
      chains: { asr: ['x'], llm: ['a'], multimodal: [] }
    })
    expect(profilesOf(s, 'asr').map((p) => p.id)).toEqual(['x'])
  })
})

describe('upsertProfile', () => {
  it('adds a new profile to the end of its chain', () => {
    const next = upsertProfile(settings(), profile({ id: 'd' }))
    expect(next.profiles).toHaveLength(4)
    expect(next.chains.llm).toEqual(['a', 'b', 'c', 'd'])
  })

  it('replaces in place without duplicating the chain entry', () => {
    const next = upsertProfile(settings(), profile({ id: 'b', model: 'new-model' }))
    expect(next.profiles).toHaveLength(3)
    expect(next.profiles.find((p) => p.id === 'b')!.model).toBe('new-model')
    expect(next.chains.llm).toEqual(['a', 'b', 'c'])
  })
})

describe('removeProfile', () => {
  it('drops the profile and its chain slots', () => {
    const next = removeProfile(settings(), 'b')
    expect(next.profiles.map((p) => p.id)).toEqual(['a', 'c'])
    expect(next.chains.llm).toEqual(['a', 'c'])
  })
})

describe('moveProfile', () => {
  it('moves earlier and later inside the chain', () => {
    const up = moveProfile(settings(), 'b', -1)
    expect(up.chains.llm).toEqual(['b', 'a', 'c'])
    const down = moveProfile(settings(), 'a', 1)
    expect(down.chains.llm).toEqual(['b', 'a', 'c'])
  })

  it('clamps at both ends instead of wrapping', () => {
    expect(moveProfile(settings(), 'a', -1).chains.llm).toEqual(['a', 'b', 'c'])
    expect(moveProfile(settings(), 'c', 1).chains.llm).toEqual(['a', 'b', 'c'])
  })

  it('chains an unchained profile at the end before moving it', () => {
    const s = settings({ chains: { asr: [], llm: ['a'], multimodal: [] } })
    // Unchained profiles render last, so "move up" puts them in front of 'a'.
    expect(moveProfile(s, 'c', -1).chains.llm).toEqual(['c', 'a'])
  })

  it('leaves the chain alone when an unchained profile is already last', () => {
    const s = settings({ chains: { asr: [], llm: ['a'], multimodal: [] } })
    // It already renders last, so a downward move is a no-op rather than a rewrite.
    expect(moveProfile(s, 'c', 1).chains.llm).toEqual(['a'])
  })

  it('ignores an unknown id', () => {
    const base = settings()
    expect(moveProfile(base, 'nope', 1)).toBe(base)
  })
})

describe('setProfileEnabled', () => {
  it('flips enabled and keeps the position', () => {
    const next = setProfileEnabled(settings(), 'a', false)
    expect(next.profiles.find((p) => p.id === 'a')!.enabled).toBe(false)
    expect(next.chains.llm).toEqual(['a', 'b', 'c'])
  })
})

describe('newProfileId', () => {
  it('returns the first free slot per kind', () => {
    expect(newProfileId('llm', [profile({ id: 'llm-1' })])).toBe('llm-2')
    expect(newProfileId('asr', [])).toBe('asr-1')
  })
})
describe('uniqueProfileName', () => {
  it('keeps a name nobody else uses', () => {
    expect(uniqueProfileName('Groq', [profile({ name: 'OpenAI' })])).toBe('Groq')
  })

  it('suffixes a duplicate so two rows never look identical', () => {
    const existing = [profile({ id: 'a', name: 'Groq' }), profile({ id: 'b', name: 'Groq 2' })]
    expect(uniqueProfileName('Groq', existing)).toBe('Groq 3')
  })

  it('falls back to a placeholder for an empty name', () => {
    expect(uniqueProfileName('   ', [])).toBe('未命名')
  })
})