import { HttpError } from '../http.mjs'
import { bumpCounter, lastSeq } from '../db.mjs'
import { requireUser } from '../session.mjs'

/**
 * The calendar, over the same protocol as `notes`: incremental pull by `seq`,
 * tombstone for a deletion, one transaction per push.
 *
 * The write is an upsert with no version check, on purpose. A calendar row is
 * personal data the user edits on whichever device is at hand; the server has no
 * better claim to the truth than the client that just sent the edit, so a
 * "someone else changed this" answer would only produce a conflict dialog over
 * the user's own change. Ordering is therefore last-write-wins per `id`, while a
 * deletion stays a tombstone so a device that was offline cannot resurrect the
 * row by pushing its stale copy.
 */

/** One push may not exceed this many rows; the client pages below it. */
const MAX_PUSH = 200
const MAX_TITLE = 200
const MAX_NOTES = 2000
const MAX_LOCATION = 300
const MAX_UID = 300
/** ±275 000 years: the range of a JS date, so no legitimate stamp is refused. */
const STAMP_MIN = -8_640_000_000_000_000
const STAMP_MAX = 8_640_000_000_000_000
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const STATUSES = new Set(['confirmed', 'cancelled'])
const SOURCES = new Set(['voice', 'manual', 'import'])

function integer(value, field, { min = 0, max = STAMP_MAX, fallback } = {}) {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback
    throw new HttpError(400, 'bad_calendar', `缺少 ${field}`)
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, 'bad_calendar', `${field} 不合法`)
  }
  return parsed
}

function text(value, field, maxLength, fallback = '') {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') throw new HttpError(400, 'bad_calendar', `${field} 必须是字符串`)
  if (value.length > maxLength) throw new HttpError(400, 'bad_calendar', `${field} 太长`)
  return value
}

function optionalText(value, field, maxLength) {
  if (value === undefined || value === null) return null
  const parsed = text(value, field, maxLength)
  return parsed === '' ? null : parsed
}

function eventId(value) {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!ID.test(id)) throw new HttpError(400, 'bad_calendar_id', '日程 id 不合法')
  return id
}

/**
 * One client change, validated.
 *
 * A tombstone carries only its identity and stamp: the device that deleted the
 * row has already dropped the content, and echoing that content back would keep
 * it alive on every other machine.
 */
function parseChange(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HttpError(400, 'bad_calendar', `第 ${index + 1} 条变更不是对象`)
  }
  const updatedAt = integer(raw.updatedAt, 'updatedAt', { min: STAMP_MIN, fallback: Date.now() })
  const rawDeletedAt = raw.deletedAt ?? (raw.deleted === true ? updatedAt : null)
  const deletedAt = rawDeletedAt === null || rawDeletedAt === undefined
    ? null
    : integer(rawDeletedAt, 'deletedAt', { min: STAMP_MIN })
  const change = {
    id: eventId(raw.id),
    updatedAt,
    deletedAt,
    title: text(raw.title, 'title', MAX_TITLE),
    start: integer(raw.start, 'start', { min: STAMP_MIN, fallback: 0 }),
    end: integer(raw.end, 'end', { min: STAMP_MIN, fallback: 0 }),
    allDay: raw.allDay === true,
    location: optionalText(raw.location, 'location', MAX_LOCATION),
    notes: optionalText(raw.notes, 'notes', MAX_NOTES),
    leadMinutes: raw.leadMinutes === undefined || raw.leadMinutes === null
      ? null
      : integer(raw.leadMinutes, 'leadMinutes', { max: 1440 }),
    source: SOURCES.has(raw.source) ? raw.source : 'manual',
    uid: optionalText(raw.uid, 'uid', MAX_UID),
    status: STATUSES.has(raw.status) ? raw.status : 'confirmed'
  }
  if (change.deletedAt !== null) {
    change.title = ''
    change.start = 0
    change.end = 0
    change.allDay = false
    change.location = null
    change.notes = null
    change.leadMinutes = null
    // The uid is dropped as well: a retracted event must not keep occupying the
    // identity a later subscription refresh would match against.
    change.uid = null
    change.status = 'confirmed'
  }
  return change
}

function serialize(row) {
  const deleted = Number(row.deleted) === 1
  return {
    id: row.id,
    title: row.title,
    start: Number(row.start_at),
    end: Number(row.end_at),
    allDay: Number(row.all_day) === 1,
    location: row.location ?? null,
    notes: row.notes ?? null,
    leadMinutes: row.lead_minutes === null || row.lead_minutes === undefined ? null : Number(row.lead_minutes),
    source: row.source,
    uid: row.uid ?? null,
    status: row.status,
    updatedAt: Number(row.updated_at),
    deleted,
    deletedAt: row.deleted_at === null || row.deleted_at === undefined ? null : Number(row.deleted_at),
    serverUpdatedAt: Number(row.server_updated_at)
  }
}

