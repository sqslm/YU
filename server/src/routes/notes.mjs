import { HttpError } from '../http.mjs'
import { bumpCounter, lastSeq } from '../db.mjs'
import { quotaBytesFor, requireUser } from '../session.mjs'
import {
  commitUpload,
  noteAudioPath,
  normalizeAudioFormat,
  receiveToTemp,
  removeFile,
  sendAudio,
  usageBytes
} from '../storage.mjs'

/** One batch may not exceed this many notes; the client pages below it. */
const MAX_PUSH = 200
const MAX_TEXT = 200_000
const MAX_TAGS = 32
const MAX_TAG_CHARS = 64
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const POLISH_STATUSES = new Set(['pending', 'ok', 'failed', 'skipped'])

function integer(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback } = {}) {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback
    throw new HttpError(400, 'bad_note', `缺少 ${field}`)
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, 'bad_note', `${field} 不合法`)
  }
  return parsed
}

function text(value, field, maxLength, fallback = '') {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') throw new HttpError(400, 'bad_note', `${field} 必须是字符串`)
  if (value.length > maxLength) throw new HttpError(400, 'bad_note', `${field} 太长`)
  return value
}

function noteId(value) {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!ID.test(id)) throw new HttpError(400, 'bad_note_id', '随记 id 不合法')
  return id
}

/** Tags as the client's own normaliser produces them: trimmed, unique, capped. */
function normalizeTags(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new HttpError(400, 'bad_note', 'tags 必须是数组')
  const tags = []
  for (const raw of value.slice(0, MAX_TAGS * 2)) {
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim().replace(/\s+/g, ' ')
    if (!trimmed) continue
    // Code points, not UTF-16 units: clipping must never split an emoji.
    const clipped = Array.from(trimmed).slice(0, MAX_TAG_CHARS).join('')
    if (tags.includes(clipped)) continue
    tags.push(clipped)
    if (tags.length >= MAX_TAGS) break
  }
  return tags
}

/**
 * One client change, validated.
 *
 * A tombstone carries only its identity, version and stamp, so the content
 * fields are optional when `deleted` is true — which is exactly what the client
 * has left after it removed the text locally.
 */
function parseChange(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HttpError(400, 'bad_note', `第 ${index + 1} 条变更不是对象`)
  }
  const deleted = raw.deleted === true
  const change = {
    id: noteId(raw.id),
    version: integer(raw.version, 'version', { max: 2_000_000_000 }),
    deleted,
    createdAt: integer(raw.createdAt, 'createdAt', { fallback: Date.now() }),
    updatedAt: integer(raw.updatedAt, 'updatedAt', { fallback: Date.now() }),
    durationMs: integer(raw.durationMs, 'durationMs', { max: 24 * 3600 * 1000, fallback: 0 }),
    transcript: text(raw.transcript, 'transcript', MAX_TEXT),
    title: raw.title === undefined ? undefined : text(raw.title, 'title', 200),
    polished: text(raw.polished, 'polished', MAX_TEXT),
    polishStatus: 'skipped',
    polishError: null,
    categoryId: null,
    tags: [],
    editedAt: null
  }
  const status = typeof raw.polishStatus === 'string' ? raw.polishStatus : ''
  change.polishStatus = POLISH_STATUSES.has(status) ? status : change.polished ? 'ok' : 'skipped'
  change.polishError = raw.polishError === null || raw.polishError === undefined
    ? null
    : text(raw.polishError, 'polishError', 500)
  change.categoryId = raw.categoryId === null || raw.categoryId === undefined
    ? null
    : text(raw.categoryId, 'categoryId', 128) || null
  change.tags = normalizeTags(raw.tags)
  if (raw.editedAt !== undefined && raw.editedAt !== null) {
    change.editedAt = integer(raw.editedAt, 'editedAt')
  }
  return change
}

function audioRow(db, userId, id) {
  return db
    .prepare('SELECT bytes, format, sha256 FROM note_audio WHERE note_id = ? AND user_id = ?')
    .get(id, userId)
}

