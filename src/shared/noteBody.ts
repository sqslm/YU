import type { NoteEntry } from './types'

/** The editable body shown by the notes page, including an intentionally cleared body. */
export function noteBodyField(note: Pick<NoteEntry, 'polished' | 'polishStatus'>): 'polished' | 'transcript' {
  return note.polished.trim() || ['pending', 'ok'].includes(note.polishStatus) ? 'polished' : 'transcript'
}
