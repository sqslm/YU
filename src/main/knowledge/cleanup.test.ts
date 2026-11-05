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

  it('hands a page only the rows of its own channel, without the record or ticket', async () => {
    const cleanups = new CleanupRetries(() => deps())
    const note = cleanups.add(input, identity, { reason: 'database is locked', ticket: 't1' })
    const thread = cleanups.add(
      { channel: 'chat', groupKey: 'th1' },
      { channel: 'chat', groupKey: 'th1' },
      { reason: 'cannot start the knowledge helper', ticket: 't2' }
    )

    const notes = cleanups.list('note')
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ id: note.id, reason: 'database is locked', stale: false })
    // Nothing that could widen the range travels back to the page.
    expect(Object.keys(notes[0]).sort()).toEqual(['at', 'busy', 'cards', 'id', 'reason', 'stale'])
    expect(cleanups.list('chat').map(row => row.id)).toEqual([thread.id])
    expect(cleanups.list('reminder')).toEqual([])
  })

  it('remembers a refused ticket even when the downgrade fails too', async () => {
    const moved = Object.assign(new Error('预览已失效，请重新确认'), { code: 'source_changed' })
    let lock = true
    const d = deps({
      purgeCards: vi.fn(async () => {
        throw moved
      }),
      release: vi.fn(async () =>
        lock
          ? { retired: 0, detached: 0, cancelled: [], failures: ['database is locked'] }
          : { retired: 1, detached: 0, cancelled: ['q1'], failures: [] }
      )
    })
    const cleanups = new CleanupRetries(() => d)
    const handle = cleanups.add(input, identity, { reason: 'database is locked', ticket: 't1' })

    await expect(cleanups.retry(handle.id, 'purge')).resolves.toMatchObject({ status: 'stale' })
    expect(cleanups.list('note')[0]).toMatchObject({ stale: true })

    // The library is locked again during the downgrade: the offer has to survive.
    await expect(cleanups.retry(handle.id, 'release')).resolves.toMatchObject({ status: 'failed' })
    const after = cleanups.list('note')
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ stale: true, reason: 'database is locked' })

    lock = false
    await expect(cleanups.retry(handle.id, 'release')).resolves.toMatchObject({ status: 'done' })
    expect(cleanups.list('note')).toEqual([])
  })

  it('leaves the other rows alone when one of them finishes', async () => {
    const cleanups = new CleanupRetries(() => deps())
    const first = cleanups.add(input, identity, { reason: 'database is locked', ticket: 't1' })
    const second = cleanups.add(
      { channel: 'note', originRef: 'n2' },
      { channel: 'note', originRef: 'n2' },
      { reason: 'database is locked', ticket: 't2' }
    )

    await cleanups.retry(first.id, 'purge')

    expect(cleanups.list('note').map(row => row.id)).toEqual([second.id])
  })

  it('names the channel on every change a page can see, and never the record', async () => {
    const seen: string[] = []
    const cleanups = new CleanupRetries(() => deps(), channel => seen.push(channel))
    const handle = cleanups.add(input, identity, { reason: 'database is locked', ticket: 't1' })
    expect(seen).toEqual(['note'])

    await cleanups.retry(handle.id, 'purge')

    // A start and a settle: both are changes the page has to pick up.
    expect(seen).toEqual(['note', 'note', 'note'])
    expect(seen.every(channel => channel === 'note')).toBe(true)
    cleanups.add({ channel: 'chat', groupKey: 'th1' }, { channel: 'chat', groupKey: 'th1' }, { reason: 'x' })
    expect(seen.at(-1)).toBe('chat')
  })

  it('reports the attempt as in flight while it runs, and settles the revision', async () => {
    let finish: (value: { removed: string[]; kept: string[]; skipped: string[] }) => void = () => {}
    const purgeCards = vi.fn(
      () =>
        new Promise<{ removed: string[]; kept: string[]; skipped: string[] }>(resolve => {
          finish = resolve
        })
    )
    const cleanups = new CleanupRetries(() => deps({ purgeCards: purgeCards as never }))
    const handle = cleanups.add(input, identity, { reason: 'database is locked', ticket: 't1' })
    const before = cleanups.snapshot('note')

    const running = cleanups.retry(handle.id, 'purge')
    const during = cleanups.snapshot('note')

    expect(before.revision).toBeLessThan(during.revision)
    expect(during.rows[0]).toMatchObject({ id: handle.id, busy: true })

    finish({ removed: ['c1'], kept: [], skipped: [] })
    await running
    const after = cleanups.snapshot('note')

    expect(after.revision).toBeGreaterThan(during.revision)
    expect(after.rows).toEqual([])
  })

  it('refuses a handle that is already finished', async () => {
    const cleanups = new CleanupRetries(() => deps())
    await expect(cleanups.retry('gone', 'purge')).rejects.toThrow('这次知识清理已经结束，不需要再重试')
  })
})
