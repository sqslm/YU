import assert from 'node:assert/strict'
import test from 'node:test'
import { register, startMailServer, startServer } from './helpers.mjs'

function event(overrides = {}) {
  const now = Date.now()
  return {
    id: 'evt-1',
    title: '周会',
    start: now + 60_000,
    end: now + 3_600_000,
    allDay: false,
    location: '会议室 A',
    notes: '带上周报',
    leadMinutes: 10,
    source: 'manual',
    uid: 'uid-1@example.com',
    status: 'confirmed',
    updatedAt: now,
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

test('推送新日程后按 seq 增量拉取', async (t) => {
  const { app, alice } = await setup(t)
  const change = event()

  const push = await app.call('POST', '/api/v1/calendar', {
    token: alice.accessToken,
    body: { changes: [change] }
  })
  assert.equal(push.status, 200, JSON.stringify(push.body))
  assert.deepEqual(push.body.applied, ['evt-1'])
  assert.ok(push.body.cursor > 0)

  const pull = await app.call('GET', '/api/v1/calendar?since=0', { token: alice.accessToken })
  assert.equal(pull.status, 200)
  assert.equal(pull.body.events.length, 1)
  const stored = pull.body.events[0]
  assert.equal(stored.id, 'evt-1')
  assert.equal(stored.title, '周会')
  assert.equal(stored.start, change.start)
  assert.equal(stored.end, change.end)
  assert.equal(stored.allDay, false)
  assert.equal(stored.location, '会议室 A')
  assert.equal(stored.notes, '带上周报')
  assert.equal(stored.leadMinutes, 10)
  assert.equal(stored.source, 'manual')
  assert.equal(stored.uid, 'uid-1@example.com')
  assert.equal(stored.status, 'confirmed')
  assert.equal(stored.deleted, false)
  assert.equal(pull.body.cursor, push.body.cursor)

  // The `changes` alias answers the same thing, so a client can use either.
  const alias = await app.call('GET', '/api/v1/calendar/changes?since=0', { token: alice.accessToken })
  assert.equal(alias.status, 200)
  assert.deepEqual(alias.body.events, pull.body.events)
})

test('重复推送同样内容不推进游标', async (t) => {
  const { app, alice } = await setup(t)
  const change = event()
  const first = await app.call('POST', '/api/v1/calendar', {
    token: alice.accessToken,
    body: { changes: [change] }
  })
  const cursor = first.body.cursor

  const replay = await app.call('POST', '/api/v1/calendar', {
    token: alice.accessToken,
    body: { changes: [change] }
  })
  assert.equal(replay.status, 200, JSON.stringify(replay.body))
  assert.deepEqual(replay.body.applied, [])
  assert.deepEqual(replay.body.duplicates, ['evt-1'])
  assert.equal(replay.body.cursor, cursor)
})

test('修改内容会递增 seq 并被游标之后的拉取看到', async (t) => {
  const { app, alice } = await setup(t)
  const first = await app.call('POST', '/api/v1/calendar', {
    token: alice.accessToken,
    body: { changes: [event()] }
  })
  const cursor = first.body.cursor

  const stale = await app.call('GET', `/api/v1/calendar?since=${cursor}`, { token: alice.accessToken })
  assert.equal(stale.body.events.length, 0)

  const second = await app.call('POST', '/api/v1/calendar', {
    token: alice.accessToken,
    body: { changes: [event({ title: '周会（改期）', updatedAt: Date.now() + 1 })] }
  })
  assert.equal(second.status, 200)
  assert.ok(second.body.cursor > cursor)

  const delta = await app.call('GET', `/api/v1/calendar?since=${cursor}`, { token: alice.accessToken })
  assert.equal(delta.body.events.length, 1)
  assert.equal(delta.body.events[0].title, '周会（改期）')
  assert.equal(delta.body.cursor, second.body.cursor)
})

test('删除是 tombstone：内容被清空且游标推进', async (t) => {
  const { app, alice } = await setup(t)
  const first = await app.call('POST', '/api/v1/calendar', {
    token: alice.accessToken,
    body: { changes: [event()] }
  })
  const cursor = first.body.cursor

  const remove = await app.call('POST', '/api/v1/calendar', {
    token: alice.accessToken,
    body: { changes: [{ id: 'evt-1', updatedAt: Date.now() + 5, deletedAt: Date.now() + 5 }] }
  })
  assert.equal(remove.status, 200, JSON.stringify(remove.body))
  assert.deepEqual(remove.body.applied, ['evt-1'])
  assert.ok(remove.body.cursor > cursor)

  const delta = await app.call('GET', `/api/v1/calendar?since=${cursor}`, { token: alice.accessToken })
  assert.equal(delta.body.events.length, 1)
  const tomb = delta.body.events[0]
  assert.equal(tomb.id, 'evt-1')
  assert.equal(tomb.deleted, true)
  assert.ok(tomb.deletedAt > 0)
  // A retracted row must not keep its content, otherwise every other device
  // would resurrect it on the next push.
  assert.equal(tomb.title, '')
  assert.equal(tomb.notes, null)
  assert.equal(tomb.location, null)
  assert.equal(tomb.leadMinutes, null)
  assert.equal(tomb.uid, null)

  const after = await app.call('GET', `/api/v1/calendar?since=${delta.body.cursor}`, { token: alice.accessToken })
  assert.equal(after.body.events.length, 0)
})

test('游标只会往前：超过最高 seq 时从头开始', async (t) => {
  const { app, alice } = await setup(t)
  await app.call('POST', '/api/v1/calendar', {
    token: alice.accessToken,
    body: { changes: [event()] }
  })

  const pull = await app.call('GET', '/api/v1/calendar?since=999999', { token: alice.accessToken })
  assert.equal(pull.status, 200)
  assert.equal(pull.body.events.length, 1)
  assert.equal(pull.body.cursor, 1)
})

test('limit 与 hasMore 支持分页', async (t) => {
  const { app, alice } = await setup(t)
  const now = Date.now()
  const changes = [1, 2, 3].map((n) => event({ id: `evt-${n}`, title: `日程 ${n}`, start: now + n * 60_000 }))
  await app.call('POST', '/api/v1/calendar', { token: alice.accessToken, body: { changes } })

  const page1 = await app.call('GET', '/api/v1/calendar?since=0&limit=2', { token: alice.accessToken })
  assert.equal(page1.body.events.length, 2)
  assert.equal(page1.body.hasMore, true)
  const page2 = await app.call('GET', `/api/v1/calendar?since=${page1.body.cursor}&limit=2`, { token: alice.accessToken })
  assert.equal(page2.body.events.length, 1)
  assert.equal(page2.body.hasMore, false)
  assert.deepEqual(page2.body.events.map((row) => row.id), ['evt-3'])
})

test('不同账号的数据互相隔离', async (t) => {
  const { app, alice, bob } = await setup(t)
  await app.call('POST', '/api/v1/calendar', { token: alice.accessToken, body: { changes: [event()] } })

  const bobPull = await app.call('GET', '/api/v1/calendar?since=0', { token: bob.accessToken })
  assert.equal(bobPull.status, 200)
  assert.deepEqual(bobPull.body.events, [])
  assert.equal(bobPull.body.cursor, 0)

  // Bob may not overwrite Alice's row either. (Same id is refused as a conflict.)
  const clash = await app.call('POST', '/api/v1/calendar', { token: bob.accessToken, body: { changes: [event()] } })
  assert.equal(clash.status, 409)
  assert.deepEqual(clash.body.conflicts, [{ id: 'evt-1', error: 'calendar_id_taken' }])
})

test('日程接口的鉴权、方法与体积限制', async (t) => {
  const { app, alice } = await setup(t)

  const anonymous = await app.call('GET', '/api/v1/calendar?since=0')
  assert.equal(anonymous.status, 401)

  const wrongVerb = await app.call('PUT', '/api/v1/calendar', { token: alice.accessToken, body: {} })
  assert.equal(wrongVerb.status, 405)
  assert.equal(wrongVerb.body.error, 'method_not_allowed')

  const unknown = await app.call('GET', '/api/v1/calendar/nope', { token: alice.accessToken })
  assert.equal(unknown.status, 404)

  const tooMany = await app.call('POST', '/api/v1/calendar', {
    token: alice.accessToken,
    body: { changes: Array.from({ length: 201 }, (_, i) => event({ id: `evt-${i}` })) }
  })
  assert.equal(tooMany.status, 413)
  assert.equal(tooMany.body.error, 'too_many_changes')

  const badId = await app.call('POST', '/api/v1/calendar', {
    token: alice.accessToken,
    body: { changes: [event({ id: '../etc/passwd' })] }
  })
  assert.equal(badId.status, 400)
  assert.equal(badId.body.error, 'bad_calendar_id')

  const badTitle = await app.call('POST', '/api/v1/calendar', {
    token: alice.accessToken,
    body: { changes: [event({ title: 'x'.repeat(201) })] }
  })
  assert.equal(badTitle.status, 400)

  const notObject = await app.call('POST', '/api/v1/calendar', {
    token: alice.accessToken,
    body: { changes: ['evt-1'] }
  })
  assert.equal(notObject.status, 400)

  const empty = await app.call('POST', '/api/v1/calendar', { token: alice.accessToken, body: { changes: [] } })
  assert.equal(empty.status, 400)
})

test('单条对象与 changes 数组等价', async (t) => {
  const { app, alice } = await setup(t)
  const push = await app.call('POST', '/api/v1/calendar', { token: alice.accessToken, body: event({ id: 'evt-single' }) })
  assert.equal(push.status, 200, JSON.stringify(push.body))
  assert.deepEqual(push.body.applied, ['evt-single'])
  assert.equal(push.body.events[0].id, 'evt-single')
})
