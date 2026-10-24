import assert from 'node:assert/strict'
import test from 'node:test'
import { register, startMailServer, startServer } from './helpers.mjs'

function reminder(overrides = {}) {
  const now = Date.now()
  return {
    id: 'rem-1',
    title: '给妈妈打电话',
    dueAt: now + 600_000,
    level: 'normal',
    priority: 'high',
    deadlineAt: now + 3_600_000,
    recurrence: { unit: 'day', interval: 1, timeOfDay: '20:00' },
    status: 'pending',
    updatedAt: now,
    data: { id: 'rem-1', title: '给妈妈打电话', description: '问问体检结果', createdAt: now },
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

test('推送提醒后按 seq 增量拉取，recurrence 与 data 原样往返', async (t) => {
  const { app, alice } = await setup(t)
  const change = reminder()

  const push = await app.call('POST', '/api/v1/reminders', {
    token: alice.accessToken,
    body: { changes: [change] }
  })
  assert.equal(push.status, 200, JSON.stringify(push.body))
  assert.deepEqual(push.body.applied, ['rem-1'])
  assert.ok(push.body.cursor > 0)

  const pull = await app.call('GET', '/api/v1/reminders?since=0', { token: alice.accessToken })
  assert.equal(pull.status, 200)
  assert.equal(pull.body.reminders.length, 1)
  const stored = pull.body.reminders[0]
  assert.equal(stored.id, 'rem-1')
  assert.equal(stored.title, '给妈妈打电话')
  assert.equal(stored.dueAt, change.dueAt)
  assert.equal(stored.level, 'normal')
  assert.equal(stored.priority, 'high')
  assert.equal(stored.deadlineAt, change.deadlineAt)
  assert.deepEqual(stored.recurrence, change.recurrence)
  assert.equal(stored.status, 'pending')
  assert.equal(stored.deleted, false)
  // The client's own document survives verbatim, so a field this server has never
  // heard of still comes back on another device.
  assert.deepEqual(stored.data, change.data)
  assert.equal(pull.body.cursor, push.body.cursor)

  const alias = await app.call('GET', '/api/v1/reminders/changes?since=0', { token: alice.accessToken })
  assert.equal(alias.status, 200)
  assert.deepEqual(alias.body.reminders, pull.body.reminders)
})

test('重复推送同样内容不推进游标，改动则递增', async (t) => {
  const { app, alice } = await setup(t)
  const change = reminder()
  const first = await app.call('POST', '/api/v1/reminders', {
    token: alice.accessToken,
    body: { changes: [change] }
  })

  const replay = await app.call('POST', '/api/v1/reminders', {
    token: alice.accessToken,
    body: { changes: [change] }
  })
  assert.equal(replay.status, 200, JSON.stringify(replay.body))
  assert.deepEqual(replay.body.duplicates, ['rem-1'])
  assert.equal(replay.body.cursor, first.body.cursor)

  const edited = await app.call('POST', '/api/v1/reminders', {
    token: alice.accessToken,
    body: { changes: [reminder({ title: '给妈妈打电话（改）', updatedAt: Date.now() + 1 })] }
  })
  assert.equal(edited.status, 200)
  assert.ok(edited.body.cursor > first.body.cursor)

  const delta = await app.call('GET', `/api/v1/reminders?since=${first.body.cursor}`, { token: alice.accessToken })
  assert.equal(delta.body.reminders.length, 1)
  assert.equal(delta.body.reminders[0].title, '给妈妈打电话（改）')
})

test('推来更旧的提醒时被拒为 stale，不落库也不推进游标', async (t) => {
  const { app, alice } = await setup(t)
  const NEWER = 2_000_000_000_000
  const OLDER = 1_000_000_000_000

  const first = await app.call('POST', '/api/v1/reminders', {
    token: alice.accessToken,
    body: { changes: [reminder({ title: '提醒（新）', updatedAt: NEWER })] }
  })
  assert.deepEqual(first.body.applied, ['rem-1'])
  const cursor = first.body.cursor

  const late = await app.call('POST', '/api/v1/reminders', {
    token: alice.accessToken,
    body: { changes: [reminder({ title: '提醒（旧）', updatedAt: OLDER })] }
  })
  assert.equal(late.status, 200, JSON.stringify(late.body))
  assert.deepEqual(late.body.applied, [])
  assert.deepEqual(late.body.duplicates, [])
  assert.deepEqual(late.body.stale, ['rem-1'])
  assert.equal(late.body.cursor, cursor)

  const pull = await app.call('GET', '/api/v1/reminders?since=0', { token: alice.accessToken })
  assert.equal(pull.body.reminders.length, 1)
  assert.equal(pull.body.reminders[0].title, '提醒（新）')
  assert.equal(Number(pull.body.reminders[0].updatedAt), NEWER)

  const next = await app.call('POST', '/api/v1/reminders', {
    token: alice.accessToken,
    body: { changes: [reminder({ title: '提醒（更新）', updatedAt: NEWER + 1 })] }
  })
  assert.deepEqual(next.body.applied, ['rem-1'])
  assert.ok(next.body.cursor > cursor)
})

test('删除是 tombstone：状态取消、内容清空', async (t) => {
  const { app, alice } = await setup(t)
  const first = await app.call('POST', '/api/v1/reminders', {
    token: alice.accessToken,
    body: { changes: [reminder()] }
  })

  const remove = await app.call('POST', '/api/v1/reminders', {
    token: alice.accessToken,
    body: { changes: [{ id: 'rem-1', updatedAt: Date.now() + 9, deleted: true }] }
  })
  assert.equal(remove.status, 200, JSON.stringify(remove.body))
  assert.deepEqual(remove.body.applied, ['rem-1'])

  const delta = await app.call('GET', `/api/v1/reminders?since=${first.body.cursor}`, { token: alice.accessToken })
  assert.equal(delta.body.reminders.length, 1)
  const tomb = delta.body.reminders[0]
  assert.equal(tomb.deleted, true)
  assert.ok(tomb.deletedAt > 0)
  assert.equal(tomb.title, '')
  assert.equal(tomb.dueAt, null)
  assert.equal(tomb.deadlineAt, null)
  assert.equal(tomb.recurrence, null)
  assert.equal(tomb.status, 'cancelled')
  assert.equal(tomb.data, null)

  const after = await app.call('GET', `/api/v1/reminders?since=${delta.body.cursor}`, { token: alice.accessToken })
  assert.equal(after.body.reminders.length, 0)
})

test('过去的时间点与空 dueAt 都允许（逾期提醒本来就是过去）', async (t) => {
  const { app, alice } = await setup(t)
  const past = Date.now() - 86_400_000
  const push = await app.call('POST', '/api/v1/reminders', {
    token: alice.accessToken,
    body: {
      changes: [
        reminder({ id: 'rem-past', title: '逾期的', dueAt: past }),
        reminder({ id: 'rem-any', title: '随时都行', dueAt: null, deadlineAt: null, recurrence: null })
      ]
    }
  })
  assert.equal(push.status, 200, JSON.stringify(push.body))
  assert.deepEqual(push.body.applied, ['rem-past', 'rem-any'])

  const pull = await app.call('GET', '/api/v1/reminders?since=0', { token: alice.accessToken })
  const byId = new Map(pull.body.reminders.map((row) => [row.id, row]))
  assert.equal(byId.get('rem-past').dueAt, past)
  assert.equal(byId.get('rem-any').dueAt, null)
  assert.equal(byId.get('rem-any').recurrence, null)
})

test('提醒接口的鉴权、方法与体积限制', async (t) => {
  const { app, alice, bob } = await setup(t)

  assert.equal((await app.call('GET', '/api/v1/reminders?since=0')).status, 401)
  assert.equal((await app.call('PUT', '/api/v1/reminders', { token: alice.accessToken, body: {} })).status, 405)
  assert.equal((await app.call('GET', '/api/v1/reminders/nope', { token: alice.accessToken })).status, 404)

  const tooMany = await app.call('POST', '/api/v1/reminders', {
    token: alice.accessToken,
    body: { changes: Array.from({ length: 201 }, (_, i) => reminder({ id: `rem-${i}` })) }
  })
  assert.equal(tooMany.status, 413)
  assert.equal(tooMany.body.error, 'too_many_changes')

  const huge = await app.call('POST', '/api/v1/reminders', {
    token: alice.accessToken,
    body: { changes: [reminder({ data: { blob: 'x'.repeat(21_000) } })] }
  })
  assert.equal(huge.status, 413)
  assert.equal(huge.body.error, 'reminder_too_large')

  const badRecurrence = await app.call('POST', '/api/v1/reminders', {
    token: alice.accessToken,
    body: { changes: [reminder({ recurrence: [1, 2] })] }
  })
  assert.equal(badRecurrence.status, 400)

  const badLevel = await app.call('POST', '/api/v1/reminders', {
    token: alice.accessToken,
    body: { changes: [reminder()] }
  })
  assert.equal(badLevel.status, 200)
  assert.equal(badLevel.body.reminders[0].level, 'normal')

  // Foreign ids are refused rather than taken over.
  const clash = await app.call('POST', '/api/v1/reminders', { token: bob.accessToken, body: { changes: [reminder()] } })
  assert.equal(clash.status, 409)
  assert.deepEqual(clash.body.conflicts, [{ id: 'rem-1', error: 'reminder_id_taken' }])

  const bobPull = await app.call('GET', '/api/v1/reminders?since=0', { token: bob.accessToken })
  assert.deepEqual(bobPull.body.reminders, [])
})

test('游标超过最高 seq 时从头拉取', async (t) => {
  const { app, alice } = await setup(t)
  await app.call('POST', '/api/v1/reminders', { token: alice.accessToken, body: { changes: [reminder()] } })
  const pull = await app.call('GET', '/api/v1/reminders?since=500000', { token: alice.accessToken })
  assert.equal(pull.status, 200)
  assert.equal(pull.body.reminders.length, 1)
  assert.equal(pull.body.cursor, 1)
})

test('limit 分页', async (t) => {
  const { app, alice } = await setup(t)
  const now = Date.now()
  await app.call('POST', '/api/v1/reminders', {
    token: alice.accessToken,
    body: { changes: [1, 2, 3].map((n) => reminder({ id: `rem-${n}`, title: `提醒 ${n}`, dueAt: now + n * 60_000 })) }
  })
  const page1 = await app.call('GET', '/api/v1/reminders?since=0&limit=2', { token: alice.accessToken })
  assert.equal(page1.body.reminders.length, 2)
  assert.equal(page1.body.hasMore, true)
  const page2 = await app.call('GET', `/api/v1/reminders?since=${page1.body.cursor}&limit=2`, { token: alice.accessToken })
  assert.equal(page2.body.reminders.length, 1)
  assert.equal(page2.body.hasMore, false)
})
