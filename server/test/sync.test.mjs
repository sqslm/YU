import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { register, startMailServer, startServer } from './helpers.mjs'

async function boot() {
  const mail = await startMailServer()
  const server = await startServer({
    smtp: { configured: true, host: '127.0.0.1', port: mail.port },
    smtpConfigured: true
  })
  return { mail, server }
}

function entry(id, updatedAt, final) {
  return { id, createdAt: updatedAt, updatedAt, mode: 'dictation', transcript: final, final, durationMs: 1000 }
}

describe('history sync', () => {
  let server
  let mail
  let token
  before(async () => {
    ;({ server, mail } = await boot())
    const session = await register(server.call, mail, 'sync@example.com', 'correct horse')
    token = session.accessToken
  })
  after(async () => {
    await server.close()
    await mail.close()
  })

  it('pushes rows and pulls them back with their payload intact', async () => {
    const push = await server.call('POST', '/api/v1/transcription_history/push', {
      token,
      body: { entries: [entry('a', 1000, '你好'), entry('b', 2000, 'hello')] }
    })
    assert.equal(push.status, 200)
    assert.equal(push.body.accepted, 2)

    const pull = await server.call('GET', '/api/v1/transcription_history/pull?since=0', { token })
    assert.equal(pull.status, 200)
    assert.deepEqual(
      pull.body.entries.map((item) => item.id),
      ['a', 'b']
    )
    assert.equal(pull.body.entries[0].final, '你好')
    assert.equal(pull.body.entries[0].deleted, false)
  })

  it('keeps the newer copy when two machines disagree', async () => {
    await server.call('POST', '/api/v1/transcription_history/push', {
      token,
      body: { entries: [entry('c', 5000, '新的')] }
    })
    // A stale machine re-pushes an older revision of the same row.
    await server.call('POST', '/api/v1/transcription_history/push', {
      token,
      body: { entries: [entry('c', 4000, '旧的')] }
    })
    const pull = await server.call('GET', '/api/v1/transcription_history/pull?since=0', { token })
    const row = pull.body.entries.find((item) => item.id === 'c')
    assert.equal(row.final, '新的')
  })

  it('turns a delete into a tombstone the other machine can see', async () => {
    await server.call('POST', '/api/v1/transcription_history/push', {
      token,
      body: { deleted: ['a'] }
    })
    const pull = await server.call('GET', '/api/v1/transcription_history/pull?since=0', { token })
    const row = pull.body.entries.find((item) => item.id === 'a')
    assert.equal(row.deleted, true)
    // A tombstone carries no payload: the client only needs to drop the row.
    assert.equal(row.final, undefined)
  })

  it('pages forward from the cursor it handed out', async () => {
    const first = await server.call('GET', '/api/v1/transcription_history/pull?since=0', { token })
    await server.call('POST', '/api/v1/transcription_history/push', {
      token,
      body: { entries: [entry('d', 12000, '四')] }
    })
    const next = await server.call(
      'GET',
      `/api/v1/transcription_history/pull?since=${first.body.nextSince}`,
      { token }
    )
    assert.deepEqual(
      next.body.entries.map((item) => item.id),
      ['d']
    )
    assert.equal(next.body.nextSince > first.body.nextSince, true)
  })

  it('starts over for a cursor left behind by the timestamp era', async () => {
    // An older build (or a re-created database) asks with a millisecond stamp, which
    // is far above any `seq` this server has issued. Treating that as "up to date"
    // would leave the client silently never pulling again.
    const stale = await server.call('GET', '/api/v1/transcription_history/pull?since=1792567198048', {
      token
    })
    assert.equal(stale.body.entries.length > 0, true)
    assert.equal(stale.body.nextSince < 1792567198048, true)
  })

  it('counts what it holds for the account', async () => {
    const status = await server.call('GET', '/api/v1/transcription_history/sync_status', { token })
    assert.equal(status.status, 200)
    // `a` is a tombstone now, so `b`, `c` and the row the cursor test pushed count.
    assert.equal(status.body.count, 3)
    assert.equal(status.body.enabled, true)
  })

  it('wipes through tombstones so other machines learn about it', async () => {
    const wipe = await server.call('DELETE', '/api/v1/transcription_history/wipe', { token })
    assert.equal(wipe.status, 200)
    const pull = await server.call('GET', '/api/v1/transcription_history/pull?since=0', { token })
    assert.equal(
      pull.body.entries.every((item) => item.deleted === true),
      true
    )
    const status = await server.call('GET', '/api/v1/transcription_history/sync_status', { token })
    assert.equal(status.body.count, 0)
  })

  it('keeps one account out of another account’s rows', async () => {
    const other = await register(server.call, mail, 'other@example.com', 'correct horse')
    await server.call('POST', '/api/v1/transcription_history/push', {
      token: other.accessToken,
      body: { entries: [entry('private', 9000, 'mine')] }
    })
    const mine = await server.call('GET', '/api/v1/transcription_history/pull?since=0', { token })
    assert.equal(
      mine.body.entries.some((item) => item.id === 'private'),
      false
    )
    // And a stolen id cannot be overwritten from another account either.
    await server.call('POST', '/api/v1/transcription_history/push', {
      token: other.accessToken,
      body: { entries: [entry('b', 99999, 'hijacked')] }
    })
    const after = await server.call('GET', '/api/v1/transcription_history/pull?since=0', {
      token: other.accessToken
    })
    const hijack = after.body.entries.find((item) => item.id === 'b')
    assert.equal(hijack?.final, undefined)
  })

  it('rejects a row without an id', async () => {
    const res = await server.call('POST', '/api/v1/transcription_history/push', {
      token,
      body: { entries: [{ final: 'no id' }] }
    })
    assert.equal(res.status, 400)
    assert.equal(res.body.error, 'bad_entry')
  })

  it('needs a token for every sync call', async () => {
    for (const [method, path] of [
      ['GET', '/api/v1/sync/check'],
      ['GET', '/api/v1/transcription_history/pull'],
      ['POST', '/api/v1/transcription_history/push'],
      ['DELETE', '/api/v1/transcription_history/wipe']
    ]) {
      const res = await server.call(method, path, { body: method === 'POST' ? {} : undefined })
      assert.equal(res.status, 401, `${method} ${path}`)
    }
  })
})

