import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryEntry } from '@shared/types'
import { HistoryStore, toSyncRow } from './history'

/**
 * Retention, persistence and audio cleanup of the real `HistoryStore` (REQ-05 /
 * REQ-07).
 *
 * These exercise the store against an actual temporary directory on purpose.
 * The bugs they lock down only exist on disk — a stale `history.json` refilling
 * after a restart, wav files surviving the row they belonged to — so a stubbed
 * filesystem would prove exactly nothing.
 */

const mocks = vi.hoisted(() => ({ userData: '' }))

// `userData` is read on every audio path operation, so the mock stays a plain
// mutable slot that each test points at its own temp directory.
vi.mock('electron', () => ({
  app: { getPath: () => mocks.userData }
}))

const DAY = 86_400_000

let dir = ''
let storePath = ''
/** Every store opened by a test; Windows locks an open SQLite file. */
const opened: HistoryStore[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'typeless-history-'))
  mocks.userData = dir
  storePath = join(dir, 'history.sqlite')
})

afterEach(() => {
  for (const store of opened) store.close()
  opened.length = 0
  rmSync(dir, { recursive: true, force: true })
})

function makeStore(): HistoryStore {
  const store = new HistoryStore(storePath)
  opened.push(store)
  return store
}

it('enforces a changed row limit immediately and keeps it on the next write', async () => {
  const store = makeStore()
  await store.load()
  for (let i = 0; i < 4; i++) await store.add({ mode: 'dictation', transcript: `${i}`, final: `${i}`, durationMs: 0 })
  store.setLimit(2)
  expect(store.list()).toHaveLength(2)
  await store.add({ mode: 'dictation', transcript: 'new', final: 'new', durationMs: 0 })
  expect(store.list()).toHaveLength(2)
  expect(store.latest()?.final).toBe('new')
})

function entry(id: string, createdAt: number, audioPath?: string): HistoryEntry {
  return {
    id,
    createdAt,
    mode: 'dictation',
    transcript: `原始 ${id}`,
    final: `final ${id}`,
    durationMs: 1200,
    app: '',
    ...(audioPath ? { audioPath } : {})
  }
}

/** Creates a wav-shaped file under `<userData>/audio` and returns both paths. */
function seedAudio(id: string): { relative: string; absolute: string } {
  mkdirSync(join(dir, 'audio'), { recursive: true })
  const relative = join('audio', `${id}.wav`)
  const absolute = join(dir, relative)
  writeFileSync(absolute, Buffer.from('RIFF....WAVEfmt '))
  return { relative, absolute }
}

/**
 * Seeds rows as if an earlier app run had written them. A second store instance
 * writes them into the same database file, so what the assertions read back went
 * through the real persistence path instead of a hand-built document.
 */
function seedStore(entries: HistoryEntry[]): void {
  const store = makeStore()
  store.migrateFrom(entries)
  // Released immediately: Windows refuses to delete a file another handle holds,
  // and the "never keep" tests delete the database out from under the store.
  store.close()
}

/** Reads back through a fresh store, i.e. what the next start would see. */
async function readStore(): Promise<HistoryEntry[]> {
  const store = makeStore()
  await store.load(1000)
  return store.list('', 1000)
}

function ids(store: HistoryStore): string[] {
  return store.list().map((item) => item.id)
}

