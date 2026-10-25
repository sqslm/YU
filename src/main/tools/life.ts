import { formatEventTime, localDayKey, rangeFor, type CalendarRange } from '@shared/calendar'
import { mainLanguage, mt } from '@shared/mainI18n'
import { resolveReminderTime } from '../reminder-time'
import type { ToolDefinition, ToolOutcome } from './registry'
import type { BriefingSettings } from '@shared/types'

/**
 * Tools for the capabilities that used to be advertised as "not connected":
 * the local calendar, the daily briefing, read-aloud and cloud-sync
 * administration.
 *
 * They live in their own group instead of joining `personal.ts` because each one
 * has a different failure mode: the calendar is a local write that must never lie
 * about what was stored, read-aloud is a slow side effect, and sync control only
 * flips a setting. Keeping them separable lets the assistant turn individual
 * groups on without dragging the rest in.
 */
export const LIFE_TOOLS = ['create_event', 'list_events', 'manage_event', 'daily_briefing', 'configure_briefing', 'speak_text', 'stop_speaking', 'sync_status', 'sync_control'] as const

/** Shapes the stores project into. Structural on purpose: `index.ts` owns the mapping. */
export interface LifeEvent {
  id: string
  title: string
  start: number
  end: number
  allDay: boolean
  location?: string
  notes?: string
  leadMinutes?: number | null
  status: 'confirmed' | 'cancelled'
}
export interface LifeEventInput {
  title: string
  start: number
  end: number
  allDay?: boolean
  location?: string
  notes?: string
  leadMinutes?: number | null
}
export interface LifeSyncStatus { enabled: boolean; signedIn: boolean; serverUrl: string; lastSyncAt: number | null; busy: boolean; lastError?: string }
export interface LifeBriefing { title: string; body: string; empty: boolean }

export interface LifeTools {
  event(id: string): LifeEvent | undefined
  events(range: { from: number; until: number }): LifeEvent[]
  saveEvent(input: LifeEventInput, id?: string): LifeEvent
  controlEvent(id: string, action: 'cancel' | 'restore'): LifeEvent
  briefing(): LifeBriefing
  briefingSettings?(): BriefingSettings
  setBriefingSettings?(patch: Partial<BriefingSettings>): Promise<BriefingSettings>
  setTtsEnabled?(enabled: boolean): Promise<void>
  speak(text: string): Promise<{ spoken: number; skipped: boolean }>
  stopSpeaking(): void
  ttsEnabled(): boolean
  syncStatus(): LifeSyncStatus
  setSyncEnabled(enabled: boolean): void
}

const string = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
const ok = (summary: string, data: Record<string, unknown> = {}): ToolOutcome => ({ ok: true, summary, data: { ...data, ok: true } })
const language = (): 'zh' | 'en' => mainLanguage() === 'en' ? 'en' : 'zh'
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

function eventDetails(event: LifeEvent): Record<string, unknown> {
  return { ...event, when: formatEventTime(event, language()), day: localDayKey(event.start), cancelled: event.status === 'cancelled' }
}

/** Resolves one natural-language instant with the same parser reminders use. */
function resolveStart(expression: string, now: number): number {
  const resolved = resolveReminderTime(expression, now)
  if (resolved.issue || resolved.dueAt === null) throw new Error(resolved.issue || mt('请补充日程的开始时间'))
  return resolved.dueAt
}

/**
 * Resolves the end of a range. "下午三点到四点" drops the daypart on the second
 * half, so the first attempt fails and we retry with the start's half of the
 * day. Explicit invalid ends must be clarified instead of silently replacing them.
 */
