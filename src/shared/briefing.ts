/** Daily briefing: pure local text assembly, no model call, no i18n indirection. */
export interface BriefingSettings {
  enabled: boolean
  time: string
  speak: boolean
  notify: boolean
  skipEmpty: boolean
}

export const DEFAULT_BRIEFING_SETTINGS: BriefingSettings = { enabled: false, time: '08:00', speak: false, notify: true, skipEmpty: true }

export function normalizeBriefingTime(value: unknown): string {
  // Settings are user-editable and survive migrations, so a single unusable clock
  // string must degrade to the default instead of disabling the whole scheduler.
  if (typeof value !== 'string') return DEFAULT_BRIEFING_SETTINGS.time
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(value.trim())
  if (!match) return DEFAULT_BRIEFING_SETTINGS.time
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return DEFAULT_BRIEFING_SETTINGS.time
  return `${pad(hour)}:${pad(minute)}`
}

export function normalizeBriefingSettings(input: unknown): BriefingSettings {
  const raw = input !== null && typeof input === 'object' ? input as Record<string, unknown> : {}
  const flag = (key: 'enabled' | 'speak' | 'notify' | 'skipEmpty'): boolean =>
    typeof raw[key] === 'boolean' ? raw[key] : DEFAULT_BRIEFING_SETTINGS[key]
  return { enabled: flag('enabled'), time: normalizeBriefingTime(raw.time), speak: flag('speak'), notify: flag('notify'), skipEmpty: flag('skipEmpty') }
}

export interface BriefingEvent { id: string; title: string; start: number; end: number; allDay: boolean }
export interface BriefingTask { id: string; title: string; dueAt: number | null; level?: 'normal' | 'strong'; overdue?: boolean }
export interface BriefingMemory { id: string; kind: string; text: string }
export interface BriefingStats { entries: number; characters: number; durationMs: number }

/** Everything the caller has already projected; this module never reads a store. */
export interface BriefingData {
  now: number
  language: 'zh' | 'en'
  events: BriefingEvent[]
  tasks: BriefingTask[]
  overdue: BriefingTask[]
  tomorrow: BriefingEvent[]
  memories: BriefingMemory[]
  stats?: BriefingStats
}

export interface Briefing {
  title: string
  body: string
  sections: string[]
  empty: boolean
  language: 'zh' | 'en'
}

const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
/** Memories are quoted, not expanded, so a long note cannot flood the briefing. */
const MEMORY_LIMIT = 3

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function clock(at: number): string {
  const date = new Date(at)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Local day bucket. UTC math would fold the whole briefing onto the wrong date. */
export function briefingDayKey(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function composeBriefing(data: BriefingData): Briefing {
  // The result lands as one note or one notification, so every line comes from the
  // caller's `language`; half-translated output would read as a bug.
  const zh = data.language === 'zh'
  const now = new Date(data.now)
  const title = zh
    ? `${now.getMonth() + 1} 月 ${now.getDate()} 日 · 今日简报`
    : `${MONTHS_EN[now.getMonth()]} ${now.getDate()} · Daily briefing`
  const sections: string[] = []
  const add = (heading: string, lines: string[]): void => {
    if (lines.length) sections.push(`${heading}\n${lines.join('\n')}`)
  }
  const span = (event: BriefingEvent): string => event.allDay ? (zh ? '全天' : 'All day') : `${clock(event.start)}–${clock(event.end)}`
  const eventLines = (events: BriefingEvent[]): string[] =>
    [...events].sort((a, b) => a.start - b.start).map(event => `- ${span(event)} ${event.title}`)
  // Tomorrow is a preview: only the start time matters, the end is not worth a range.
  const previewLines = (events: BriefingEvent[]): string[] =>
    [...events].sort((a, b) => a.start - b.start).map(event =>
      `- ${event.allDay ? (zh ? '全天' : 'All day') : clock(event.start)} ${event.title}`)
  const dueLines = (tasks: BriefingTask[]): string[] =>
    tasks.map(task => task.dueAt === null ? `- ${task.title}` : `- ${clock(task.dueAt)} ${task.title}`)
  const dayLabel = (at: number): string => {
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime()
    if (briefingDayKey(at) === briefingDayKey(yesterday)) return zh ? '昨天' : 'Yesterday'
    if (briefingDayKey(at) === briefingDayKey(data.now)) return zh ? '今天' : 'Today'
    const date = new Date(at)
    return zh ? `${date.getMonth() + 1} 月 ${date.getDate()} 日` : `${MONTHS_EN[date.getMonth()]} ${date.getDate()}`
  }
  const overdueSuffix = zh ? '（已逾期）' : ' (overdue)'
  const overdueLines = data.overdue.map(task => task.dueAt === null
    ? `- ${task.title}${overdueSuffix}`
    : `- ${dayLabel(task.dueAt)} ${clock(task.dueAt)} ${task.title}${overdueSuffix}`)
  const memoryLines = data.memories
    .map(memory => memory.text.trim())
    .filter(text => text.length > 0)
    .slice(0, MEMORY_LIMIT)
    .map(text => `- ${text}`)
  const stats = data.stats
  const recapLines = stats && stats.entries > 0
    ? [zh ? `昨天听写 ${stats.entries} 条、共 ${stats.characters} 字。` : `Yesterday: ${stats.entries} notes, ${stats.characters} characters.`]
    : []

  add(zh ? '今天' : 'Today', eventLines(data.events))
  add(zh ? '待办' : 'To do', dueLines(data.tasks))
  add(zh ? '已经过期' : 'Overdue', overdueLines)
  add(zh ? '明天' : 'Tomorrow', previewLines(data.tomorrow))
  add(zh ? '你让我记住的' : 'What you asked me to remember', memoryLines)
  add(zh ? '回顾' : 'Recap', recapLines)

  const empty = sections.length === 0
  return {
    title,
    body: empty ? (zh ? '今天没有安排。' : 'Nothing scheduled for today.') : sections.join('\n\n'),
    sections,
    empty,
    language: data.language
  }
}

/** The next HH:mm strictly after `now`, in local wall-clock time. */
export function nextBriefingAt(now: number, time: string): number {
  const [hour, minute] = normalizeBriefingTime(time).split(':').map(Number)
  const current = new Date(now)
  const today = new Date(current.getFullYear(), current.getMonth(), current.getDate(), hour, minute).getTime()
  // Date(year, month, day + 1) rolls month and year boundaries correctly.
  if (today > now) return today
  return new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1, hour, minute).getTime()
}
