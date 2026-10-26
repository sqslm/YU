import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { screenshotNeedsEditor } from './voice-intent'
import { nextOccurrence, resolveDeadline, resolveReminderTime } from './reminder-time'
import { WorkflowStore } from './workflows'
import { WindowsTools } from './tools/windows'
import { resolveReference, referenceEditHint, referenceOperation } from './assistant'
import { classifyQuestion, rankSources } from './providers/search'

const now = new Date(2026, 9, 26, 16).getTime()
const directories: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('V2 reported regressions', () => {
  it.each(['帮我确认截图中报错的原因。', 'Confirm the error shown on this screenshot.'])('does not confuse checking a fact with requesting upload approval: %s', text => {
    expect(screenshotNeedsEditor(text)).toBe(false)
  })
  it.each(['Python 官方最新稳定版是多少', 'Acme 最新稳定版', 'latest Acme stable release'])('uses documentation rather than news freshness for stable releases: %s', text => {
    expect(classifyQuestion(text)).toBe('technical')
  })
  it('does not promote an undated reprint after the dated original ages out', () => {
    const sources = [
      { title: 'Vendor announces new device', url: 'https://vendor.test/releases/device', snippet: 'Official announcement, 2026-10-18.' },
      { title: 'Vendor announces new device', url: 'https://reprint.test/device', snippet: 'Reprinted from the original announcement.' }
    ]
    expect(rankSources(sources, 'Vendor latest news', { now: new Date('2026-10-19T12:00Z'), maxAgeHours: 168 }).map(r => r.url)).toEqual([sources[0].url])
    expect(rankSources(sources, 'Vendor latest news', { now: new Date('2026-10-26T12:00Z'), maxAgeHours: 168 })).toEqual([])
  })
  it.each([
    '先展示你打算上传的截图，我确认之后你再分析。',
    '先让我确认要发给AI的图片，再分析截图。',
    '分析屏幕前请让我确认图片。'
  ])('keeps requested screenshot confirmation before capture/upload: %s', text => {
    expect(screenshotNeedsEditor(text)).toBe(true)
  })

  it.each(['纽约时间明天上午九点', '东京时间明天上午九点', 'tomorrow at 9 AM America/New_York', 'tomorrow at 9 AM Pacific time'])('refuses unsupported zones instead of silently using local time: %s', text => {
    expect(resolveReminderTime(text, now)).toMatchObject({ dueAt: null, recurrence: null, issue: expect.any(String) })
    expect(resolveDeadline(text, now)).toBeNull()
  })

  it.each([['每个月一号晚上八点', 1], ['每月二十一日晚上八点', 21], ['每个月三十一号晚上八点', 31]] as const)('understands spoken month dates: %s', (text, day) => {
    expect(resolveReminderTime(text, now)).toMatchObject({ recurrence: { frequency: 'monthly', day, hour: 20 } })
  })

  it('keeps the start date and fortnightly interval together', () => {
    const result = resolveReminderTime('从下周二开始，每两周上午九点', now)
    expect(result).toMatchObject({ dueAt: new Date(2026, 10, 3, 9).getTime(), recurrence: { frequency: 'weekly', interval: 2, weekdays: [2] } })
    expect(nextOccurrence(result.recurrence!, result.dueAt!)).toBe(new Date(2026, 10, 17, 9).getTime())
  })

  it('uses the actual local month end for a recurrence end', () => {
    const result = resolveReminderTime('每天晚上十点，一直到这个月底', now)
    expect(result).toMatchObject({ dueAt: new Date(2026, 9, 26, 22).getTime(), recurrence: { until: new Date(2026, 9, 31, 23, 59, 59, 999).getTime() } })
  })

  it('preserves workflow conditions and false branches across disk reloads', () => {
    const directory = mkdtempSync(join(tmpdir(), 'yu-v2-regression-')); directories.push(directory)
    const file = join(directory, 'workflows.json'), store = new WorkflowStore(file)
    const saved = store.save({ name: 'conditional', steps: [
      { tool: 'calculate', args: { expression: '1+1' }, label: 'first' },
      { tool: 'calculate', args: { expression: '2+2' }, label: 'second', when: { ref: '1.result', op: 'eq', value: 2 }, otherwise: { tool: 'get_datetime', args: {}, label: 'else' } }
    ] })
    expect(new WorkflowStore(file).get(saved.id)?.steps).toEqual(saved.steps)
    const damaged = JSON.parse(readFileSync(file, 'utf8'))
    damaged.workflows[0].steps[1].otherwise.tool = 'run_shell'
    writeFileSync(file, JSON.stringify(damaged))
    expect(new WorkflowStore(file).get(saved.id)).toBeUndefined()
  })

  it.each(['打开我最近的一条随记。', '打开最近保存的笔记。', '打开昨天的语音输入历史。'])('does not treat a personal record as an installed app: %s', text => {
    const windows = new WindowsTools({ folders: { downloads: '', desktop: '', documents: '' }, native: vi.fn(), openPath: vi.fn(), openUrl: vi.fn() })
    expect(windows.command(text)).toBeNull()
  })

  it('narrows named reminder references before asking which result', () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now)
    const items = [
      { id: 'parcel', title: '取快递', fields: { id: 'parcel', title: '取快递', dueAt: new Date(2026, 9, 27, 8).getTime() } },
      { id: 'water', title: '喝水', fields: { id: 'water', title: '喝水', dueAt: new Date(2026, 9, 27, 9).getTime() } }
    ]
    expect(resolveReference('把明天那条取快递提醒改成下午两点。', { tool: 'list_reminders', items })).toMatchObject({ kind: 'ambient', item: { id: 'parcel' } })
    expect(resolveReference('把那条提醒改成下午两点。', { tool: 'list_reminders', items })).toMatchObject({ kind: 'clarify' })
    expect(resolveReference('把明天那条取快递提醒改成下午两点。', { tool: 'list_reminders', items: [items[0], { ...items[0], id: 'duplicate' }] })).toMatchObject({ kind: 'clarify' })
  })

  it('includes the original calendar date in the edit context', () => {
    const start = new Date(2026, 9, 27, 15).getTime()
    expect(referenceEditHint({ id: 'event', title: '项目讨论', fields: { start, end: start + 3600000 } })).toContain('2026-10-27')
  })
  it('uses the requested clocks directly when moving the just-created event', () => {
    const start = new Date(2026, 9, 27, 15).getTime()
    const item = { id: 'event', title: '项目讨论', fields: { start, end: start + 3600000 } }
    const text = '把刚刚的项目讨论改到下午四点到五点。'
    const pointer = resolveReference(text, { tool: 'create_event', items: [], lastObject: item })
    expect(referenceOperation(text, pointer)).toEqual({ name: 'manage_event', args: { id: 'event', action: 'update', start: '下午四点', end: '五点' } })
    expect(referenceOperation('把刚刚的项目讨论改到明天下午四点到五点。', pointer)).toBeNull()
  })
})
