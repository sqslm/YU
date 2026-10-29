import test from 'node:test'
import assert from 'node:assert/strict'
import { startMailServer, startServer, register } from './helpers.mjs'

test('usage statistics are private to each account and replace that device snapshot', async t => {
  const mail = await startMailServer()
  const app = await startServer({ smtp: { configured: true, host: '127.0.0.1', port: mail.port } })
  t.after(async () => { await app.close(); await mail.close() })
  const alice = await register(app.call, mail)
  const bob = await register(app.call, mail, 'bob@example.com')
  const deviceA = 'd8ea1434-646b-43ab-bbd3-59e02e0bfe8a'
  const deviceB = 'dbdb4335-1c14-4f12-8999-16a9b5ed38a2'
  const contribution = { version: 1, records: 2, lastAt: 10, days: { '2026-10-25': { entries: 2, records: 2, chars: 5, inputUnits: 8, inputMs: 4000 } }, apps: { Editor: 2 } }

  assert.equal((await app.call('PUT', `/api/v1/stats/devices/${deviceA}`, { token: alice.accessToken, body: { stats: contribution } })).status, 200)
  await app.call('PUT', `/api/v1/stats/devices/${deviceB}`, { token: alice.accessToken, body: { stats: { ...contribution, records: 3 } } })
  const list = await app.call('GET', '/api/v1/stats/devices', { token: alice.accessToken })
  assert.equal(list.body.devices.length, 2)
  assert.equal(list.body.devices.find(row => row.deviceId === deviceA).stats.records, 2)
  assert.equal(list.body.devices.find(row => row.deviceId === deviceA).stats.days['2026-10-25'].inputUnits, 8)

  await app.call('PUT', `/api/v1/stats/devices/${deviceA}`, { token: alice.accessToken, body: { stats: { ...contribution, records: 4 } } })
  const replaced = await app.call('GET', '/api/v1/stats/devices', { token: alice.accessToken })
  assert.equal(replaced.body.devices.find(row => row.deviceId === deviceA).stats.records, 4)
  assert.deepEqual((await app.call('GET', '/api/v1/stats/devices', { token: bob.accessToken })).body.devices, [])

  await app.call('DELETE', '/api/v1/transcription_history/wipe', { token: alice.accessToken })
  assert.equal((await app.call('GET', '/api/v1/stats/devices', { token: alice.accessToken })).body.devices.length, 2)
})

test('statistics payloads and device identifiers are validated', async t => {
  const mail = await startMailServer()
  const app = await startServer({ smtp: { configured: true, host: '127.0.0.1', port: mail.port } })
  t.after(async () => { await app.close(); await mail.close() })
  const user = await register(app.call, mail)
  assert.equal((await app.call('PUT', '/api/v1/stats/devices/nope', { token: user.accessToken, body: { stats: {} } })).status, 400)
  assert.equal((await app.call('PUT', '/api/v1/stats/devices/d8ea1434-646b-43ab-bbd3-59e02e0bfe8a', { token: user.accessToken, body: { stats: { version: 1, days: { '2026-02-30': { entries: 1 } } } } })).status, 400)
  assert.equal((await app.call('PUT', '/api/v1/stats/devices/d8ea1434-646b-43ab-bbd3-59e02e0bfe8a', { token: user.accessToken, body: { stats: { version: 1, records: -1 } } })).status, 400)
})
