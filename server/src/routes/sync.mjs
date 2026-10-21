import { HttpError } from '../http.mjs'
import { bumpCounter, readCounter } from '../db.mjs'
import { requireUser, subscriptionOf } from '../session.mjs'

/** One push may not exceed this many rows; clients batch smaller. */
const MAX_PUSH_ROWS = 500

const UPSERT = `
INSERT INTO history (id, user_id, payload, created_at, updated_at, deleted, seq)
VALUES (?, ?, ?, ?, ?, 0, ?)
ON CONFLICT(id) DO UPDATE SET
  payload = excluded.payload,
  updated_at = excluded.updated_at,
  deleted = 0,
  seq = excluded.seq
WHERE excluded.updated_at >= history.updated_at AND history.user_id = excluded.user_id
`

/**
 * `updated_at` moves past the row it replaces even when the server clock reads the
 * same millisecond, because clients compare their own `updatedAt` against the
 * tombstone's to decide whether the local edit is newer. Without the `+ 1` a push
 * and its delete inside one millisecond leave the deletion looking older than the
 * row, and the other machine keeps it forever.
 */
const TOMBSTONE = `
UPDATE history
   SET deleted = 1,
       updated_at = max(?, updated_at + 1),
       seq = ?
 WHERE id = ? AND user_id = ? AND deleted = 0
`

function parseEntry(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HttpError(400, 'bad_entry', `第 ${index + 1} 条记录不是对象`)
  }
  const id = typeof raw.id === 'string' ? raw.id : ''
  if (id.length === 0 || id.length > 128) {
    throw new HttpError(400, 'bad_entry', `第 ${index + 1} 条记录缺少 id`)
  }
  const createdAt = Number(raw.createdAt)
  const updatedAt = Number(raw.updatedAt ?? raw.createdAt)
  return {
    id,
    createdAt: Number.isFinite(createdAt) ? Math.trunc(createdAt) : Date.now(),
    updatedAt: Number.isFinite(updatedAt) ? Math.trunc(updatedAt) : Date.now(),
    payload: JSON.stringify(raw)
  }
}

