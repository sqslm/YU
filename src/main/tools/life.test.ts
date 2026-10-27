import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mergeSettings } from '@shared/defaults'
import { setMainLanguage } from '@shared/mainI18n'
import type { LifeBriefing, LifeEvent, LifeSyncStatus, LifeTools } from './life'
import { LIFE_TOOLS } from './life'
import { DEFAULT_TTS_SETTINGS } from '@shared/speech'
import { runTool, toolSchemas, type ToolContext } from './registry'

/**
 * The life tools are the first place where an assistant answer can change a
 * lasting store — an event, the sync switch. These cases pin the two
 * halves that matter: what the model is allowed to reach, and what the program
 * does with a real argument (including the refusals).
 */

const event = (overrides: Partial<LifeEvent> = {}): LifeEvent => ({
  id: 'e1', title: '项目讨论', start: new Date(2026, 9, 24, 15).getTime(), end: new Date(2026, 9, 24, 16).getTime(),
  allDay: false, status: 'confirmed', ...overrides
})

const status = (overrides: Partial<LifeSyncStatus> = {}): LifeSyncStatus => ({
  enabled: true, signedIn: true, serverUrl: 'https://sync.test', lastSyncAt: new Date(2026, 9, 24, 9).getTime(),
  busy: false, ...overrides
})

const briefing = (overrides: Partial<LifeBriefing> = {}): LifeBriefing => ({
  title: '10 月 24 日 · 今日简报', body: '今天\n- 15:00–16:00 项目讨论', empty: false, ...overrides
})

let api: LifeTools, ctx: ToolContext

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 9, 23, 8, 0))
  api = {
    event: vi.fn().mockReturnValue(event()),
    events: vi.fn().mockReturnValue([event()]),
    saveEvent: vi.fn((input, id) => event({ ...input, id: id ?? 'e-new' } as Partial<LifeEvent>)),
    controlEvent: vi.fn((id: string, action: 'cancel' | 'restore') => event({ id, status: action === 'cancel' ? 'cancelled' : 'confirmed' })),
    briefing: vi.fn().mockReturnValue(briefing()),
    speak: vi.fn().mockResolvedValue({ spoken: 42, skipped: false }),
    stopSpeaking: vi.fn(),
    ttsEnabled: vi.fn().mockReturnValue(true),
    syncStatus: vi.fn().mockReturnValue(status()),
    setSyncEnabled: vi.fn()
  }
  ctx = { settings: mergeSettings({}), question: '明天下午三点有个项目讨论', log: vi.fn(), allowedTools: LIFE_TOOLS,
    life: api, cache: new Map(), signal: new AbortController().signal, onLocalResult: vi.fn(), submittedAt: Date.now() }
})

afterEach(() => { vi.useRealTimers(); setMainLanguage('zh') })

