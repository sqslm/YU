import { mt } from '@shared/mainI18n'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { Reminder, ReminderAction, ReminderInput } from '@shared/reminders'
import { isMissedReminder, normalizePriority, sortTodos } from '@shared/reminders'
import { nextOccurrence, validRecurrence } from './reminder-time'

/**
 * Rows live as plain JSON, so a field added later is simply absent on old rows.
 * Filling defaults here keeps one damaged-looking task from breaking the list.
 */
function readReminder(row: Record<string, unknown>): Reminder {
  const parsed = JSON.parse(String(row.data)) as Reminder
  return { ...parsed, priority: normalizePriority(parsed.priority), deadlineAt: typeof parsed.deadlineAt === 'number' ? parsed.deadlineAt : null }
}

/** Same local SQLite engine as history, kept independent of history retention. */
export class ReminderStore {
  private readonly db: DatabaseSync
  constructor(file: string, private readonly now = Date.now) {
    this.db = new DatabaseSync(file)
    this.db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS reminders (id TEXT PRIMARY KEY, dueAt INTEGER, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS reminders_due ON reminders(status, dueAt);`)
  }
  list(): Reminder[] {
    // SQL keeps a deterministic base order; sortTodos then applies the explicit todo order.
    return sortTodos(this.db.prepare('SELECT data FROM reminders ORDER BY dueAt IS NULL, dueAt, id').all().map(readReminder))
  }
  scheduled(): Reminder[] {
    return sortTodos(this.db.prepare("SELECT data FROM reminders WHERE status = 'pending' AND dueAt IS NOT NULL ORDER BY dueAt").all().map(readReminder))
  }
  due(): Reminder[] {
    return this.db.prepare("SELECT data FROM reminders WHERE status = 'due' ORDER BY dueAt").all().map(readReminder)
  }
  get(id: string): Reminder | undefined {
    const row = this.db.prepare('SELECT data FROM reminders WHERE id = ?').get(id)
    return row ? readReminder(row) : undefined
  }
  missed(): Reminder[] { return this.due().filter(isMissedReminder) }
  recoverMissed(): number {
    const now = this.now()
    const rows = this.db.prepare("SELECT data FROM reminders WHERE status IN ('pending','due') AND dueAt IS NOT NULL AND dueAt <= ?").all(now).map(readReminder)
    let count = 0
    for (const row of rows) {
      if (row.missedAt === row.dueAt) continue
      this.write({ ...row, status: 'due', missedAt: row.dueAt!, missedAcknowledgedAt: undefined, deliveredAt: row.deliveredAt ?? now, updatedAt: now })
      count++
    }
    return count
  }
  acknowledgeMissed(id: string, dueAt: number, completed: boolean): void {
    const row = this.get(id)
    if (!row || row.dueAt !== dueAt || !isMissedReminder(row)) return
    if (completed) this.action(id, 'complete')
    else this.write({ ...row, missedAcknowledgedAt: this.now() })
  }
  save(input: ReminderInput, id?: string): Reminder {
    const old = id ? this.get(id) : undefined
    if (id && !old) throw new Error(mt('提醒不存在'))
    const sameSchedule = old && old.dueAt === input?.dueAt && JSON.stringify(old.recurrence) === JSON.stringify(input.recurrence)
    if (!input || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 300) throw new Error(mt('请输入 1–300 字的提醒事项'))
    if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 4000)) throw new Error(mt('提醒备注不能超过 4000 字'))
    if (!['normal', 'strong'].includes(input.level) || !['manual', 'voice', 'note'].includes(input.source)) throw new Error(mt('提醒类型无效'))
    if (input.dueAt !== null && (!Number.isSafeInteger(input.dueAt) || input.dueAt <= this.now() && !(sameSchedule && old.status !== 'pending') || input.dueAt > 8640000000000000)) throw new Error(mt('请选择将来的提醒时间'))
    if (input.recurrence !== null && (!validRecurrence(input.recurrence) || input.dueAt === null)) throw new Error(mt('重复规则无效'))
    // A deadline may already be in the past (that task is simply overdue); only the shape is checked.
    const deadlineAt = input.deadlineAt === undefined ? old?.deadlineAt ?? null : input.deadlineAt
    if (deadlineAt !== null && (!Number.isSafeInteger(deadlineAt) || deadlineAt > 8640000000000000)) throw new Error(mt('截止时间无效'))
    const reminder: Reminder = { title: input.title.trim(), description: (input.description ?? old?.description ?? '').trim(), dueAt: input.dueAt, level: input.level,
      priority: normalizePriority(input.priority, normalizePriority(old?.priority)), deadlineAt,
      recurrence: input.recurrence, source: old?.source ?? input.source, noteId: old?.noteId ?? input.noteId,
      timeExpression: input.timeExpression, id: id ?? randomUUID(), createdAt: old?.createdAt ?? this.now(),
      updatedAt: this.now(), status: sameSchedule ? old.status : 'pending', deliveredAt: sameSchedule ? old.deliveredAt : null,
      snoozedUntil: sameSchedule ? old.snoozedUntil : undefined, lastCompletedAt: old?.lastCompletedAt,
      missedAt: sameSchedule ? old.missedAt : undefined, missedAcknowledgedAt: sameSchedule ? old.missedAcknowledgedAt : undefined }
    return this.write(reminder)
  }
  saveMany(inputs: ReminderInput[]): Reminder[] {
    if (!Array.isArray(inputs) || !inputs.length || inputs.length > 20) throw new Error(mt('请选择 1–20 个事项'))
    this.db.exec('BEGIN')
    try { const rows = inputs.map(input => this.save(input)); this.db.exec('COMMIT'); return rows }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  /**
   * Stores a row as given, for rows pulled from another device.
   *
   * `save()` rejects a `dueAt` in the past, which is right for creating an event
   * but wrong for a reminder that arrived while this machine was off: those are
   * exactly the ones worth surfacing.
   */
  put(reminder: Reminder): Reminder {
    return this.write(reminder)
  }
  private write(reminder: Reminder): Reminder {
    this.db.prepare('INSERT OR REPLACE INTO reminders (id,dueAt,status,data) VALUES (?,?,?,?)')
      .run(reminder.id, reminder.dueAt, reminder.status, JSON.stringify(reminder))
    return reminder
  }
  markDue(id: string): Reminder | undefined {
    const row = this.get(id)
    if (!row || row.status !== 'pending' || row.dueAt === null || row.dueAt > this.now()) return undefined
    return this.write({ ...row, status: 'due', deliveredAt: this.now(), updatedAt: this.now() })
  }
  action(id: string, action: ReminderAction, snoozeMinutes = 5): Reminder {
    const row = this.get(id)
    if (!row) throw new Error(mt('提醒不存在'))
    if (action === 'restore') {
      if (row.status !== 'completed' && row.status !== 'cancelled') throw new Error(mt('仅可恢复已完成或已取消的提醒'))
      const dueAt = row.recurrence ? nextOccurrence(row.recurrence, this.now()) : row.dueAt !== null && row.dueAt > this.now() ? row.dueAt : null
      return this.write({ ...row, dueAt, status: 'pending', deliveredAt: null, snoozedUntil: undefined, updatedAt: this.now() })
    }
    if (!['pending', 'due'].includes(row.status)) throw new Error(mt('这条提醒已处理'))
    if (action === 'snooze') {
      if (!Number.isInteger(snoozeMinutes) || snoozeMinutes < 1 || snoozeMinutes > 1440) throw new Error(mt('稍后提醒时长无效'))
      const dueAt = this.now() + snoozeMinutes * 60_000
      return this.write({ ...row, dueAt, snoozedUntil: dueAt, status: 'pending', deliveredAt: null, updatedAt: this.now() })
    }
    if (action !== 'cancel' && action !== 'complete') throw new Error(mt('提醒操作无效'))
    if (action === 'complete' && row.recurrence) return this.write({ ...row,
      dueAt: nextOccurrence(row.recurrence, Math.max(this.now(), row.dueAt ?? this.now())), status: 'pending', deliveredAt: null,
      snoozedUntil: undefined, lastCompletedAt: this.now(), updatedAt: this.now() })
    return this.write({ ...row, status: action === 'complete' ? 'completed' : 'cancelled', updatedAt: this.now() })
  }
  remove(id: string): void { this.db.prepare('DELETE FROM reminders WHERE id = ?').run(id) }
  rebaseRecurrences(): void {
    for (const row of this.scheduled()) if (row.recurrence && row.dueAt! > this.now() && row.snoozedUntil !== row.dueAt) {
      this.write({ ...row, dueAt: nextOccurrence(row.recurrence, this.now()), updatedAt: this.now() })
    }
  }
  close(): void { this.db.close() }
}

/** One deadline timer; a one-minute ceiling also detects wall-clock/zone changes. */
export class ReminderScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null
  private zone = ''
  constructor(private readonly store: ReminderStore, private readonly deliver: (reminder: Reminder) => void,
    private readonly changed: () => void, private readonly now = Date.now) {}
  check(): void {
    this.stop()
    const zone = `${Intl.DateTimeFormat().resolvedOptions().timeZone}/${new Date(this.now()).getTimezoneOffset()}`
    if (this.zone && this.zone !== zone) this.store.rebaseRecurrences()
    this.zone = zone
    let next = this.now() + 60_000
    for (const row of this.store.scheduled()) {
      if (row.status !== 'pending' || row.dueAt === null) continue
      if (row.dueAt <= this.now()) {
        const due = this.store.markDue(row.id)
        if (due) { this.changed(); this.deliver(due) }
      } else next = Math.min(next, row.dueAt)
    }
    this.timer = setTimeout(() => this.check(), Math.max(1, next - this.now()))
    this.timer.unref?.()
  }
  stop(): void { if (this.timer) clearTimeout(this.timer); this.timer = null }
}