/** Highest cursor handed out so far, across every account. */
function lastSeq(db) {
  return Number(db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM history').get()?.n ?? 0)
}

export function registerSyncRoutes(router) {
  router.get('/api/v1/sync/check', async (ctx) => {
    const user = requireUser(ctx)
    const revision = readCounter(ctx.db, 'history_revision')
    const count = Number(
      ctx.db.prepare('SELECT COUNT(*) AS n FROM history WHERE user_id = ? AND deleted = 0').get(user.id)
        ?.n ?? 0
    )
    return {
      serverTime: ctx.now,
      revision,
      count,
      subscription: subscriptionOf(user, ctx.now)
    }
  })

  router.get('/api/v1/transcription_history/sync_status', async (ctx) => {
    const user = requireUser(ctx)
    const row = ctx.db
      .prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS last FROM history WHERE user_id = ? AND deleted = 0')
      .get(user.id)
    return {
      revision: readCounter(ctx.db, 'history_revision'),
      count: Number(row?.n ?? 0),
      lastUpdatedAt: row?.last === null || row?.last === undefined ? null : Number(row.last),
      enabled: subscriptionOf(user, ctx.now).active
    }
  })

  /**
   * Pushes client rows. Last write wins on `updatedAt`, and a row the server
   * already has with a newer stamp is left alone — two machines editing the same
   * entry must not ping-pong.
   *
   * A push that loses that comparison keeps its old `seq` on purpose: no client
   * needs to hear about a write that was rejected.
   */
  router.post('/api/v1/transcription_history/push', async (ctx) => {
    const user = requireUser(ctx)
    const body = ctx.body
    const rawEntries = Array.isArray(body.entries) ? body.entries : []
    const rawDeleted = Array.isArray(body.deleted) ? body.deleted : []
    if (rawEntries.length + rawDeleted.length > MAX_PUSH_ROWS) {
      throw new HttpError(413, 'too_many_rows', `一次最多推送 ${MAX_PUSH_ROWS} 条`)
    }
    const entries = rawEntries.map(parseEntry)
    const deletedIds = rawDeleted.map((value, index) => {
      if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
        throw new HttpError(400, 'bad_entry', `第 ${index + 1} 个删除标记不是 id`)
      }
      return value
    })

    const upsert = ctx.db.prepare(UPSERT)
    const tombstone = ctx.db.prepare(TOMBSTONE)
    let seq = lastSeq(ctx.db)
    ctx.db.exec('BEGIN')
    try {
      for (const entry of entries) {
        seq += 1
        upsert.run(entry.id, user.id, entry.payload, entry.createdAt, entry.updatedAt, seq)
      }
      for (const id of deletedIds) {
        seq += 1
        tombstone.run(ctx.now, seq, id, user.id)
      }
      ctx.db.exec('COMMIT')
    } catch (err) {
      ctx.db.exec('ROLLBACK')
      throw err
    }
    const revision = bumpCounter(ctx.db, 'history_revision')
    ctx.log(`[sync] push ${user.email} +${entries.length} -${deletedIds.length}`)
    return { revision, accepted: entries.length, deleted: deletedIds.length, cursor: seq }
  })

  /**
   * Everything changed after `since`, oldest first so the client applies in order.
   *
   * `since` is a `seq`, not a timestamp. A client that still carries a timestamp
   * cursor (an older build, or a database wiped and re-created with a lower
   * counter) sends a number above every `seq` the server can hand out, so it is
   * treated as "start over" rather than as "you are up to date" — otherwise that
   * client would silently never pull again.
   */
  router.get('/api/v1/transcription_history/pull', async (ctx) => {
    const user = requireUser(ctx)
    const requested = Math.max(0, Math.trunc(Number(ctx.query.get('since') ?? 0)) || 0)
    const limit = Math.min(MAX_PUSH_ROWS, Math.max(1, Math.trunc(Number(ctx.query.get('limit') ?? 200)) || 200))
    const highest = lastSeq(ctx.db)
    const since = requested > highest ? 0 : requested
    const rows = ctx.db
      .prepare(
        'SELECT id, payload, updated_at, deleted, seq FROM history WHERE user_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?'
      )
      .all(user.id, since, limit)
    const entries = rows.map((row) => {
      if (Number(row.deleted) === 1) {
        return { id: row.id, deleted: true, updatedAt: Number(row.updated_at) }
      }
      try {
        return { ...JSON.parse(row.payload), updatedAt: Number(row.updated_at), deleted: false }
      } catch {
        // A row we cannot parse is reported as a tombstone rather than dropped:
        // silently omitting it would make the client think it is up to date.
        return { id: row.id, deleted: true, updatedAt: Number(row.updated_at) }
      }
    })
    const revision = readCounter(ctx.db, 'history_revision')
    const hasMore = rows.length === limit
    const nextSince = rows.length > 0 ? Number(rows[rows.length - 1].seq) : since
    return { revision, entries, hasMore, nextSince }
  })

  /**
   * Forgets everything on the server. Rows become tombstones rather than being
   * deleted outright: another machine that pulls later has to learn that the rows
   * are gone, and a missing row is indistinguishable from "not pushed yet".
   *
   * Each row takes its own `seq` so a page limit cannot split one wipe into a
   * batch the client would never ask for again.
   */
  router.delete('/api/v1/transcription_history/wipe', async (ctx) => {
    const user = requireUser(ctx)
    const live = ctx.db.prepare('SELECT id FROM history WHERE user_id = ? AND deleted = 0').all(user.id)
    const tombstone = ctx.db.prepare(TOMBSTONE)
    let seq = lastSeq(ctx.db)
    ctx.db.exec('BEGIN')
    try {
      for (const row of live) {
        seq += 1
        tombstone.run(ctx.now, seq, row.id, user.id)
      }
      ctx.db.exec('COMMIT')
    } catch (err) {
      ctx.db.exec('ROLLBACK')
      throw err
    }
    const revision = bumpCounter(ctx.db, 'history_revision')
    ctx.log(`[sync] wipe ${user.email} (${live.length} rows)`)
    return { revision, ok: true, wiped: live.length, cursor: seq }
  })
}
