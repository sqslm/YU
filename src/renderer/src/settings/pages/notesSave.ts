import type { NoteEntry, NotePatch } from '@shared/types'

export interface PendingNoteEdit {
  id: string
  patch: NotePatch
}

/** Keep a failed write available for retry while the user continues editing. */
export async function saveNoteEdit(
  edit: PendingNoteEdit,
  pending: { current: PendingNoteEdit | null },
  update: (id: string, patch: NotePatch) => Promise<NoteEntry | undefined>
): Promise<NoteEntry> {
  try {
    const updated = await update(edit.id, edit.patch)
    if (!updated) throw new Error('Note no longer exists')
    return updated
  } catch (error) {
    const newer = pending.current
    pending.current = newer?.id === edit.id
      ? { id: edit.id, patch: { ...edit.patch, ...newer.patch } }
      : newer ?? edit
    throw error
  }
}
