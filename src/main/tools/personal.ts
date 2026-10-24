import type { HistoryEntry, NoteCategory, NoteEntry, NotePatch } from '@shared/types'
import { randomUUID } from 'node:crypto'
import type { Reminder, ReminderAction, ReminderInput } from '@shared/reminders'
import { mainLanguage, mt } from '@shared/mainI18n'
import { nextOccurrence, resolveReminderTime } from '../reminder-time'
import { directVoiceIntent } from '../voice-intent'
import type { ToolDefinition, ToolOutcome } from './registry'

export const PERSONAL_TOOLS = ['create_reminder', 'list_reminders', 'manage_reminder', 'create_note', 'search_notes', 'update_note_tags', 'update_note', 'extract_note_tasks', 'search_history', 'read_clipboard', 'copy_to_clipboard', 'open_page'] as const
export const HUB_PAGES = ['overview', 'history', 'notes', 'reminders', 'corrections', 'settings'] as const
export type HubPage = typeof HUB_PAGES[number]
export function personalCommand(text: string): { name: string; args: Record<string, unknown> } | null {
  const match = /^(?:请|帮我)?(?:打开|进入)(?:语的|YU的|轻令的|软件的)?(概览|首页|历史记录|随记|提醒|待办|纠正规则|设置)(?:页面|页)?[。！!]?$/iu.exec(text.trim()) ||
    /^open (?:the )?(?:YU )?(home|overview|history|notes|reminders|todos|corrections|settings)(?: page)?[.!]?$/iu.exec(text.trim())
  if (!match) return null
  const page = ({ 概览: 'overview', 首页: 'overview', 历史记录: 'history', 随记: 'notes', 提醒: 'reminders', 待办: 'reminders', 纠正规则: 'corrections', 设置: 'settings', home: 'overview', todos: 'reminders' } as Record<string, string>)[match[1].toLowerCase()] || match[1].toLowerCase()
  return { name: 'open_page', args: { page } }
}
export interface PersonalTools {
  remind(text: string, signal: AbortSignal, submittedAt?: number): Promise<{ message: string; undo?: boolean; reminder?: Reminder }>
  reminders(): Reminder[]
  saveReminder(input: ReminderInput, id: string): Reminder
  action(id: string, action: ReminderAction | 'delete', minutes?: number): void
  notes(): NoteEntry[]
  createNote(text: string): Promise<NoteEntry>
  updateNoteTags(id: string, tags: string[]): Promise<NoteEntry | undefined>
  updateNote(id: string, patch: NotePatch): Promise<NoteEntry | undefined>
  categories(): NoteCategory[]
  saveCategories(categories: NoteCategory[]): Promise<NoteCategory[]>
  extract(id: string, signal: AbortSignal): Promise<string>
  history(query: string, range?: { from: number; until: number }): HistoryEntry[]
  copy(text: string): void
  readClipboard(): string
  open(page: HubPage): void
}

const string = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
const ok = (summary: string, data: Record<string, unknown> = {}): ToolOutcome => ({ ok: true, summary, data: { ...data, ok: true } })

function dateRange(day: string, now: number): { from: number; until: number } | undefined {
  if (!day) return undefined
  const start = new Date(now); start.setHours(0, 0, 0, 0)
  if (day === 'yesterday') start.setDate(start.getDate() - 1)
  else if (day === 'tomorrow') start.setDate(start.getDate() + 1)
  else if (day !== 'today') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(mt('请补充具体日期'))
    const [year, month, date] = day.split('-').map(Number)
    start.setFullYear(year, month - 1, date)
    if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== date) throw new Error(mt('请补充具体日期'))
  }
  const end = new Date(start); end.setDate(end.getDate() + 1)
  return { from: +start, until: +end }
}

function reminderDetails(row: Reminder, now: number): Record<string, unknown> {
  const time = row.dueAt === null ? mt('未设置提醒时间') : new Date(row.dueAt).toLocaleString(mainLanguage() === 'en' ? 'en-US' : 'zh-CN')
  const remainingSeconds = row.dueAt === null ? null : Math.ceil((row.dueAt - now) / 1000)
  return { ...row, triggerTime: time, remainingSeconds, overdue: remainingSeconds !== null && remainingSeconds < 0,
    kind: row.dueAt === null ? 'todo' : 'reminder', levelName: mt(row.level === 'strong' ? '强提醒' : '普通提醒') }
}

