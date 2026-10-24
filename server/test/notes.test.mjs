import assert from 'node:assert/strict'
import test from 'node:test'
import { register, startMailServer, startServer } from './helpers.mjs'

function note(overrides = {}) {
  const now = Date.now()
  return {
    id: 'note-1',
    createdAt: now,
    updatedAt: now,
    durationMs: 1200,
    transcript: '原始识别文本',
    polished: '润色后的文本',
    polishStatus: 'ok',
    categoryId: 'cat-work',
    tags: ['工作', '会议'],
    version: 0,
    deleted: false,
    ...overrides
  }
}

async function setup(t) {
  const mail = await startMailServer()
  const app = await startServer({
    smtp: { configured: true, host: '127.0.0.1', port: mail.port },
    smtpConfigured: true
  })
  t.after(async () => {
    await app.close()
    await mail.close()
  })
  const alice = await register(app.call, mail, 'alice@example.com')
  const bob = await register(app.call, mail, 'bob@example.com')
  return { app, alice, bob }
}

test('推送一条新随记并增量拉取', async (t) => {
  const { app, alice } = await setup(t)
  const change = note()

  const push = await app.call('POST', '/api/v1/notes/changes', {
    token: alice.accessToken,
    body: { changes: [change] }
  })
  assert.equal(push.status, 200, JSON.stringify(push.body))
  assert.deepEqual(push.body.applied, ['note-1'])
  assert.ok(push.body.cursor > 0)

  const pull = await app.call('GET', '/api/v1/notes?since=0', { token: alice.accessToken })
  assert.equal(pull.status, 200)
  assert.equal(pull.body.notes.length, 1)
  const stored = pull.body.notes[0]
  assert.equal(stored.id, 'note-1')
  assert.equal(stored.transcript, change.transcript)
  assert.equal(stored.polished, change.polished)
  assert.equal(stored.polishStatus, 'ok')
  assert.equal(stored.categoryId, 'cat-work')
  assert.deepEqual(stored.tags, ['工作', '会议'])
  assert.equal(stored.version, 1)
  assert.equal(stored.deleted, false)
  assert.equal(stored.audio, null)

  const single = await app.call('GET', '/api/v1/notes/note-1', { token: alice.accessToken })
  assert.equal(single.status, 200)
  assert.equal(single.body.note.version, 1)
})

test('重复推送同一条变更是幂等的', async (t) => {
  const { app, alice } = await setup(t)
  const change = note()
  await app.call('POST', '/api/v1/notes/changes', { token: alice.accessToken, body: { changes: [change] } })

  const replay = await app.call('POST', '/api/v1/notes/changes', {
    token: alice.accessToken,
    body: { changes: [change] }
  })
  assert.equal(replay.status, 200, JSON.stringify(replay.body))
  assert.deepEqual(replay.body.applied, [])
  assert.deepEqual(replay.body.duplicates, ['note-1'])

  const stale = await app.call('GET', '/api/v1/notes/note-1', { token: alice.accessToken })
  assert.equal(stale.body.note.version, 1)
})

test('版本冲突不会被静默覆盖', async (t) => {
  const { app, alice } = await setup(t)
  const first = note()
  const pushed = await app.call('POST', '/api/v1/notes/changes', {
    token: alice.accessToken,
    body: { changes: [first] }
  })
  const baseVersion = 1

  // Machine A wins the race.
  const updated = await app.call('POST', '/api/v1/notes/changes', {
    token: alice.accessToken,
    body: {
      changes: [{ ...first, version: baseVersion, updatedAt: first.updatedAt + 10, transcript: 'A 的修改' }]
    }
  })
  assert.equal(updated.status, 200)

  // Machine B still thinks it is at version 1 and pushes different text.
  const conflict = await app.call('POST', '/api/v1/notes/changes', {
    token: alice.accessToken,
    body: {
      changes: [{ ...first, version: baseVersion, updatedAt: first.updatedAt + 20, transcript: 'B 的修改' }]
    }
  })
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body))
  assert.equal(conflict.body.error, 'conflict')
  assert.equal(conflict.body.conflicts.length, 1)
  // The server copy comes back so B can merge without losing either side.
  assert.equal(conflict.body.conflicts[0].server.transcript, 'A 的修改')
  assert.equal(conflict.body.conflicts[0].server.version, 2)

  const after = await app.call('GET', '/api/v1/notes/note-1', { token: alice.accessToken })
  assert.equal(after.body.note.transcript, 'A 的修改')
  assert.equal(after.body.note.version, 2)
})

test('删除需要版本号，删除后留下墓碑并移除音频', async (t) => {
  const { app, alice } = await setup(t)
  const change = note({ id: 'note-del' })
  await app.call('POST', '/api/v1/notes/changes', { token: alice.accessToken, body: { changes: [change] } })
  await app.callBytes('PUT', '/api/v1/notes/note-del/audio?format=ogg', {
    token: alice.accessToken,
    contentType: 'audio/ogg',
    body: Buffer.from('OggS-fake-audio')
  })

  const missingVersion = await app.call('DELETE', '/api/v1/notes/note-del', { token: alice.accessToken })
  assert.equal(missingVersion.status, 400)
  assert.equal(missingVersion.body.error, 'version_required')

  const deleted = await app.call('DELETE', '/api/v1/notes/note-del?version=1', { token: alice.accessToken })
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body))
  assert.equal(deleted.body.deleted, true)

  const pull = await app.call('GET', '/api/v1/notes?since=0', { token: alice.accessToken })
  const tombstone = pull.body.notes.find((item) => item.id === 'note-del')
  assert.equal(tombstone.deleted, true)
  assert.equal(tombstone.transcript, '')
  assert.equal(tombstone.audio, null)
  assert.equal(tombstone.version, 2)

  const audio = await app.callBytes('GET', '/api/v1/notes/note-del/audio', { token: alice.accessToken })
  assert.equal(audio.status, 404)
  const gone = await app.call('DELETE', '/api/v1/notes/missing?version=1', { token: alice.accessToken })
  assert.equal(gone.body.alreadyGone, true)
})

