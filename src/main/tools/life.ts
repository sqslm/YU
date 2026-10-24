import { formatEventTime, localDayKey, rangeFor, type CalendarRange } from '@shared/calendar'
import { mainLanguage, mt } from '@shared/mainI18n'
import { resolveReminderTime } from '../reminder-time'
import type { ToolDefinition, ToolOutcome } from './registry'

/**
 * Tools for the capabilities that used to be advertised as "not connected":
 * long-term memory, the local calendar, the daily briefing, read-aloud and
 * cloud-sync administration.
 *
 * They live in their own group instead of joining `personal.ts` because each one
 * has a different failure mode: memory and calendar are local writes that must
 * never lie about what was stored, read-aloud is a slow side effect, and sync
 * control only flips a setting. Keeping them separable lets the assistant turn
 * individual groups on without dragging the rest in.
 */
export const LIFE_TOOLS = ['remember', 'recall_memory', 'forget_memory', 'create_event', 'list_events', 'manage_event', 'daily_briefing', 'speak_text', 'stop_speaking', 'sync_status', 'sync_control'] as const

/** Shapes the stores project into. Structural on purpose: `index.ts` owns the mapping. */
export interface LifeMemory { id: string; kind: string; text: string; tags: string[]; createdAt: number; updatedAt: number }
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
  remember(input: { text: string; kind?: string; tags?: string[] }): LifeMemory
  memories(query: string, kind?: string): LifeMemory[]
  touchMemories(ids: readonly string[]): void
  archiveMemory(id: string, action: 'archive' | 'restore'): void
  event(id: string): LifeEvent | undefined
  events(range: { from: number; until: number }): LifeEvent[]
  saveEvent(input: LifeEventInput, id?: string): LifeEvent
  controlEvent(id: string, action: 'cancel' | 'restore'): LifeEvent
  briefing(): LifeBriefing
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
 * day; if it still fails the range falls back to one hour, which is what a user
 * means by "a meeting at three" far more often than "until four".
 */
function resolveEnd(expression: string, startAt: number): number {
  let resolved = resolveReminderTime(expression, startAt - 1)
  if (resolved.issue || resolved.dueAt === null) {
    const daypart = new Date(startAt).getHours() >= 12 ? '下午' : '上午'
    resolved = resolveReminderTime(`${daypart}${expression}`, startAt - 1)
  }
  return !resolved.issue && resolved.dueAt !== null && resolved.dueAt > startAt ? resolved.dueAt : startAt + 60 * MINUTE
}