describe('HistoryStore retention', () => {
  it('keeps entries of any age when the window is -1 (forever)', async () => {
    const ancient = Date.now() - 400 * DAY
    seedStore([entry('fresh', Date.now()), entry('ancient', ancient)])

    const store = makeStore()
    await store.setRetention(-1)
    await store.load()

    expect(ids(store)).toEqual(['fresh', 'ancient'])
    // Nothing was pruned, so the file still holds both rows.
    expect(await readStore()).toHaveLength(2)
  })

  it('drops entries outside the window and deletes their wav', async () => {
    const stale = seedAudio('stale')
    const kept = seedAudio('kept')
    seedStore([
      entry('kept', Date.now(), kept.relative),
      entry('stale', Date.now() - 2 * DAY, stale.relative)
    ])

    const store = makeStore()
    await store.setRetention(86_400)
    await store.load()

    expect(ids(store)).toEqual(['kept'])
    // The trim is persisted right away, not only on the next append.
    expect((await readStore()).map((item) => item.id)).toEqual(['kept'])
    // `removeAudioFile` is fire-and-forget, so give the unlink a moment.
    await vi.waitFor(() => expect(existsSync(stale.absolute)).toBe(false))
    expect(existsSync(kept.absolute)).toBe(true)
  })

  it('deletes the wav of rows dropped by the row limit', async () => {
    const newest = seedAudio('newest')
    const middle = seedAudio('middle')
    const oldest = seedAudio('oldest')
    const now = Date.now()
    seedStore([
      entry('newest', now, newest.relative),
      entry('middle', now - 1000, middle.relative),
      entry('oldest', now - 2000, oldest.relative)
    ])

    const store = makeStore()
    await store.setRetention(-1)
    await store.load(2)

    expect(ids(store)).toEqual(['newest', 'middle'])
    expect(await readStore()).toHaveLength(2)
    // Only the truncated row loses its audio; the kept rows still have theirs.
    await vi.waitFor(() => expect(existsSync(oldest.absolute)).toBe(false))
    expect(existsSync(newest.absolute)).toBe(true)
    expect(existsSync(middle.absolute)).toBe(true)
  })

  it('wipes memory and deletes the file when retention is 0 on load', async () => {
    seedStore([entry('a', Date.now()), entry('b', Date.now() - 1000)])
    expect(existsSync(storePath)).toBe(true)

    const store = makeStore()
    await store.setRetention(0)
    await store.load()

    expect(store.list()).toEqual([])
    // The old file must not survive: leaving it behind is what refilled the list
    // on the next start.
    expect(existsSync(storePath)).toBe(false)
  })

  it('sweeps leftover wavs that no persisted entry points at', async () => {
    // "Never keep" never persists entries, so a wav written last session has
    // nothing on disk that could name it; loading must reclaim it.
    const orphan = seedAudio('orphan')

    const store = makeStore()
    await store.setRetention(0)
    await store.load()

    expect(existsSync(orphan.absolute)).toBe(false)
  })

  it('never writes the file in retention 0 but keeps the session list usable', async () => {
    const store = makeStore()
    await store.setRetention(0)
    await store.load()

    const added = await store.add({
      mode: 'dictation',
      transcript: '你好',
      final: '你好。',
      durationMs: 900
    })

    expect(existsSync(storePath)).toBe(false)
    // In-memory only: the bar and retry read `latest()` during this session.
    expect(store.latest()?.id).toBe(added.id)
  })

  it('clears rows, audio and file immediately when switched to "never"', async () => {
    const audio = seedAudio('a')
    seedStore([entry('a', Date.now(), audio.relative)])

    const store = makeStore()
    await store.setRetention(-1)
    await store.load()
    expect(ids(store)).toEqual(['a'])

    await store.setRetention(0)

    expect(store.list()).toEqual([])
    expect(existsSync(storePath)).toBe(false)
    await vi.waitFor(() => expect(existsSync(audio.absolute)).toBe(false))
  })

  it('applies a narrower window immediately without waiting for the next take', async () => {
    seedStore([entry('fresh', Date.now()), entry('stale', Date.now() - 10 * DAY)])

    const store = makeStore()
    await store.setRetention(-1)
    await store.load()
    expect(ids(store)).toEqual(['fresh', 'stale'])

    await store.setRetention(604_800)

    expect(ids(store)).toEqual(['fresh'])
    expect((await readStore()).map((item) => item.id)).toEqual(['fresh'])
  })
})

