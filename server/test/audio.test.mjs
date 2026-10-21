import assert from 'node:assert/strict'
import test from 'node:test'
import { register, startMailServer, startServer } from './helpers.mjs'

const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(600, 7)])

async function setup(t, overrides = {}) {
  const mail = await startMailServer()
  const app = await startServer({
    smtp: { configured: true, host: '127.0.0.1', port: mail.port },
    smtpConfigured: true,
    maxAudioUploadBytes: 1024,
    defaultStorageQuotaBytes: 1024,
    ...overrides
  })
  t.after(async () => {
    await app.close()
    await mail.close()
  })
  const alice = await register(app.call, mail, 'alice@example.com')
  const bob = await register(app.call, mail, 'bob@example.com')
  return { app, alice, bob }
}

function note(id) {
  const now = Date.now()
  return {
    id,
    createdAt: now,
    updatedAt: now,
    durationMs: 900,
    transcript: '录音',
    polished: '',
    polishStatus: 'skipped',
    tags: [],
    version: 0,
    deleted: false
  }
}

test('上传、下载与元数据一致', async (t) => {
  const { app, alice } = await setup(t)
  await app.call('POST', '/api/v1/notes/changes', {
    token: alice.accessToken,
    body: { changes: [note('a1')] }
  })

  const upload = await app.callBytes('PUT', '/api/v1/notes/a1/audio?format=ogg', {
    token: alice.accessToken,
    contentType: 'audio/ogg',
    body: OGG
  })
  assert.equal(upload.status, 200, upload.buffer.toString())
  const meta = JSON.parse(upload.buffer.toString())
  assert.equal(meta.bytes, OGG.length)
  assert.equal(meta.format, 'ogg')

  const noteAfter = await app.call('GET', '/api/v1/notes/a1', { token: alice.accessToken })
  assert.equal(noteAfter.body.note.audio.bytes, OGG.length)
  assert.equal(noteAfter.body.note.audio.sha256, meta.sha256)

  const download = await app.callBytes('GET', '/api/v1/notes/a1/audio', { token: alice.accessToken })
  assert.equal(download.status, 200)
  assert.equal(download.headers.get('content-type'), 'audio/ogg')
  assert.equal(Number(download.headers.get('content-length')), OGG.length)
  assert.ok(download.buffer.equals(OGG))

  const head = await app.callBytes('HEAD', '/api/v1/notes/a1/audio', {
    token: alice.accessToken,
    contentType: null
  })
  assert.equal(head.status, 200)
  assert.equal(Number(head.headers.get('content-length')), OGG.length)
  assert.equal(head.buffer.length, 0)

  const storage = await app.call('GET', '/api/v1/user/storage', { token: alice.accessToken })
  assert.equal(storage.body.usedBytes, OGG.length)
  assert.equal(storage.body.audioCount, 1)
  assert.equal(storage.body.quotaBytes, 1024)
})

test('超出单文件上限与总配额都被拒绝，旧文件保留', async (t) => {
  const { app, alice } = await setup(t)
  await app.call('POST', '/api/v1/notes/changes', {
    token: alice.accessToken,
    body: { changes: [note('q1'), note('q2')] }
  })

  const first = await app.callBytes('PUT', '/api/v1/notes/q1/audio?format=ogg', {
    token: alice.accessToken,
    contentType: 'audio/ogg',
    body: OGG
  })
  assert.equal(first.status, 200)

  const tooBig = await app.callBytes('PUT', '/api/v1/notes/q2/audio?format=ogg', {
    token: alice.accessToken,
    contentType: 'audio/ogg',
    body: Buffer.concat([Buffer.from('OggS'), Buffer.alloc(2000, 1)])
  })
  assert.equal(tooBig.status, 413)
  assert.equal(JSON.parse(tooBig.buffer.toString()).error, 'audio_too_large')

  const quota = await app.callBytes('PUT', '/api/v1/notes/q2/audio?format=ogg', {
    token: alice.accessToken,
    contentType: 'audio/ogg',
    body: Buffer.concat([Buffer.from('OggS'), Buffer.alloc(600, 2)])
  })
  assert.equal(quota.status, 413)
  assert.equal(JSON.parse(quota.buffer.toString()).error, 'quota_exceeded')

  const intact = await app.callBytes('GET', '/api/v1/notes/q1/audio', { token: alice.accessToken })
  assert.equal(intact.status, 200)
  assert.ok(intact.buffer.equals(OGG))

  const nothing = await app.call('GET', '/api/v1/notes/q2', { token: alice.accessToken })
  assert.equal(nothing.body.note.audio, null)
})

