/**
 * Manual extraction has to end where collected work ends: the queue.
 *
 * These tests drive the real production function against the real release helper,
 * with the body supplied exactly as the app supplies it, so "queued" is not just a
 * return value — a group really became claimable and the driver was really told.
 *
 * The review's two counter-examples are pinned here: a body that is gone and a
 * body that changed must never clear the progress an earlier run committed, and
 * neither may wake a model call.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { KnowledgeSource } from '@shared/knowledge'

import { ExtractEngine } from './engine'
import { KnowledgeHost } from './host'
import { extractSourceNow, missingReason, sourceChannel, type ManualExtractDeps } from './manual'

const entry = join(process.cwd(), 'native', 'bin', 'yu-knowledge.exe')
const BODY = '随记原文'

/** Polls until the condition holds, so no test depends on a fixed sleep. */
async function until(check: () => Promise<boolean>, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return false
}

describe('manual extraction', () => {
  let root = ''
  let host: KnowledgeHost

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'yu-knowledge-manual-'))
    host = new KnowledgeHost({ entry, root, requestMs: 5_000 })
  })

  afterEach(async () => {
    await host.stop()
    rmSync(root, { recursive: true, force: true })
  })

  function deps(over: Partial<ManualExtractDeps> = {}): ManualExtractDeps {
    return {
      host: () => host,
      enabled: () => true,
      allowed: () => true,
      resolveBody: () => ({ text: BODY }),
      wake: () => undefined,
      ...over
    }
  }

  /** Publishes one synthetic note exactly the way the collector does. */
  async function published(text = BODY, originRef = 'n1'): Promise<KnowledgeSource> {
    // The channels start off; a real install turns them on from settings.
    await host.configureCollect({ enabled: true, notes: true, chat: true, reading: true })
    const result = await host.publishSource({
      channel: 'note',
      kind: 'note',
      originRef,
      groupKey: originRef,
      title: '随记标题',
      text,
      at: 1
    })
    return host.getSource(result.sourceId)
  }

  /**
   * The committed extraction progress, read straight out of the helper's database.
   *
   * The review measured this column, so the regression does too: a refused manual
   * extraction has to leave exactly the rows an earlier run wrote.
   */
  function progress(): number {
    const db = new DatabaseSync(join(root, 'data', 'knowledge', 'knowledge.db'), { readOnly: true })
    try {
      const row = db.prepare('SELECT count(*) AS n FROM extract_progress').get() as { n: number }
      return row.n
    } finally {
      db.close()
    }
  }

  it('queues the existing task and wakes the engine once', async () => {
    const source = await published()
    let wakes = 0
    const result = await extractSourceNow(source.id, deps({ wake: () => { wakes++ } }))
    expect(result.queued).toBe(1)
    expect(result.groupId).toBeTruthy()
    expect(wakes).toBe(1)
    const status = await host.queueStatus()
    expect(status.groups.some(group => group.id === result.groupId && group.state === 'stabilizing')).toBe(true)
  })

  it('parks a body that is gone and keeps the progress of the last run', async () => {
    await host.configureCollect({ enabled: true, notes: true, chat: true, reading: true })
    process.env.YU_KNOWLEDGE_STABLE_MS = '0'
    const instance = new KnowledgeHost({
      entry,
      root,
      requestMs: 8_000,
      completer: async () => '{"cards": []}'
    })
    try {
      const result = await instance.publishSource({
        channel: 'note', kind: 'note', originRef: 'n2', groupKey: 'n2', title: '随记标题', text: BODY, at: 1
      })
      const engine = new ExtractEngine({
        host: () => instance,
        readBody: () => ({ text: BODY }),
        settings: () => DEFAULT_SETTINGS,
        allowed: () => true
      })
      const first = await extractSourceNow(result.sourceId, {
        host: () => instance,
        enabled: () => true,
        allowed: () => true,
        resolveBody: () => ({ text: BODY }),
        wake: () => engine.wake()
      })
      expect(first.queued).toBe(1)
      const done = await until(async () => {
        const status = await instance.queueStatus()
        return status.groups.find(group => group.id === first.groupId)?.state === 'completed'
      })
      expect(done).toBe(true)
      expect(progress()).toBe(1)

      // The body is gone: the task is parked, the committed progress stays.
      let wakes = 0
      const parked = await extractSourceNow(result.sourceId, {
        host: () => instance,
        enabled: () => true,
        allowed: () => true,
        resolveBody: () => ({ missing: 'unknown' }),
        wake: () => { wakes++ }
      })
      expect(parked).toMatchObject({ queued: 0, state: 'needs_reread', reason: missingReason('unknown', false) })
      expect(wakes).toBe(0)
      expect(progress()).toBe(1)
      const status = await instance.queueStatus()
      expect(status.groups.find(group => group.id === first.groupId)?.state).toBe('needs_reread')
    } finally {
      delete process.env.YU_KNOWLEDGE_STABLE_MS
      await instance.stop()
    }
  }, 60_000)

  it('refuses a body that changed after it was read and keeps the progress', async () => {
    await host.configureCollect({ enabled: true, notes: true, chat: true, reading: true })
    const result = await host.publishSource({
      channel: 'note', kind: 'note', originRef: 'n3', groupKey: 'n3', title: '随记标题', text: BODY, at: 1
    })
    // An earlier run left progress behind for this version.
    const first = await extractSourceNow(result.sourceId, deps())
    expect(first.queued).toBe(1)
    const seeded = new DatabaseSync(join(root, 'data', 'knowledge', 'knowledge.db'))
    try {
      const version = (seeded.prepare('SELECT version FROM sources WHERE id = ?').get(result.sourceId) as { version: string }).version
      seeded.prepare(
        "INSERT INTO extract_progress (source_id, version, segment, state, group_id, created_at, updated_at) VALUES (?, ?, 0, 'done', 'grp_seed', 1, 1)"
      ).run(result.sourceId, version)
    } finally {
      seeded.close()
    }
    expect(progress()).toBe(1)

    // The text the caller holds is not the text the source stores any more.
    let wakes = 0
    const refused = await extractSourceNow(result.sourceId, deps({
      resolveBody: () => ({ text: '改过的正文' }),
      wake: () => { wakes++ }
    }))
    expect(refused).toMatchObject({ queued: 0, reason: '原文已变更，需要重新读取该来源' })
    expect(wakes).toBe(0)
    expect(progress()).toBe(1)
  }, 60_000)

  it('refuses when the source moved to a newer version than the one read', async () => {
    await host.configureCollect({ enabled: true, notes: true, chat: true, reading: true })
    const before = await published(BODY, 'n4')
    // A second publish of the same origin mints a new version.
    const after = await published('新一版正文', 'n4')
    expect(after.version).not.toBe(before.version)
    let wakes = 0
    const refused = await extractSourceNow(after.id, deps({
      resolveBody: () => ({ text: BODY }),
      wake: () => { wakes++ }
    }))
    expect(refused).toMatchObject({ queued: 0, reason: '原文已变更，需要重新读取该来源' })
    expect(wakes).toBe(0)
  }, 60_000)

  it('refuses when the switch is off without starting the helper', async () => {
    const result = await extractSourceNow('s1', deps({ enabled: () => false }))
    expect(result).toEqual({ queued: 0, reason: '知识采集未开启' })
    expect(host.running).toBe(false)
  })

  it('maps a stored source onto the channel it was collected under', () => {
    expect(sourceChannel({ kind: 'note' })).toBe('note')
    expect(sourceChannel({ kind: 'chat' })).toBe('chat')
    expect(sourceChannel({ kind: 'web' })).toBe('reading')
    expect(sourceChannel({ kind: 'document' })).toBe('reading')
  })

  it('fails honestly when the helper cannot start at all', async () => {
    const broken = new KnowledgeHost({ entry: join(process.cwd(), 'native', 'bin', 'missing.exe'), root, requestMs: 2_000 })
    await expect(extractSourceNow('s1', deps({ host: () => broken }))).rejects.toMatchObject({ code: 'internal' })
    await broken.stop()
  })

  it('finishes a clicked extraction through the real engine with no manual pump', async () => {
    // The settling window is the only delay the production loop has; a real click
    // may wait for it, so it is collapsed here instead of being faked away.
    process.env.YU_KNOWLEDGE_STABLE_MS = '0'
    const engineRoot = mkdtempSync(join(tmpdir(), 'yu-knowledge-manual-engine-'))
    const instance = new KnowledgeHost({
      entry,
      root: engineRoot,
      requestMs: 5_000,
      completer: async () => '{"cards": []}'
    })
    const body = '正文正文正文'
    try {
      await instance.configureCollect({ enabled: true, notes: true, chat: true, reading: true })
      const publishedResult = await instance.publishSource({
        channel: 'note', kind: 'note', originRef: 'n1', groupKey: 'n1', title: '随记标题', text: body, at: 1
      })
      const engine = new ExtractEngine({
        host: () => instance,
        readBody: () => ({ text: body }),
        settings: () => DEFAULT_SETTINGS,
        allowed: () => true
      })
      const result = await extractSourceNow(publishedResult.sourceId, {
        host: () => instance,
        enabled: () => true,
        allowed: () => true,
        resolveBody: () => ({ text: body }),
        wake: () => engine.wake()
      })
      expect(result.queued).toBe(1)
      // Nothing else touches the engine: the click itself has to be enough.
      const done = await until(async () => {
        const status = await instance.queueStatus()
        return status.groups.find(group => group.id === result.groupId)?.state === 'completed'
      })
      expect(done).toBe(true)
    } finally {
      delete process.env.YU_KNOWLEDGE_STABLE_MS
      await instance.stop()
      rmSync(engineRoot, { recursive: true, force: true })
    }
  }, 60_000)
})