function serialize(row, audio) {
  const deleted = Number(row.deleted) === 1
  return {
    id: row.id,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    durationMs: Number(row.duration_ms),
    // A tombstone never carries the text back to a client that asked to forget it.
    transcript: deleted ? '' : row.transcript,
    title: deleted ? '' : row.title ?? '',
    polished: deleted ? '' : row.polished,
    polishStatus: row.polish_status,
    polishError: deleted ? null : row.polish_error ?? null,
    categoryId: deleted ? null : row.category_id ?? null,
    tags: deleted ? [] : safeTags(row.tags),
    editedAt: row.edited_at === null || row.edited_at === undefined ? null : Number(row.edited_at),
    version: Number(row.version),
    deleted,
    audio: audio ? { bytes: Number(audio.bytes), format: audio.format, sha256: audio.sha256 } : null,
    serverUpdatedAt: Number(row.server_updated_at)
  }
}

function safeTags(value) {
  try {
    const parsed = JSON.parse(value || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** One row plus its audio metadata, the shape every route returns. */
export function readNote(db, userId, id) {
  const row = db.prepare('SELECT * FROM notes WHERE id = ? AND user_id = ?').get(id, userId)
  return row ? serialize(row, audioRow(db, userId, id)) : null
}

function sameContent(row, change) {
  return (
    Number(row.updated_at) === change.updatedAt &&
    Number(row.created_at) === change.createdAt &&
    Number(row.duration_ms) === change.durationMs &&
    row.transcript === change.transcript &&
    (change.title === undefined || (row.title ?? '') === change.title) &&
    row.polished === change.polished &&
    row.polish_status === change.polishStatus &&
    (row.polish_error ?? null) === change.polishError &&
    (row.category_id ?? null) === change.categoryId &&
    safeTags(row.tags).join('\u0000') === change.tags.join('\u0000') &&
    Number(row.deleted) === (change.deleted ? 1 : 0)
  )
}

/**
 * Applies one change with optimistic concurrency.
 *
 * `version` is the version the client last saw; the server accepts only when it
 * still holds exactly that number. A retried request that already landed is
 * recognised by content (`version + 1` and identical fields) and reported as a
 * duplicate instead of a conflict — otherwise a dropped response would force the
 * user to resolve a conflict with themselves.
 *
 * Never overwrites: a mismatch returns the server copy so the caller can decide.
 */
function applyChange(ctx, user, change) {
  const db = ctx.db
  const existing = db.prepare('SELECT * FROM notes WHERE id = ? AND user_id = ?').get(change.id, user.id)
  const removePaths = []

  if (!existing) {
    // Ids are the client's and globally unique in this table, so an upload can
    // address a note without a user segment. A collision with another account is
    // reported rather than leaking or overwriting that row.
    const foreign = db.prepare('SELECT 1 AS taken FROM notes WHERE id = ?').get(change.id)
    if (foreign) return { status: 'id_taken' }
    const seq = bumpCounter(db, 'notes_seq')
    db.prepare(
      `INSERT INTO notes
         (id, user_id, created_at, updated_at, duration_ms, transcript, polished, polish_status,
          polish_error, category_id, tags, edited_at, version, deleted, seq, server_updated_at, title)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      change.id,
      user.id,
      change.createdAt,
      change.updatedAt,
      change.durationMs,
      change.deleted ? '' : change.transcript,
      change.deleted ? '' : change.polished,
      change.polishStatus,
      change.deleted ? null : change.polishError,
      change.deleted ? null : change.categoryId,
      change.deleted ? '[]' : JSON.stringify(change.tags),
      change.deleted ? null : change.editedAt,
      change.version + 1,
      change.deleted ? 1 : 0,
      seq,
      ctx.now,
      change.deleted ? '' : change.title ?? ''
    )
    return { status: 'applied', note: readNote(db, user.id, change.id) }
  }

  const currentVersion = Number(existing.version)
  if (currentVersion === change.version) {
    const seq = bumpCounter(db, 'notes_seq')
    db.prepare(
      `UPDATE notes
          SET created_at = ?, updated_at = ?, duration_ms = ?, transcript = ?, polished = ?,
              polish_status = ?, polish_error = ?, category_id = ?, tags = ?, edited_at = ?,
              version = ?, deleted = ?, seq = ?, server_updated_at = ?, title = ?
        WHERE id = ? AND user_id = ?`
    ).run(
      change.createdAt,
      change.updatedAt,
      change.durationMs,
      change.deleted ? '' : change.transcript,
      change.deleted ? '' : change.polished,
      change.polishStatus,
      change.deleted ? null : change.polishError,
      change.deleted ? null : change.categoryId,
      change.deleted ? '[]' : JSON.stringify(change.tags),
      change.deleted ? null : change.editedAt,
      currentVersion + 1,
      change.deleted ? 1 : 0,
      seq,
      ctx.now,
      change.deleted ? '' : change.title ?? existing.title,
      change.id,
      user.id
    )
    if (change.deleted) {
      const audio = audioRow(db, user.id, change.id)
      if (audio) {
        db.prepare('DELETE FROM note_audio WHERE note_id = ? AND user_id = ?').run(change.id, user.id)
        removePaths.push(noteAudioPath(ctx.config, user.id, change.id, audio.format))
      }
    }
    return { status: 'applied', note: readNote(db, user.id, change.id), removePaths }
  }

  if (currentVersion === change.version + 1 && sameContent(existing, change)) {
    return { status: 'duplicate', note: serialize(existing, audioRow(db, user.id, change.id)) }
  }

  return { status: 'conflict', server: serialize(existing, audioRow(db, user.id, change.id)) }
}

function afterCommit(paths) {
  for (const path of paths) {
    try {
      removeFile(path)
    } catch {
      // An orphaned file wastes space but never blocks the caller; the next
      // upload to the same note overwrites it.
    }
  }
}

function clampLimit(raw, fallback = 200) {
  const value = Math.trunc(Number(raw))
  if (!Number.isFinite(value)) return fallback
  return Math.min(500, Math.max(1, value))
}

export function registerNoteRoutes(router) {
  /** Incremental pull: every note whose `seq` is above the cursor. */
  router.get('/api/v1/notes', async (ctx) => {
    const user = requireUser(ctx)
    const limit = clampLimit(ctx.query.get('limit') ?? undefined)
    let since = Math.max(0, Math.trunc(Number(ctx.query.get('since') ?? 0)) || 0)
    const highest = Number(
      ctx.db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM notes WHERE user_id = ?').get(user.id)?.n ?? 0
    )
    // A cursor above anything the server ever handed out means the client comes
    // from another install (or a restored backup). Restarting at zero is the only
    // reading that does not leave it permanently empty.
    if (since > highest) since = 0
    const rows = ctx.db
      .prepare(
        `SELECT n.*, a.bytes AS a_bytes, a.format AS a_format, a.sha256 AS a_sha256
           FROM notes n
           LEFT JOIN note_audio a ON a.note_id = n.id AND a.user_id = n.user_id
          WHERE n.user_id = ? AND n.seq > ?
          ORDER BY n.seq ASC
          LIMIT ?`
      )
      .all(user.id, since, limit)
    const notes = rows.map((row) =>
      serialize(
        row,
        row.a_bytes === null || row.a_bytes === undefined
          ? null
          : { bytes: row.a_bytes, format: row.a_format, sha256: row.a_sha256 }
      )
    )
    const cursor = rows.length > 0 ? Number(rows[rows.length - 1].seq) : since
    return { cursor, notes, hasMore: rows.length === limit, serverTime: ctx.now }
  })

  router.get('/api/v1/notes/:id', async (ctx) => {
    const user = requireUser(ctx)
    const id = noteId(ctx.params.id)
    const note = readNote(ctx.db, user.id, id)
    if (!note) throw new HttpError(404, 'note_not_found', '没有这条随记')
    return { note }
  })

  /** Batch push. Applied changes are committed even when another one conflicts. */
  router.post('/api/v1/notes/changes', async (ctx) => {
    const user = requireUser(ctx)
    const body = ctx.body
    if (!Array.isArray(body.changes)) throw new HttpError(400, 'bad_request', '缺少 changes 数组')
    if (body.changes.length > MAX_PUSH) {
      throw new HttpError(413, 'too_many_changes', `一次最多提交 ${MAX_PUSH} 条变更`)
    }
    const changes = body.changes.map(parseChange)

    const applied = []
    const conflicts = []
    const duplicates = []
    const removePaths = []
    ctx.db.exec('BEGIN')
    try {
      for (const change of changes) {
        const result = applyChange(ctx, user, change)
        if (result.status === 'applied') {
          applied.push(change.id)
          if (result.removePaths) removePaths.push(...result.removePaths)
        } else if (result.status === 'duplicate') {
          duplicates.push(change.id)
        } else if (result.status === 'id_taken') {
          conflicts.push({ id: change.id, server: null, error: 'note_id_taken' })
        } else {
          conflicts.push({ id: change.id, server: result.server })
        }
      }
      ctx.db.exec('COMMIT')
    } catch (error) {
      ctx.db.exec('ROLLBACK')
      throw error
    }
    afterCommit(removePaths)
    const cursor = lastSeq(ctx.db)
    if (conflicts.length > 0) {
      return ctx.reply(409, {
        error: 'conflict',
        message: '这些随记在服务器上已经被改过，请先合并',
        applied,
        duplicates,
        conflicts,
        cursor
      })
    }
    return { applied, duplicates, conflicts: [], cursor, serverTime: ctx.now }
  })

  /** Single-note update, same optimistic check as the batch endpoint. */
  router.put('/api/v1/notes/:id', async (ctx) => {
    const user = requireUser(ctx)
    const id = noteId(ctx.params.id)
    const body = ctx.body
    const change = parseChange({ ...body, id }, 0)

    let result
    ctx.db.exec('BEGIN')
    try {
      result = applyChange(ctx, user, change)
      ctx.db.exec('COMMIT')
    } catch (error) {
      ctx.db.exec('ROLLBACK')
      throw error
    }
    if (result.removePaths) afterCommit(result.removePaths)
    if (result.status === 'id_taken') {
      return ctx.reply(409, {
        error: 'note_id_taken',
        message: '这个随记 ID 已被占用，请换一个'
      })
    }
    if (result.status === 'conflict') {
      return ctx.reply(409, {
        error: 'conflict',
        message: '这条随记在服务器上已经被改过，请先合并',
        server: result.server
      })
    }
    return { note: result.note, duplicate: result.status === 'duplicate', serverTime: ctx.now }
  })

  router.delete('/api/v1/notes/:id', async (ctx) => {
    const user = requireUser(ctx)
    const id = noteId(ctx.params.id)
    const rawVersion = ctx.query.get('version')
    const version = Math.trunc(Number(rawVersion))
    if (rawVersion === null || rawVersion === '' || !Number.isFinite(version) || version < 0) {
      throw new HttpError(400, 'version_required', '删除随记需要带上 version，避免覆盖别处的修改')
    }
    const existing = ctx.db.prepare('SELECT * FROM notes WHERE id = ? AND user_id = ?').get(id, user.id)
    if (!existing) return { ok: true, deleted: true, alreadyGone: true }
    const change = parseChange(
      {
        id,
        version,
        deleted: true,
        createdAt: Number(existing.created_at),
        updatedAt: ctx.now,
        durationMs: Number(existing.duration_ms)
      },
      0
    )
    let result
    ctx.db.exec('BEGIN')
    try {
      result = applyChange(ctx, user, change)
      ctx.db.exec('COMMIT')
    } catch (error) {
      ctx.db.exec('ROLLBACK')
      throw error
    }
    if (result.removePaths) afterCommit(result.removePaths)
    if (result.status === 'conflict') {
      return ctx.reply(409, {
        error: 'conflict',
        message: '这条随记在服务器上已经被改过，请先合并',
        server: result.server
      })
    }
    return { ok: true, deleted: true, version: result.note?.version ?? version + 1 }
  })

  /* --------------------------------- audio -------------------------------- */

  /**
   * Stores one recording. The note must already exist, so a stray upload cannot
   * create a row that the sync protocol would then have to explain.
   *
   * Order: stream to a temp file → check quota → rename over the old file →
   * upsert the metadata row in a transaction. A rejected upload removes only its
   * temp file and leaves the previous recording in place.
   */
  router.put('/api/v1/notes/:id/audio', async (ctx) => {
    const user = requireUser(ctx)
    const id = noteId(ctx.params.id)
    const note = ctx.db.prepare('SELECT deleted FROM notes WHERE id = ? AND user_id = ?').get(id, user.id)
    if (!note || Number(note.deleted) === 1) throw new HttpError(404, 'note_not_found', '没有这条随记')

    const format = normalizeAudioFormat(ctx.query.get('format') ?? ctx.req.headers['content-type'])
    if (!format) {
      throw new HttpError(415, 'unsupported_media_type', '只接受 Ogg Opus 或 WAV 音频')
    }
    const declared = Number(ctx.req.headers['content-length'])
    if (Number.isFinite(declared) && declared > ctx.config.maxAudioUploadBytes) {
      throw new HttpError(
        413,
        'audio_too_large',
        `单个音频不能超过 ${Math.round(ctx.config.maxAudioUploadBytes / (1024 * 1024))} MB`
      )
    }

    const target = noteAudioPath(ctx.config, user.id, id, format)
    const existing = audioRow(ctx.db, user.id, id)
    const { temp, bytes, sha256 } = await receiveToTemp(ctx.req, target, ctx.config.maxAudioUploadBytes)
    if (bytes === 0) {
      removeFile(temp)
      throw new HttpError(400, 'empty_audio', '音频是空的')
    }

    const quota = quotaBytesFor(user, ctx.config)
    const used = usageBytes(ctx.db, user.id) - Number(existing?.bytes ?? 0)
    if (used + bytes > quota) {
      removeFile(temp)
      throw new HttpError(
        413,
        'quota_exceeded',
        `存储空间不够：已用 ${Math.round(used / 1024)} KB，配额 ${Math.round(quota / (1024 * 1024))} MB`
      )
    }

    ctx.db.exec('BEGIN')
    try {
      ctx.db
        .prepare(
          `INSERT INTO note_audio (note_id, user_id, bytes, format, sha256, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(note_id) DO UPDATE SET
             bytes = excluded.bytes, format = excluded.format,
             sha256 = excluded.sha256, created_at = excluded.created_at`
        )
        .run(id, user.id, bytes, format, sha256, ctx.now)
      commitUpload(temp, target)
      // The note's text is unchanged, but the recording is what other devices
      // are missing. They only learn about it through the note's seq, so the
      // bump belongs inside this transaction.
      const seq = bumpCounter(ctx.db, 'notes_seq')
      ctx.db
        .prepare('UPDATE notes SET seq = ?, server_updated_at = ? WHERE id = ? AND user_id = ?')
        .run(seq, ctx.now, id, user.id)
      ctx.db.exec('COMMIT')
    } catch (error) {
      ctx.db.exec('ROLLBACK')
      removeFile(temp)
      throw error
    }
    // A format change leaves the previous extension behind; drop it so the
    // directory cannot accumulate two copies of the same note.
    if (existing && existing.format !== format) {
      afterCommit([noteAudioPath(ctx.config, user.id, id, existing.format)])
    }
    return { ok: true, noteId: id, bytes, format, sha256 }
  })

  router.get('/api/v1/notes/:id/audio', async (ctx) => {
    const user = requireUser(ctx)
    const id = noteId(ctx.params.id)
    const note = ctx.db.prepare('SELECT deleted FROM notes WHERE id = ? AND user_id = ?').get(id, user.id)
    if (!note || Number(note.deleted) === 1) throw new HttpError(404, 'note_not_found', '没有这条随记')
    const audio = audioRow(ctx.db, user.id, id)
    if (!audio) throw new HttpError(404, 'audio_not_found', '这条随记没有音频文件')
    sendAudio(ctx.res, noteAudioPath(ctx.config, user.id, id, audio.format), audio, ctx.req.method)
    return undefined
  })

  router.delete('/api/v1/notes/:id/audio', async (ctx) => {
    const user = requireUser(ctx)
    const id = noteId(ctx.params.id)
    const audio = audioRow(ctx.db, user.id, id)
    ctx.db.prepare('DELETE FROM note_audio WHERE note_id = ? AND user_id = ?').run(id, user.id)
    if (audio) {
      const seq = bumpCounter(ctx.db, 'notes_seq')
      ctx.db
        .prepare('UPDATE notes SET seq = ?, server_updated_at = ? WHERE id = ? AND user_id = ?')
        .run(seq, ctx.now, id, user.id)
      afterCommit([noteAudioPath(ctx.config, user.id, id, audio.format)])
    }
    return { ok: true, removed: Boolean(audio) }
  })
}
