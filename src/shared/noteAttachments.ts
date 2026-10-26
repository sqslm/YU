export interface NoteAttachment {
  name: string
  path: string
  image: boolean
}

/** Markdown targets remain relative to the note data directory. */
export function noteAttachmentUrl(noteId: string, path: string): string {
  return `typeless-audio://attachment/${encodeURIComponent(noteId)}/${encodeAttachmentTarget(decodeAttachmentTarget(path))}`
}

export const encodeAttachmentTarget = (path: string): string => path.split('/').map(encodeURIComponent).join('/')
export function decodeAttachmentTarget(path: string): string {
  try { return decodeURIComponent(path) } catch { return path }
}

export function attachmentMarkdown(file: NoteAttachment): string {
  const label = file.name.replace(/[\\[\]]/g, '\\$&')
  return `${file.image ? '!' : ''}[${label}](<${encodeAttachmentTarget(file.path)}>)`
}
