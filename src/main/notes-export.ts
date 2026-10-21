import { copyFile, stat, writeFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { dialog } from 'electron'
import type { NoteCategory, NoteEntry, NoteExportFormat } from '@shared/types'
import { mt } from '@shared/mainI18n'
import type { NotesStore } from './notes'

/** Local timestamp shared by document headings and filesystem-safe names. */
function stamp(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** Metadata is literal text; note bodies keep the user's original formatting. */
function markdownText(text: string): string {
  return text.replace(/[\\`*_{}\[\]<>#!|]/g, '\\$&').replace(/[\r\n]+/g, ' ')
}

export function formatNotesExport(notes: readonly NoteEntry[], categories: readonly NoteCategory[], format: NoteExportFormat): string {
  const md = format === 'markdown'
  const names = new Map(categories.map(category => [category.id, category.name]))
  const heading = (level: number, text: string): string => md ? `${'#'.repeat(level)} ${text}` : text
  const literal = (text: string): string => md ? markdownText(text) : text
  const sections = notes.map(note => {
    const category = names.get(note.categoryId ?? '')
    const duration = Math.round(note.durationMs / 1000)
    const metadata = [
      `${mt('创建时间（本地）')}：${stamp(note.createdAt)}`,
      `${mt('录音时长')}：${mt('{{n}} 秒', { n: duration })}`,
      ...(category ? [`${mt('分类')}：${literal(category)}`] : []),
      ...(note.tags.length ? [`${mt('标签')}：${note.tags.map(literal).join(' / ')}`] : [])
    ].map(line => md ? `- ${line}` : line).join('\n')
    return [
      heading(2, stamp(note.createdAt)), metadata,
      heading(3, mt('原始转写')), note.transcript || mt('（无内容）'),
      heading(3, mt('润色文本')), note.polished || mt('（无内容）')
    ].join('\n\n')
  })
  return `${heading(1, mt('随记导出'))}\n\n${sections.join('\n\n---\n\n')}\n`
}

/** IDs are explicit: an empty/stale selection must never turn into "export all". */
function selectedNotes(store: NotesStore, ids: string[]): { notes: NoteEntry[]; categories: NoteCategory[] } {
  if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => typeof id !== 'string')) throw new Error(mt('请选择要导出的随记'))
  const snapshot = store.list()
  const byId = new Map(snapshot.notes.map(note => [note.id, note]))
  const notes = [...new Set(ids)].map(id => {
    const note = byId.get(id)
    if (!note) throw new Error(mt('部分随记已不存在，请刷新后重试'))
    return note
  })
  return { notes, categories: snapshot.categories }
}

export async function exportNoteText(store: NotesStore, ids: string[], format: NoteExportFormat): Promise<{ path: string; count: number } | null> {
  if (format !== 'markdown' && format !== 'text') throw new Error(mt('不支持的导出格式'))
  const { notes, categories } = selectedNotes(store, ids)
  const extension = format === 'markdown' ? 'md' : 'txt'
  const result = await dialog.showSaveDialog({
    title: mt('导出随记'),
    defaultPath: `${mt('随记')}-${stamp(Date.now()).replace(/[ :]/g, '-')}.${extension}`,
    filters: [{ name: format === 'markdown' ? 'Markdown' : mt('纯文本'), extensions: [extension] }]
  })
  if (result.canceled || !result.filePath) return null
  await writeFile(result.filePath, formatNotesExport(notes, categories, format), 'utf8')
  return { path: result.filePath, count: notes.length }
}

/** Preserve the original recording format; copy on disk without buffering it. */
export async function exportNoteAudio(store: NotesStore, id: string): Promise<string | null> {
  const { notes: [note] } = selectedNotes(store, [id])
  const source = store.audioPathOf(id)
  if (!source) throw new Error(mt('这条随记没有可保存的录音'))
  const extension = extname(source).slice(1).toLowerCase()
  if (!['wav', 'ogg'].includes(extension) || !(await stat(source)).isFile()) throw new Error(mt('录音文件不可用'))
  const result = await dialog.showSaveDialog({
    title: mt('保存随记录音'),
    defaultPath: `${mt('随记')}-${stamp(note.createdAt).replace(/[ :]/g, '-')}.${extension}`,
    filters: [{ name: `${extension.toUpperCase()} ${mt('录音')}`, extensions: [extension] }]
  })
  if (result.canceled || !result.filePath) return null
  const from = resolve(source), to = resolve(result.filePath)
  if (process.platform === 'win32' ? from.toLowerCase() === to.toLowerCase() : from === to) throw new Error(mt('请选择原始录音以外的保存位置'))
  await copyFile(source, result.filePath)
  return result.filePath
}
