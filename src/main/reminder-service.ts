import { Notification, ipcMain, type BrowserWindow } from 'electron'
import type { Settings } from '@shared/types'
import type { Reminder, ReminderAction, ReminderInput, ReminderView } from '@shared/reminders'
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
  start(): void { this.scheduler.check(); this.updateStrong() }
  open(view: ReminderView = {}): void { this.view = view; this.openView(view) }
  private closeNotice(id: string): void { this.notices.get(id)?.close(); this.notices.delete(id) }
  save(input: ReminderInput, id?: string): Reminder {
    const row = this.store.save(input, id)
    if (id) { this.dismissed.delete(id); this.closeNotice(id) }
    this.refresh()
    return row
  }
  action(id: string, action: ReminderAction): void {
    this.store.action(id, action, this.settings().reminders.snoozeMinutes)
    this.dismissed.delete(id); this.closeNotice(id); this.refresh()
  }
  remove(id: string): void { this.store.remove(id); this.dismissed.delete(id); this.closeNotice(id); this.refresh() }
  refresh(): void { this.scheduler.check(); this.updateStrong(); this.changed() }
  settingsChanged(): void {
    if (this.strong && !this.strong.isDestroyed()) {
      this.strong.setTitle(`${mt('强提醒')} · Typeless Rebuild`)
      this.strong.webContents.send('settings:changed', this.settings())
    }
  }
  strongRows(): Reminder[] { return this.store.due().filter(row => row.level === 'strong' && !this.dismissed.has(row.id)) }
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
  async voice(text: string, signal: AbortSignal, onProgress?: (hint: string) => void, submittedAt = Date.now()): Promise<{ message: string; undo?: boolean }> {
    const drafts = await extractReminders(this.settings(), text, 'voice', AbortSignal.any([signal, AbortSignal.timeout(60_000)]), onProgress, submittedAt)
    signal.throwIfAborted()
    this.log(`[reminders] voice parsed: ${drafts.length} item(s), intents=${drafts.map(item => item.intent).join(',')}`)
    if (!drafts.length) return { message: mt('没有可创建的提醒，本次未保存') }
    if (drafts.every(item => item.intent !== 'create_reminder' && item.intent !== 'todo')) throw new Error(mt('没有识别到明确的提醒指令，未创建提醒'))
    const draft = drafts[0]!
    if (drafts.length !== 1 || draft.intent !== 'create_reminder' || draft.needs_confirmation || draft.dueAt === null || draft.dueAt <= Date.now()) {
      this.open({ drafts }); return { message: mt('请确认提醒事项与时间') }
    }
    const row = this.save({ title: draft.title, description: draft.description, dueAt: draft.dueAt, level: draft.level, recurrence: draft.rule,
      source: 'voice', timeExpression: draft.time_expression ?? undefined })
    this.undoId = row.id
    const time = new Date(row.dueAt!).toLocaleString(mainLanguage() === 'en' ? 'en-US' : 'zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    })
    return { message: `${time} · ${mt(row.level === 'strong' ? '强提醒' : '普通提醒')} · ${row.title}`, undo: true }
  }
  undo(): void {
    if (this.undoId) this.remove(this.undoId)
    this.undoId = null
  }
  registerIpc(notes: NotesStore): void {
    ipcMain.handle('reminders:list', () => this.store.list())
    ipcMain.handle('reminders:save', (_event, input: ReminderInput, id?: string) => this.save(input, id))
    ipcMain.handle('reminders:save-many', (_event, inputs: ReminderInput[]) => {
      const rows = this.store.saveMany(inputs); this.refresh(); return rows
    })
    ipcMain.handle('reminders:action', (_event, id: string, action: ReminderAction) => this.action(id, action))
    ipcMain.handle('reminders:remove', (_event, id: string) => this.remove(id))
    ipcMain.handle('reminders:view', () => { const view = this.view; this.view = null; return view })
    ipcMain.handle('reminders:strong', () => this.strongRows())
    ipcMain.on('reminders:close-strong', () => this.strong?.close())
    ipcMain.handle('reminders:extract-note', async (_event, id: string) => {
      if (this.extracting) throw new Error(mt('正在提取待办，请稍候'))
      const note = notes.list().notes.find(item => item.id === id)
      if (!note) throw new Error(mt('随记不存在'))
      this.extracting = true
      const controller = new AbortController()
      this.noteAbort = controller
      try {
        const drafts = await extractReminders(this.settings(), note.transcript || note.polished, 'note', AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]))
        controller.signal.throwIfAborted()
        if (!drafts.length) throw new Error(mt('没有发现待办或提醒事项'))
        this.open({ drafts, noteId: id })
      } finally { this.extracting = false; if (this.noteAbort === controller) this.noteAbort = null }
    })
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
