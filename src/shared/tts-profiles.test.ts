import { expect, it } from 'vitest'
import { applySettingsPatch, mergeSettings } from './defaults'
import { DEFAULT_TTS_SETTINGS, normalizeTtsSettings, ttsProfiles } from './speech'

it('only migrates configured TTS providers and preserves the active provider fields', () => {
  const settings = normalizeTtsSettings({ provider: 'azure', apiKey: 'active-secret', baseUrl: 'https://region.example', apiVoice: 'voice-a',
    connections: { openai: { baseUrl: 'https://one.example', apiKey: 'saved-secret', model: 'tts-a', apiVoice: 'a' } } })
  const profiles = ttsProfiles(settings)
  expect(profiles.map(profile => profile.provider)).toEqual(['windows', 'openai', 'azure'])
  expect(profiles.at(-1)).toMatchObject({ apiKey: 'active-secret', baseUrl: 'https://region.example', apiVoice: 'voice-a' })
  expect(normalizeTtsSettings({ ...settings, profiles, activeProfileId: 'migrated-azure' })).toMatchObject({ provider: 'azure', apiKey: 'active-secret' })
})

it('saves two configurations of the same provider and restores each one after switching and reloading', () => {
  let settings = mergeSettings({ tts: { ...DEFAULT_TTS_SETTINGS, profiles: [
    { id: 'one', name: 'Account 1', provider: 'openai', baseUrl: 'https://one.example', apiKey: 'key-1', model: 'model-1', apiVoice: 'voice-1', speed: 0.8 },
    { id: 'two', name: 'Account 2', provider: 'openai', baseUrl: 'https://two.example', apiKey: 'key-2', model: 'model-2', apiVoice: 'voice-2', speed: 1.5 }
  ], activeProfileId: 'one' } })
  settings = mergeSettings(applySettingsPatch(settings, { tts: { activeProfileId: 'two' } as never }))
  expect(settings.tts).toMatchObject({ apiKey: 'key-2', baseUrl: 'https://two.example', model: 'model-2', apiVoice: 'voice-2', speed: 1.5 })
  settings = mergeSettings(applySettingsPatch(settings, { tts: { apiVoice: 'edited-voice', volume: 40 } as never }))
  settings = mergeSettings(applySettingsPatch(settings, { tts: { activeProfileId: 'one' } as never }))
  expect(settings.tts).toMatchObject({ apiKey: 'key-1', apiVoice: 'voice-1', speed: 0.8 })
  settings = mergeSettings(JSON.parse(JSON.stringify(settings)))
  settings = mergeSettings(applySettingsPatch(settings, { tts: { activeProfileId: 'two' } as never }))
  expect(settings.tts).toMatchObject({ apiVoice: 'edited-voice', volume: 40 })
})

it('editing a nonactive TTS profile never overwrites the active one', () => {
  const tts = normalizeTtsSettings({ ...DEFAULT_TTS_SETTINGS, profiles: ttsProfiles(DEFAULT_TTS_SETTINGS) })
  const renamed = { ...tts, profiles: [...tts.profiles!, { id: 'other', name: 'Other', provider: 'custom' as const, baseUrl: 'https://test', apiKey: 'other-secret', model: 'other', apiVoice: 'b' }] }
  expect(normalizeTtsSettings(renamed).apiKey).toBe('')
})
