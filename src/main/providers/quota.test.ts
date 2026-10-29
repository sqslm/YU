import { describe, expect, it, vi } from 'vitest'
import { mergeSettings } from '@shared/defaults'
import type { ProviderProfile } from '@shared/types'
import { QuotaService, parseQuota } from './quota'
import { quotaRemainingRatio } from '@shared/quota'

const profile = (patch: Partial<ProviderProfile> = {}): ProviderProfile => ({ id: 'first', kind: 'llm', name: 'Saved connection', preset: 'deepseek', enabled: true, baseUrl: 'https://api.deepseek.com/v1', apiKey: 'fixture-key', model: 'model', ...patch })
const balance = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.50', granted_balance: '2.50', topped_up_balance: '10.00' }] }
const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status })

describe('documented quota response contracts', () => {
  it('keeps real balance/currency, never invents a total from remaining balance', () => {
    const parsed = parseQuota('deepseek', balance)
    expect(parsed).toMatchObject({ scope: 'account', metrics: [{ remaining: 12.5, unit: 'CNY' }] })
    expect(parsed.metrics[0].total).toBeUndefined()
    expect(quotaRemainingRatio({ ...parsed, status: 'ok', checkedAt: 1 })).toBeUndefined()
  })
  it('preserves different currencies separately, including zero and debt', () => {
    const parsed = parseQuota('deepseek', { balance_infos: [{ currency: 'CNY', total_balance: '0' }, { currency: 'USD', total_balance: '-1.25' }] })
    expect(parsed.metrics.map(row => [row.unit, row.remaining])).toEqual([['CNY', 0], ['USD', -1.25]])
  })
  it('does not confuse SiliconFlow remaining totals with the original allotment', () => {
    expect(parseQuota('siliconflow', { status: true, data: { status: 'normal', balance: '0.88', chargeBalance: '88.00', totalBalance: '88.88' } }).metrics).toEqual([{ label: '可用余额', remaining: 88.88, unit: 'CNY' }])
    expect(() => parseQuota('siliconflow', { status: true, data: { status: '', balance: '0', chargeBalance: '0', totalBalance: '0' } })).toThrow('restricted')
  })
  it('parses Moonshot account balance without adding vouchers twice', () => {
    expect(parseQuota('moonshot', { status: true, data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 } }).metrics[0].remaining).toBe(49.58894)
  })
  it('uses OpenRouter limit_remaining for its reset window rather than lifetime usage', () => {
    const parsed = parseQuota('openrouter', { data: { limit: 100, limit_remaining: 80, usage: 450, limit_reset: 'monthly' } })
    expect(parsed.metrics[0]).toMatchObject({ remaining: 80, total: 100, used: 20 })
    expect(parseQuota('openrouter', { data: { limit: null, limit_remaining: null, usage: 12 } }).metrics[0]).toMatchObject({ used: 12 })
    expect(parseQuota('openrouter', { data: { limit: null, usage: 12 } }).metrics[0].remaining).toBeUndefined()
  })
  it('keeps subscription characters separate from currency and reports the actual reset', () => {
    const parsed = parseQuota('elevenlabs', { character_count: 1200, character_limit: 1000, next_character_count_reset_unix: 1800000000 })
    expect(parsed.metrics[0]).toMatchObject({ remaining: 0, used: 1200, total: 1000, unit: 'characters', resetsAt: 1800000000000 })
  })
  it.each([null, {}, { balance_infos: [] }, { balance_infos: [{ currency: 'CNY', total_balance: '' }] }, { balance_infos: [{ currency: 'CNY', total_balance: 'NaN' }] }])('rejects absent/malformed data instead of showing zero: %j', body => {
    expect(() => parseQuota('deepseek', body)).toThrow()
  })
})

