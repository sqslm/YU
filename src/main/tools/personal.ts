import type { HistoryEntry, NoteEntry } from '@shared/types'
import type { Reminder, ReminderAction } from '@shared/reminders'
import { mt } from '@shared/mainI18n'
import type { ToolDefinition, ToolOutcome } from './registry'

export const PERSONAL_TOOLS = ['create_reminder', 'list_reminders', 'manage_reminder', 'create_note', 'search_notes', 'extract_note_tasks', 'search_history', 'copy_to_clipboard', 'open_page'] as const
export const HUB_PAGES = ['overview', 'history', 'notes', 'reminders', 'corrections', 'settings'] as const
export type HubPage = typeof HUB_PAGES[number]
export function personalCommand(text: string): { name: string; args: Record<string, unknown> } | null {
  const match = /^(?:请|帮我)?(?:打开|进入)(?:轻令的|软件的)?(概览|首页|历史记录|随记|提醒|待办|纠正规则|设置)(?:页面|页)?[。！!]?$/iu.exec(text.trim()) ||
    /^open (?:the )?(home|overview|history|notes|reminders|todos|corrections|settings)(?: page)?[.!]?$/iu.exec(text.trim())
  if (!match) return null
  const page = ({ 概览: 'overview', 首页: 'overview', 历史记录: 'history', 随记: 'notes', 提醒: 'reminders', 待办: 'reminders', 纠正规则: 'corrections', 设置: 'settings', home: 'overview', todos: 'reminders' } as Record<string, string>)[match[1].toLowerCase()] || match[1].toLowerCase()
  return { name: 'open_page', args: { page } }
}
export interface PersonalTools {
  remind(text: string, signal: AbortSignal, submittedAt?: number): Promise<{ message: string; undo?: boolean }>
  reminders(): Reminder[]
  action(id: string, action: ReminderAction | 'delete', minutes?: number): void
  notes(): NoteEntry[]
  createNote(text: string): Promise<NoteEntry>
  extract(id: string, signal: AbortSignal): Promise<void>
  history(query: string): HistoryEntry[]
  copy(text: string): void
  open(page: HubPage): void
  confirm(description: string, signal?: AbortSignal): Promise<boolean>
}

const string = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
const ok = (summary: string, data: Record<string, unknown> = {}): ToolOutcome => ({ ok: true, summary, data: { ...data, ok: true } })