describe('life tools reach real stores and stay out of ordinary answers', () => {
  it('propagates tool cancellation to pending speech so a timed-out request cannot speak later', async () => {
    let signal: AbortSignal | undefined
    api.speak = vi.fn((_text, received) => { signal = received; return new Promise<{ spoken: number; skipped: boolean }>(() => undefined) })
    ctx.timeouts = { speak_text: 5 }
    const pending = runTool('speak_text', { text: 'hello' }, ctx)
    await vi.advanceTimersByTimeAsync(6)
    expect((await pending).status).toBe('timeout')
    expect(signal?.aborted).toBe(true)
  })
  it('does not disclose provider credentials through read-aloud tool results', async () => {
    api.speechSettings = () => ({ ...DEFAULT_TTS_SETTINGS, apiKey: 'tts-secret', connections: { openai: { baseUrl: 'https://example.test', apiKey: 'saved-secret', model: 'tts', apiVoice: 'a' } } })
    api.setSpeechSettings = vi.fn()
    const result = await runTool('configure_speech', {}, ctx)
    expect(result.ok).toBe(true)
    expect(JSON.stringify(result)).not.toContain('secret')
  })
  it('resolves both tomorrow endpoints against the original request day, and refuses a reversed range', async () => {
    expect((await runTool('create_event', { title: '项目讨论', start: '明天下午三点', end: '明天下午四点' }, ctx)).ok).toBe(true)
    expect(api.saveEvent).toHaveBeenCalledWith(expect.objectContaining({ start: +new Date(2026,9,24,15), end: +new Date(2026,9,24,16) }))
    vi.mocked(api.saveEvent).mockClear()
    expect((await runTool('create_event', { title: '错误时间', start: '明天下午三点', end: '明天下午两点' }, ctx)).ok).toBe(false)
    expect(api.saveEvent).not.toHaveBeenCalled()
  })
  it('persists text-only mode only when requested while always stopping current speech', async () => {
    api.setTtsEnabled = vi.fn().mockResolvedValue(undefined)
    await runTool('stop_speaking', { text_only: true }, ctx)
    expect(api.stopSpeaking).toHaveBeenCalledOnce()
    expect(api.setTtsEnabled).toHaveBeenCalledExactlyOnceWith(false)
  })
  it('edits an event clock on its existing day and uses the submission time for relative starts', async () => {
    await runTool('manage_event', { id: 'e1', action: 'update', start: '下午四点', end: '下午五点' }, ctx)
    expect(api.saveEvent).toHaveBeenCalledWith(expect.objectContaining({ start: new Date(2026,9,24,16).getTime(), end: new Date(2026,9,24,17).getTime() }), 'e1')
    vi.mocked(api.saveEvent).mockClear()
    await runTool('create_event', { title: '相对日程', start: '十分钟后' }, { ...ctx, submittedAt: Date.now()-120000 })
    expect(api.saveEvent).toHaveBeenCalledWith(expect.objectContaining({ start: Date.now()+8*60000 }))
  })
  it('configures one persisted daily briefing without creating a reminder', async () => {
    let current = { ...mergeSettings({}).briefing, enabled: false }
    api.briefingSettings = () => current
    api.setBriefingSettings = vi.fn(async patch => { current = { ...current, ...patch }; return current })
    const result = await runTool('configure_briefing', { enabled: true, time: '08:00' }, { ...ctx, allowedTools: [...LIFE_TOOLS, 'configure_briefing'] })
    expect(result.ok).toBe(true); expect(current).toMatchObject({ enabled: true, time: '08:00' })
    expect(api.saveEvent).not.toHaveBeenCalled()
    expect((await runTool('configure_briefing', { time: '25:00' }, { ...ctx, allowedTools: [...LIFE_TOOLS, 'configure_briefing'] })).ok).toBe(false)
  })
  it('keeps calendar and sync tools out of plain Ask and denies a missing capability', async () => {
    const names = toolSchemas().map(tool => (tool.function as { name: string }).name)
    for (const name of LIFE_TOOLS) expect(names).not.toContain(name)
    expect((await runTool('create_event', { title: 'x', start: '明天下午三点' }, { ...ctx, allowedTools: undefined })).ok).toBe(false)
    expect((await runTool('list_events', {}, { ...ctx, life: undefined })).ok).toBe(false)
    expect(api.saveEvent).not.toHaveBeenCalled()
    expect(api.events).not.toHaveBeenCalled()
  })

  it('parses the start with the reminder parser and recovers a dropped daypart in the end', async () => {
    const result = await runTool('create_event', { title: '项目讨论', start: '明天下午三点', end: '四点' }, ctx)
    const input = vi.mocked(api.saveEvent).mock.calls[0][0]
    expect(input.start).toBe(new Date(2026, 9, 24, 15).getTime())
    expect(input.end).toBe(new Date(2026, 9, 24, 16).getTime())
    expect(result.data.item).toMatchObject({ title: '项目讨论', cancelled: false })
    expect((await runTool('create_event', { title: '没有时间' }, ctx)).ok).toBe(false)
  })

  it('defaults to one hour and normalises whole-day events to local midnight', async () => {
    await runTool('create_event', { title: '评审', start: '明天上午九点' }, ctx)
    const single = vi.mocked(api.saveEvent).mock.calls[0][0]
    expect(single.end - single.start).toBe(60 * 60_000)
    await runTool('create_event', { title: '团建', start: '明天', all_day: true }, ctx)
    const allDay = vi.mocked(api.saveEvent).mock.calls[1][0]
    expect(new Date(allDay.start).getHours()).toBe(0)
    expect(allDay.end - allDay.start).toBe(24 * 60 * 60_000)
  })

  it('reads one explicit day or a named range, hides cancelled events and filters by keyword', async () => {
    await runTool('list_events', { day: '2026-10-24' }, ctx)
    expect(vi.mocked(api.events).mock.calls[0][0]).toEqual({ from: new Date(2026, 9, 24).getTime(), until: new Date(2026, 9, 25).getTime() })
    await runTool('list_events', { range: 'tomorrow' }, ctx)
    expect(vi.mocked(api.events).mock.calls[1][0]).toMatchObject({ from: new Date(2026, 9, 24).getTime() })
    vi.mocked(api.events).mockReturnValue([event({ id: 'c', status: 'cancelled' }), event({ id: 'k', title: '牙医', location: '医院' })])
    const filtered = await runTool('list_events', { query: '医院' }, ctx)
    expect(filtered.data).toMatchObject({ total: 1 })
    expect((filtered.data.items as { id: string }[])[0].id).toBe('k')
  })

  it('refuses a no-op edit but moves an event when only the start changes and keeps its duration', async () => {
    expect((await runTool('manage_event', { id: 'e1', action: 'update' }, ctx)).ok).toBe(false)
    expect(api.saveEvent).not.toHaveBeenCalled()
    const moved = await runTool('manage_event', { id: 'e1', action: 'update', start: '明天下午五点' }, ctx)
    expect(moved.ok).toBe(true)
    const input = vi.mocked(api.saveEvent).mock.calls[0][0]
    expect(input.start).toBe(new Date(2026, 9, 24, 17).getTime())
    expect(input.end - input.start).toBe(60 * 60_000)
    expect((await runTool('manage_event', { id: 'e1', action: 'archive' }, ctx)).ok).toBe(false)
  })

  it('cancels and restores a real event instead of deleting it', async () => {
    const cancelled = await runTool('manage_event', { id: 'e1', action: 'cancel' }, ctx)
    expect(api.controlEvent).toHaveBeenCalledWith('e1', 'cancel')
    expect(cancelled.data).toMatchObject({ id: 'e1', action: 'cancel', item: { cancelled: true } })
    vi.mocked(api.event).mockReturnValue(undefined)
    expect((await runTool('manage_event', { id: 'ghost', action: 'cancel' }, ctx)).ok).toBe(false)
  })

  it('returns the composed briefing and only speaks when the setting is on', async () => {
    const plain = await runTool('daily_briefing', {}, ctx)
    expect(plain.data).toMatchObject({ body: briefing().body, empty: false })
    expect(api.speak).not.toHaveBeenCalled()
    vi.mocked(api.ttsEnabled).mockReturnValue(false)
    const quiet = await runTool('daily_briefing', { speak: true }, ctx)
    expect(api.speak).not.toHaveBeenCalled()
    expect(quiet.summary).toContain('没有朗读')
    vi.mocked(api.ttsEnabled).mockReturnValue(true)
    const spoken = await runTool('daily_briefing', { speak: true }, ctx)
    expect(api.speak).toHaveBeenCalledWith(briefing().body, expect.any(AbortSignal))
    expect(spoken.data).toMatchObject({ spoken: 42 })
  })

  it('reports a disabled voice honestly instead of pretending to read', async () => {
    vi.mocked(api.ttsEnabled).mockReturnValue(false)
    const result = await runTool('speak_text', { text: '这是一段文字' }, ctx)
    expect(api.speak).not.toHaveBeenCalled()
    expect(result.data).toMatchObject({ spoken: 0, skipped: true, reason: 'disabled' })
    vi.mocked(api.ttsEnabled).mockReturnValue(true)
    const read = await runTool('speak_text', { text: '这是一段文字' }, ctx)
    expect(api.speak).toHaveBeenCalledWith('这是一段文字', expect.any(AbortSignal))
    expect(read.data).toMatchObject({ spoken: 42, skipped: false })
    expect((await runTool('speak_text', {}, ctx)).ok).toBe(false)
  })

  it('stops the current read-aloud and tolerates nothing being read', async () => {
    expect((await runTool('stop_speaking', {}, ctx)).ok).toBe(true)
    expect(api.stopSpeaking).toHaveBeenCalled()
  })

  it('describes the real sync state, never a hopeful one', async () => {
    const signedIn = await runTool('sync_status', {}, ctx)
    expect(signedIn.data).toMatchObject({ enabled: true, signedIn: true, serverUrl: 'https://sync.test' })
    vi.mocked(api.syncStatus).mockReturnValue(status({ enabled: false }))
    expect((await runTool('sync_status', {}, ctx)).summary).toContain('暂停')
    vi.mocked(api.syncStatus).mockReturnValue(status({ signedIn: false, lastSyncAt: null }))
    expect((await runTool('sync_status', {}, ctx)).summary).toContain('登录')
  })

  it('pauses sync without touching local data and refuses to resume while signed out', async () => {
    const paused = await runTool('sync_control', { action: 'pause' }, ctx)
    expect(api.setSyncEnabled).toHaveBeenCalledWith(false)
    expect(paused.summary).toContain('本地')
    vi.mocked(api.syncStatus).mockReturnValue(status({ enabled: false, signedIn: false }))
    expect((await runTool('sync_control', { action: 'resume' }, ctx)).ok).toBe(false)
    vi.mocked(api.syncStatus).mockReturnValue(status({ enabled: false, signedIn: true }))
    expect((await runTool('sync_control', { action: 'resume' }, ctx)).ok).toBe(true)
    expect(api.setSyncEnabled).toHaveBeenLastCalledWith(true)
    expect((await runTool('sync_control', { action: 'wipe' }, ctx)).ok).toBe(false)
  })

  it('rejects unknown arguments the schema does not allow', async () => {
    expect((await runTool('create_event', { title: 'x', start: '明天下午三点', all_day: 'yes' }, ctx)).ok).toBe(false)
    expect((await runTool('list_events', { range: 'next-month' }, ctx)).ok).toBe(false)
    expect(api.saveEvent).not.toHaveBeenCalled()
  })
})
