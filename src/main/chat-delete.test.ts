import { describe, expect, it, vi } from 'vitest'

import { deleteThread } from './chat-delete'
import type { ChatDeleteDeps } from './chat-delete'

const input = { action: 'delete', id: 't1', deleteKnowledge: true, ticket: 't1' } as const

function deps(overrides: Partial<ChatDeleteDeps> = {}): ChatDeleteDeps {
  const order: string[] = []
  const base: ChatDeleteDeps = {
    edit: vi.fn(async () => { order.push('edit') }),
    verify: vi.fn(async () => { order.push('verify') }),
    settle: vi.fn(async (_id, body) => body()),
    purge: vi.fn(async () => { order.push('purge') }),
    pending: vi.fn(() => ({ id: 'retry-1', reason: 'database is locked', cards: true }))
  }
  return { ...base, ...overrides }
}

describe('deleting a conversation and the knowledge only it supported', () => {
  it('proves the preview first, then writes the thread, then settles', async () => {
    const order: string[] = []
    const d = deps({
      verify: vi.fn(async () => { order.push('verify') }),
      edit: vi.fn(async () => { order.push('edit') }),
      purge: vi.fn(async () => { order.push('purge') })
    })

    await expect(deleteThread(d, input)).resolves.toBeUndefined()

    expect(order).toEqual(['verify', 'edit', 'purge'])
    expect(d.purge).toHaveBeenCalledWith(
      { channel: 'chat', groupKey: 't1' },
      { channel: 'chat', groupKey: 't1' },
      { cards: true, ticket: 't1' }
    )
    expect(d.pending).not.toHaveBeenCalled()
  })

  it('skips the preview when the user kept the knowledge', async () => {
    const d = deps()
    await deleteThread(d, { action: 'delete', id: 't1' })
    expect(d.verify).not.toHaveBeenCalled()
    expect(d.purge).toHaveBeenCalledWith(
      { channel: 'chat', groupKey: 't1' },
      { channel: 'chat', groupKey: 't1' },
      { cards: false, ticket: undefined }
    )
  })

  it('hands back a retry when the ticked cleanup fails after the thread is gone', async () => {
    const d = deps({ purge: vi.fn(async () => { throw new Error('database is locked') }) })

    const result = await deleteThread(d, input)

    expect(result).toEqual({ id: 'retry-1', reason: 'database is locked', cards: true })
    // The thread was really deleted, so the page is not told about a record that
    // no longer exists: it gets the reason plus the handle to finish the cleanup.
    expect(d.edit).toHaveBeenCalledOnce()
    expect(d.pending).toHaveBeenCalledWith(
      { channel: 'chat', groupKey: 't1' },
      { reason: 'database is locked', ticket: 't1' }
    )
  })

  it('keeps the default wording when the kept-knowledge cleanup fails', async () => {
    const d = deps({ purge: vi.fn(async () => { throw new Error('database is locked') }) })

    await expect(deleteThread(d, { action: 'delete', id: 't1' })).rejects.toThrow('对话已删除，但关联知识清理失败：database is locked')
    // Keeping the cards stays helper-driven, so no manual retry is created for it.
    expect(d.pending).not.toHaveBeenCalled()
  })

  it('keeps the write error untouched and settles nothing', async () => {
    const d = deps({ edit: vi.fn(async () => { throw new Error('threads.db is locked') }) })

    await expect(deleteThread(d, input)).rejects.toThrow('threads.db is locked')

    expect(d.purge).not.toHaveBeenCalled()
    expect(d.pending).not.toHaveBeenCalled()
  })

  it('deletes nothing when the preview no longer holds', async () => {
    const d = deps({ verify: vi.fn(async () => { throw new Error('预览已失效，请重新确认') }) })

    await expect(deleteThread(d, input)).rejects.toThrow('预览已失效，请重新确认')

    expect(d.edit).not.toHaveBeenCalled()
    expect(d.pending).not.toHaveBeenCalled()
  })
})