async function run(name: string, args: Record<string, unknown>, api: PersonalTools, question: string, signal: AbortSignal, submittedAt?: number): Promise<ToolOutcome> {
  signal.throwIfAborted()
  const approve = async (description: string): Promise<void> => {
    if (!await api.confirm(description, signal)) throw new Error(mt('已取消本次系统操作'))
    signal.throwIfAborted()
  }
  if (name === 'create_reminder') {
    // The established full-template refinement / time parser is authoritative.
    // Never accept a model-invented timestamp or silently drop a correction.
    const result = await api.remind(question, signal, submittedAt)
    return ok(result.message, { confirmationRequired: !result.undo })
  }
  if (name === 'list_reminders') {
    const status = string(args.status) || 'active', query = string(args.query).toLowerCase()
    const from = new Date(); from.setHours(0, 0, 0, 0)
    const until = new Date(from); until.setDate(until.getDate() + 1)
    const matching = api.reminders().filter(row => (status === 'all' || status === 'active' ? status === 'all' || ['pending', 'due'].includes(row.status) : row.status === status) &&
      (!query || `${row.title} ${row.description ?? ''}`.toLowerCase().includes(query)) &&
      (args.today !== true || row.dueAt !== null && row.dueAt >= +from && row.dueAt < +until))
    return ok(mt('找到 {{count}} 个事项', { count: matching.length }), { total: matching.length, items: matching.slice(0, 40), truncated: matching.length > 40 })
  }
  if (name === 'manage_reminder') {
    const row = api.reminders().find(item => item.id === args.id)
    if (!row) throw new Error(mt('提醒不存在'))
    const action = string(args.action) as ReminderAction | 'delete'
    const label = { complete: '确认完成', cancel: '取消提醒', snooze: '稍后提醒', restore: '恢复', delete: '删除' }[action]
    await approve(`${mt(label)} · ${row.title}${action === 'snooze' ? `\n${mt('{{n}} 分钟', { n: args.minutes as number ?? 5 })}` : ''}`)
    api.action(row.id, action, args.minutes as number | undefined)
    return ok(mt('事项已更新'), { id: row.id, action })
  }
  if (name === 'create_note') {
    const text = string(args.text)
    if (!text || text.length > 10_000) throw new Error(mt('请输入 1–10000 字的请求'))
    await approve(`${mt('将这段文字保存到随记？')}\n\n${text}`)
    const note = await api.createNote(text)
    return ok(mt('随记已保存'), { id: note.id })
  }
  if (name === 'search_notes') {
    await approve(mt('读取匹配的随记内容并发送给当前模型？'))
    const query = string(args.query).toLowerCase()
    const matching = api.notes().filter(row => !query || `${row.transcript} ${row.polished} ${row.tags.join(' ')}`.toLowerCase().includes(query))
      .sort((a, b) => b.updatedAt - a.updatedAt)
    return ok(mt('找到 {{count}} 条随记', { count: matching.length }), { total: matching.length,
      items: matching.slice(0, 10).map(row => ({ id: row.id, text: (row.polished || row.transcript).slice(0, 2000), updatedAt: row.updatedAt })), truncated: matching.length > 10 })
  }
  if (name === 'extract_note_tasks') {
    if (!api.notes().some(row => row.id === args.id)) throw new Error(mt('随记不存在'))
    await approve(mt('读取这条随记并提取待办与提醒？'))
    await api.extract(string(args.id), signal)
    return ok(mt('请确认提醒事项与时间'), { confirmationRequired: true })
  }
  if (name === 'search_history') {
    await approve(mt('读取匹配的历史记录并发送给当前模型？'))
    const rows = api.history(string(args.query))
    return ok(mt('找到 {{count}} 条记录', { count: rows.length }), { items: rows.slice(0, 10).map(row => ({ id: row.id, createdAt: row.createdAt, mode: row.mode, text: row.final.slice(0, 2000) })), truncated: rows.length > 10 })
  }
  if (name === 'copy_to_clipboard') {
    const text = string(args.text)
    if (!text || text.length > 20_000) throw new Error(mt('没有可替换的文本'))
    await approve(mt('将助手结果复制到剪贴板？'))
    api.copy(text)
    return ok(mt('已复制到剪贴板'))
  }
  const page = args.page as HubPage
  api.open(page)
  return ok(mt('已打开功能页面'), { page })
}

const schemas: Record<typeof PERSONAL_TOOLS[number], { description: string; properties: Record<string, { type: string; enum?: readonly string[] }>; required?: string[] }> = {
  create_reminder: { description: 'Create reminders/todos from the actual user request using the existing parser. Ambiguity opens review; never invent times. No timestamp arguments.', properties: {} },
  list_reminders: { description: 'Query real local reminders and untimed todos. Use today=true for today only. Returns stable IDs; never invent tasks.', properties: { query: { type: 'string' }, status: { type: 'string', enum: ['active', 'pending', 'due', 'completed', 'cancelled', 'all'] }, today: { type: 'boolean' } } },
  manage_reminder: { description: 'Complete, cancel, snooze, restore or delete an existing task by an ID returned by list_reminders. Native user confirmation is required.', properties: { id: { type: 'string' }, action: { type: 'string', enum: ['complete', 'cancel', 'snooze', 'restore', 'delete'] }, minutes: { type: 'number' } }, required: ['id', 'action'] },
  create_note: { description: 'Save explicitly requested text or a previous answer as a local text note after native confirmation. Do not claim it includes an audio recording.', properties: { text: { type: 'string' } }, required: ['text'] },
  search_notes: { description: 'Search local notes by keyword, newest first. Reading note content requires native permission. Returns up to 10 excerpts and IDs.', properties: { query: { type: 'string' } } },
  extract_note_tasks: { description: 'Extract task/reminder suggestions from a note ID returned by search_notes. Reuses the complete reminder prompt, opens user review; does not overwrite the note.', properties: { id: { type: 'string' } }, required: ['id'] },
  search_history: { description: 'Read matching completed recognition/Ask history, newest first. Native permission required before returning excerpts to the model.', properties: { query: { type: 'string' } } },
  copy_to_clipboard: { description: 'Copy explicitly requested text or a previous answer to the clipboard after native confirmation. Does not read clipboard contents or paste into another application.', properties: { text: { type: 'string' } }, required: ['text'] },
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
      if (!field || typeof value !== field.type || field.enum && !field.enum.includes(value as string)) throw new Error(mt('工具参数无效：{{name}}', { name: key }))
    }
    return run(name, args, ctx.personal, ctx.question, ctx.signal ?? new AbortController().signal, ctx.submittedAt)
  }
}))
