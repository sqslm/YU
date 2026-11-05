import { describe, expect, it, vi } from 'vitest'

import { CleanupRetries } from './cleanup'
import type { CleanupDeps } from './cleanup'

const input = { channel: 'note', originRef: 'n1' } as const
const identity = { channel: 'note', originRef: 'n1' } as const

function deps(overrides: Partial<CleanupDeps> = {}): CleanupDeps {
  return {
    purgeCards: vi.fn(async () => ({ removed: ['c1'], kept: [], skipped: [] })),
    release: vi.fn(async () => ({ retired: 2, detached: 1, cancelled: ['q1'], failures: [] })),
    log: vi.fn(),
    ...overrides
  }
}

describe('finishing a cleanup that failed after its record was deleted', () => {
  it('deletes the confirmed cards and forgets the handle', async () => {
    const d = deps()
    const cleanups = new CleanupRetries(() => d)
    const handle = cleanups.add(input, identity, { reason: 'database is locked', ticket: 't1' })
    expect(handle.cards).toBe(true)
    expect(cleanups.waiting).toBe(1)

    const result = await cleanups.retry(handle.id, 'purge')

    // The ticket the user already confirmed travels again; the helper decides again.
    expect(d.purgeCards).toHaveBeenCalledWith({
      record: identity,
      confirm: { sources: [], ticket: 't1' },
      cards: true
    })
    expect(result).toEqual({ status: 'done', removed: 1, kept: 0, released: 0 })
    expect(cleanups.waiting).toBe(0)
  })

  it('keeps the handle when the library is still unreachable', async () => {
    const d = deps({ purgeCards: vi.fn(async () => { throw new Error('database is locked') }) })
    const cleanups = new CleanupRetries(() => d)
    const handle = cleanups.add(input, identity, { reason: 'database is locked', ticket: 't1' })

    const result = await cleanups.retry(handle.id, 'purge')

    // A failure is not a downgrade: the same offer stands, with the real reason.
    expect(result.status).toBe('failed')
    expect(result.reason).toBe('database is locked')
    expect(cleanups.waiting).toBe(1)
  })

  it('reports a moved range as stale and deletes nothing', async () => {
    const error = Object.assign(new Error('预览已失效，请重新确认'), { code: 'source_changed' })
    const d = deps({ purgeCards: vi.fn(async () => { throw error }) })
    const cleanups = new CleanupRetries(() => d)
    const handle = cleanups.add(input, identity, { reason: 'database is locked', ticket: 't1' })

    const result = await cleanups.retry(handle.id, 'purge')

    expect(result.status).toBe('stale')
    expect(result.removed).toBe(0)
    // Still offered: the user may pick the downgrade now that the range moved.
    expect(cleanups.waiting).toBe(1)
    expect(d.release).not.toHaveBeenCalled()
  })

  it('only withdraws the sources when the user chooses to keep the cards', async () => {
    const d = deps()
    const cleanups = new CleanupRetries(() => d)
    const handle = cleanups.add(input, identity, { reason: 'database is locked', ticket: 't1' })

    const result = await cleanups.retry(handle.id, 'release')

    expect(d.release).toHaveBeenCalledWith(input, '记录已删除')
    expect(d.purgeCards).not.toHaveBeenCalled()
    expect(result).toEqual({ status: 'done', removed: 0, kept: 1, released: 2 })
    expect(cleanups.waiting).toBe(0)
  })

  it('keeps the handle when the source withdrawal fails too', async () => {
    const d = deps({
      release: vi.fn(async () => ({ retired: 0, detached: 0, cancelled: [], failures: ['database is locked'] }))
    })
    const cleanups = new CleanupRetries(() => d)
    const handle = cleanups.add(input, identity, { reason: 'database is locked', ticket: 't1' })

    const result = await cleanups.retry(handle.id, 'release')

    expect(result.status).toBe('failed')
    expect(result.reason).toBe('database is locked')
    expect(cleanups.waiting).toBe(1)
  })

  it('runs one attempt for repeated clicks', async () => {
    let release: (value: { removed: string[]; kept: string[]; skipped: string[] }) => void = () => {}
    const purgeCards = vi.fn(() => new Promise<{ removed: string[]; kept: string[]; skipped: string[] }>(resolve => { release = resolve }))
    const cleanups = new CleanupRetries(() => deps({ purgeCards: purgeCards as never }))
    const handle = cleanups.add(input, identity, { reason: 'database is locked', ticket: 't1' })

    const first = cleanups.retry(handle.id, 'purge')
    const second = cleanups.retry(handle.id, 'purge')
    expect(second).toBe(first)
    release({ removed: ['c1'], kept: [], skipped: [] })
    await expect(first).resolves.toMatchObject({ status: 'done' })
    expect(purgeCards).toHaveBeenCalledTimes(1)
  })

  it('refuses a handle that is already finished', async () => {
    const cleanups = new CleanupRetries(() => deps())
    await expect(cleanups.retry('gone', 'purge')).rejects.toThrow('这次知识清理已经结束，不需要再重试')
  })
})
