/**
 * Manual extraction has to end where collected work ends: the queue.
 *
 * These tests drive the real production function against the real release helper,
 * with the body supplied exactly as the app supplies it, so "queued" is not just a
 * return value — a group really became claimable and the driver was really told.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { KnowledgeSource } from '@shared/knowledge'

import { ExtractEngine } from './engine'
import { KnowledgeHost } from './host'
import { extractSourceNow, missingReason, sourceChannel, type ManualExtractDeps } from './manual'

const entry = join(process.cwd(), 'native', 'bin', 'yu-knowledge.exe')

/** Polls until the condition holds, so no test depends on a fixed sleep. */
async function until(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
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
      resolveBody: () => ({ text: '正文' }),
      wake: () => undefined,
      ...over
    }
  }

  /** Publishes one synthetic note exactly the way the collector does. */
  async function published(text = '随记原文'): Promise<KnowledgeSource> {
    // The channels start off; a real install turns them on from settings.
    await host.configureCollect({ enabled: true, notes: true, chat: true, reading: true })
    const result = await host.publishSource({
      channel: 'note',
      kind: 'note',
      originRef: 'n1',
      groupKey: 'n1',
      title: '随记标题',
      text,
      at: 1
    })
    return host.getSource(result.sourceId)
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

  it('reports a body that is gone as needs_reread and spends no model call', async () => {
    const source = await published()
    let wakes = 0
    const result = await extractSourceNow(source.id, deps({
      resolveBody: () => ({ missing: 'unknown' }),
      wake: () => { wakes++ }
    }))
    expect(wakes).toBe(0)
    expect(result).toMatchObject({ queued: 0, state: 'needs_reread', reason: missingReason('unknown', false) })
    const status = await host.queueStatus()
    expect(status.groups.find(group => group.id === result.groupId)?.state).toBe('needs_reread')
    // The source and its revision survive: only the task is parked.
    const after = await host.getSource(source.id)
    expect(after.state).toBe('active')
    expect(after.version).toBe(source.version)
  })

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