// Tolerate the brand's ASR homophones only while matching searches; never rewrite notes.
function searchText(text: string): string { return text.toLowerCase().replace(/轻令|清令|青令|qinly/giu, 'qinly') }

async function run(name: string, args: Record<string, unknown>, api: PersonalTools, question: string, signal: AbortSignal, submittedAt?: number): Promise<ToolOutcome> {
  signal.throwIfAborted()
  if (name === 'create_reminder') {
    // The established full-template refinement / time parser is authoritative.
    // Never accept a model-invented timestamp or silently drop a correction.
    const intent = directVoiceIntent(question)
    if (intent?.kind === 'assistant' || intent?.kind === 'dictation') throw new Error(mt('本次请求不应创建新提醒，请查询或修改已有事项'))
    if (!/提醒|待办|代办|(?:添加|创建|新建|加个|记个).{0,8}任务|\b(?:remind|reminder|to-?do|notify|alert)\b|\b(?:create|add|save)\b.{0,30}\btask\b/iu.test(question)) throw new Error(mt('没有识别到明确的提醒指令，未创建提醒'))
    const result = await api.remind(question, signal, submittedAt)
    return ok(result.message, { ...(result.reminder ? { item: reminderDetails(result.reminder, Date.now()) } : {}) })
  }
  if (name === 'list_reminders') {
    const status = string(args.status) || 'active', query = string(args.query).toLowerCase()
    const now = Date.now(), range = dateRange(string(args.day) || (args.today === true ? 'today' : ''), now)
    const matching = api.reminders().filter(row => (status === 'all' || status === 'active' ? status === 'all' || ['pending', 'due'].includes(row.status) : row.status === status) &&
      (!query || `${row.title} ${row.description ?? ''}`.toLowerCase().includes(query)) &&
      (args.kind !== 'todo' || row.dueAt === null) && (args.kind !== 'reminder' || row.dueAt !== null) &&
      (!range || row.dueAt === null || row.dueAt >= range.from && row.dueAt < range.until))
      .sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0))
    return ok(mt('找到 {{count}} 个事项', { count: matching.length }), { total: matching.length, asOf: now,
      items: matching.slice(0, 40).map(row => reminderDetails(row, now)), truncated: matching.length > 40 })
  }
  if (name === 'manage_reminder') {
    if (args.action === 'delete') throw new Error(mt('已拒绝不可逆删除；可以取消事项，保留恢复能力'))
    const row = api.reminders().find(item => item.id === args.id)
    if (!row) throw new Error(mt('提醒不存在'))
    const before = reminderDetails(row, Date.now())
    if (args.action === 'update') {
      const expression = string(args.time_expression)
      if (!expression && !args.level) throw new Error(mt('请输入要修改的时间或提醒等级'))
      let dueAt = row.dueAt, recurrence = row.recurrence
      if (expression) {
        // A clock-only edit inherits this task's date, never the assistant window's date.
        const clockOnly = /^(?:凌晨|早上|早晨|上午|中午|下午|傍晚|晚上)\s*[零〇一二两三四五六七八九十\d:：点點时時分半刻\s]+$/.test(expression) || /^(?:at\s+)?\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?$/i.test(expression)
        const base = row.dueAt === null ? null : new Date(row.dueAt)
        let resolved = resolveReminderTime(expression, Date.now())
        if (base && (clockOnly || resolved.issue === mt('请补充具体日期'))) {
          const reference = row.recurrence ? Math.min(Date.now(), +new Date(base.getFullYear(), base.getMonth(), base.getDate()) - 1) : Date.now()
          resolved = resolveReminderTime(`${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}-${String(base.getDate()).padStart(2, '0')} ${expression}`, reference)
        }
        if (resolved.issue || resolved.dueAt === null) throw new Error(resolved.issue || mt('请补充具体提醒时间'))
        dueAt = resolved.dueAt
        if (row.recurrence && !resolved.recurrence) {
          const clock = new Date(dueAt)
          recurrence = { ...row.recurrence, hour: clock.getHours(), minute: clock.getMinutes() }
          dueAt = nextOccurrence(recurrence, Date.now())
        } else recurrence = resolved.recurrence
      }

      const current = api.reminders().find(item => item.id === row.id)
      if (!current || JSON.stringify(current) !== JSON.stringify(row)) throw new Error(mt('事项已更改，请重新查询后操作'))
      const saved = api.saveReminder({ ...row, dueAt, recurrence, level: args.level as Reminder['level'] ?? row.level,
        timeExpression: expression || row.timeExpression }, row.id)
      const after = reminderDetails(saved, Date.now())
      return ok(`${mt('事项已更新')} · ${saved.title}\n${before.triggerTime} → ${after.triggerTime} · ${after.levelName}`, { id: row.id, action: 'update', before, item: after })
    }
    const action = string(args.action) as ReminderAction | 'delete'
    const label = { complete: '确认完成', cancel: '取消提醒', snooze: '稍后提醒', restore: '恢复', delete: '删除' }[action]

    api.action(row.id, action, args.minutes as number | undefined)
    return ok(`${mt(label)} · ${row.title}\n${before.triggerTime} · ${before.levelName}`, { id: row.id, action, before,
      item: action === 'delete' ? null : reminderDetails(api.reminders().find(item => item.id === row.id)!, Date.now()) })
  }
  if (name === 'create_note') {
    const text = string(args.text)
    if (!text || text.length > 10_000) throw new Error(mt('请输入 1–10000 字的请求'))

    const note = await api.createNote(text)
    return ok(mt('随记已保存'), { id: note.id, tags: note.tags, text: (note.polished || note.transcript || text).slice(0, 2000) })
  }
  if (name === 'search_notes') {

    const query = searchText(string(args.query)), range = dateRange(string(args.day), Date.now())
    const categories = api.categories()
    let matching = api.notes().filter(row => (!query || searchText(`${row.title ?? ''} ${row.transcript} ${row.polished} ${row.tags.join(' ')} ${categories.find(c => c.id === row.categoryId)?.name ?? ''}`).includes(query)) &&
      (!range || row.createdAt >= range.from && row.createdAt < range.until))
      .sort((a, b) => b.createdAt - a.createdAt)
    if (args.position) matching = matching.slice(args.position === 'previous' ? 1 : 0, args.position === 'previous' ? 2 : 1)
    return ok(mt('找到 {{count}} 条随记', { count: matching.length }), { total: matching.length,
      categories, items: matching.slice(0, 10).map(row => ({ id: row.id, title: row.title, categoryId: row.categoryId, text: (row.polished || row.transcript).slice(0, 2000), tags: row.tags, createdAt: row.createdAt, updatedAt: row.updatedAt })), truncated: matching.length > 10 })
  }
  if (name === 'update_note') {
    const id = string(args.id)
    if (!api.notes().some(row => row.id === id)) throw new Error(mt('随记不存在'))
    if (args.category_id !== undefined && args.category_name !== undefined) throw new Error(mt('请只提供一种分类方式'))
    const patch: NotePatch = {}
    if (typeof args.title === 'string') patch.title = args.title
    if (typeof args.category_id === 'string') {
      if (args.category_id && !api.categories().some(row => row.id === args.category_id)) throw new Error(mt('分类不存在'))
      patch.categoryId = args.category_id
    } else if (typeof args.category_name === 'string') {
      const name = args.category_name.trim()
      if (!name || name.length > 100) throw new Error(mt('请输入分类名称'))
      const categories = api.categories(), matching = categories.filter(row => row.name.toLowerCase() === name.toLowerCase())
      if (matching.length > 1) throw new Error(mt('存在同名分类，请指定分类 ID'))
      const category = matching[0] ?? { id: randomUUID(), name }
      if (!matching.length && !(await api.saveCategories([...categories, category])).some(row => row.id === category.id)) throw new Error(mt('分类数量已达上限，请使用已有分类'))
      patch.categoryId = category.id
    }
    if (!Object.keys(patch).length) throw new Error(mt('请提供随记名称或分类'))
    const saved = await api.updateNote(id, patch)
    if (!saved) throw new Error(mt('随记不存在'))
    return ok(mt('随记已更新'), { id: saved.id, title: saved.title, categoryId: saved.categoryId })
  }
  if (name === 'update_note_tags') {
    const note = api.notes().find(row => row.id === args.id)
    if (!note) throw new Error(mt('随记不存在'))
    const remove = args.remove_tags as string[] ?? [], add = args.add_tags as string[] ?? []
    if (!add.length && !remove.length) throw new Error(mt('请提供要添加或移除的标签'))

    const current = api.notes().find(row => row.id === note.id)
    if (!current || current.updatedAt !== note.updatedAt) throw new Error(mt('随记内容已更改，请重新提取'))
    const saved = await api.updateNoteTags(note.id, [...new Set([...current.tags.filter(tag => !remove.includes(tag)), ...add])])
    if (!saved) throw new Error(mt('随记不存在'))
    return ok(mt('随记标签已更新'), { id: saved.id, tags: saved.tags })
  }
  if (name === 'extract_note_tasks') {
    if (!api.notes().some(row => row.id === args.id)) throw new Error(mt('随记不存在'))

    return ok(await api.extract(string(args.id), signal))
  }
  if (name === 'search_history') {

    const rows = api.history(string(args.query), dateRange(string(args.day), Date.now()))
    return ok(mt('找到 {{count}} 条记录', { count: rows.length }), { items: rows.slice(0, 10).map(row => ({ id: row.id, createdAt: row.createdAt, mode: row.mode, text: row.final.slice(0, 2000) })), truncated: rows.length > 10 })
  }
  if (name === 'read_clipboard') {

    const text = api.readClipboard()
    if (!text.trim()) throw new Error(mt('剪贴板没有文字'))
    if (text.length > 20000) throw new Error(mt('剪贴板文字过长，请先选择需要处理的部分'))
    return ok(mt('已读取当前剪贴板文字'), { text, length: text.length })
  }
  if (name === 'copy_to_clipboard') {
    const text = string(args.text)
    if (!text || text.length > 20_000) throw new Error(mt('没有可替换的文本'))

    api.copy(text)
    return ok(mt('已复制到剪贴板'))
  }
  const page = args.page as HubPage
  api.open(page)
  return ok(mt('已打开功能页面'), { page })
}