test('替换同名音频时旧文件被覆盖而不是叠加', async (t) => {
  const { app, alice } = await setup(t, { defaultStorageQuotaBytes: 10_000 })
  await app.call('POST', '/api/v1/notes/changes', {
    token: alice.accessToken,
    body: { changes: [note('r1')] }
  })
  await app.callBytes('PUT', '/api/v1/notes/r1/audio?format=ogg', {
    token: alice.accessToken,
    contentType: 'audio/ogg',
    body: OGG
  })
  const shorter = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(100, 9)])
  const again = await app.callBytes('PUT', '/api/v1/notes/r1/audio?format=ogg', {
    token: alice.accessToken,
    contentType: 'audio/ogg',
    body: shorter
  })
  assert.equal(again.status, 200)
  const storage = await app.call('GET', '/api/v1/user/storage', { token: alice.accessToken })
  assert.equal(storage.body.usedBytes, shorter.length)

  const download = await app.callBytes('GET', '/api/v1/notes/r1/audio', { token: alice.accessToken })
  assert.ok(download.buffer.equals(shorter))
})

test('音频接口的鉴权、格式与目标校验', async (t) => {
  const { app, alice, bob } = await setup(t)
  await app.call('POST', '/api/v1/notes/changes', {
    token: alice.accessToken,
    body: { changes: [note('s1')] }
  })

  const wrongFormat = await app.callBytes('PUT', '/api/v1/notes/s1/audio?format=mp3', {
    token: alice.accessToken,
    contentType: 'audio/mpeg',
    body: OGG
  })
  assert.equal(wrongFormat.status, 415)

  const missing = await app.callBytes('PUT', '/api/v1/notes/nope/audio?format=ogg', {
    token: alice.accessToken,
    contentType: 'audio/ogg',
    body: OGG
  })
  assert.equal(missing.status, 404)

  const traversal = await app.callBytes('PUT', '/api/v1/notes/..%2F..%2Fescape/audio?format=ogg', {
    token: alice.accessToken,
    contentType: 'audio/ogg',
    body: OGG
  })
  assert.ok([400, 404].includes(traversal.status), String(traversal.status))

  const anonymous = await app.callBytes('PUT', '/api/v1/notes/s1/audio?format=ogg', { body: OGG })
  assert.equal(anonymous.status, 401)

  await app.callBytes('PUT', '/api/v1/notes/s1/audio?format=ogg', {
    token: alice.accessToken,
    contentType: 'audio/ogg',
    body: OGG
  })
  const crossUser = await app.callBytes('GET', '/api/v1/notes/s1/audio', { token: bob.accessToken })
  assert.equal(crossUser.status, 404)
})

test('删除随记会连带删除音频文件', async (t) => {
  const { app, alice } = await setup(t)
  await app.call('POST', '/api/v1/notes/changes', {
    token: alice.accessToken,
    body: { changes: [note('d1')] }
  })
  await app.callBytes('PUT', '/api/v1/notes/d1/audio?format=ogg', {
    token: alice.accessToken,
    contentType: 'audio/ogg',
    body: OGG
  })
  const deleted = await app.call('DELETE', '/api/v1/notes/d1?version=1', { token: alice.accessToken })
  assert.equal(deleted.status, 200)

  const storage = await app.call('GET', '/api/v1/user/storage', { token: alice.accessToken })
  assert.equal(storage.body.usedBytes, 0)

  // Recreating the id must not resurrect the old recording.
  await app.call('POST', '/api/v1/notes/changes', {
    token: alice.accessToken,
    body: { changes: [note('d1')] }
  })
  const audio = await app.callBytes('GET', '/api/v1/notes/d1/audio', { token: alice.accessToken })
  assert.equal(audio.status, 404)
})

test('录音晚于文字上传时仍能通过增量游标发现，删除录音也推进游标', async (t) => {
  const { app, alice } = await setup(t)
  const token = alice.accessToken
  await app.call('POST', '/api/v1/notes/changes', { token, body: { changes: [note('late-audio')] } })
  const first = await app.call('GET', '/api/v1/notes?since=0', { token })
  await app.callBytes('PUT', '/api/v1/notes/late-audio/audio?format=ogg', { token, contentType: 'audio/ogg', body: OGG })
  const uploaded = await app.call('GET', `/api/v1/notes?since=${first.body.cursor}`, { token })
  assert.equal(uploaded.body.notes.length, 1)
  assert.equal(uploaded.body.notes[0].audio.bytes, OGG.length)
  await app.call('DELETE', '/api/v1/notes/late-audio/audio', { token })
  const removed = await app.call('GET', `/api/v1/notes?since=${uploaded.body.cursor}`, { token })
  assert.equal(removed.body.notes.length, 1)
  assert.equal(removed.body.notes[0].audio, null)
})

test('空音频被拒绝', async (t) => {
  const { app, alice } = await setup(t)
  await app.call('POST', '/api/v1/notes/changes', {
    token: alice.accessToken,
    body: { changes: [note('e1')] }
  })
  const empty = await app.callBytes('PUT', '/api/v1/notes/e1/audio?format=ogg', {
    token: alice.accessToken,
    contentType: 'audio/ogg',
    body: Buffer.alloc(0)
  })
  assert.equal(empty.status, 400)
  assert.equal(JSON.parse(empty.buffer.toString()).error, 'empty_audio')
})