describe('HistoryStore entries', () => {
  it('records a completed status by default and persists it', async () => {
    const store = makeStore()
    await store.setRetention(-1)
    await store.load()

    const added = await store.add({
      mode: 'dictation',
      transcript: '今天我们 deploy',
      final: '今天我们 deploy。',
      durationMs: 2400
    })

    expect(added.status).toBe('completed')
    expect((await readStore())[0]?.status).toBe('completed')
  })

  it('patches fields in place and writes them through', async () => {
    const store = makeStore()
    await store.setRetention(-1)
    await store.load()
    const added = await store.add({
      mode: 'dictation',
      transcript: '原话',
      final: '原话。',
      durationMs: 1500
    })

    const updated = await store.update(added.id, {
      editedText: '改过的',
      editedStatus: 'EXTRACTED',
      attempts: 1
    })

    expect(updated?.editedText).toBe('改过的')
    expect(store.get(added.id)?.editedStatus).toBe('EXTRACTED')
    expect(store.get(added.id)?.attempts).toBe(1)
    expect((await readStore())[0]?.editedText).toBe('改过的')
  })

  it('returns undefined when updating an unknown id', async () => {
    const store = makeStore()
    await store.setRetention(-1)
    await store.load()

    await expect(store.update('missing', { final: 'x' })).resolves.toBeUndefined()
  })
})

describe('provenance survives the store', () => {
  // The card and the provider were passed to `add()` from the first version of
  // REQ-21 and silently dropped by the field whitelist, so every row claimed
  // "card not recorded". Reading back from disk is the only assertion that
  // catches a whitelist regression.
  it('keeps the card and provider it was given', async () => {
    const store = makeStore()
    await store.load()
    const added = await store.add({
      mode: 'dictation',
      transcript: '原始',
      final: '润色后',
      durationMs: 1200,
      app: 'DeepSeek Harness',
      status: 'completed',
      promptKind: 'ai',
      promptId: 'ai-1',
      promptName: '清晰结构',
      providerId: 'llm-1',
      providerName: 'llm.cpp'
    })

    expect(added.promptName).toBe('清晰结构')
    expect(added.providerName).toBe('llm.cpp')

    const reloaded = makeStore()
    await reloaded.load()
    const first = reloaded.list()[0]!
    expect(first.promptKind).toBe('ai')
    expect(first.promptId).toBe('ai-1')
    expect(first.providerId).toBe('llm-1')
  })
})
describe('migration from the JSON era', () => {
  // Every existing user has a history.json. If the first SQLite start ignored it
  // the upgrade would look exactly like "we deleted your history".
  it('imports history.json once and archives the original', async () => {
    const legacy = join(dir, 'history.json')
    writeFileSync(legacy, JSON.stringify([entry('old', Date.now() - 1000)]), 'utf8')

    const store = makeStore()
    await store.setRetention(-1)
    await store.load()

    expect(store.list().map((item) => item.id)).toEqual(['old'])
    expect(existsSync(legacy)).toBe(false)

    // A second start reads the database, not the archived file, so nothing is
    // imported twice and no row is duplicated.
    const again = makeStore()
    await again.load()
    expect(again.list().map((item) => item.id)).toEqual(['old'])
  })

  it('starts empty when there is nothing to migrate', async () => {
    const store = makeStore()
    await store.load()
    expect(store.list()).toEqual([])
  })
})