async function run(name: string, args: Record<string, unknown>, api: LifeTools): Promise<ToolOutcome> {
  if (name === 'remember') {
    const text = string(args.text)
    if (!text) throw new Error(mt('请提供要记住的内容'))
    const tags = Array.isArray(args.tags) ? args.tags.filter((tag): tag is string => typeof tag === 'string') : undefined
    const saved = api.remember({ text, kind: string(args.kind) || undefined, tags })
    return ok(mt('已记住：{{text}}', { text: saved.text.slice(0, 80) }), { id: saved.id, kind: saved.kind, tags: saved.tags, text: saved.text })
  }
  if (name === 'recall_memory') {
    const rows = api.memories(string(args.query), string(args.kind) || undefined)
    api.touchMemories(rows.slice(0, 12).map(row => row.id))
    return ok(mt('找到 {{count}} 条记忆', { count: rows.length }), { total: rows.length, asOf: Date.now(),
      items: rows.slice(0, 12).map(row => ({ id: row.id, kind: row.kind, text: row.text, tags: row.tags, updatedAt: row.updatedAt })), truncated: rows.length > 12 })
  }
  if (name === 'forget_memory') {
    const id = string(args.id)
    if (!id) throw new Error(mt('请提供要处理的记忆 ID'))
    const action = string(args.action) === 'restore' ? 'restore' : 'archive'
    api.archiveMemory(id, action)
    return ok(mt(action === 'archive' ? '已归档这条记忆，需要时可以恢复' : '已恢复这条记忆'), { id, action })
  }
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
      start = resolveStart(startText, Date.now())
    } catch (error) {
      if (!allDay) throw error
      start = resolveStart(`${startText} 上午八点`, Date.now())
    }
    let end: number
    if (allDay) {
      const day = new Date(start)
      day.setHours(0, 0, 0, 0)
      start = +day
      end = start + DAY
    } else {
      const endText = string(args.end)
      end = endText ? resolveEnd(endText, start) : start + 60 * MINUTE
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
    const start = startText ? resolveStart(startText, Date.now()) : current.start
    const end = endText ? resolveEnd(endText, start) : start === current.start ? current.end : start + (current.end - current.start)
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
  remember: { description: 'Save one standing preference, fact or rule that the user explicitly asked to remember, so later sessions keep it. Quote the user\'s own wording and never infer extra preferences. This is storage, not an agreement to do something now.', properties: { text: { type: 'string' }, kind: { type: 'string', enum: ['preference', 'fact', 'profile', 'rule'] }, tags: { type: 'array', items: { type: 'string' }, maxItems: 8 } }, required: ['text'] },
  recall_memory: { description: 'Search the local long-term memory by keyword or kind. Only the memories actually returned exist: never claim to remember anything that is not in the result, and say so plainly when a search finds nothing.', properties: { query: { type: 'string' }, kind: { type: 'string', enum: ['preference', 'fact', 'profile', 'rule'] } } },
  forget_memory: { description: 'Archive a real memory ID returned by recall_memory (default, recoverable) or restore an archived one. Nothing is deleted permanently.', properties: { id: { type: 'string' }, action: { type: 'string', enum: ['archive', 'restore'] } }, required: ['id'] },
  create_event: { description: 'Add a local calendar event from the actual request. start (and optional end) are natural-language time expressions parsed by the existing time parser, e.g. "明天下午三点" or "9:30"; never invent a time and never turn a schedule into a reminder. Set all_day for whole-day items. Missing details must be asked for in text.', properties: { title: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, all_day: { type: 'boolean' }, location: { type: 'string' }, notes: { type: 'string' }, lead_minutes: { type: 'number' } }, required: ['title', 'start'] },
  list_events: { description: 'Read actual confirmed calendar events. range: today/tomorrow/week/upcoming/yesterday by local calendar day, or day=YYYY-MM-DD for one date. Returns real IDs and absolute times; answer from these fields instead of counting down relative phrases.', properties: { range: { type: 'string', enum: ['today', 'tomorrow', 'week', 'upcoming', 'yesterday'] }, day: { type: 'string' }, query: { type: 'string' } } },
  manage_event: { description: 'Change a real event ID returned by list_events. action=update edits title/start/end/all_day/location/notes/lead_minutes in place and keeps the ID; cancel keeps the data recoverable and restore undoes it. Deletion is not available.', properties: { id: { type: 'string' }, action: { type: 'string', enum: ['update', 'cancel', 'restore'] }, title: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, all_day: { type: 'boolean' }, location: { type: 'string' }, notes: { type: 'string' }, lead_minutes: { type: 'number' } }, required: ['id', 'action'] },
  daily_briefing: { description: 'Build today\'s briefing from real local data: today\'s schedule, due todos, overdue items, tomorrow preview and yesterday\'s dictation recap. Use this instead of guessing what is scheduled, and answer from the returned text. speak only when the user asked to hear it.', properties: { speak: { type: 'boolean' } } },
  speak_text: { description: 'Read text aloud through the local Windows voice only on the explicit user request. Report the real outcome: when reading is disabled in settings nothing is read.', properties: { text: { type: 'string' } }, required: ['text'] },
  stop_speaking: { description: 'Stop the current read-aloud. Safe to call when nothing is being read.', properties: {} },
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
    return run(name, args, ctx.life)
  }
}))