test('账号之间互相看不见随记', async (t) => {
  const { app, alice, bob } = await setup(t)
  await app.call('POST', '/api/v1/notes/changes', {
    token: alice.accessToken,
    body: { changes: [note()] }
  })

  const direct = await app.call('GET', '/api/v1/notes/note-1', { token: bob.accessToken })
  assert.equal(direct.status, 404)

  const pull = await app.call('GET', '/api/v1/notes?since=0', { token: bob.accessToken })
  assert.deepEqual(pull.body.notes, [])

  const steal = await app.call('POST', '/api/v1/notes/changes', {
    token: bob.accessToken,
    body: { changes: [note({ transcript: '偷来的' })] }
  })
  assert.equal(steal.status, 409)
  assert.equal(steal.body.conflicts[0].error, 'note_id_taken')

  const untouched = await app.call('GET', '/api/v1/notes/note-1', { token: alice.accessToken })
  assert.equal(untouched.body.note.transcript, '原始识别文本')
})

test('游标分页与游标越界自愈', async (t) => {
  const { app, alice } = await setup(t)
  const changes = [1, 2, 3].map((index) =>
    note({ id: `page-${index}`, transcript: `第 ${index} 条` })
  )
  await app.call('POST', '/api/v1/notes/changes', { token: alice.accessToken, body: { changes } })

  const first = await app.call('GET', '/api/v1/notes?since=0&limit=2', { token: alice.accessToken })
  assert.equal(first.body.notes.length, 2)
  assert.equal(first.body.hasMore, true)

  const second = await app.call(
    'GET',
    `/api/v1/notes?since=${first.body.cursor}&limit=2`,
    { token: alice.accessToken }
  )
  assert.equal(second.body.notes.length, 1)
  assert.equal(second.body.hasMore, false)
  assert.deepEqual(
    [...first.body.notes, ...second.body.notes].map((item) => item.id),
    ['page-1', 'page-2', 'page-3']
  )

  // A cursor from a wiped or foreign install restarts instead of hiding everything.
  const stale = await app.call('GET', '/api/v1/notes?since=999999', { token: alice.accessToken })
  assert.equal(stale.body.notes.length, 3)
})

test('不合法的输入被明确拒绝', async (t) => {
  const { app, alice } = await setup(t)

  const badId = await app.call('POST', '/api/v1/notes/changes', {
    token: alice.accessToken,
    body: { changes: [note({ id: '../escape' })] }
  })
  assert.equal(badId.status, 400)
  assert.equal(badId.body.error, 'bad_note_id')

  const badBody = await app.call('POST', '/api/v1/notes/changes', {
    token: alice.accessToken,
    body: { changes: 'nope' }
  })
  assert.equal(badBody.status, 400)

  const tooLong = await app.call('POST', '/api/v1/notes/changes', {
    token: alice.accessToken,
    body: { changes: [note({ transcript: 'x'.repeat(200_001) })] }
  })
  assert.equal(tooLong.status, 400)

  const noAuth = await app.call('GET', '/api/v1/notes?since=0')
  assert.equal(noAuth.status, 401)
})

test('标签与分类按客户端规则裁剪', async (t) => {
  const { app, alice } = await setup(t)
  const tags = ['  工作  ', '工作', '', 'x'.repeat(80), '生活']
  const push = await app.call('POST', '/api/v1/notes/changes', {
    token: alice.accessToken,
    body: { changes: [note({ tags, categoryId: 'unknown-category' })] }
  })
  assert.equal(push.status, 200)
  const pull = await app.call('GET', '/api/v1/notes/note-1', { token: alice.accessToken })
  // The server keeps what the client called the category; reconciling it against
  // the category list is the client's job.
  assert.equal(pull.body.note.categoryId, 'unknown-category')
  assert.deepEqual(pull.body.note.tags, ['工作', 'x'.repeat(64), '生活'])
})


test('随记标题兼容旧客户端，支持重命名和显式清空', async t => {
  const {app,alice}=await setup(t)
  const call=change=>app.call('POST','/api/v1/notes/changes',{token:alice.accessToken,body:{changes:[change]}})
  const get=async()=>(await app.call('GET','/api/v1/notes/note-1',{token:alice.accessToken})).body.note
  const original=note({title:'Project plan'})
  assert.equal((await call(original)).status,200)
  assert.equal((await get()).title,'Project plan')
  const legacy={...original,version:1,transcript:'Legacy edit'};delete legacy.title
  await call(legacy);assert.equal((await get()).title,'Project plan')
  await call({...legacy,version:2,title:'新标题'});assert.equal((await get()).title,'新标题')
  await call({...legacy,version:3,title:''});assert.equal((await get()).title,'')
})
