import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { startServer } from './helpers.mjs'
import { issueSession } from '../src/session.mjs'
import { noteAudioPath } from '../src/storage.mjs'

async function fixture(t) {
  const s = await startServer()
  t.after(() => s.close())
  const insert = s.db.prepare(`INSERT INTO users (id,email,password_salt,password_hash,created_at,is_admin) VALUES (?,?, 'salt','hash',?,?)`)
  const admin = { id: randomUUID(), email: 'admin@example.com' }
  const user = { id: randomUUID(), email: 'user@example.com' }
  const other = { id: randomUUID(), email: 'other@example.com' }
  for (const [u, role] of [[admin, 1], [user, 0], [other, 0]]) insert.run(u.id, u.email, Date.now(), role)
  const adminToken = issueSession(s.db, s.config, admin).accessToken
  const userToken = issueSession(s.db, s.config, user).accessToken
  const root = `/api/v1/admin/users/${user.id}`
  const call = (method, url, body, token = adminToken) => s.call(method, url, { token, body })
  return { ...s, admin, user, other, adminToken, userToken, root, request: call }
}

test('admin static assets have strict headers, HEAD works, unknown paths cannot read files', async t => {
  const s = await fixture(t)
  for (const url of ['/admin', '/admin/', '/admin/app.js', '/admin/style.css']) {
    const res = await fetch(s.base + url)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/)
    assert.ok((await res.text()).length > 100)
  }
  const head = await fetch(s.base + '/admin', { method: 'HEAD' })
  assert.equal(head.status, 200); assert.equal(await head.text(), '')
  assert.equal((await fetch(s.base + '/admin/config.mjs')).status, 404)
})

test('all admin data and mutation endpoints reject missing and ordinary user credentials', async t => {
  const s = await fixture(t)
  for (const [method, url] of [['GET','/api/v1/admin/overview'], ['GET','/api/v1/admin/users'], ['GET',s.root], ['PUT',s.root],
    ['GET',s.root+'/notes'], ['GET',s.root+'/history'], ['GET',s.root+'/stats'], ['GET',s.root+'/export'],
    ['DELETE',s.root+'/notes/x'], ['DELETE',s.root+'/history/x'], ['GET',s.root+'/notes/x/audio']]) {
    assert.equal((await s.call(method, url)).status, 401, `${method} ${url}`)
    assert.equal((await s.request(method, url, method === 'GET' ? undefined : {}, s.userToken)).status, 403, `${method} ${url}`)
  }
  s.db.prepare('UPDATE users SET is_admin = 0 WHERE id = ?').run(s.admin.id)
  assert.equal((await s.request('GET', '/api/v1/admin/users')).status, 403)
})

test('account search, pagination, quota and disable revoke sessions without exposing hashes', async t => {
  const s = await fixture(t)
  let response = await s.request('GET', '/api/v1/admin/users?q=user%40')
  assert.equal(response.body.total, 1); assert.equal(response.body.users[0].email, s.user.email)
  assert.equal(JSON.stringify(response.body).includes('password'), false)
  assert.equal((await s.request('GET', '/api/v1/admin/users?page=NaN')).status, 400)
  assert.equal((await s.request('PUT', s.root, { quotaMb: -1 })).status, 400)
  response = await s.request('PUT', s.root, { quotaMb: 2 })
  assert.equal(response.body.user.quotaBytes, 2097152)
  response = await s.request('PUT', s.root, { quotaMb: 0 })
  assert.equal(response.body.user.quotaBytes, s.config.defaultStorageQuotaBytes)
  assert.equal((await s.request('PUT', `/api/v1/admin/users/${s.admin.id}`, { disabled: true })).status, 400)
  assert.equal((await s.request('PUT', s.root, { disabled: true })).status, 200)
  assert.equal((await s.call('GET', '/api/v1/auth/me', { token: s.userToken })).status, 401)
  assert.equal((await s.request('PUT', s.root, { disabled: false })).body.user.disabled, false)
  assert.equal((await s.call('GET', '/api/v1/auth/me', { token: s.userToken })).status, 401)
})

