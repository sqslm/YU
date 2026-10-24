import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { bumpCounter, lastSeq } from '../db.mjs'
import { HttpError } from '../http.mjs'
import { publicUser, quotaBytesFor, requireUser, revokeAllSessions } from '../session.mjs'
import { noteAudioPath, removeFile, sendAudio, usageBytes } from '../storage.mjs'
import { SERVER_VERSION } from '../version.mjs'
import { readNote } from './notes.mjs'
import { publicSettings, saveSettings } from '../settings.mjs'

function requireAdmin(ctx) {
  const user = requireUser(ctx)
  if (Number(user.is_admin) !== 1) throw new HttpError(403, 'admin_required', '需要管理员权限')
  return user
}

function account(ctx) {
  const user = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.params.userId)
  if (!user) throw new HttpError(404, 'user_not_found', '账号不存在')
  return user
}

function userInfo(ctx, row) {
  const count = table => Number(ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?${table === 'usage_stats' ? '' : ' AND deleted = 0'}`).get(row.id).n)
  return { ...publicUser(row, ctx.now), disabled: Boolean(row.disabled), quotaBytes: quotaBytesFor(row, ctx.config),
    quotaOverrideBytes: Number(row.storage_quota_bytes), usedBytes: usageBytes(ctx.db, row.id),
    notes: count('notes'), history: count('history'), devices: count('usage_stats') }
}

function page(ctx) {
  const number = Number(ctx.query.get('page') ?? 1)
  if (!Number.isSafeInteger(number) || number < 1 || number > 1_000_000) throw new HttpError(400, 'bad_page', '页码不合法')
  return { number, limit: 30, offset: (number - 1) * 30, search: `%${(ctx.query.get('q') ?? '').slice(0, 200)}%` }
}

function historyEntry(row) {
  return { id: row.id, updatedAt: Number(row.updated_at), createdAt: Number(row.created_at), payload: JSON.parse(row.payload) }
}

function transaction(db, action) {
  db.exec('BEGIN')
  try { const result = action(); db.exec('COMMIT'); return result } catch (error) { db.exec('ROLLBACK'); throw error }
}

function audit(ctx, actor, action, user, id = '') {
  ctx.log(`[admin] actor=${actor.id} action=${action} user=${user.id} record=${JSON.stringify(id)}`)
}

export function registerAdminRoutes(router) {
  // A fixed allowlist prevents arbitrary filesystem access. Assets are shipped in src.
  const assets = { '/admin': ['index.html', 'text/html'], '/admin/': ['index.html', 'text/html'],
    '/admin/app.js': ['app.js', 'text/javascript'], '/admin/style.css': ['style.css', 'text/css'] }
  for (const [path, [file, type]] of Object.entries(assets)) {
    const bytes = readFileSync(new URL(`../admin/${file}`, import.meta.url))
    router.get(path, async ctx => {
      ctx.res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'content-length': bytes.length,
        'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src blob:; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" })
      ctx.res.end(ctx.method === 'HEAD' ? undefined : bytes)
    })
  }

  router.get('/api/v1/admin/overview', async ctx => {
    const actor = requireAdmin(ctx)
    const count = (table, condition = '') => Number(ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}${condition}`).get().n)
    return { user: publicUser(actor), version: SERVER_VERSION, accounts: count('users'), notes: count('notes', ' WHERE deleted = 0'),
      history: count('history', ' WHERE deleted = 0'), audioBytes: Number(ctx.db.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM note_audio').get().n) }
  })

  router.get('/api/v1/admin/settings', async ctx => {
    requireAdmin(ctx)
    return publicSettings(ctx)
  })
  router.put('/api/v1/admin/settings', async ctx => {
    const actor = requireAdmin(ctx)
    const result = saveSettings(ctx)
    audit(ctx, actor, 'settings-update', actor)
    return result
  })

  router.get('/api/v1/admin/users', async ctx => {
    requireAdmin(ctx)
    const p = page(ctx)
    const total = Number(ctx.db.prepare('SELECT COUNT(*) AS n FROM users WHERE email LIKE ?').get(p.search).n)
    const users = ctx.db.prepare('SELECT * FROM users WHERE email LIKE ? ORDER BY email LIMIT ? OFFSET ?').all(p.search, p.limit, p.offset)
    return { users: users.map(row => userInfo(ctx, row)), total, page: p.number }
  })

  router.get('/api/v1/admin/users/:userId', async ctx => {
    requireAdmin(ctx)
    return { user: userInfo(ctx, account(ctx)) }
  })

  router.put('/api/v1/admin/users/:userId', async ctx => {
    const actor = requireAdmin(ctx)
    const user = account(ctx)
    const { disabled, quotaMb } = ctx.body
    if (disabled !== undefined && typeof disabled !== 'boolean') throw new HttpError(400, 'bad_account', '停用状态必须为布尔值')
    if (disabled === true && Number(user.is_admin) === 1) throw new HttpError(400, 'admin_protected', '请使用 CLI 管理管理员账号的停用状态')
    if (quotaMb !== undefined && (!Number.isSafeInteger(quotaMb) || quotaMb < 0 || quotaMb > 1_000_000)) throw new HttpError(400, 'bad_quota', '配额应为 0 到 1000000 的整数 MB，0 表示默认')
    transaction(ctx.db, () => {
      if (disabled !== undefined) {
        ctx.db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, user.id)
        if (disabled) revokeAllSessions(ctx.db, user.id, ctx.now)
      }
      if (quotaMb !== undefined) ctx.db.prepare('UPDATE users SET storage_quota_bytes = ? WHERE id = ?').run(quotaMb * 1024 * 1024, user.id)
    })
    audit(ctx, actor, `account-update disabled=${disabled} quotaMb=${quotaMb}`, user)
    return { user: userInfo(ctx, account(ctx)) }
  })

  for (const kind of ['notes', 'history', 'stats']) {
    router.get(`/api/v1/admin/users/:userId/${kind}`, async ctx => {
      requireAdmin(ctx)
      const user = account(ctx)
      const p = page(ctx)
      const table = kind === 'stats' ? 'usage_stats' : kind
      const filter = kind === 'notes' ? ' AND deleted = 0 AND (title LIKE ? OR transcript LIKE ? OR polished LIKE ?)'
        : kind === 'history' ? ' AND deleted = 0 AND payload LIKE ?' : ' AND device_id LIKE ?'
      const args = kind === 'notes' ? [user.id, p.search, p.search, p.search] : [user.id, p.search]
      const total = Number(ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?${filter}`).get(...args).n)
      const rows = ctx.db.prepare(`SELECT * FROM ${table} WHERE user_id = ?${filter} ORDER BY updated_at DESC, ${kind === 'stats' ? 'device_id' : 'id'} LIMIT ? OFFSET ?`).all(...args, p.limit, p.offset)
      const items = rows.map(row => kind === 'notes' ? readNote(ctx.db, user.id, row.id) : kind === 'history' ? historyEntry(row)
        : { id: row.device_id, updatedAt: Number(row.updated_at), stats: JSON.parse(row.payload) })
      return { items, total, page: p.number }
    })
  }

  router.get('/api/v1/admin/users/:userId/notes/:id/audio', async ctx => {
    requireAdmin(ctx)
    const user = account(ctx)
    const note = readNote(ctx.db, user.id, ctx.params.id)
    if (!note || note.deleted || !note.audio) throw new HttpError(404, 'audio_not_found', '没有这条录音')
    ctx.res.setHeader('content-disposition', 'attachment; filename="recording.' + (note.audio.format === 'wav' ? 'wav' : 'ogg') + '"')
    sendAudio(ctx.res, noteAudioPath(ctx.config, user.id, note.id, note.audio.format), note.audio, ctx.method)
  })

  router.delete('/api/v1/admin/users/:userId/notes/:id', async ctx => {
    const actor = requireAdmin(ctx)
    const user = account(ctx)
    const note = readNote(ctx.db, user.id, ctx.params.id)
    if (!note || note.deleted) throw new HttpError(404, 'note_not_found', '随记不存在')
    if (ctx.body.version !== note.version) throw new HttpError(409, 'conflict', '记录已更新，请刷新后重试')
    // Remove the recording before yielding; uploads cannot interleave with this synchronous transaction.
    if (note.audio) removeFile(noteAudioPath(ctx.config, user.id, note.id, note.audio.format))
    transaction(ctx.db, () => {
      ctx.db.prepare(`UPDATE notes SET deleted = 1, transcript = '', polished = '', title = '', tags = '[]', category_id = NULL,
        polish_error = NULL, edited_at = NULL, version = version + 1, updated_at = ?, server_updated_at = ?, seq = ? WHERE id = ? AND user_id = ?`)
        .run(Math.max(ctx.now, note.updatedAt + 1), ctx.now, bumpCounter(ctx.db, 'notes_seq'), note.id, user.id)
      ctx.db.prepare('DELETE FROM note_audio WHERE note_id = ? AND user_id = ?').run(note.id, user.id)
    })
    audit(ctx, actor, 'delete-note', user, note.id)
    return { ok: true }
  })

  router.delete('/api/v1/admin/users/:userId/history/:id', async ctx => {
    const actor = requireAdmin(ctx)
    const user = account(ctx)
    const row = ctx.db.prepare('SELECT * FROM history WHERE user_id = ? AND id = ? AND deleted = 0').get(user.id, ctx.params.id)
    if (!row) throw new HttpError(404, 'history_not_found', '历史记录不存在')
    if (ctx.body.updatedAt !== Number(row.updated_at)) throw new HttpError(409, 'conflict', '记录已更新，请刷新后重试')
    transaction(ctx.db, () => {
      ctx.db.prepare("UPDATE history SET deleted = 1, payload = '{}', updated_at = ?, seq = ? WHERE id = ? AND user_id = ?")
        .run(Math.max(ctx.now, Number(row.updated_at) + 1), lastSeq(ctx.db, 'history') + 1, row.id, user.id)
      bumpCounter(ctx.db, 'history_revision')
    })
    audit(ctx, actor, 'delete-history', user, row.id)
    return { ok: true }
  })

  router.get('/api/v1/admin/users/:userId/export', async ctx => {
    const actor = requireAdmin(ctx)
    const user = account(ctx)
    // Iterate rather than loading an entire account into memory. Audio is downloaded separately.
    function* json() {
      yield JSON.stringify({ exportedAt: new Date(ctx.now).toISOString(), user: userInfo(ctx, user) }).slice(0, -1)
      for (const kind of ['notes', 'history', 'stats']) {
        yield `,"${kind}":[`
        const table = kind === 'stats' ? 'usage_stats' : kind
        let first = true
        for (const row of ctx.db.prepare(`SELECT * FROM ${table} WHERE user_id = ?${kind === 'stats' ? '' : ' AND deleted = 0'}`).iterate(user.id)) {
          if (!first) yield ','
          first = false
          yield JSON.stringify(kind === 'notes' ? readNote(ctx.db, user.id, row.id) : kind === 'history' ? historyEntry(row)
            : { deviceId: row.device_id, updatedAt: Number(row.updated_at), stats: JSON.parse(row.payload) })
        }
        yield ']'
      }
      yield '}'
    }
    ctx.res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
      'content-disposition': 'attachment; filename="yu-cloud-export.json"' })
    await pipeline(Readable.from(json()), ctx.res)
    audit(ctx, actor, 'export', user)
  })
}
