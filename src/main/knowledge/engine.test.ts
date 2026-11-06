import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

import { DEFAULT_SETTINGS, mergeSettings } from '@shared/defaults'
import { KnowledgeError } from '@shared/knowledge'

import { dataMaintenanceActive, setDataMaintenance } from '../ipc-trust'
import { ExtractEngine } from './engine'
import type { KnowledgeHost } from './host'

const BODY = '正文正文正文'
const FINGERPRINT = createHash('sha256').update(BODY, 'utf8').digest('hex')

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
      fingerprint: FINGERPRINT,
      kind: 'note',
      originRef: 'note-1',
      scope: 'notes',
      title: '随记',
      size: BODY.length,
      segments: 1
    }
  ],
  // The helper hands out ranges, never text: the engine reads them itself.
  items: [{ sourceId: 'src_1', version: 'v1', segment: 0, start: 0, end: BODY.length }]
}

const OUTCOME = {
  groupId: 'grp_1',
  state: 'completed' as const,
  cards: [],
  proposals: [],
  noKnowledge: true,
  reason: '',
  remaining: false
}

function fakeHost(over: { extractNext?: Mock; extractRun?: Mock; extractFail?: Mock } = {}) {
  return {
    running: true,
    extractNext: vi.fn(async () => ({ enabled: true, paused: false, group: null, nextDueAt: null })),
    extractRun: vi.fn(async () => OUTCOME),
    extractFail: vi.fn(async () => ({ groupId: 'grp_1', state: 'needs_reread' })),
    cancelInFlight: vi.fn(() => 0),
    ...over
  }
}

