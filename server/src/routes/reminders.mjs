import { HttpError } from '../http.mjs'
import { bumpCounter, lastSeq } from '../db.mjs'
import { requireUser } from '../session.mjs'

/**
 * Reminders, over the same protocol as `notes` and `calendar`: incremental pull
 * by `seq`, tombstone for a deletion, newest `updatedAt` wins per id.
 *
 * The client's own reminder document travels in `data` verbatim. The columns
 * (`due_at`, `level`, `priority`, `deadline_at`, `recurrence`) are the parts a
 * server-side query can reason about without understanding that document; the
 * rest — snooze stamps, missed bookkeeping, source — stays inside `data`, where a
 * field added by a later client version simply appears instead of needing a
 * migration on this side.
 */

const MAX_PUSH = 200
const MAX_TITLE = 300
/** The whole client row: title, description (4 KB), recurrence, bookkeeping. */
const MAX_DATA = 20_000
const MAX_ID = 128
const STAMP_MIN = -8_640_000_000_000_000
const STAMP_MAX = 8_640_000_000_000_000
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const STATUSES = new Set(['pending', 'due', 'completed', 'cancelled'])
const LEVELS = new Set(['normal', 'strong'])
const PRIORITIES = new Set(['low', 'normal', 'high'])

function integer(value, field, { min = 0, max = STAMP_MAX, fallback } = {}) {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback
    throw new HttpError(400, 'bad_reminder', `缺少 ${field}`)
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, 'bad_reminder', `${field} 不合法`)
  }
  return parsed
}

function reminderId(value) {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!ID.test(id) || id.length > MAX_ID) throw new HttpError(400, 'bad_reminder_id', '提醒 id 不合法')
  return id
}

function text(value, field, maxLength, fallback = '') {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') throw new HttpError(400, 'bad_reminder', `${field} 必须是字符串`)
  if (value.length > maxLength) throw new HttpError(400, 'bad_reminder', `${field} 太长`)
  return value
}

/** Recurrence is one of a handful of small objects; an array or a scalar is a bug. */
function recurrenceJson(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'bad_reminder', 'recurrence 必须是对象')
  }
  const encoded = JSON.stringify(value)
  if (encoded.length > 2000) throw new HttpError(400, 'bad_reminder', 'recurrence 太长')
  return encoded
}

/** The client's whole row, stored verbatim so an unknown field survives a round trip. */
function dataJson(value) {
  if (value === undefined || value === null) return '{}'
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'bad_reminder', 'data 必须是对象')
  }
  const encoded = JSON.stringify(value)
  if (encoded.length > MAX_DATA) throw new HttpError(413, 'reminder_too_large', `data 不能超过 ${MAX_DATA} 字节`)
  return encoded
}

function parseChange(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HttpError(400, 'bad_reminder', `第 ${index + 1} 条变更不是对象`)
  }
  const updatedAt = integer(raw.updatedAt, 'updatedAt', { min: STAMP_MIN, fallback: Date.now() })
  const rawDeletedAt = raw.deletedAt ?? (raw.deleted === true ? updatedAt : null)
  const deletedAt = rawDeletedAt === null || rawDeletedAt === undefined
    ? null
    : integer(rawDeletedAt, 'deletedAt', { min: STAMP_MIN })
  const change = {
    id: reminderId(raw.id),
    updatedAt,
    deletedAt,
    title: text(raw.title, 'title', MAX_TITLE),
    dueAt: raw.dueAt === undefined || raw.dueAt === null
      ? null
      : integer(raw.dueAt, 'dueAt', { min: STAMP_MIN }),
    // A deadline may legitimately be in the past: that task is simply overdue.
    deadlineAt: raw.deadlineAt === undefined || raw.deadlineAt === null
      ? null
      : integer(raw.deadlineAt, 'deadlineAt', { min: STAMP_MIN }),
    level: LEVELS.has(raw.level) ? raw.level : 'normal',
    priority: PRIORITIES.has(raw.priority) ? raw.priority : 'normal',
    recurrence: recurrenceJson(raw.recurrence),
    status: STATUSES.has(raw.status) ? raw.status : 'pending',
    data: dataJson(raw.data)
  }
  if (change.deletedAt !== null) {
    // Identity and stamp only; see calendar.mjs.
    change.title = ''
    change.dueAt = null
    change.deadlineAt = null
    change.recurrence = null
    change.status = 'cancelled'
    change.data = '{}'
  }
  return change
}