function resolveEnd(expression: string, startAt: number, referenceTime: number): number {
  const hasDate = /今天|明天|后天|周|星期|\d{4}-\d{1,2}-\d{1,2}|[年月日号]|\b(?:today|tomorrow|next|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/iu.test(expression)
  const source = hasDate ? expression : `${localDayKey(startAt)} ${expression}`
  let resolved = resolveReminderTime(source, referenceTime)
  if (!hasDate && (resolved.issue || resolved.dueAt === null || resolved.dueAt <= startAt)) {
    const daypart = new Date(startAt).getHours() >= 12 ? '下午' : '上午'
    resolved = resolveReminderTime(`${localDayKey(startAt)} ${daypart}${expression}`, referenceTime)
  }
  if (resolved.issue || resolved.dueAt === null || resolved.dueAt <= startAt) throw new Error(mt('请补充有效的日程结束时间'))
  return resolved.dueAt
}

async function run(name: string, args: Record<string, unknown>, api: LifeTools, submittedAt = Date.now()): Promise<ToolOutcome> {
  if (name === 'create_event') {
    const title = string(args.title)
    if (!title) throw new Error(mt('请提供日程标题'))
    const startText = string(args.start)
    if (!startText) throw new Error(mt('请补充日程的开始时间'))
    const allDay = args.all_day === true
    // A whole-day event has no clock, so "明天团建一天" carries only a date and the
    // parser refuses it for lacking an hour. Borrowing a fixed morning hour gives
    // a real date to normalise to midnight; anything that still fails was not a
    // date at all and keeps its original complaint.
    let start: number
    try {
      start = resolveStart(startText, submittedAt)
    } catch (error) {
      if (!allDay) throw error
      start = resolveStart(`${startText} 上午八点`, submittedAt)
    }
    let end: number
    if (allDay) {
      const day = new Date(start)
      day.setHours(0, 0, 0, 0)
      start = +day
      end = start + DAY
    } else {
      const endText = string(args.end)
      end = endText ? resolveEnd(endText, start, submittedAt) : start + 60 * MINUTE
    }
    const saved = api.saveEvent({ title, start, end, allDay,
      location: string(args.location) || undefined, notes: string(args.notes) || undefined,
      leadMinutes: typeof args.lead_minutes === 'number' ? args.lead_minutes : undefined })
    const details = eventDetails(saved)
    return ok(`${saved.title} · ${details.when}`, { item: details })
  }
  if (name === 'list_events') {
    const now = Date.now(), day = string(args.day)
    const range = /^\d{4}-\d{2}-\d{2}$/.test(day)
      ? (() => {
        const [year, month, date] = day.split('-').map(Number)
        const from = +new Date(year, month - 1, date)
        return { from, until: from + DAY }
      })()
      : rangeFor((string(args.range) || 'today') as CalendarRange, now)
    const query = string(args.query).toLowerCase()
    const rows = api.events(range)
      .filter(row => row.status === 'confirmed')
      .filter(row => !query || `${row.title} ${row.notes ?? ''} ${row.location ?? ''}`.toLowerCase().includes(query))
      .sort((a, b) => a.start - b.start || (a.end - a.start) - (b.end - b.start))
    return ok(mt('找到 {{count}} 个日程', { count: rows.length }), { total: rows.length, asOf: now, from: range.from, until: range.until,
      items: rows.slice(0, 20).map(eventDetails), truncated: rows.length > 20 })
  }
  if (name === 'manage_event') {
    const id = string(args.id)
    const current = api.event(id)
    if (!current) throw new Error(mt('日程不存在'))
    const action = string(args.action)
    if (action === 'cancel' || action === 'restore') {
      const saved = api.controlEvent(id, action)
      const details = eventDetails(saved)
      return ok(`${mt(action === 'cancel' ? '日程已取消' : '日程已恢复')} · ${saved.title} ${details.when}`, { id, action, item: details })
    }
    if (action !== 'update') throw new Error(mt('请提供要执行的操作'))
    const before = eventDetails(current)
    const title = typeof args.title === 'string' ? string(args.title) : current.title
    if (!title) throw new Error(mt('请提供日程标题'))
    const startText = string(args.start), endText = string(args.end)
    const clockOnly = /^(?:凌晨|早上|早晨|上午|中午|下午|傍晚|晚上)?\s*[零〇一二两三四五六七八九十\d:：点點时時分半刻\s]+$/.test(startText) || /^(?:at\s+)?\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?$/i.test(startText)
    const start = startText ? resolveStart(clockOnly ? `${localDayKey(current.start)} ${startText}` : startText, submittedAt) : current.start
    const end = endText ? resolveEnd(endText, start, submittedAt) : start === current.start ? current.end : start + (current.end - current.start)
    const allDay = typeof args.all_day === 'boolean' ? args.all_day : current.allDay
    const location = typeof args.location === 'string' ? args.location : current.location
    const notes = typeof args.notes === 'string' ? args.notes : current.notes
    const leadMinutes = typeof args.lead_minutes === 'number' ? args.lead_minutes : current.leadMinutes
    if (title === current.title && start === current.start && end === current.end && allDay === current.allDay &&
      location === current.location && notes === current.notes && leadMinutes === current.leadMinutes) throw new Error(mt('请输入要修改的内容'))
    const saved = api.saveEvent({ title, start, end, allDay, location, notes, leadMinutes }, id)
    const after = eventDetails(saved)
    return ok(`${mt('日程已更新')} · ${saved.title}\n${before.when} → ${after.when}`, { id, action, before, item: after })
  }
  if (name === 'daily_briefing') {
    const briefing = api.briefing()
    if (args.speak === true && !briefing.empty) {
      if (!api.ttsEnabled()) return ok(`${briefing.body}\n\n${mt('朗读已在设置里关闭，以上内容没有朗读。')}`, { title: briefing.title, body: briefing.body, empty: false, spoken: 0 })
      const spoken = await api.speak(briefing.body)
      return ok(`${briefing.body}\n\n${spoken.skipped ? mt('没有可朗读的内容。') : mt('已开始朗读。')}`, { title: briefing.title, body: briefing.body, empty: false, spoken: spoken.spoken })
    }
    return ok(briefing.body, { title: briefing.title, body: briefing.body, empty: briefing.empty })
  }
  if (name === 'configure_briefing') {
    if (!api.briefingSettings || !api.setBriefingSettings) throw new Error(mt('简报设置服务尚未就绪'))
    if (args.time !== undefined && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(string(args.time))) throw new Error(mt('请提供有效的简报时间（HH:mm）'))
    const current = Object.keys(args).length ? await api.setBriefingSettings(args as Partial<BriefingSettings>) : api.briefingSettings()
    return ok(mt(current.enabled ? '每日简报已开启，每天 {{time}} 生成' : '每日简报已关闭', { time: current.time }), { settings: current })
  }
  if (name === 'speak_text') {
    const text = string(args.text)
    if (!text) throw new Error(mt('请提供要朗读的内容'))
    if (!api.ttsEnabled()) return ok(mt('朗读已在设置里关闭，本次没有朗读'), { spoken: 0, skipped: true, reason: 'disabled' })
    const result = await api.speak(text)
    return result.skipped
      ? ok(mt('这段文本没有可朗读的内容'), { spoken: 0, skipped: true })
      : ok(mt('已开始朗读 {{count}} 字', { count: result.spoken }), { spoken: result.spoken, skipped: false })
  }
  if (name === 'stop_speaking') {
    api.stopSpeaking()
    if (args.text_only === true) {
      if (!api.setTtsEnabled) throw new Error(mt('朗读设置服务尚未就绪'))
      await api.setTtsEnabled(false)
      return ok(mt('已停止朗读，后续仅显示文字'), { textOnly: true })
    }
    return ok(mt('已停止朗读'))
  }
  if (name === 'sync_status') {
    const status = api.syncStatus()
    const last = status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString(language() === 'en' ? 'en-US' : 'zh-CN') : mt('从未同步')
    const summary = !status.enabled ? mt('云同步已暂停；本地数据不受影响')
      : !status.signedIn ? mt('尚未登录同步账号')
        : mt('云同步已开启，上次同步：{{time}}', { time: last })
    return ok(summary, { ...status, lastSyncText: last })
  }
  if (name === 'sync_control') {
    const status = api.syncStatus(), action = string(args.action)
    if (action === 'pause') {
      if (!status.enabled) return ok(mt('云同步已经是暂停状态'), { enabled: false })
      // Pausing only flips the switch: local notes, history and reminders are untouched.
      api.setSyncEnabled(false)
      return ok(mt('已暂停云同步；本地提醒、随记与历史不受影响'), { enabled: false })
    }
    if (action !== 'resume') throw new Error(mt('请提供要执行的操作'))
    if (!status.signedIn) throw new Error(mt('尚未登录同步账号，请先在设置里登录'))
    if (status.enabled) return ok(mt('云同步已经是开启状态'), { enabled: true })
    api.setSyncEnabled(true)
    return ok(mt('已恢复云同步'), { enabled: true })
  }
  throw new Error(mt('未知工具：{{name}}', { name }))
}

const schemas: Record<typeof LIFE_TOOLS[number], { description: string; properties: Record<string, { type: string; enum?: readonly string[]; items?: { type: string }; maxItems?: number }>; required?: string[] }> = {
  create_event: { description: 'Add a local calendar event from the actual request. start (and optional end) are natural-language time expressions parsed by the existing time parser, e.g. "明天下午三点" or "9:30"; never invent a time and never turn a schedule into a reminder. Set all_day for whole-day items. Missing details must be asked for in text.', properties: { title: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, all_day: { type: 'boolean' }, location: { type: 'string' }, notes: { type: 'string' }, lead_minutes: { type: 'number' } }, required: ['title', 'start'] },
  list_events: { description: 'Read actual confirmed calendar events. range: today/tomorrow/week/upcoming/yesterday by local calendar day, or day=YYYY-MM-DD for one date. Returns real IDs and absolute times; answer from these fields instead of counting down relative phrases.', properties: { range: { type: 'string', enum: ['today', 'tomorrow', 'week', 'upcoming', 'yesterday'] }, day: { type: 'string' }, query: { type: 'string' } } },
  manage_event: { description: 'Change a real event ID returned by list_events. action=update edits title/start/end/all_day/location/notes/lead_minutes in place and keeps the ID; cancel keeps the data recoverable and restore undoes it. Deletion is not available.', properties: { id: { type: 'string' }, action: { type: 'string', enum: ['update', 'cancel', 'restore'] }, title: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, all_day: { type: 'boolean' }, location: { type: 'string' }, notes: { type: 'string' }, lead_minutes: { type: 'number' } }, required: ['id', 'action'] },
  daily_briefing: { description: 'Build today\'s briefing from real local data: today\'s schedule, due todos, overdue items, tomorrow preview and yesterday\'s dictation recap. Use this instead of guessing what is scheduled, and answer from the returned text. speak only when the user asked to hear it.', properties: { speak: { type: 'boolean' } } },
  configure_briefing: { description: 'Read or configure the ONE existing local daily briefing schedule. enabled turns it on/off; time is the explicitly requested local HH:mm clock. speak/notify control delivery. Preserve unspecified settings; do not create a reminder, event, workflow or duplicate schedule. Empty arguments read current settings. Use for daily task briefings and changes to their time.', properties: { enabled: { type: 'boolean' }, time: { type: 'string' }, speak: { type: 'boolean' }, notify: { type: 'boolean' } } },
  speak_text: { description: 'Read text aloud through the local Windows voice only on the explicit user request. Report the real outcome: when reading is disabled in settings nothing is read.', properties: { text: { type: 'string' } }, required: ['text'] },
  stop_speaking: { description: 'Stop the current read-aloud immediately. text_only=true also disables future automatic speech when explicitly requested; otherwise preserve the current preference.', properties: { text_only: { type: 'boolean' } } },
  sync_status: { description: 'Read the actual cloud-sync state: enabled, signed in, server, last successful sync time. Never guess whether something was synced or claim a sync succeeded.', properties: {} },
  sync_control: { description: 'Pause or resume cloud sync on the explicit user request. Pausing never deletes local data, and reminders keep working while sync is paused.', properties: { action: { type: 'string', enum: ['pause', 'resume'] } }, required: ['action'] }
}

export const LIFE_DEFINITIONS: ToolDefinition[] = LIFE_TOOLS.map(name => ({ name, description: schemas[name].description,
  parameters: { type: 'object', properties: schemas[name].properties, required: schemas[name].required ?? [], additionalProperties: false },
  run: async (args, ctx) => {
    if (!ctx.life || !ctx.allowedTools?.includes(name)) throw new Error(mt('本次任务未授权此工具：{{name}}', { name }))
    const schema = schemas[name]
    for (const key of schema.required ?? []) if (!(key in args)) throw new Error(mt('工具参数无效：{{name}}', { name: key }))
    for (const [key, value] of Object.entries(args)) {
      const field = Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined
      const validType = field?.type === 'array' ? Array.isArray(value) && value.length <= (field.maxItems ?? 30) && value.every(tag => typeof tag === 'string' && tag.trim() && tag.length <= 100) : typeof value === field?.type
      if (!field || !validType || field.enum && !field.enum.includes(value as string)) throw new Error(mt('工具参数无效：{{name}}', { name: key }))
    }
    return run(name, args, ctx.life, ctx.submittedAt)
  }
}))
