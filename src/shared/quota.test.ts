import { expect, it } from 'vitest'
import { mergeSettings } from './defaults'
import { defaultQuotaTarget, quotaAmountMetric, quotaConnections, quotaRemainingRatio, type QuotaResult } from './quota'

it('lists saved ASR/LLM/multimodal/TTS connections, including disabled ones and enabled local ASR, without credentials', () => {
  const settings = mergeSettings({})
  settings.profiles = ['asr', 'llm', 'multimodal'].map(kind => ({ id: kind, kind: kind as 'asr' | 'llm' | 'multimodal', name: kind, preset: '', baseUrl: 'https://example.com', model: kind, apiKey: 'must-not-return', enabled: kind !== 'asr' }))
  settings.localAsr.enabled = true
  expect(quotaConnections(settings).map(row => row.kind)).toEqual(['asr', 'llm', 'multimodal', 'local-asr', 'tts'])
  expect(JSON.stringify(quotaConnections(settings))).not.toContain('must-not-return')
  expect(defaultQuotaTarget(settings)?.kind).toBe('llm')
})
it('selects the enabled preferred LLM without mixing different accounts or units', () => {
  const settings = mergeSettings({})
  settings.profiles = ['one', 'two'].map(id => ({ id, kind: 'llm', name: id, preset: '', baseUrl: 'https://example.com', model: id, apiKey: '', enabled: true }))
  settings.chains.llm = ['two', 'one']
  expect(defaultQuotaTarget(settings)?.id).toBe('two')
})
it('calculates only known nonzero limits, preserving unknown versus exhausted', () => {
  const row = (remaining: number, total?: number): QuotaResult => ({ status: 'ok', scope: 'key', message: '', checkedAt: 1, metrics: [{ label: '', unit: 'USD', remaining, total }] })
  expect(quotaRemainingRatio(row(75, 100))).toBe(0.75)
  expect(quotaRemainingRatio(row(0, 100))).toBe(0)
  expect(quotaRemainingRatio(row(-5, 100))).toBe(0)
  expect(quotaRemainingRatio(row(110, 100))).toBe(1)
  expect(quotaRemainingRatio(row(5))).toBeUndefined()
  expect(quotaRemainingRatio(row(0, 0))).toBeUndefined()
})
it('recognizes the active legacy TTS connection when no LLM is configured', () => {
  const settings = mergeSettings({})
  settings.tts.enabled = true; settings.tts.provider = 'elevenlabs'
  settings.tts.baseUrl = 'https://api.elevenlabs.io/v1/text-to-speech'; settings.tts.model = 'voice-model'
  expect(defaultQuotaTarget(settings)).toMatchObject({ kind: 'tts', id: 'migrated-elevenlabs' })
})

it('falls back to the amount when a provider reports money without a ceiling', () => {
  const balance: QuotaResult = { status: 'ok', scope: 'account', message: '', checkedAt: 1, metrics: [{ label: '可用余额', remaining: 7.62, unit: 'CNY' }] }
  expect(quotaRemainingRatio(balance)).toBeUndefined()
  expect(quotaAmountMetric(balance)).toMatchObject({ label: '可用余额', remaining: 7.62 })
  const usage: QuotaResult = { status: 'ok', scope: 'key', message: '', checkedAt: 1, metrics: [{ label: '密钥累计用量', used: 3.5, unit: 'USD' }] }
  expect(quotaAmountMetric(usage)).toMatchObject({ used: 3.5 })
})
it('prefers a real ratio and ignores unavailable or empty rows', () => {
  const mixed: QuotaResult = { status: 'ok', scope: 'account', message: '', checkedAt: 1, metrics: [
    { label: 'a', remaining: 5, unit: 'CNY' }, { label: 'b', remaining: 75, total: 100, unit: 'USD' }] }
  expect(quotaAmountMetric(mixed)).toMatchObject({ label: 'a' })
  expect(quotaAmountMetric({ ...mixed, status: 'error', metrics: [] })).toBeUndefined()
  expect(quotaAmountMetric({ status: 'ok', scope: 'none', message: '', checkedAt: 1, metrics: [] })).toBeUndefined()
  expect(quotaAmountMetric({ ...mixed, metrics: [{ label: 'c', remaining: 0, total: 0, unit: 'USD' }] })).toMatchObject({ label: 'c' })
})
