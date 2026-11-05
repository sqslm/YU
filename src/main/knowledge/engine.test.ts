import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

import { DEFAULT_SETTINGS, mergeSettings } from '@shared/defaults'

import { ExtractEngine } from './engine'
import type { KnowledgeHost } from './host'

const GROUP = {
  groupId: 'grp_1',
  channel: 'note' as const,
  title: '随记',
  scope: 'notes',
  claim: 'clm_1',
  sources: [
    {
      sourceId: 'src_1',
      version: 'v1',
      fingerprint: 'f'.repeat(64),
      kind: 'note',
      originRef: 'note-1',
      scope: 'notes',
      title: '随记',
      size: 10
    }
  ]
}

function fakeHost(over: { extractNext?: Mock; extractRun?: Mock; extractFail?: Mock } = {}) {
  return {
    running: true,
    extractNext: vi.fn(async () => ({ enabled: true, paused: false, group: null, nextDueAt: null })),
    extractRun: vi.fn(async () => ({
      groupId: 'grp_1',
      state: 'completed' as const,
      cards: [],
      proposals: [],
      noKnowledge: true,
      reason: '',
      remaining: false
    })),
    extractFail: vi.fn(async () => ({ groupId: 'grp_1', state: 'needs_reread' })),
    ...over
  }
}

function engineWith(host: ReturnType<typeof fakeHost>, over: Record<string, unknown> = {}) {
  const scheduled: { run: () => void; delay: number }[] = []
  const engine = new ExtractEngine({
    host: () => host as unknown as KnowledgeHost,
    readBody: (() => ({ text: '正文' })) as never,
    settings: () => mergeSettings({ ...DEFAULT_SETTINGS }),
    allowed: () => true,
    schedule: (run, delay) => {
      scheduled.push({ run, delay })
      return { cancel: () => undefined }
    },
    ...over
  })
  return { engine, scheduled }
}

describe('ExtractEngine', () => {
  it('does nothing while the helper is not running', async () => {
    const host = fakeHost()
    host.running = false
    const { engine, scheduled } = engineWith(host)
    await engine.tick()
    expect(host.extractNext).not.toHaveBeenCalled()
    expect(scheduled).toHaveLength(0)
  })

  it('does nothing while the feature is not allowed', async () => {
    const host = fakeHost()
    const { engine } = engineWith(host, { allowed: () => false })
    await engine.tick()
    expect(host.extractNext).not.toHaveBeenCalled()
  })

  it('waits for the due time when nothing is runnable', async () => {
    const now = 1_000
    const host = fakeHost({
      extractNext: vi.fn(async () => ({ enabled: true, paused: false, group: null, nextDueAt: 61_000 }))
    })
    const { engine, scheduled } = engineWith(host, { now: () => now })
    await engine.tick()
    expect(host.extractRun).not.toHaveBeenCalled()
    expect(scheduled.at(-1)?.delay).toBe(60_000)
  })

  it('reads the material, runs one batch and asks again when segments remain', async () => {
    const host = fakeHost({
      extractNext: vi.fn(async () => ({ enabled: true, paused: false, group: GROUP, nextDueAt: null })),
      extractRun: vi.fn(async () => ({
        groupId: 'grp_1',
        state: 'ready' as const,
        cards: [{ cardId: 'card_1', action: 'new' as const }],
        proposals: [],
        noKnowledge: false,
        reason: '',
        remaining: true
      }))
    })
    const readBody = vi.fn(() => ({ text: '正文' }))
    const { engine, scheduled } = engineWith(host, { readBody })
    await engine.tick()
    expect(readBody).toHaveBeenCalledWith('note', 'note-1')
    expect(host.extractRun).toHaveBeenCalledWith({
      groupId: 'grp_1',
      claim: 'clm_1',
      sources: [{ sourceId: 'src_1', version: 'v1', text: '正文' }],
      profileId: null,
      effort: 'high'
    })
    expect(scheduled.at(-1)?.delay).toBe(0)
  })

  it('releases the claim when the body is gone instead of calling the model', async () => {
    const host = fakeHost({
      extractNext: vi.fn(async () => ({ enabled: true, paused: false, group: GROUP, nextDueAt: null }))
    })
    const { engine } = engineWith(host, { readBody: () => ({ missing: 'deleted' }) })
    await engine.tick()
    expect(host.extractRun).not.toHaveBeenCalled()
    expect(host.extractFail).toHaveBeenCalledWith({
      groupId: 'grp_1',
      claim: 'clm_1',
      code: 'source_changed',
      reason: '来源已删除'
    })
  })

  it('keeps a storage failure retryable', async () => {
    const host = fakeHost({
      extractNext: vi.fn(async () => ({ enabled: true, paused: false, group: GROUP, nextDueAt: null }))
    })
    const { engine } = engineWith(host, { readBody: () => ({ missing: 'unknown' }) })
    await engine.tick()
    expect(host.extractFail).toHaveBeenCalledWith({
      groupId: 'grp_1',
      claim: 'clm_1',
      code: 'internal',
      reason: '来源暂时无法读取'
    })
  })

  it('never runs two batches at once', async () => {
    let release: () => void = () => undefined
    const host = fakeHost({
      extractNext: vi.fn(async () => ({ enabled: true, paused: false, group: GROUP, nextDueAt: null }))
    })
    host.extractRun.mockImplementation(
      () =>
        new Promise(resolve => {
          release = () =>
            resolve({
              groupId: 'grp_1',
              state: 'completed',
              cards: [],
              proposals: [],
              noKnowledge: true,
              reason: '',
              remaining: false
            })
        }) as never
    )
    const { engine } = engineWith(host)
    const first = engine.tick()
    await engine.tick()
    expect(host.extractNext).toHaveBeenCalledTimes(1)
    release()
    await first
  })

  it('passes the configured extraction profile and effort', async () => {
    const host = fakeHost({
      extractNext: vi.fn(async () => ({ enabled: true, paused: false, group: GROUP, nextDueAt: null }))
    })
    const settings = mergeSettings({
      ...DEFAULT_SETTINGS,
      knowledge: { ...DEFAULT_SETTINGS.knowledge, profileId: 'p1', effort: 'medium' }
    })
    const { engine } = engineWith(host, { settings: () => settings })
    await engine.tick()
    expect(host.extractRun).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'p1', effort: 'medium' }))
  })

  it('survives a failing batch without throwing', async () => {
    const host = fakeHost({
      extractNext: vi.fn(async () => ({ enabled: true, paused: false, group: GROUP, nextDueAt: null })),
      extractRun: vi.fn(async () => {
        throw new Error('provider down')
      })
    })
    const log = vi.fn()
    const { engine } = engineWith(host, { log })
    await expect(engine.tick()).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('provider down'))
  })
})
