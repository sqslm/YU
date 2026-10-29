import { expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from './defaults'
import { onboardingCapabilities, onboardingExamples } from './onboarding'
import type { Settings } from './types'
function configured(kind: 'llm' | 'asr' | 'multimodal'): Settings {
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.profiles = [{ id: kind, kind, enabled: true, name: 'Local', preset: '', baseUrl: 'http://127.0.0.1:1234/v1', apiKey: '', model: 'configured-model' }]
  return settings
}
it('shows no examples before any usable model is configured', () => {
  expect(onboardingExamples(DEFAULT_SETTINGS)).toEqual([])
  for (const patch of [{ enabled: false }, { model: '' }, { baseUrl: '' }]) {
    const settings = configured('llm'); Object.assign(settings.profiles[0], patch)
    expect(onboardingExamples(settings)).toEqual([])
  }
})
it('offers text experiences with LLM alone without pretending voice recognition is configured', () => {
  const settings = configured('llm')
  expect(onboardingCapabilities(settings)).toEqual({ text: true, voice: false })
  expect(onboardingExamples(settings).map(item => item.id)).toEqual(['polish', 'translate', 'reminder', 'todo', 'calendar', 'ask'])
})
it('offers transcription only when ASR is present and does not call it a full assistant', () => {
  expect(onboardingExamples(configured('asr')).map(item => item.id)).toEqual(['dictation'])
  const settings = structuredClone(DEFAULT_SETTINGS); settings.localAsr.enabled = true
  expect(onboardingExamples(settings, false)).toEqual([])
  expect(onboardingExamples(settings, true).map(item => item.id)).toEqual(['dictation'])
})
it('respects the active audio pipeline and marks actual data-creating samples', () => {
  const settings = configured('multimodal')
  expect(onboardingCapabilities(settings).voice).toBe(false)
  settings.pipelineMode = 'multimodal'
  expect(onboardingCapabilities(settings).voice).toBe(true)
  expect(onboardingExamples(configured('llm')).filter(item => item.createsData).map(item => item.id)).toEqual(['reminder', 'todo', 'calendar'])
})
it('hides examples whose tools were disabled and rejects malformed endpoints', () => {
  const settings = configured('llm'); settings.assistantAccess.disabledTools = ['create_reminder', 'create_event']
  expect(onboardingExamples(settings).some(item => item.createsData)).toBe(false)
  settings.profiles[0].baseUrl = 'https://'
  expect(onboardingExamples(settings)).toEqual([])
})