function engineWith(host: ReturnType<typeof fakeHost>, over: Record<string, unknown> = {}) {
  const scheduled: { run: () => void; delay: number }[] = []
  const engine = new ExtractEngine({
    host: () => host as unknown as KnowledgeHost,
    readBody: (() => ({ text: BODY })) as never,
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

/** One runnable group, then nothing: the loop stops on its own. */
function oneGroup(host: ReturnType<typeof fakeHost>, group: unknown = GROUP) {
  let calls = 0
  host.extractNext.mockImplementation(async () => {
    calls += 1
    return calls === 1
      ? { enabled: true, paused: false, group, nextDueAt: null }
      : { enabled: true, paused: false, group: null, nextDueAt: null }
  })
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

  it('parks until the claim it requested came back and was released', async () => {
    const host = fakeHost()
    let answer: (value: unknown) => void = () => undefined
    let asked = 0
    host.extractNext.mockImplementation(async () => {
      asked += 1
      if (asked > 1) return { enabled: true, paused: false, group: null, nextDueAt: null }
      return new Promise(resolve => { answer = resolve })
    })
    const { engine } = engineWith(host)
    const ticking = engine.tick()
    await Promise.resolve()
    let parked = false
    const park = engine.park('正在备份').then(() => { parked = true })
    await Promise.resolve()
    // `park` only awaiting the running batch would miss the claim request that is
    // still in flight: the snapshot has to wait for Rust to answer it.
    expect(parked).toBe(false)
    answer({ enabled: true, paused: false, group: GROUP, nextDueAt: null })
    await park
    await ticking
    // One claim ran to its release; the loop then found nothing else to do.
    expect(host.extractRun).toHaveBeenCalledTimes(1)
    expect(host.extractFail).not.toHaveBeenCalled()
  })

  it('waits while the backup window holds the data still', async () => {
    const host = fakeHost()
    oneGroup(host)
    // The production closure asks the same gate the backup work sets, so a queued
    // group waits for the window instead of writing into the copied database.
    const { engine } = engineWith(host, { allowed: () => !dataMaintenanceActive() })
    setDataMaintenance(true)
    try {
      await engine.tick()
      expect(host.extractNext).not.toHaveBeenCalled()
      expect(host.extractRun).not.toHaveBeenCalled()
    } finally { setDataMaintenance(false) }
    await engine.tick()
    expect(host.extractRun).toHaveBeenCalled()
  })

  it('hands a claim back when the window closes while it is handed out', async () => {
    const host = fakeHost()
    let allowed = true
    // The claim was taken just before the backup window; the write must not follow.
    host.extractNext.mockImplementationOnce(async () => {
      allowed = false
      return { enabled: true, paused: false, group: GROUP, nextDueAt: null }
    })
    const { engine } = engineWith(host, { allowed: () => allowed })
    await engine.tick()
    expect(host.extractRun).not.toHaveBeenCalled()
    // The claim is handed back as a pause, the state a closed window leaves a task in.
    expect(host.extractFail).toHaveBeenCalledWith(expect.objectContaining({ groupId: 'grp_1', claim: 'clm_1', code: 'paused' }))
  })

  it('parks until the claim a running batch holds is released', async () => {
    const host = fakeHost()
    let release: (() => void) | undefined
    host.extractNext.mockImplementationOnce(async () => ({ enabled: true, paused: false, group: GROUP, nextDueAt: null }))
    host.extractRun.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ state: 'paused', cards: [], proposals: [] }) }))
    const { engine } = engineWith(host)
    void engine.tick()
    await Promise.resolve()
    let parked = false
    const park = engine.park('正在备份').then(() => { parked = true })
    await Promise.resolve()
    expect(parked).toBe(false)
    release?.()
    await park
    expect(parked).toBe(true)
    expect(host.cancelInFlight).toHaveBeenCalled()
  })

  it('waits for the due time when nothing is runnable', async () => {
    const host = fakeHost({
      extractNext: vi.fn(async () => ({ enabled: true, paused: false, group: null, nextDueAt: 61_000 }))
    })
    const { engine, scheduled } = engineWith(host, { now: () => 1_000 })
    await engine.tick()
    expect(host.extractRun).not.toHaveBeenCalled()
    expect(scheduled.at(-1)?.delay).toBe(60_000)
  })

  it('drains every runnable group in one wake', async () => {
    const host = fakeHost()
    const second = { ...GROUP, groupId: 'grp_2', claim: 'clm_2' }
    host.extractNext.mockImplementationOnce(async () => ({ enabled: true, paused: false, group: GROUP, nextDueAt: null }))
    host.extractNext.mockImplementationOnce(async () => ({ enabled: true, paused: false, group: second, nextDueAt: null }))
    host.extractNext.mockImplementation(async () => ({ enabled: true, paused: false, group: null, nextDueAt: null }))
    const { engine } = engineWith(host)
    await engine.tick()
    expect(host.extractRun).toHaveBeenCalledTimes(2)
    expect(host.extractRun.mock.calls[1]?.[0]).toMatchObject({ groupId: 'grp_2', claim: 'clm_2' })
  })

  it('sends the planned range and the whole-body fingerprint', async () => {
    const host = fakeHost()
    oneGroup(host)
    const { engine } = engineWith(host)
    await engine.tick()
    expect(host.extractRun).toHaveBeenCalledWith({
      groupId: 'grp_1',
      claim: 'clm_1',
      items: [
        { sourceId: 'src_1', version: 'v1', fingerprint: FINGERPRINT, segment: 0, start: 0, end: BODY.length, text: BODY }
      ],
      profileId: null,
      effort: 'high'
    })
  })

  it('reads only the slice the helper asked for', async () => {
    const host = fakeHost()
    oneGroup(host, { ...GROUP, items: [{ sourceId: 'src_1', version: 'v1', segment: 3, start: 2, end: 4 }] })
    const { engine } = engineWith(host)
    await engine.tick()
    expect(host.extractRun.mock.calls[0]?.[0].items[0]).toMatchObject({ segment: 3, start: 2, end: 4, text: '正文' })
  })

  it('releases the claim when the body is gone instead of calling the model', async () => {
    const host = fakeHost()
    oneGroup(host)
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
    const host = fakeHost()
    oneGroup(host)
    const { engine } = engineWith(host, { readBody: () => ({ missing: 'unknown' }) })
    await engine.tick()
    expect(host.extractFail).toHaveBeenCalledWith({
      groupId: 'grp_1',
      claim: 'clm_1',
      code: 'internal',
      reason: '来源暂时无法读取'
    })
  })

  it('settles a failing batch with the error code instead of leaving it working', async () => {
    const host = fakeHost()
    oneGroup(host)
    host.extractRun.mockImplementation(async () => {
      throw new KnowledgeError('invalid_output', '模型输出无法解析')
    })
    const log = vi.fn()
    const { engine } = engineWith(host, { log })
    await expect(engine.tick()).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('模型输出无法解析'))
    expect(host.extractFail).toHaveBeenCalledWith({
      groupId: 'grp_1',
      claim: 'clm_1',
      code: 'invalid_output',
      reason: '模型输出无法解析'
    })
  })

  it('parks a cancelled batch when the switch closed mid-flight', async () => {
    const host = fakeHost()
    oneGroup(host)
    let allowed = true
    host.extractRun.mockImplementation(async () => {
      allowed = false
      throw new KnowledgeError('cancelled', 'the request was cancelled')
    })
    const { engine } = engineWith(host, { allowed: () => allowed })
    await engine.tick()
    expect(host.extractFail).toHaveBeenCalledWith({
      groupId: 'grp_1',
      claim: 'clm_1',
      code: 'paused',
      reason: 'the request was cancelled'
    })
  })

  it('never runs two batches at once, and does not lose a wake', async () => {
    let release: () => void = () => undefined
    const host = fakeHost()
    oneGroup(host)
    host.extractRun.mockImplementation(
      () =>
        new Promise(resolve => {
          release = () => resolve(OUTCOME)
        }) as never
    )
    const { engine, scheduled } = engineWith(host)
    const first = engine.tick()
    engine.wake()
    await engine.tick()
    expect(host.extractRun).toHaveBeenCalledTimes(1)
    release()
    await first
    // The wake that arrived during the batch re-arms a tick instead of vanishing.
    expect(scheduled.at(-1)?.delay).toBe(0)
  })

  it('aborts the in-flight batch through the host', async () => {
    const host = fakeHost()
    const { engine } = engineWith(host)
    engine.abort('采集已暂停')
    expect(host.cancelInFlight).toHaveBeenCalledWith('采集已暂停', 'extract.run')
  })

  it('passes the configured extraction profile and effort', async () => {
    const host = fakeHost()
    oneGroup(host)
    const settings = mergeSettings({
      ...DEFAULT_SETTINGS,
      knowledge: { ...DEFAULT_SETTINGS.knowledge, profileId: 'p1', effort: 'medium' }
    })
    const { engine } = engineWith(host, { settings: () => settings })
    await engine.tick()
    expect(host.extractRun).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'p1', effort: 'medium' }))
  })

  it('stops ticking once it is stopped', async () => {
    const host = fakeHost()
    oneGroup(host)
    const { engine, scheduled } = engineWith(host)
    engine.stop()
    engine.wake()
    await engine.tick()
    expect(host.extractNext).not.toHaveBeenCalled()
    expect(scheduled).toHaveLength(0)
  })
})