/** True when the stored row already says exactly what this change says. */
function sameContent(row, change) {
  return (
    Number(row.updated_at) === change.updatedAt &&
    (Number(row.deleted) === 1) === (change.deletedAt !== null) &&
    (Number(row.deleted_at) || null) === change.deletedAt &&
    row.title === change.title &&
    Number(row.start_at) === change.start &&
    Number(row.end_at) === change.end &&
    (Number(row.all_day) === 1) === change.allDay &&
    (row.location ?? null) === change.location &&
    (row.notes ?? null) === change.notes &&
    (row.lead_minutes === null || row.lead_minutes === undefined ? null : Number(row.lead_minutes)) === change.leadMinutes &&
    row.source === change.source &&
    (row.uid ?? null) === change.uid &&
    row.status === change.status
  )
}

/**
 * Applies one change.
 *
 * `duplicate` is not an error: a client whose response was lost retries the same
 * content, and bumping `seq` for it would hand every other device a row that did
 * not change.
 */
function applyChange(ctx, user, change) {
  const db = ctx.db
  const existing = db.prepare('SELECT * FROM calendar_events WHERE id = ? AND user_id = ?').get(change.id, user.id)

  if (!existing) {
    // Ids are the client's; a collision with another account is reported instead
    // of overwriting (or leaking) that row.
    const foreign = db.prepare('SELECT 1 AS taken FROM calendar_events WHERE id = ?').get(change.id)
    if (foreign) return { status: 'id_taken' }
    const seq = bumpCounter(db, 'calendar_seq')
    db.prepare(
      `INSERT INTO calendar_events
         (id, user_id, title, start_at, end_at, all_day, location, notes, lead_minutes, source, uid,
          status, updated_at, deleted, deleted_at, seq, server_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      change.id,
      user.id,
      change.title,
      change.start,
      change.end,
      change.allDay ? 1 : 0,
      change.location,
      change.notes,
      change.leadMinutes,
      change.source,
      change.uid,
      change.status,
      change.updatedAt,
      change.deletedAt === null ? 0 : 1,
      change.deletedAt,
      seq,
      ctx.now
    )
    return { status: 'applied' }
  }

  if (sameContent(existing, change)) return { status: 'duplicate' }

  const seq = bumpCounter(db, 'calendar_seq')
  db.prepare(
    `UPDATE calendar_events
        SET title = ?, start_at = ?, end_at = ?, all_day = ?, location = ?, notes = ?,
            lead_minutes = ?, source = ?, uid = ?, status = ?, updated_at = ?,
            deleted = ?, deleted_at = ?, seq = ?, server_updated_at = ?
      WHERE id = ? AND user_id = ?`
  ).run(
    change.title,
    change.start,
    change.end,
    change.allDay ? 1 : 0,
    change.location,
    change.notes,
    change.leadMinutes,
    change.source,
    change.uid,
    change.status,
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

/** Incremental pull: every row whose `seq` is above the cursor. */
function listEvents(ctx) {
  const user = requireUser(ctx)
  const limit = clampLimit(ctx.query.get('limit') ?? undefined)
  let since = Math.max(0, Math.trunc(Number(ctx.query.get('since') ?? 0)) || 0)
  const highest = Number(
    ctx.db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM calendar_events WHERE user_id = ?').get(user.id)?.n ?? 0
  )
  // A cursor above anything this account was ever handed out means the client
  // comes from another install (or a restored backup). Restarting at zero is the
  // only reading that does not leave it permanently empty.
  if (since > highest) since = 0
  const rows = ctx.db
    .prepare(
      `SELECT * FROM calendar_events
        WHERE user_id = ? AND seq > ?
        ORDER BY seq ASC
        LIMIT ?`
    )
    .all(user.id, since, limit)
  const cursor = rows.length > 0 ? Number(rows[rows.length - 1].seq) : since
  return { cursor, events: rows.map(serialize), hasMore: rows.length === limit, serverTime: ctx.now }
}

export function registerCalendarRoutes(router) {
  // Two spellings of the same read: `?since=` on the collection, and the explicit
  // `/changes` alias the notes client already uses.
  router.get('/api/v1/calendar', async (ctx) => listEvents(ctx))
  router.get('/api/v1/calendar/changes', async (ctx) => listEvents(ctx))

  /**
   * Upsert. Accepts either one event or `{ changes: [...] }`, because a single
   * edit from a form and a batch from a sync pass are the same operation.
   */
  router.post('/api/v1/calendar', async (ctx) => {
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
    ctx.db.exec('BEGIN')
    try {
      for (const change of changes) {
        const result = applyChange(ctx, user, change)
        if (result.status === 'applied') applied.push(change.id)
        else if (result.status === 'duplicate') duplicates.push(change.id)
        else conflicts.push({ id: change.id, error: 'calendar_id_taken' })
      }
      ctx.db.exec('COMMIT')
    } catch (error) {
      ctx.db.exec('ROLLBACK')
      throw error
    }

    const stored = [...applied, ...duplicates].map((id) =>
      serialize(ctx.db.prepare('SELECT * FROM calendar_events WHERE id = ? AND user_id = ?').get(id, user.id))
    )
    if (conflicts.length > 0) {
      return ctx.reply(409, {
        error: 'conflict',
        message: '这些日程 ID 已被其他账号占用',
        applied,
        duplicates,
        conflicts,
        cursor: lastSeq(ctx.db, 'calendar_events')
      })
    }
    return {
      applied,
      duplicates,
      conflicts: [],
      events: stored,
      cursor: lastSeq(ctx.db, 'calendar_events'),
      serverTime: ctx.now
    }
  })
}