describe('a delete in the same millisecond as the push', () => {
  let server
  let mail
  let token
  before(async () => {
    ;({ server, mail } = await boot())
    const session = await register(server.call, mail, 'same-ms@example.com', 'correct horse')
    token = session.accessToken
  })
  after(async () => {
    await server.close()
    await mail.close()
  })

  it('still reaches the machine that already holds the row', async () => {
    // Machine A pushes, machine B pulls and keeps its cursor, then A deletes inside
    // the same millisecond the row was stamped with. The tombstone has to be
    // strictly newer than the row it replaces: B compares that stamp with its own
    // copy, and an equal stamp leaves the deleted entry on disk forever.
    const now = Date.now()
    const push = await server.call('POST', '/api/v1/transcription_history/push', {
      token,
      body: { entries: [entry('x', now, '删掉我')] }
    })
    assert.equal(push.status, 200)
    const seen = await server.call('GET', '/api/v1/transcription_history/pull?since=0', { token })
    assert.equal(seen.body.entries[0].id, 'x')

    await server.call('POST', '/api/v1/transcription_history/push', {
      token,
      body: { deleted: ['x'] }
    })
    const later = await server.call(
      'GET',
      `/api/v1/transcription_history/pull?since=${seen.body.nextSince}`,
      { token }
    )
    const tombstone = later.body.entries.find((item) => item.id === 'x')
    assert.equal(tombstone?.deleted, true)
    assert.equal(tombstone.updatedAt > now, true)
  })
})
