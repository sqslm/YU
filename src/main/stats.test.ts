import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryEntry } from '@shared/types'
import { StatsStore } from './stats'

/**
 * The lifetime rollup on disk: seeding, accumulation and the promise that a
 * wipe of the history cannot empty it.
 */

const mocks = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => mocks.userData }
}))

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: 'id-1',
    createdAt: new Date(2026, 9, 19, 12, 0, 0).getTime(),
    mode: 'dictation',
    transcript: '你好世界',
    final: '你好世界',
    durationMs: 4000,
    app: 'Notepad',
    ...overrides
  }
}

let dir = ''
let path = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'typeless-stats-'))
  mocks.userData = dir
  path = join(dir, 'stats.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('StatsStore', () => {
  it('writes what it counted and reads it back after a restart', async () => {
    const store = new StatsStore(path)
    await store.load()
    store.add(entry())
    store.add(entry({ id: 'b', createdAt: entry().createdAt + 60000 }))
    await store.flush()

    expect(existsSync(path)).toBe(true)
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { records: number }
    expect(onDisk.records).toBe(2)

    const reopened = new StatsStore(path)
    const loaded = await reopened.load()
    expect(loaded.records).toBe(2)
    expect(Object.values(loaded.days)[0]?.entries).toBe(2)
  })

  it('seeds from the history when the file does not exist yet', async () => {
    const store = new StatsStore(path)
    const seeded = await store.load(() => [entry(), entry({ id: 'b', status: 'error' })])

    expect(seeded.records).toBe(1)
    expect(seeded.days['2026-10-19']?.entries).toBe(2)
    // Seeding persists immediately, so the work is not repeated on next launch.
    expect(existsSync(path)).toBe(true)
  })

  it('rebuilds instead of throwing on a corrupt file', async () => {
    writeFileSync(path, '{ this is not json', 'utf8')
    const store = new StatsStore(path)
    const loaded = await store.load(() => [entry()])

    expect(loaded.records).toBe(1)
  })

  it('keeps the counters when the history is wiped', async () => {
    const store = new StatsStore(path)
    await store.load()
    store.add(entry())
    await store.flush()

    // There is no `clear()` on purpose: nothing on the history side reaches into
    // the rollup, so this is the whole contract.
    const reopened = new StatsStore(path)
    const loaded = await reopened.load(() => [])
    expect(loaded.records).toBe(1)
    expect(Object.keys(loaded.days)).toEqual(['2026-10-19'])
  })

  it('combines per-device statistics without modifying or counting them into this device snapshot', async () => {
    const store = new StatsStore(path)
    await store.load()
    store.add(entry())
    await store.setCloudContributions([
      { deviceId: 'this-device', stats: { version: 1, records: 99, lastAt: 0, days: {}, apps: {} } },
      { deviceId: 'other-device', stats: { version: 1, records: 2, lastAt: 2, days: { '2026-10-19': { entries: 2, records: 2, chars: 8 } }, apps: { Editor: 2 } } }
    ], 'this-device', 'account-a')

    expect(store.localSnapshot().records).toBe(1)
    expect(store.get('account-a').records).toBe(3)
    expect(store.get('account-a').days['2026-10-19']).toMatchObject({ entries: 3, records: 3, chars: 12 })
    expect(store.get('account-a').apps.Editor).toBe(2)
    expect(store.get('account-b').records).toBe(1)
    await store.flush()

    const reopened = new StatsStore(path)
    await reopened.load()
    expect(reopened.get('account-a').records).toBe(3)
  })
})