describe('saved-connection quota queries', () => {
  it('uses the actual saved host and auth, shares the same account lookup across models, and invalidates on key change', async () => {
    const settings = mergeSettings({ profiles: [profile(), profile({ id: 'second', kind: 'asr', model: 'other' })] })
    const request = vi.fn<typeof fetch>().mockImplementation(async () => response(balance))
    let now = 1000
    const service = new QuotaService(() => settings, request, () => now)
    const results = await Promise.all([service.query({ kind: 'llm', id: 'first' }), service.query({ kind: 'asr', id: 'second' })])
    expect(results.every(row => row.status === 'ok')).toBe(true)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0][0]).toBe('https://api.deepseek.com/user/balance')
    expect(new Headers(request.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer fixture-key')
    expect(request.mock.calls[0][1]).toMatchObject({ redirect: 'error', method: 'GET' })
    await service.query({ kind: 'llm', id: 'first' }); expect(request).toHaveBeenCalledTimes(1)
    settings.profiles[0].apiKey = 'changed-key'
    await service.query({ kind: 'llm', id: 'first' }); expect(request).toHaveBeenCalledTimes(2)
    now += 300001
    await service.query({ kind: 'llm', id: 'first' }); expect(request).toHaveBeenCalledTimes(3)
    service.clear(); await service.query({ kind: 'llm', id: 'first' }); expect(request).toHaveBeenCalledTimes(4)
  })
  it.each(['https://gateway.example/v1', 'http://api.deepseek.com/v1', 'https://api.deepseek.com:8443/v1', 'https://api.deepseek.com.evil.example/v1'])('never sends keys to a guessed endpoint for %s', async baseUrl => {
    const request = vi.fn<typeof fetch>(), settings = mergeSettings({ profiles: [profile({ baseUrl })] })
    expect((await new QuotaService(() => settings, request).query({ kind: 'llm', id: 'first' })).status).toBe('unsupported')
    expect(request).not.toHaveBeenCalled()
  })
  it.each([401, 403, 404, 410, 429, 500])('reports HTTP %s without leaking the vendor body or a fake exhausted balance', async status => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response({ error: 'sensitive vendor body' }, status))
    const row = await new QuotaService(() => mergeSettings({ profiles: [profile()] }), request).query({ kind: 'llm', id: 'first' })
    expect(row.status).toBe([404, 410].includes(status) ? 'unsupported' : 'error')
    expect(row.metrics).toEqual([]); expect(JSON.stringify(row)).not.toContain('sensitive')
  })
  it('does not fetch when keys or saved connections are missing, or for local voices', async () => {
    const request = vi.fn<typeof fetch>(), service = new QuotaService(() => mergeSettings({ profiles: [profile({ apiKey: '' })] }), request)
    expect((await service.query({ kind: 'llm', id: 'first' })).status).toBe('unconfigured')
    expect((await service.query({ kind: 'llm', id: 'deleted' })).status).toBe('unconfigured')
    expect((await service.query({ kind: 'tts', id: 'windows' })).status).toBe('local')
    expect(request).not.toHaveBeenCalled()
  })
  it('uses ElevenLabs xi-api-key from its saved TTS profile', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response({ character_count: 25, character_limit: 100 }))
    const settings = mergeSettings({})
    settings.tts.profiles = [{ id: 'voice', name: 'Voice', provider: 'elevenlabs', baseUrl: 'https://api.elevenlabs.io/v1/text-to-speech', apiKey: 'voice-key', model: 'eleven_multilingual_v2', apiVoice: 'voice' }]
    const row = await new QuotaService(() => settings, request).query({ kind: 'tts', id: 'voice' })
    expect(row.metrics[0].remaining).toBe(75)
    expect(new Headers(request.mock.calls[0][1]?.headers).get('xi-api-key')).toBe('voice-key')
  })
  it('handles malformed success bodies and network errors without leaving failed promises cached forever', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response({})).mockRejectedValueOnce(Error('private endpoint details')).mockResolvedValueOnce(response(balance))
    const service = new QuotaService(() => mergeSettings({ profiles: [profile()] }), request)
    expect((await service.query({ kind: 'llm', id: 'first' })).status).toBe('error')
    service.clear()
    expect(JSON.stringify(await service.query({ kind: 'llm', id: 'first' }))).not.toContain('private')
    service.clear()
    expect((await service.query({ kind: 'llm', id: 'first' })).status).toBe('ok')
  })
  it('reports cancellation from its timeout without persisting a fake balance', async () => {
    const controller = new AbortController(), timer = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    const request = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Error('aborted')), { once: true })
    }))
    try {
      const pending = new QuotaService(() => mergeSettings({ profiles: [profile()] }), request).query({ kind: 'llm', id: 'first' })
      controller.abort()
      expect(await pending).toMatchObject({ status: 'error', message: '额度查询超时，请检查网络后重试', metrics: [] })
    } finally { timer.mockRestore() }
  })
})
