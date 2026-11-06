/**
 * The backup window closes a gate over the helpers' background work. A batch that
 * was claimed before the door shut must be handed back instead of being written
 * while the databases are being copied, and parking has to wait until it is.
 */
import { describe, expect, it, vi } from 'vitest'
import { mergeSettings, DEFAULT_SETTINGS } from '@shared/defaults'
import { HistoryDriver } from './history'
import { ProfileCollector } from './profile'
import type { KnowledgeHost } from './host'

const deferred = <T>() => {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('background work and the maintenance gate', () => {
  it('stops a history walk whose status answer lands after the gate closed', async () => {
    const status = deferred<{ job: { id: string; state: string } }>()
    let allowed = true
    const host = {
      historyStatus: vi.fn(() => status.promise),
      stepHistory: vi.fn()
    }
    const driver = new HistoryDriver({
      host: () => host as unknown as KnowledgeHost,
      allowed: () => allowed,
      pages: { notes: () => ({ rows: [], cursor: '', done: true }), chat: () => ({ rows: [], cursor: '', done: true }) },
      log: () => undefined
    })
    const walk = driver.walk('job_1', { notes: true, chat: true })
    await Promise.resolve()
    allowed = false
    status.resolve({ job: { id: 'job_1', state: 'running' } })
    await walk
    // A page started here would be written into the database being snapshotted.
    expect(host.stepHistory).not.toHaveBeenCalled()
  })

  it('parks until the status call it is waiting on comes back', async () => {
    const status = deferred<{ job: { id: string; state: string } }>()
    const host = { historyStatus: vi.fn(() => status.promise), stepHistory: vi.fn() }
    const driver = new HistoryDriver({
      host: () => host as unknown as KnowledgeHost,
      allowed: () => true,
      pages: { notes: () => ({ rows: [], cursor: '', done: true }), chat: () => ({ rows: [], cursor: '', done: true }) },
      log: () => undefined
    })
    void driver.walk('job_2', { notes: true, chat: true })
    await Promise.resolve()
    let parked = false
    const park = driver.park().then(() => { parked = true })
    await Promise.resolve()
    expect(parked).toBe(false)
    status.resolve({ job: { id: 'job_2', state: 'paused' } })
    await park
    expect(parked).toBe(true)
  })

  it('hands a claimed profile batch back when the gate closed meanwhile', async () => {
    const next = deferred<{ batch: { claim: string } }>()
    let allowed = true
    const host = {
      learnNext: vi.fn(() => next.promise),
      learnRun: vi.fn(),
      learnFail: vi.fn(async () => ({ claim: 'clm_1' })),
      cancelInFlight: vi.fn(() => 0)
    }
    const collector = new ProfileCollector({
      settings: () => mergeSettings({ ...DEFAULT_SETTINGS, userProfile: { ...DEFAULT_SETTINGS.userProfile, enabled: true } }),
      host: () => host as unknown as KnowledgeHost,
      allowed: () => allowed,
      log: () => undefined,
      schedule: () => ({ cancel: () => undefined })
    })
    collector.wake()
    await Promise.resolve()
    allowed = false
    next.resolve({ batch: { claim: 'clm_1' } })
    await collector.settled()
    expect(host.learnRun).not.toHaveBeenCalled()
    expect(host.learnFail).toHaveBeenCalledWith(expect.objectContaining({ claim: 'clm_1', code: 'cancelled' }))
  })
})