describe('sync cursors', () => {
  it('stamps a new row so the other machine can order it', async () => {
    const store = makeStore()
    await store.load()
    const before = Date.now()
    const added = await store.add({ mode: 'dictation', transcript: 'a', final: 'b', durationMs: 10 })
    expect(added.updatedAt).toBeGreaterThanOrEqual(before)
    expect(store.changesSince(0).map((item) => item.id)).toEqual([added.id])
  })

  it('reports only rows changed after the cursor', async () => {
    const store = makeStore()
    await store.load()
    const first = await store.add({ mode: 'dictation', transcript: 'a', final: 'b', durationMs: 10 })
    const cursor = first.updatedAt ?? first.createdAt
    const second = await store.add({ mode: 'dictation', transcript: 'c', final: 'd', durationMs: 10 })
    expect(store.changesSince(cursor).map((item) => item.id)).toEqual([second.id])
    expect(store.pendingSince(cursor)).toBe(1)
  })

  it('leaves a tombstone when a row is deleted', async () => {
    const store = makeStore()
    await store.load()
    const added = await store.add({ mode: 'dictation', transcript: 'a', final: 'b', durationMs: 10 })
    await store.remove(added.id)
    expect(store.list()).toEqual([])
    expect(store.deletionsSince(0).map((item) => item.id)).toEqual([added.id])
  })

  it('leaves tombstones when everything is cleared', async () => {
    const store = makeStore()
    await store.load()
    await store.add({ mode: 'dictation', transcript: 'a', final: 'b', durationMs: 10 })
    await store.add({ mode: 'dictation', transcript: 'c', final: 'd', durationMs: 10 })
    await store.clear()
    expect(store.deletionsSince(0)).toHaveLength(2)
  })

  it('keeps the local wav out of the wire shape', async () => {
    const store = makeStore()
    await store.load()
    const audio = seedAudio('synced')
    const added = await store.add({
      mode: 'dictation',
      transcript: 'a',
      final: 'b',
      durationMs: 10,
      audioPath: audio.relative
    })
    expect(toSyncRow(added).audioPath).toBeUndefined()
    expect(toSyncRow(added).final).toBe('b')
  })

  it('applies a newer remote row and keeps the local wav', async () => {
    const store = makeStore()
    await store.load()
    const audio = seedAudio('shared')
    await store.add({
      mode: 'dictation',
      transcript: 'a',
      final: 'old',
      durationMs: 10,
      audioPath: audio.relative
    })
    const local = store.list()[0]
    const changed = await store.applyRemote(
      [{ ...toSyncRow(local), final: 'new', updatedAt: (local.updatedAt ?? 0) + 1000 }],
      []
    )
    expect(changed).toBe(1)
    const after = store.get(local.id)
    expect(after?.final).toBe('new')
    // The wav is a local fact the server never sent, so the merge must not drop it.
    expect(after?.audioPath).toBe(audio.relative)
  })

  it('ignores a remote row older than the local copy', async () => {
    const store = makeStore()
    await store.load()
    const added = await store.add({ mode: 'dictation', transcript: 'a', final: 'mine', durationMs: 10 })
    const changed = await store.applyRemote(
      [{ ...toSyncRow(added), final: 'theirs', updatedAt: (added.updatedAt ?? 0) - 5000 }],
      []
    )
    expect(changed).toBe(0)
    expect(store.get(added.id)?.final).toBe('mine')
  })

  it('deletes a row the server reports as gone', async () => {
    const store = makeStore()
    await store.load()
    const added = await store.add({ mode: 'dictation', transcript: 'a', final: 'b', durationMs: 10 })
    const changed = await store.applyRemote([], [{ id: added.id, deletedAt: (added.updatedAt ?? 0) + 1 }])
    expect(changed).toBe(1)
    expect(store.get(added.id)).toBeUndefined()
    // The delete came from the server, so it must not bounce back as a local one.
    expect(store.deletionsSince(0)).toEqual([])
  })

  it('keeps a local edit that happened after the remote delete', async () => {
    const store = makeStore()
    await store.load()
    const added = await store.add({ mode: 'dictation', transcript: 'a', final: 'b', durationMs: 10 })
    const changed = await store.applyRemote([], [{ id: added.id, deletedAt: (added.updatedAt ?? 0) - 1 }])
    expect(changed).toBe(0)
    expect(store.get(added.id)).toBeDefined()
  })

  it('skips a malformed row instead of trusting it', async () => {
    const store = makeStore()
    await store.load()
    expect(await store.applyRemote([{ nope: 1 }, null, 'x'], [])).toBe(0)
  })
})
