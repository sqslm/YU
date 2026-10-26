import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, isAbsolute, join, relative } from 'node:path'
import type { NoteAttachment } from '@shared/noteAttachments'
import { mt } from '@shared/mainI18n'

export const MAX_NOTE_ATTACHMENT_BYTES = 50 * 1024 * 1024
const IMAGES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp' }
export const attachmentMime = (file: string): string => IMAGES[extname(file).toLowerCase()] || 'application/octet-stream'
export const noteAttachmentDirectory = (id: string): string => `attachments/${Buffer.from(id).toString('hex')}`

export function writeNoteAttachment(root: string, id: string, name: string, bytes: Uint8Array): NoteAttachment {
  if (typeof name !== 'string' || !name.trim() || !(bytes instanceof Uint8Array) || !bytes.length) throw new Error(mt('附件内容为空或格式无效'))
  if (bytes.length > MAX_NOTE_ATTACHMENT_BYTES) throw new Error(mt('单个附件不能超过 50 MB'))
  const safeName = basename(name.replace(/\\/g, '/')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(-160) || 'attachment'
  const path = `${noteAttachmentDirectory(id)}/${randomUUID()}-${safeName}`
  const directory = join(root, 'notes', noteAttachmentDirectory(id))
  mkdirSync(directory, { recursive: true })
  const notesRoot = realpathSync(join(root, 'notes'))
  const rel = relative(notesRoot, realpathSync(directory))
  if (rel.replace(/\\/g, '/') !== noteAttachmentDirectory(id)) throw new Error(mt('附件目录超出随记目录'))
  writeFileSync(join(root, 'notes', path), bytes, { flag: 'wx' })
  return { name: safeName, path, image: attachmentMime(safeName).startsWith('image/') }
}

export function importNoteAttachment(root: string, id: string, file: string): NoteAttachment {
  const info = statSync(file)
  if (!info.isFile() || info.size > MAX_NOTE_ATTACHMENT_BYTES) throw new Error(mt('请选择不超过 50 MB 的附件文件'))
  return writeNoteAttachment(root, id, basename(file), readFileSync(file))
}

/** A note cannot read another note's attachments, arbitrary files, or junction escapes. */
export function resolveNoteAttachment(root: string, id: string, path: string): string | null {
  if (typeof path !== 'string' || !path.startsWith(noteAttachmentDirectory(id) + '/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) return null
  try {
    const directory = realpathSync(join(root, 'notes', noteAttachmentDirectory(id)))
    const owned = relative(realpathSync(join(root, 'notes')), directory)
    const file = realpathSync(join(root, 'notes', path)), rel = relative(directory, file)
    if (owned.replace(/\\/g, '/') !== noteAttachmentDirectory(id) || !rel || rel.startsWith('..') || isAbsolute(rel) || !statSync(file).isFile()) return null
    return file
  } catch { return null }
}

/** Conflict copies get their own directory; deleting the old record cannot break them. */
export function forkNoteAttachments(root: string, from: string, to: string): void {
  const source = join(root, 'notes', noteAttachmentDirectory(from))
  if (!existsSync(source)) return
  const owned = relative(realpathSync(join(root, 'notes')), realpathSync(source)).replace(/\\/g, '/')
  if (owned !== noteAttachmentDirectory(from)) throw new Error(mt('附件目录超出随记目录'))
  cpSync(source, join(root, 'notes', noteAttachmentDirectory(to)), { recursive: true, dereference: false })
}

export function removeNoteAttachments(root: string, id: string): void {
  const directory = join(root, 'notes', noteAttachmentDirectory(id))
  if (!existsSync(directory)) return
  const owned = relative(realpathSync(join(root, 'notes')), realpathSync(directory)).replace(/\\/g, '/')
  if (owned !== noteAttachmentDirectory(id)) throw new Error(mt('附件目录超出随记目录'))
  rmSync(directory, { recursive: true })
}
