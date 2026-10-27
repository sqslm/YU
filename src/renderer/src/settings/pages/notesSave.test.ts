import { describe, expect, it } from 'vitest'
import type { NoteEntry, NotePatch } from '@shared/types'
import { saveNoteEdit, type PendingNoteEdit } from './notesSave'

function note(): NoteEntry {
  return { id: 'note', title: 'Original title', polished: 'Original body', transcript: '',
    createdAt: 1, updatedAt: 1, durationMs: 0, polishStatus: 'ok', tags: [] }
}

describe('note edits during a failed save', () => {
  it.each([false, true])('retries both fields and keeps a newer value for the same field: %s', async newerTitle => {
    const stored = note()
    const failed: PendingNoteEdit = { id: stored.id, patch: { title: 'Changed title' } }
    const pending: { current: PendingNoteEdit | null } = { current: null }
    let rejectWrite!: (error: Error) => void
    const blocked = new Promise<NoteEntry>((_resolve, reject) => { rejectWrite = reject })
    const writing = saveNoteEdit(failed, pending, () => blocked)
    const rejection = expect(writing).rejects.toThrow('Disk unavailable')
    pending.current = { id: stored.id, patch: { polished: 'Changed body', ...(newerTitle ? { title: 'Newest title' } : {}) } }
    rejectWrite(new Error('Disk unavailable'))
    await rejection

    const retry = pending.current!
    pending.current = null
    const saved = await saveNoteEdit(retry, pending, async (_id: string, patch: NotePatch) => Object.assign(stored, patch))
    expect(saved.title).toBe(newerTitle ? 'Newest title' : 'Changed title')
    expect(saved.polished).toBe('Changed body')
    expect(pending.current).toBeNull()
  })

  it('restores a failed edit when there are no newer keystrokes', async () => {
    const edit = { id: 'note', patch: { title: 'Changed title' } }
    const pending: { current: PendingNoteEdit | null } = { current: null }
    await expect(saveNoteEdit(edit, pending, async () => { throw new Error('Disk unavailable') })).rejects.toThrow('Disk unavailable')
    expect(pending.current).toEqual(edit)
  })

  it('does not consume newer edits when a write succeeds', async () => {
    const pending = { current: { id: 'note', patch: { polished: 'Newer body' } } }
    await saveNoteEdit({ id: 'note', patch: { title: 'Title' } }, pending, async () => note())
    expect(pending.current.patch.polished).toBe('Newer body')
  })
})