const schemas: Record<typeof PERSONAL_TOOLS[number], { description: string; properties: Record<string, { type: string; enum?: readonly string[]; items?: { type: string }; maxItems?: number }>; required?: string[] }> = {
  update_note: { description: 'Rename or categorize an actual existing note ID, preserving its original transcript, polished text, audio and tags. title sets or clears its custom name. category_id uses a real returned ID (empty clears it); category_name uses an existing exact name or creates that category. Do not provide both category fields. Resolve latest/previous references with search_notes first. Executes directly without a confirmation popup.', properties: { id: { type: 'string' }, title: { type: 'string' }, category_id: { type: 'string' }, category_name: { type: 'string' } }, required: ['id'] },
  create_reminder: { description: 'Create clear reminders/todos directly from the actual user request using the existing parser. Ask for missing details in text; never invent times or open confirmation dialogs. No timestamp arguments.', properties: {} },
  list_reminders: { description: 'Query actual reminders and untimed todos, including untimed active tasks in day queries. kind=todo means only untimed tasks, reminder means timed, omitted means both. day: today/yesterday/tomorrow/YYYY-MM-DD. Returns real IDs, level, status, absolute triggerTime, remainingSeconds at asOf (negative=overdue). Do not use the original relative timeExpression as a countdown.', properties: { query: { type: 'string' }, status: { type: 'string', enum: ['active', 'pending', 'due', 'completed', 'cancelled', 'all'] }, today: { type: 'boolean' }, day: { type: 'string' }, kind: { type: 'string', enum: ['todo', 'reminder', 'all'] } } },
  manage_reminder: { description: 'Modify a real task ID from query/create results. action=update edits time_expression and/or level in place, preserving ID and unrelated fields. Clock-only edits preserve its date and weekly rule. Other actions: complete/cancel/snooze/restore/delete. Never guess the target; query first if unknown.', properties: { id: { type: 'string' }, action: { type: 'string', enum: ['complete', 'cancel', 'snooze', 'restore', 'delete', 'update'] }, minutes: { type: 'number' }, time_expression: { type: 'string' }, level: { type: 'string', enum: ['normal', 'strong'] } }, required: ['id', 'action'] },
  create_note: { description: 'Save explicitly requested text or a previous answer as a local text note. Do not claim it includes an audio recording.', properties: { text: { type: 'string' } }, required: ['text'] },
  search_notes: { description: 'Search local notes by content keyword, newest created first. For latest/previous note set position, omit query: never search for the literal words note/latest/随记/随机. day: today/yesterday/tomorrow/YYYY-MM-DD. Returns IDs, tags and excerpts.', properties: { query: { type: 'string' }, day: { type: 'string' }, position: { type: 'string', enum: ['latest', 'previous'] } } },
  update_note_tags: { description: 'Add/remove tags on a real existing note ID, preserving original text, audio and other tags. resolve a recent reference with search_notes first.', properties: { id: { type: 'string' }, add_tags: { type: 'array', items: { type: 'string' }, maxItems: 30 }, remove_tags: { type: 'array', items: { type: 'string' }, maxItems: 30 } }, required: ['id'] },
  extract_note_tasks: { description: 'Extract and save clear todos/reminders from an explicitly requested note ID returned by search_notes. Reuses the complete reminder prompt; skips ambiguous items and never overwrites the note. No confirmation popup.', properties: { id: { type: 'string' } }, required: ['id'] },
  search_history: { description: 'Read actual completed recognition/Ask history, newest first. Set day=today/yesterday/YYYY-MM-DD for local calendar date filtering BEFORE limiting results. query is a content keyword, never put the date phrase there. Executes the user request directly.', properties: { query: { type: 'string' }, day: { type: 'string' } } },
  copy_to_clipboard: { description: 'Copy explicitly requested text or a previous answer to the clipboard. Does not read clipboard contents or paste into another application.', properties: { text: { type: 'string' } }, required: ['text'] },
  read_clipboard: { description: 'Read ONLY current clipboard text only when the user requested clipboard content. No monitoring or clipboard history. Prefer the actual previous answer for references; use get_selection for explicitly selected text.', properties: {} },
  open_page: { description: 'Open existing overview, history, notes, reminders/todos, corrections or settings pages. Use settings for existing configuration (models, prompts, hotkeys, sync, etc). Does not modify any setting.', properties: { page: { type: 'string', enum: HUB_PAGES } }, required: ['page'] }
}

export const PERSONAL_DEFINITIONS: ToolDefinition[] = PERSONAL_TOOLS.map(name => ({ name, description: schemas[name].description,
  parameters: { type: 'object', properties: schemas[name].properties, required: schemas[name].required ?? [], additionalProperties: false },
  run: async (args, ctx) => {
    if (!ctx.personal || !ctx.allowedTools?.includes(name)) throw new Error(mt('本次任务未授权此工具：{{name}}', { name }))
    const schema = schemas[name]
    for (const key of schema.required ?? []) if (!(key in args)) throw new Error(mt('工具参数无效：{{name}}', { name: key }))
    for (const [key, value] of Object.entries(args)) {
      const field = Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined
      const validType = field?.type === 'array' ? Array.isArray(value) && value.length <= (field.maxItems ?? 30) && value.every(tag => typeof tag === 'string' && tag.trim() && tag.length <= 100) : typeof value === field?.type
      if (!field || !validType || field.enum && !field.enum.includes(value as string)) throw new Error(mt('工具参数无效：{{name}}', { name: key }))
    }
    return run(name, args, ctx.personal, ctx.question, ctx.signal ?? new AbortController().signal, ctx.submittedAt)
  }
}))
