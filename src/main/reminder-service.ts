import { handle, subscribe } from './ipc-trust'
import { Notification, type BrowserWindow } from 'electron'
import type { Settings } from '@shared/types'
import type { Reminder, ReminderAction, ReminderInput, ReminderView, TodoPriority } from '@shared/reminders'
import type { NotesStore } from './notes'
import { ReminderScheduler, ReminderStore } from './reminders'
import { extractReminders } from './reminder-parser'
import { createReminderWindow } from './windows'
import { mainLanguage, mt } from '@shared/mainI18n'

export class ReminderService {
  readonly store: ReminderStore
  readonly scheduler: ReminderScheduler
  private strong: BrowserWindow | null = null
  private dismissed = new Set<string>()
  private notices = new Map<string, Notification>()
  private view: ReminderView | null = null
  private undoId: string | null = null
  private extracting = false
  private noteAbort: AbortController | null = null
  constructor(file: string, private readonly settings: () => Settings,
    private readonly openView: (view: ReminderView) => void, private readonly changed: () => void,
    private readonly log: (line: string) => void) {
    this.store = new ReminderStore(file)
    this.scheduler = new ReminderScheduler(this.store, row => {
      try { this.deliver(row) } catch (error) { this.log(`[reminders] delivery failed: ${String(error)}`) }
    }, () => this.changed())
  }
  start(): void { this.store.recoverMissed(); this.refresh() }
  suspend(): void { this.scheduler.stop() }
  resume(): boolean { const recovered = this.store.recoverMissed(); this.refresh(); return recovered > 0 }
  open(view: ReminderView = {}): void { this.view = view; this.openView(view) }
  private closeNotice(id: string): void { this.notices.get(id)?.close(); this.notices.delete(id) }
  save(input: ReminderInput, id?: string): Reminder {
    const row = this.store.save(input, id)
    if (id) { this.dismissed.delete(id); this.closeNotice(id) }
    this.refresh()
    return row
  }
  action(id: string, action: ReminderAction, snoozeMinutes?: number): void {
    this.store.action(id, action, snoozeMinutes ?? this.settings().reminders.snoozeMinutes)
    this.dismissed.delete(id); this.closeNotice(id); this.refresh()
  }
  remove(id: string): void { this.store.remove(id); this.dismissed.delete(id); this.closeNotice(id); this.refresh() }
  refresh(): void { this.scheduler.check(); this.updateStrong(); this.changed() }
  settingsChanged(): void {
    if (this.strong && !this.strong.isDestroyed()) {
      this.strong.setTitle(`${mt('强提醒')} · ${mt('语')}`)
      this.strong.webContents.send('settings:changed', this.settings())
    }
  }
  strongRows(): Reminder[] { return this.store.due().filter(row => row.level === 'strong' && row.missedAt !== row.dueAt && !this.dismissed.has(row.id)) }
  private updateStrong(): void {
    const rows = this.strongRows()
    if (!rows.length) {
      if (this.strong && !this.strong.isDestroyed()) this.strong.close()
      return
    }
    if (!this.strong || this.strong.isDestroyed()) {
      const win = createReminderWindow(this.settings().themeMode)
      this.strong = win
      win.on('closed', () => {
        // An emergency close leaves every item pending and restores it on the
        // next launch. It never reopens in a loop in this session.
        for (const row of this.strongRows()) this.dismissed.add(row.id)
        this.strong = null
      })
    } else this.strong.webContents.send('reminders:changed')
  }
  private deliver(row: Reminder): void {
    if (row.level === 'strong') { this.updateStrong(); return }
    if (!this.settings().reminders.notifications) return
    if (!Notification.isSupported()) { this.log('[reminders] Windows notifications are unavailable'); return }
    const notice = new Notification({ title: `${mt('提醒')} · ${row.title}`, body: new Date(row.dueAt!).toLocaleString(mainLanguage() === 'en' ? 'en-US' : 'zh-CN') + (row.description ? `\n${row.description}` : ''), silent: false })
    this.notices.set(row.id, notice)
    notice.on('click', () => this.open({ id: row.id }))
    notice.on('close', () => { if (this.notices.get(row.id) === notice) this.notices.delete(row.id) })
    notice.on('failed', (_event, error) => this.log(`[reminders] notification failed: ${error}`))
    notice.show()
  }
  /**
   * `extra` carries the fields the caller read from the user's own words
   * (priority, deadline). The parser never produces them, and attaching them
   * only after a single stored row came back used to drop them on the pending and
   * multi-item paths.
   */
  async voice(text: string, signal: AbortSignal, onProgress?: (hint: string) => void, submittedAt = Date.now(),
    extra?: { priority?: TodoPriority; deadlineAt?: number | null }): Promise<{ message: string; undo?: boolean; reminder?: Reminder; saved?: number }> {
    const drafts = await extractReminders(this.settings(), text, 'voice', AbortSignal.any([signal, AbortSignal.timeout(60_000)]), onProgress, submittedAt)
    signal.throwIfAborted()
    this.log(`[reminders] voice parsed: ${drafts.length} item(s), intents=${drafts.map(item => item.intent).join(',')}`)
    if (!drafts.length) return { message: mt('没有可创建的提醒，本次未保存') }
    if (drafts.every(item => item.intent !== 'create_reminder' && item.intent !== 'todo')) throw new Error(mt('没有识别到明确的提醒指令，未创建提醒'))
    const clear = drafts.every(draft => !draft.needs_confirmation && (
      draft.intent === 'todo' && draft.time_expression === null && draft.rule === null ||
      draft.intent === 'create_reminder' && draft.dueAt !== null && draft.dueAt > Date.now()
    ))
    if (!clear) {
      return { message: mt('请补充明确的事项和提醒时间，本次未保存') }
    }
    const rows = this.store.saveMany(drafts.map(draft => ({ title: draft.title, description: draft.description, dueAt: draft.dueAt, level: draft.level, recurrence: draft.rule,
      source: 'voice', timeExpression: draft.time_expression ?? undefined,
      // Omitted keys fall back to the store defaults instead of resetting them.
      ...(extra?.priority === undefined ? {} : { priority: extra.priority }),
      ...(extra?.deadlineAt === undefined || extra.deadlineAt === null ? {} : { deadlineAt: extra.deadlineAt }) })))
    this.refresh()
    this.undoId = rows.length === 1 ? rows[0].id : null
    const message = rows.map(row => {
      const time = row.dueAt === null ? mt('未设置提醒时间') : new Date(row.dueAt).toLocaleString(mainLanguage() === 'en' ? 'en-US' : 'zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
      })
      return `${time} · ${mt(row.dueAt === null ? '待办' : row.level === 'strong' ? '强提醒' : '普通提醒')} · ${row.title}`
    }).join('\n')
    // A multi-item take has no single row to report, but the caller still has to
    // know the fields were stored rather than guess from a missing `reminder`.
    return { message, undo: rows.length === 1, ...(rows.length === 1 ? { reminder: rows[0] } : {}), ...(rows.length > 1 ? { saved: rows.length } : {}) }
  }
  undo(): void {
    if (this.undoId) this.remove(this.undoId)
    this.undoId = null
  }
  registerIpc(notes: NotesStore): void {
    handle('reminders:list', () => this.store.list())
    handle('reminders:acknowledge-missed', (_event, id: string, dueAt: number, completed: boolean) => {
      if (typeof id !== 'string' || !Number.isSafeInteger(dueAt) || typeof completed !== 'boolean') throw new Error('Invalid missed reminder action')
      this.store.acknowledgeMissed(id, dueAt, completed); this.refresh()
    })
    handle('reminders:save', (_event, input: ReminderInput, id?: string) => this.save(input, id))
    handle('reminders:save-many', (_event, inputs: ReminderInput[]) => {
      const rows = this.store.saveMany(inputs); this.refresh(); return rows
    })
    handle('reminders:action', (_event, id: string, action: ReminderAction, snoozeMinutes?: number) => this.action(id, action, snoozeMinutes))
    handle('reminders:remove', (_event, id: string) => this.remove(id))
    handle('reminders:view', () => { const view = this.view; this.view = null; return view })
    handle('reminders:strong', () => this.strongRows())
    subscribe('reminders:close-strong', () => this.strong?.close())
    handle('reminders:extract-note', (_event, id: string) => this.extractNote(notes, id))
  }
  async extractNote(notes: NotesStore, id: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    if (this.extracting) throw new Error(mt('正在提取待办，请稍候'))
    const note = notes.list().notes.find(item => item.id === id)
    if (!note) throw new Error(mt('随记不存在'))
    const text = note.transcript.trim() || note.polished.trim()
    this.extracting = true
    const controller = new AbortController()
    this.noteAbort = controller
    try {
      const drafts = await extractReminders(this.settings(), text, 'note', AbortSignal.any([controller.signal, ...(signal ? [signal] : []), AbortSignal.timeout(60_000)]))
      controller.signal.throwIfAborted()
      signal?.throwIfAborted()
      const current = notes.list().notes.find(item => item.id === id)
      if (!current) throw new Error(mt('随记不存在'))
      if ((current.transcript.trim() || current.polished.trim()) !== text) throw new Error(mt('随记内容已更改，请重新提取'))
      if (!drafts.length) throw new Error(mt('没有发现待办或提醒事项'))
      const valid = drafts.filter(draft => !draft.needs_confirmation && (
        draft.intent === 'todo' && draft.time_expression === null && draft.rule === null ||
        draft.intent === 'create_reminder' && draft.dueAt !== null && draft.dueAt > Date.now()
      ))
      if (!valid.length) return mt('没有明确可保存的事项，请补充事项或具体时间')
      this.store.saveMany(valid.map(draft => ({ title: draft.title, description: draft.description,
        dueAt: draft.intent === 'todo' ? null : draft.dueAt, level: draft.level, recurrence: draft.rule,
        source: 'note', noteId: id, timeExpression: draft.time_expression ?? undefined })))
      this.refresh()
      return mt('已保存 {{count}} 个事项，{{skipped}} 个不明确事项未保存', { count: valid.length, skipped: drafts.length - valid.length })
    } finally { this.extracting = false; if (this.noteAbort === controller) this.noteAbort = null }
  }

  stop(): void {
    this.noteAbort?.abort()
    this.scheduler.stop()
    this.strong?.destroy()
    for (const notice of this.notices.values()) notice.close()
    this.notices.clear()
    this.store.close()
  }
}