function safeJson(value, fallback) {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function serialize(row) {
  const deleted = Number(row.deleted) === 1
  return {
    id: row.id,
    title: row.title,
    dueAt: row.due_at === null || row.due_at === undefined ? null : Number(row.due_at),
    level: row.level,
    priority: row.priority,
    deadlineAt: row.deadline_at === null || row.deadline_at === undefined ? null : Number(row.deadline_at),
    recurrence: row.recurrence === null || row.recurrence === undefined ? null : safeJson(row.recurrence, null),
    status: row.status,
    data: deleted ? null : safeJson(row.data, {}),
    updatedAt: Number(row.updated_at),
    deleted,
    deletedAt: row.deleted_at === null || row.deleted_at === undefined ? null : Number(row.deleted_at),
    serverUpdatedAt: Number(row.server_updated_at)
  }
}

function sameContent(row, change) {
  const dueAt = row.due_at === null || row.due_at === undefined ? null : Number(row.due_at)
  const deadlineAt = row.deadline_at === null || row.deadline_at === undefined ? null : Number(row.deadline_at)
  return (
    Number(row.updated_at) === change.updatedAt &&
    (Number(row.deleted) === 1) === (change.deletedAt !== null) &&
    (Number(row.deleted_at) || null) === change.deletedAt &&
    row.title === change.title &&
    dueAt === change.dueAt &&
    deadlineAt === change.deadlineAt &&
    row.level === change.level &&
    row.priority === change.priority &&
    (row.recurrence ?? null) === change.recurrence &&
    row.status === change.status &&
    row.data === change.data
  )
}

function applyChange(ctx, user, change) {
  const db = ctx.db
  const existing = db.prepare('SELECT * FROM reminders WHERE id = ? AND user_id = ?').get(change.id, user.id)

  if (!existing) {
    const foreign = db.prepare('SELECT 1 AS taken FROM reminders WHERE id = ?').get(change.id)
    if (foreign) return { status: 'id_taken' }
    const seq = bumpCounter(db, 'reminders_seq')
    db.prepare(
      `INSERT INTO reminders
         (id, user_id, title, due_at, level, priority, deadline_at, recurrence, status, data,
          updated_at, deleted, deleted_at, seq, server_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      change.id,
      user.id,
      change.title,
      change.dueAt,
      change.level,
      change.priority,
      change.deadlineAt,
      change.recurrence,
      change.status,
      change.data,
      change.updatedAt,
      change.deletedAt === null ? 0 : 1,
      change.deletedAt,
      seq,
      ctx.now
    )
    return { status: 'applied' }
  }

  if (sameContent(existing, change)) return { status: 'duplicate' }

  // See `calendar.mjs`: "last write wins" means last by `updatedAt`, not last to
  // arrive. An older change is refused as `stale` and reported by id so the client
  // can keep its version as a conflict copy instead of losing it.
  if (change.updatedAt <= Number(existing.updated_at)) return { status: 'stale' }

  const seq = bumpCounter(db, 'reminders_seq')
  db.prepare(
    `UPDATE reminders
        SET title = ?, due_at = ?, level = ?, priority = ?, deadline_at = ?, recurrence = ?,
            status = ?, data = ?, updated_at = ?, deleted = ?, deleted_at = ?, seq = ?,
            server_updated_at = ?
      WHERE id = ? AND user_id = ?`
  ).run(
    change.title,
    change.dueAt,
    change.level,
    change.priority,
    change.deadlineAt,
    change.recurrence,
    change.status,
    change.data,
    change.updatedAt,
    change.deletedAt === null ? 0 : 1,
    change.deletedAt,
    seq,
    ctx.now,
    change.id,
    user.id
  )
  return { status: 'applied' }
}

function clampLimit(raw, fallback = 200) {
  const value = Math.trunc(Number(raw))
  if (!Number.isFinite(value)) return fallback
  return Math.min(500, Math.max(1, value))
}

function listReminders(ctx) {
  const user = requireUser(ctx)
  const limit = clampLimit(ctx.query.get('limit') ?? undefined)
  let since = Math.max(0, Math.trunc(Number(ctx.query.get('since') ?? 0)) || 0)
  const highest = Number(
    ctx.db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM reminders WHERE user_id = ?').get(user.id)?.n ?? 0
  )
  // See calendar.mjs: a cursor from another install restarts at zero rather than
  // leaving the client permanently empty.
  if (since > highest) since = 0
  const rows = ctx.db
    .prepare(
      `SELECT * FROM reminders
        WHERE user_id = ? AND seq > ?
        ORDER BY seq ASC
        LIMIT ?`
    )
    .all(user.id, since, limit)
  const cursor = rows.length > 0 ? Number(rows[rows.length - 1].seq) : since
  return { cursor, reminders: rows.map(serialize), hasMore: rows.length === limit, serverTime: ctx.now }
}

export function registerReminderRoutes(router) {
  router.get('/api/v1/reminders', async (ctx) => listReminders(ctx))
  router.get('/api/v1/reminders/changes', async (ctx) => listReminders(ctx))

  router.post('/api/v1/reminders', async (ctx) => {
    const user = requireUser(ctx)
    const body = ctx.body ?? {}
    const rawChanges = Array.isArray(body.changes) ? body.changes : [body]
    if (rawChanges.length === 0) throw new HttpError(400, 'bad_request', '缺少 changes 数组')
    if (rawChanges.length > MAX_PUSH) {
      throw new HttpError(413, 'too_many_changes', `一次最多提交 ${MAX_PUSH} 条变更`)
    }
    const changes = rawChanges.map(parseChange)

    const applied = []
    const duplicates = []
    const conflicts = []
    const stale = []
    ctx.db.exec('BEGIN')
    try {
      for (const change of changes) {
        const result = applyChange(ctx, user, change)
        if (result.status === 'applied') applied.push(change.id)
        else if (result.status === 'duplicate') duplicates.push(change.id)
        else if (result.status === 'stale') stale.push(change.id)
        else conflicts.push({ id: change.id, error: 'reminder_id_taken' })
      }
      ctx.db.exec('COMMIT')
    } catch (error) {
      ctx.db.exec('ROLLBACK')
      throw error
    }

    const stored = [...applied, ...duplicates].map((id) =>
      serialize(ctx.db.prepare('SELECT * FROM reminders WHERE id = ? AND user_id = ?').get(id, user.id))
    )
    if (conflicts.length > 0) {
      return ctx.reply(409, {
        error: 'conflict',
        message: '这些提醒 ID 已被其他账号占用',
        applied,
        duplicates,
        conflicts,
        stale,
        cursor: lastSeq(ctx.db, 'reminders')
      })
    }
    return {
      applied,
      duplicates,
      conflicts: [],
      stale,
      reminders: stored,
      cursor: lastSeq(ctx.db, 'reminders'),
      serverTime: ctx.now
    }
  })
}
