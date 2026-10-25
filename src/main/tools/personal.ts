import type { HistoryEntry, NoteCategory, NoteEntry, NotePatch } from '@shared/types'
import { randomUUID } from 'node:crypto'
import type { Reminder, ReminderAction, ReminderInput, TodoPriority } from '@shared/reminders'
import { isOverdue, normalizePriority, PRIORITY_LABELS, sortTodos, TODO_PRIORITIES } from '@shared/reminders'
import { mainLanguage, mt } from '@shared/mainI18n'
import { nextOccurrence, resolveDeadline, resolveReminderTime } from '../reminder-time'
import { directVoiceIntent } from '../voice-intent'
import type { ToolDefinition, ToolOutcome } from './registry'

export const PERSONAL_TOOLS = ['create_reminder', 'list_reminders', 'manage_reminder', 'create_note', 'search_notes', 'update_note_tags', 'update_note', 'extract_note_tasks', 'search_history', 'read_clipboard', 'copy_to_clipboard', 'open_page', 'control_note_audio', 'get_prompt_info', 'note_sync_status', 'prepare_selection_edit', 'apply_selection_edit'] as const
export const HUB_PAGES = ['overview', 'history', 'notes', 'reminders', 'calendar', 'briefing', 'corrections', 'settings'] as const
export type HubPage = typeof HUB_PAGES[number]
export function personalCommand(text: string): { name: string; args: Record<string, unknown> } | null {
  if(/^(?:(?:请|帮我)?(?:查|查看|告诉我))?(?:刚才|这次|上一条|本次).{0,10}(?:用了|使用|用的|实际使用).{0,8}(?:提示词|卡片).{0,8}[？?。！!]?$/u.test(text.trim()))return {name:'get_prompt_info',args:{}}
  const audio=/^(?:请|帮我)?(暂停|继续|停止)(?:播放)?(?:随记)?录音[。！!]?$/u.exec(text.trim())
  if(audio)return {name:'control_note_audio',args:{action:({暂停:'pause',继续:'resume',停止:'stop'} as Record<string,string>)[audio[1]]}}
  const match = /^(?:请|帮我)?(?:打开|进入)(?:语的|YU的|轻令的|软件的)?(概览|首页|历史记录|随记|提醒|待办|日程|日历|简报|纠正规则|设置)(?:页面|页)?[。！!]?$/iu.exec(text.trim()) ||
    /^open (?:the )?(?:YU )?(home|overview|history|notes|reminders|todos|calendar|briefing|corrections|settings)(?: page)?[.!]?$/iu.exec(text.trim())
  if (!match) return null
  const page = ({ 概览: 'overview', 首页: 'overview', 历史记录: 'history', 随记: 'notes', 提醒: 'reminders', 待办: 'reminders', 日程: 'calendar', 日历: 'calendar', 简报: 'briefing', 纠正规则: 'corrections', 设置: 'settings', home: 'overview', todos: 'reminders' } as Record<string, string>)[match[1].toLowerCase()] || match[1].toLowerCase()
  return { name: 'open_page', args: { page } }
}
export interface PersonalTools {
  latestPromptUse?():Record<string,unknown>|null
  prepareSelectionEdit?(operation:'polish'|'translate',signal:AbortSignal):Promise<{text:string;promptName:string}>
  applySelectionEdit?(signal:AbortSignal):Promise<void>
  /**
   * `extra` carries what the tool read from the user's own words. The extractor
   * cannot produce these fields, and dropping them on the pending path used to
   * lose the priority and deadline the user asked for.
   */
  remind(text: string, signal: AbortSignal, submittedAt?: number, extra?: { priority?: TodoPriority; deadlineAt?: number | null }): Promise<{ message: string; undo?: boolean; reminder?: Reminder; saved?: number }>
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
  controlNoteAudio?(action: 'play'|'pause'|'resume'|'stop'|'status', id?: string): Promise<Record<string,unknown>>
  syncInfo?(): { enabled: boolean; signedIn: boolean; failures: Array<{ id: string; stage: string; error: string; at: number }> }
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

/**
 * The shared label table is data about a field, not a sentence, so it has no
 * MAIN_MESSAGES key yet. Localize here and let an added dictionary entry win.
 */
const PRIORITY_LABELS_EN: Record<TodoPriority, string> = { low: 'Low', normal: 'Normal', high: 'High' }
function priorityText(value: unknown): string {
  const priority = normalizePriority(value), translated = mt(PRIORITY_LABELS[priority])
  return translated === PRIORITY_LABELS[priority] && mainLanguage() === 'en' ? PRIORITY_LABELS_EN[priority] : translated
}
const priorityName = (priority: TodoPriority): string => mt(priority === 'high' ? '高优先级' : priority === 'low' ? '低优先级' : '普通优先级')

/** Relative days keep a spoken receipt readable; the absolute time is still exact. */
function deadlineText(value: number, now: number): string {
  const target = new Date(value), base = new Date(now)
  const time = target.toLocaleTimeString(mainLanguage() === 'en' ? 'en-US' : 'zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  if (target.toDateString() === base.toDateString()) return mt('今天 {{time}}', { time })
  const tomorrow = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1)
  if (target.toDateString() === tomorrow.toDateString()) return mt('明天 {{time}}', { time })
  return `${mainLanguage() === 'en' ? `${target.getMonth() + 1}/${target.getDate()}` : `${target.getMonth() + 1}月${target.getDate()}日`} ${time}`
}

function reminderDetails(row: Reminder, now: number): Record<string, unknown> {
  const time = row.dueAt === null ? mt('未设置提醒时间') : new Date(row.dueAt).toLocaleString(mainLanguage() === 'en' ? 'en-US' : 'zh-CN')
  const remainingSeconds = row.dueAt === null ? null : Math.ceil((row.dueAt - now) / 1000)
  // Overdue follows the deadline, not the alert time: finishing work late is about the deadline.
  return { ...row, triggerTime: time, remainingSeconds, overdue: isOverdue(row, now),
    kind: row.dueAt === null ? 'todo' : 'reminder', levelName: mt(row.level === 'strong' ? '强提醒' : '普通提醒'),
    priority: normalizePriority(row.priority), priorityLabel: priorityText(row.priority), deadlineAt: row.deadlineAt ?? null }
}

// Tolerate the brand's ASR homophones only while matching searches; never rewrite notes.
function searchText(text: string): string { return text.toLowerCase().replace(/轻令|清令|青令|qinly/giu, 'qinly') }

async function run(name: string, args: Record<string, unknown>, api: PersonalTools, question: string, signal: AbortSignal, submittedAt?: number): Promise<ToolOutcome> {
  signal.throwIfAborted()
  if(name==='prepare_selection_edit'){
    if(!api.prepareSelectionEdit)throw Error(mt('选区编辑服务尚未就绪'))
    const result=await api.prepareSelectionEdit(args.operation as 'polish'|'translate',signal)
    return ok(result.text,{text:result.text,promptName:result.promptName,preview:true,applied:false})
  }
  if(name==='apply_selection_edit'){
    if(!api.applySelectionEdit)throw Error(mt('选区编辑服务尚未就绪'))
    if(!/(?:替换|写回|应用|填入|放回).{0,20}(?:选区|选中|原文|文字|输入框)|(?:选区|选中|原文).{0,20}(?:替换|写回|应用)|\b(?:apply|replace|insert)\b/iu.test(question))throw Error(mt('请明确要求将预览结果替换回原选区'))
    await api.applySelectionEdit(signal)
    return ok(mt('已将预览结果替换回原选区'))
  }
  if (name === 'get_prompt_info') {
    const rows = api.history('', dateRange(string(args.day),Date.now()))
    const latest=api.latestPromptUse?.()
    if(!args.id&&!args.day&&latest&&Number(latest.createdAt)>(rows[0]?.createdAt??0))return ok(mt('实际使用的提示词卡片：{{name}}',{name:String(latest.promptName||mt('未使用卡片'))}),latest)
    const row = args.id ? rows.find(item => item.id === args.id) : rows[0]
    if (!row) throw new Error(mt('没有找到使用提示词卡片的历史记录'))
    return ok(mt('实际使用的提示词卡片：{{name}}', { name: row.promptName || row.promptId || mt('未使用卡片') }),
      { historyId: row.id, createdAt: row.createdAt, promptKind: row.promptKind ?? null, promptId: row.promptId ?? null, promptName: row.promptName ?? null, providerId: row.providerId ?? null, providerName: row.providerName ?? null, app: row.app })
  }
  if (name === 'control_note_audio') {
    if (!api.controlNoteAudio) throw new Error(mt('录音播放服务尚未就绪'))
    const id = string(args.id), action = args.action as 'play'|'pause'|'resume'|'stop'|'status'
    if (id && !api.notes().some(note => note.id === id)) throw new Error(mt('随记不存在'))
    if (action === 'play' && !id) throw new Error(mt('请先查询并指定要播放的随记'))
    return ok(mt('录音播放状态已更新'), await api.controlNoteAudio(action,id || undefined))
  }
  if (name === 'note_sync_status') {
    if (!api.syncInfo) throw new Error(mt('同步状态服务尚未就绪'))
    const state = api.syncInfo(), id = string(args.id)
    const notes = api.notes().filter(note => !id || note.id === id)
    if (id && !notes.length) throw new Error(mt('随记不存在'))
    const items = notes.map(note => {
      const failures=state.failures.filter(row=>row.id===note.id)
      const pending=note.pending===true || Boolean(note.audioPath && note.audioUploaded!==true)
      return { id: note.id, title: note.title || note.transcript.slice(0,80), version: note.version ?? null,
        textSynced: Boolean(note.version && !note.pending), audioSynced: note.audioPath ? note.audioUploaded===true : null,
        state: failures.length?'failed':pending?'pending':note.version?'synced':'local', failures }
    }).filter(note=>args.failed_only!==true || note.failures.length)
    return ok(mt('查到 {{count}} 条随记同步状态', { count: items.length }), { enabled: state.enabled, signedIn: state.signedIn, total: items.length, items: items.slice(0,30), failures: state.failures.filter(row=>!id||row.id===id), truncated: items.length>30 })
  }
  if (name === 'create_reminder') {
    // The established full-template refinement / time parser is authoritative.
    // Never accept a model-invented timestamp or silently drop a correction.
    const originalIntent = directVoiceIntent(question)
    let request = args.text === undefined ? question : string(args.text)
    if (!request || !question.includes(request)) throw new Error(mt('提醒内容必须来自原始请求'))
    const clauseStart=question.indexOf(request)
    const separateCreation=args.text!==undefined&&clauseStart>0&&/^(?:再)?(?:提醒我|(?:加个|创建|新建|添加).{0,6}(?:提醒|待办))/u.test(request)&&/(?:然后|另外|并且|同时|以及|再|[，,;；。])\s*(?:再|并)?\s*$/u.test(question.slice(0,clauseStart))
    if (originalIntent?.kind === 'dictation' || originalIntent?.kind === 'assistant'&&!separateCreation) throw new Error(mt('本次请求不应创建新提醒，请查询或修改已有事项'))
    if (originalIntent?.kind === 'reminder' && request !== question) throw new Error(mt('提醒内容必须保留完整的时间和改口'))
    // A scoped todo's content may omit the creation verb, whose authority still
    // comes from the original command. Carry that mode into the existing parser.
    if (args.text !== undefined && !/提醒|待办|代办|\b(?:remind|to-?do)\b/iu.test(request) &&
        /(?:加个|添加|创建|新建|记个).{0,6}(?:待办|代办)|\b(?:add|create)\b.{0,20}\bto-?do\b/iu.test(question) &&
        !/提醒|通知|\b(?:remind|notify)\b/iu.test(question)) request = `待办：${request}`
    const intent = directVoiceIntent(request)
    if (intent?.kind === 'assistant' || intent?.kind === 'dictation') throw new Error(mt('本次请求不应创建新提醒，请查询或修改已有事项'))
    if (!/提醒|待办|代办|(?:添加|创建|新建|加个|记个).{0,8}任务|\b(?:remind|reminder|to-?do|notify|alert)\b|\b(?:create|add|save)\b.{0,30}\btask\b/iu.test(request)) throw new Error(mt('没有识别到明确的提醒指令，未创建提醒'))
    const now = Date.now()
    // A deadline names a day, not an instant: "by Friday" is a usable target, and
    // failing the whole reminder because no clock was spoken loses a task the user
    // did state. `resolveDeadline` returns null only when the date itself is
    // unclear, which becomes a note in the receipt instead of a failed call.
    const deadlineExpression = string(args.deadline)
    const deadlineAt = deadlineExpression ? resolveDeadline(deadlineExpression, now) : null
    const priority = args.priority === undefined ? 'normal' : normalizePriority(args.priority)
    const fields = {
      ...(args.priority === undefined ? {} : { priority }),
      ...(deadlineAt === null ? {} : { deadlineAt })
    }
    // The fields ride along with the extraction so the pending and multi-item
    // paths keep them; the parser itself can never invent them.
    const explicit = args.priority !== undefined || deadlineAt !== null
    const recorded = explicit
      ? await api.remind(request, signal, submittedAt, fields)
      : await api.remind(request, signal, submittedAt)
    // The parser already persisted the row, so this re-save only patches the extra
    // fields. A deadline with no alert time would notify nobody, so the alert moves
    // onto the deadline instead of the task sitting silent forever.
    const silent = (recorded.reminder?.dueAt ?? null) === null
    const onDeadline = silent && deadlineAt !== null
    const reminder = recorded.reminder && (onDeadline || args.priority !== undefined || deadlineAt !== null)
      ? api.saveReminder({ ...recorded.reminder, ...fields, ...(onDeadline ? { dueAt: deadlineAt } : {}) }, recorded.reminder.id)
      : recorded.reminder
    const notes: string[] = []
    if (reminder) {
      if (args.priority !== undefined) notes.push(priorityName(priority))
      if (deadlineAt !== null) notes.push(mt('截止 {{time}}', { time: deadlineText(deadlineAt, now) }))
      if (onDeadline) notes.push(mt('会在截止时提醒'))
      // The task exists but the date did not parse: say which part is missing
      // rather than letting the user believe the deadline was set.
      if (deadlineExpression && deadlineAt === null) notes.push(mt('截止时间没听清，这条没有设截止'))
    } else if (args.priority !== undefined || deadlineAt !== null) {
      // A pending confirmation has no stored row at all, so a receipt would be a
      // lie; a multi-item take did store the fields, so report that instead.
      const saved = recorded.saved ?? 0
      notes.push(saved > 0
        ? mt(deadlineAt === null ? '优先级已应用到本次的 {{count}} 个事项' : '优先级和截止时间已应用到本次的 {{count}} 个事项', { count: saved })
        : mt('这次没有落库，优先级和截止时间没有记住'))
    }
    const summary = notes.length ? `${recorded.message} · ${notes.join(' · ')}` : recorded.message
    if (!reminder && !(recorded.saved && recorded.saved > 0)) return { ok: false, summary, data: { ok: false, saved: 0, needsClarification: true } }
    return ok(summary, { saved: recorded.saved ?? 1, ...(reminder ? { item: reminderDetails(reminder, now) } : {}) })
  }
  if (name === 'list_reminders') {
    const status = string(args.status) || 'active', query = string(args.query).toLowerCase()
    const now = Date.now(), range = dateRange(string(args.day) || (args.today === true ? 'today' : ''), now)
    const matching = sortTodos(api.reminders().filter(row => (status === 'all' || status === 'active' ? status === 'all' || ['pending', 'due'].includes(row.status) : row.status === status) &&
      (!query || `${row.title} ${row.description ?? ''}`.toLowerCase().includes(query)) &&
      (args.kind !== 'todo' || row.dueAt === null) && (args.kind !== 'reminder' || row.dueAt !== null) &&
      (!range || row.dueAt === null || row.dueAt >= range.from && row.dueAt < range.until)))
    return ok(mt('找到 {{count}} 个事项', { count: matching.length }), { total: matching.length, asOf: now,
      items: matching.slice(0, 40).map(row => reminderDetails(row, now)), truncated: matching.length > 40 })
  }
  if (name === 'manage_reminder') {
    if (args.action === 'delete') throw new Error(mt('已拒绝不可逆删除；可以取消事项，保留恢复能力'))
    const row = api.reminders().find(item => item.id === args.id)
    if (!row) throw new Error(mt('提醒不存在'))
    const before = reminderDetails(row, Date.now())
    if (args.action === 'update') {
      const expression = string(args.time_expression), deadlineExpression = string(args.deadline)
      const priority = args.priority === undefined ? undefined : normalizePriority(args.priority)
      if (!expression && !args.level && priority === undefined && !deadlineExpression) throw new Error(mt('请输入要修改的时间、提醒等级、优先级或截止时间'))
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

      let deadlineAt = row.deadlineAt ?? null
      if (deadlineExpression) {
        const resolved = resolveReminderTime(deadlineExpression, Date.now())
        if (resolved.issue || resolved.dueAt === null) throw new Error(resolved.issue || mt('请补充具体截止时间'))
        deadlineAt = resolved.dueAt
      }

      const current = api.reminders().find(item => item.id === row.id)
      if (!current || JSON.stringify(current) !== JSON.stringify(row)) throw new Error(mt('事项已更改，请重新查询后操作'))
      const saved = api.saveReminder({ ...row, dueAt, recurrence, level: args.level as Reminder['level'] ?? row.level,
        priority: priority ?? normalizePriority(row.priority), deadlineAt, timeExpression: expression || row.timeExpression }, row.id)
      const after = reminderDetails(saved, Date.now()), now = Date.now()
      const changes: string[] = []
      if (priority !== undefined && priority !== normalizePriority(row.priority)) changes.push(mt('优先级 {{from}} → {{to}}', { from: priorityText(row.priority), to: priorityText(priority) }))
      if (deadlineExpression) changes.push(mt('截止 {{from}} → {{to}}', { from: before.deadlineAt == null ? mt('未设置') : deadlineText(before.deadlineAt as number, now), to: deadlineText(deadlineAt!, now) }))
      return ok(`${mt('事项已更新')} · ${saved.title}\n${before.triggerTime} → ${after.triggerTime} · ${after.levelName}${changes.length ? `\n${changes.join(' · ')}` : ''}`, { id: row.id, action: 'update', before, item: after })
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
    return ok(mt('找到 {{count}} 条记录', { count: rows.length }), { items: rows.slice(0, 10).map(row => ({ id: row.id, createdAt: row.createdAt, mode: row.mode, text: row.final.slice(0, 2000), promptKind: row.promptKind, promptId: row.promptId, promptName: row.promptName })), truncated: rows.length > 10 })
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
  prepare_selection_edit:{description:'Generate a preview of polish/translation of the frozen actual selection. The original selection and actual transformed result are retained for a later apply_selection_edit. Does not apply or invent text.',properties:{operation:{type:'string',enum:['polish','translate']}},required:['operation']},
  apply_selection_edit:{description:'Apply the previous actual prepare_selection_edit preview to its original selection, only on an explicit user apply/replace request. No text arguments allowed. Rechecks the original window, process and exact selection; fails if changed or expired.',properties:{}},
  control_note_audio: { description: 'Play/pause/resume/stop actual saved note recordings, or read playback status. Resolve a real note ID with search_notes for play. Never synthesize a note transcript as a substitute for its recording.', properties: { action: { type:'string', enum:['play','pause','resume','stop','status'] }, id: { type:'string' } }, required:['action'] },
  get_prompt_info: { description: 'Read prompt card ID/name/kind and provider recorded on an actual completed history entry, not current settings or the current window. Omit id for the latest entry, including null card fields if no card was applied; a newer actual selection transformation may be returned. Or use a real history id. day filters the local recording date.', properties: { id:{type:'string'}, day:{type:'string'} } },
  note_sync_status: { description: 'Read actual per-note sync bookkeeping and recorded sync failures for the current account. id is a real note ID, omitted lists notes. failed_only filters actual attempted failures; pending or offline data is not called failed. A previous server version does not mean a newer local edit or its audio has synced.', properties: { id:{type:'string'}, failed_only:{type:'boolean'} } },
  update_note: { description: 'Rename or categorize an actual existing note ID, preserving its original transcript, polished text, audio and tags. title sets or clears its custom name. category_id uses a real returned ID (empty clears it); category_name uses an existing exact name or creates that category. Do not provide both category fields. Resolve latest/previous references with search_notes first. Executes directly without a confirmation popup.', properties: { id: { type: 'string' }, title: { type: 'string' }, category_id: { type: 'string' }, category_name: { type: 'string' } }, required: ['id'] },
  create_reminder: { description: 'Create clear reminders/todos using the existing parser. For an advance alert on a calendar event use create_event.lead_minutes; do not create a second reminder for that event. For a compound request, text MUST be the EXACT substring containing the entire independent reminder/todo clause, including all its corrections, negations and date context; exclude unrelated note or other action clauses. Omit text for a single reminder request. Never paraphrase or invent content. Ask for missing details in text; never invent times or open confirmation dialogs. An explicitly requested todo needs no alert time: preserve a planned day/weekend in its description. Optional priority (low/normal/high) and deadline (natural-language expression for when the work must be finished) are independent of the alert time. A date-only deadline is end of day; with no alert time it also becomes the alert. No timestamp arguments.', properties: { text: { type: 'string' }, priority: { type: 'string', enum: TODO_PRIORITIES }, deadline: { type: 'string' } } },
  list_reminders: { description: 'Query actual reminders and untimed todos, including untimed active tasks in day queries. kind=todo means only untimed tasks, reminder means timed, omitted means both. day: today/yesterday/tomorrow/YYYY-MM-DD. Returns real IDs, level, priority, priorityLabel, deadlineAt, status, absolute triggerTime, remainingSeconds at asOf. overdue is judged on deadlineAt when present and otherwise on the alert time, and never on completed/cancelled tasks. Ordered open first, then priority, then deadline. Do not use the original relative timeExpression as a countdown.', properties: { query: { type: 'string' }, status: { type: 'string', enum: ['active', 'pending', 'due', 'completed', 'cancelled', 'all'] }, today: { type: 'boolean' }, day: { type: 'string' }, kind: { type: 'string', enum: ['todo', 'reminder', 'all'] } } },
  manage_reminder: { description: 'Modify a real task ID from query/create results. action=update edits time_expression, level, priority and/or deadline in place, preserving ID and unrelated fields. Clock-only edits preserve its date and weekly rule. deadline is a natural-language expression for when the work must be finished; it does not move the alert. Other actions: complete/cancel/snooze/restore/delete. Never guess the target; query first if unknown.', properties: { id: { type: 'string' }, action: { type: 'string', enum: ['complete', 'cancel', 'snooze', 'restore', 'delete', 'update'] }, minutes: { type: 'number' }, time_expression: { type: 'string' }, level: { type: 'string', enum: ['normal', 'strong'] }, priority: { type: 'string', enum: TODO_PRIORITIES }, deadline: { type: 'string' } }, required: ['id', 'action'] },
  create_note: { description: 'Save explicitly requested text or a previous answer as a local text note. Do not claim it includes an audio recording.', properties: { text: { type: 'string' } }, required: ['text'] },
  search_notes: { description: 'Search local notes by content keyword, newest created first. For latest/previous note set position, omit query: never search for the literal words note/latest/随记/随机. day: today/yesterday/tomorrow/YYYY-MM-DD. Returns IDs, tags and excerpts.', properties: { query: { type: 'string' }, day: { type: 'string' }, position: { type: 'string', enum: ['latest', 'previous'] } } },
  update_note_tags: { description: 'Add/remove tags on a real existing note ID, preserving original text, audio and other tags. resolve a recent reference with search_notes first.', properties: { id: { type: 'string' }, add_tags: { type: 'array', items: { type: 'string' }, maxItems: 30 }, remove_tags: { type: 'array', items: { type: 'string' }, maxItems: 30 } }, required: ['id'] },
  extract_note_tasks: { description: 'Extract candidate todos/reminders from an explicitly requested real note ID and open the existing review editor. Nothing is saved until the user confirms. Preserve the source note ID and never overwrite its text.', properties: { id: { type: 'string' } }, required: ['id'] },
  search_history: { description: 'Read actual completed recognition/Ask history, newest first. Set day=today/yesterday/YYYY-MM-DD for local calendar date filtering BEFORE limiting results. query is a content keyword, never put the date phrase there. Executes the user request directly.', properties: { query: { type: 'string' }, day: { type: 'string' } } },
  copy_to_clipboard: { description: 'Copy explicitly requested text or a previous answer to the clipboard. Does not read clipboard contents or paste into another application.', properties: { text: { type: 'string' } }, required: ['text'] },
  read_clipboard: { description: 'Read ONLY current clipboard text only when the user requested clipboard content. No monitoring or clipboard history. Prefer the actual previous answer for references; use get_selection for explicitly selected text.', properties: {} },
  open_page: { description: 'Open existing overview, history, notes, reminders/todos, calendar, corrections or settings pages. Use settings for existing configuration (models, prompts, hotkeys, sync, etc). Does not modify any setting.', properties: { page: { type: 'string', enum: HUB_PAGES } }, required: ['page'] }
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
    return run(name, args, ctx.personal, ctx.workflowReplay && name === 'create_reminder' && typeof args.text === 'string' ? args.text : ctx.question, ctx.signal ?? new AbortController().signal, ctx.submittedAt)
  }
}))