test('notes and audio are scoped to account; optimistic admin deletion produces client tombstones', async t => {
  const s = await fixture(t)
  const pushed = await s.call('POST', '/api/v1/notes/changes', { token: s.userToken, body: { changes: [{ id: 'note-one', version: 0, createdAt: 123, updatedAt: 124, transcript: '<script>alert(1)</script>', title: '会议记录' }] } })
  assert.equal(pushed.status, 200)
  const upload = await s.callBytes('PUT', '/api/v1/notes/note-one/audio?format=wav', { token: s.userToken, body: Buffer.from('RIFFtest'), contentType: 'audio/wav' })
  assert.equal(upload.status, 200)
  const audioFile = noteAudioPath(s.config, s.user.id, 'note-one', 'wav')
  const list = await s.request('GET', s.root + '/notes?q=' + encodeURIComponent('会议'))
  assert.equal(list.body.total, 1); assert.equal(list.body.items[0].title, '会议记录')
  assert.equal((await s.request('GET', `/api/v1/admin/users/${s.other.id}/notes`)).body.total, 0)
  assert.equal((await s.request('GET', `/api/v1/admin/users/${s.other.id}/notes/note-one/audio`)).status, 404)
  const audio = await s.callBytes('GET', s.root + '/notes/note-one/audio', { token: s.adminToken })
  assert.equal(audio.status, 200); assert.equal(audio.buffer.toString(), 'RIFFtest')
  assert.equal((await s.request('DELETE', s.root + '/notes/note-one', { version: 0 })).status, 409)
  assert.equal((await s.request('DELETE', s.root + '/notes/note-one', { version: 1 })).status, 200)
  assert.equal(existsSync(audioFile), false)
  // Fresh pull sees a scrubbed tombstone with an increased version and cursor.
  const fresh = await s.call('GET', '/api/v1/notes', { token: s.userToken })
  assert.equal(fresh.body.notes[0].deleted, true); assert.equal(fresh.body.notes[0].version, 2)
  assert.equal(fresh.body.notes[0].transcript, ''); assert.equal(fresh.body.notes[0].audio, null)
  assert.ok(fresh.body.cursor > pushed.body.cursor)
  assert.equal((await s.request('GET', s.root + '/notes')).body.total, 0)
})

test('history deletion scrubs stored content and advances sync cursor without changing stats', async t => {
  const s = await fixture(t)
  const pushed = await s.call('POST', '/api/v1/transcription_history/push', { token: s.userToken, body: { entries: [{ id: 'history-one', createdAt: 100, updatedAt: Date.now()+1000, original: 'private text' }] } })
  assert.equal(pushed.status, 200)
  const stats = { version: 1, records: 1, days: {}, apps: {} }
  const device = randomUUID()
  await s.call('PUT', '/api/v1/stats/devices/' + device, { token: s.userToken, body: { stats } })
  const row = (await s.request('GET', s.root + '/history')).body.items[0]
  assert.equal((await s.request('DELETE', s.root + '/history/history-one', { updatedAt: 1 })).status, 409)
  assert.equal((await s.request('DELETE', `/api/v1/admin/users/${s.other.id}/history/history-one`, { updatedAt: row.updatedAt })).status, 404)
  assert.equal((await s.request('DELETE', s.root + '/history/history-one', { updatedAt: row.updatedAt })).status, 200)
  const pulled = await s.call('GET', `/api/v1/transcription_history/pull?since=${pushed.body.cursor}`, { token: s.userToken })
  assert.equal(pulled.body.entries[0].deleted, true); assert.ok(pulled.body.entries[0].updatedAt > row.updatedAt)
  assert.equal(s.db.prepare('SELECT payload FROM history WHERE id = ?').get(row.id).payload, '{}')
  assert.equal((await s.request('GET', s.root + '/stats')).body.items[0].stats.records, 1)
})

test('streamed JSON export contains only selected account data and no credentials or deleted content', async t => {
  const s = await fixture(t)
  await s.call('POST', '/api/v1/notes/changes', { token: s.userToken, body: { changes: [{ id: 'export-note', version: 0, createdAt: 123, transcript: 'exported note' }] } })
  await s.call('POST', '/api/v1/transcription_history/push', { token: s.userToken, body: { entries: [{ id: 'export-one', createdAt: 123, original: 'exported text' }] } })
  const exported = await s.request('GET', s.root + '/export')
  assert.equal(exported.status, 200); assert.equal(exported.body.user.email, s.user.email)
  assert.equal(exported.body.history[0].payload.original, 'exported text')
  assert.equal(exported.body.notes[0].transcript, 'exported note')
  assert.equal(JSON.stringify(exported.body).includes('password'), false)
  assert.equal((await s.request('GET', `/api/v1/admin/users/${s.other.id}/export`)).body.history.length, 0)
  assert.match(exported.headers.get('content-disposition'), /attachment/)
})

test('admin data pagination is bounded and deterministic, including empty search results', async t => {
  const s = await fixture(t)
  const entries = Array.from({ length: 35 }, (_, i) => ({ id: `page-${i}`, createdAt: 100 + i, original: 'page check' }))
  await s.call('POST', '/api/v1/transcription_history/push', { token: s.userToken, body: { entries } })
  const first = await s.request('GET', s.root + '/history?page=1')
  const second = await s.request('GET', s.root + '/history?page=2')
  assert.equal(first.body.total, 35); assert.equal(first.body.items.length, 30); assert.equal(second.body.items.length, 5)
  assert.equal(new Set([...first.body.items, ...second.body.items].map(row => row.id)).size, 35)
  assert.equal((await s.request('GET', s.root + '/history?q=missing')).body.total, 0)
})
