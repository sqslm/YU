import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mergeSettings } from '@shared/defaults'
import REFINEMENT_PROMPT from './prompts/reminder-refinement.md?raw'
const mocks = vi.hoisted(() => ({ complete: vi.fn() }))
vi.mock('./providers/llm', () => ({ complete: mocks.complete }))
import { extractReminders, parseReminderOutput } from './reminder-parser'

const now = new Date(2026, 9, 23, 8).getTime()
const candidate = (overrides = {}) => ({ title: '联系维修师傅', description: '询问电脑是否修好；如果没修好，询问预计完成时间。',
  time_expression: '20分钟后', time_type: 'relative', relative_value: 20, relative_unit: 'minute',
  level: 'normal', recurrence: null, status: 'ready', missing_fields: [], ...overrides })
const extracted = (overrides = {}) => ({ intent: 'create_reminder', title: '联系维修师傅', description: candidate().description,
  time_expression: '20分钟后', level: 'normal', recurrence: null, needs_confirmation: false, ...overrides })
const profile = (id: string) => ({ id, kind: 'llm' as const, enabled: true, name: id, preset: '', baseUrl: 'http://llm.test/v1', apiKey: 'test', model: id })
const settings = () => mergeSettings({ profiles: [profile('primary')], chains: { asr: [], llm: ['primary'], multimodal: [] } })
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks() })

describe('fixed full-document reminder refinement', () => {
  it('preserves the complete user prompt with only the authorized product-name substitutions', () => {
    expect(REFINEMENT_PROMPT.match(/语（YU）/g)).toHaveLength(2)
    expect(createHash('sha256').update(REFINEMENT_PROMPT.replace(/语（YU）/g, 'Typeless Rebuild').replace(/\r\n/g, '\n')).digest('hex'))
      .toBe('282fe51c08e1e731484f441a96eeb31eb502e2bc712a4332c2a87733af7140f6')
  })
  it.each(['voice', 'note'] as const)('uses the full template before extraction for %s, with one reference time and no user polish prompt', async source => {
    vi.useFakeTimers(); vi.setSystemTime(now)
    const refined = { reminders: [candidate()] }, progress = vi.fn(), config = settings()
    config.polish.systemPrompt = 'UNRELATED_USER_POLISH'
    mocks.complete.mockImplementationOnce(async () => { vi.setSystemTime(now + 120_000); return JSON.stringify(refined) })
      .mockResolvedValueOnce(JSON.stringify({ items: [extracted()] }))
    const original = '嗯，20分钟后提醒我联系维修师傅，问电脑修没修好，如果没修好就问大概还要多久。'
    const rows = await extractReminders(config, original, source, new AbortController().signal, progress)
    expect(mocks.complete).toHaveBeenCalledTimes(2)
    const first = mocks.complete.mock.calls[0][1], second = mocks.complete.mock.calls[1][1]
    expect(first.messages[0]).toEqual({ role: 'system', content: REFINEMENT_PROMPT })
    expect(first.messages[1].content).toContain(`source=${source}`)
    expect(JSON.parse(first.messages.at(-1).content)).toMatchObject({ ASR_TEXT: original, REQUEST_TIMESTAMP: now, source })
    expect(JSON.parse(second.messages.at(-1).content)).toMatchObject({ text: JSON.stringify(refined), original_text: original, REQUEST_TIMESTAMP: now, source })
    expect(first.messages.some((m: { content: string }) => m.content.includes('UNRELATED_USER_POLISH'))).toBe(false)
    expect(second.messages.some((m: { content: string }) => m.content.includes('UNRELATED_USER_POLISH'))).toBe(false)
    expect(rows[0]).toMatchObject({ description: candidate().description, dueAt: now + 20 * 60_000, needs_confirmation: false })
    expect(progress.mock.calls.map(([hint]) => hint)).toEqual(['整理提醒内容…', '提取提醒事项…'])
  })
  it('stops after refinement for a withdrawn or empty request', async () => {
    mocks.complete.mockResolvedValueOnce('{"reminders":[]}')
    expect(await extractReminders(settings(), '半小时后洗衣服，算了先不用提醒。', 'voice')).toEqual([])
    expect(mocks.complete).toHaveBeenCalledOnce()
  })
  it('does not run extraction when cancelled between stages or when refinement is invalid', async () => {
    const controller = new AbortController()
    mocks.complete.mockImplementationOnce(async () => { controller.abort(); return JSON.stringify({ reminders: [candidate()] }) })
    await expect(extractReminders(settings(), '提醒我联系师傅', 'voice', controller.signal)).rejects.toThrow()
    expect(mocks.complete).toHaveBeenCalledOnce()
    mocks.complete.mockClear(); mocks.complete.mockResolvedValueOnce('{"items":[]}')
    await expect(extractReminders(settings(), '提醒我联系师傅', 'voice')).rejects.toThrow('提醒内容提炼格式无效')
    expect(mocks.complete).toHaveBeenCalledOnce()
  })
  it('keeps uncertainty from refinement even when the second model returns ready', async () => {
    mocks.complete.mockResolvedValueOnce(JSON.stringify({ reminders: [candidate({ status: 'needs_clarification', missing_fields: ['time_period'] })] }))
      .mockResolvedValueOnce(JSON.stringify({ items: [extracted()] }))
    expect((await extractReminders(settings(), '明天十点联系师傅', 'voice'))[0]).toMatchObject({ needs_confirmation: true, issue: '请核对提炼后的提醒内容' })
  })
  it('restarts the same two-stage chain on the next configured provider after extraction fails', async () => {
    const config = settings(); config.profiles.push(profile('backup')); config.chains.llm.push('backup')
    const refined = JSON.stringify({ reminders: [candidate()] })
    mocks.complete.mockResolvedValueOnce(refined).mockRejectedValueOnce(new Error('provider failed'))
      .mockResolvedValueOnce(refined).mockResolvedValueOnce(JSON.stringify({ items: [extracted()] }))
    await expect(extractReminders(config, '20分钟后联系师傅', 'voice')).resolves.toHaveLength(1)
    expect(mocks.complete.mock.calls.map(([cfg]) => cfg.model)).toEqual(['primary', 'primary', 'backup', 'backup'])
  })
  it('preserves unsupported recurrence as review, never an unbounded or one-off schedule', () => {
    const row = parseReminderOutput(JSON.stringify({ items: [extracted({ time_expression: '每天上午9点，持续7天', unsupported_recurrence: true })] }), now)[0]
    expect(row).toMatchObject({ dueAt: null, rule: null, needs_confirmation: true, description: candidate().description })
  })
  it('rejects oversized input without silently removing a later correction or cancellation', async () => {
    await expect(extractReminders(settings(), 'a'.repeat(200_001), 'note')).rejects.toThrow('提醒内容过长')
    expect(mocks.complete).not.toHaveBeenCalled()
  })
  it('keeps untimed to-dos valid while reminders without times still require clarification', () => {
    const items = [extracted({ intent: 'todo', time_expression: null }), extracted({ time_expression: null })]
    expect(parseReminderOutput(JSON.stringify({ items }), now)).toMatchObject([
      { intent: 'todo', needs_confirmation: false, dueAt: null },
      { intent: 'create_reminder', needs_confirmation: true, dueAt: null }
    ])
  })
})
