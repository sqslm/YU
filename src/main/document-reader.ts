import { open } from 'node:fs/promises'
import { extname, posix } from 'node:path'
import { decodePlainText, documentText, listZipEntries, readZipEntry, stripXmlText } from './file-index'
import { pdfText } from './pdf-text'
import { cleanHtml } from './tools/read-webpage'
import { mt } from '@shared/mainI18n'

export const CURRENT_CONTENT_CHARS = 48_000
const MAX_BYTES = 32 * 1024 * 1024
const TEXT = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.xml', '.yaml', '.yml', '.log', '.ini', '.toml', '.html', '.htm', '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.c', '.cpp', '.h', '.cs', '.rs', '.go', '.sql', '.css', '.srt', '.vtt'])

export function contentExcerpt(text: string): { text: string; truncated: boolean } {
  const clean = text.replace(/\u0000/g, '').trim()
  return { text: clean.slice(0, CURRENT_CONTENT_CHARS), truncated: clean.length > CURRENT_CONTENT_CHARS }
}

/** A bounded descriptor read shared by document extraction and image OCR. */
export async function readDocumentBytes(path: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted()
  const file = await open(path, 'r')
  let bytes: Buffer
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > maxBytes) throw new Error(mt('只支持不超过 {{size}} MiB 的普通文件', { size: maxBytes / 1024 / 1024 }))
    // Read a bounded amount even if another program grows the file after stat.
    bytes = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1))
    let offset = 0
    while (offset < bytes.length) {
      signal?.throwIfAborted()
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, null)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset !== info.size) throw new Error(mt('文件正在变化，请保存后重试'))
    bytes = bytes.subarray(0, offset)
  } finally { await file.close() }
  signal?.throwIfAborted()
  return bytes
}

/** Read selected local documents without launching Office, macros or embedded links. */
export async function readDocument(path: string, signal?: AbortSignal): Promise<{ text: string; truncated: boolean }> {
  return readDocumentBuffer(path, await readDocumentBytes(path, MAX_BYTES, signal), signal)
}

/** Browser-selected chat attachments use the same bounded parser without temporary files. */
export async function readDocumentBuffer(path: string, bytes: Uint8Array, signal?: AbortSignal): Promise<{ text: string; truncated: boolean }> {
  signal?.throwIfAborted()
  if (bytes.byteLength > MAX_BYTES) throw new Error(mt('只支持不超过 {{size}} MiB 的普通文件', { size: MAX_BYTES / 1024 / 1024 }))
  const ext = extname(path).toLowerCase()
  if (!TEXT.has(ext) && !['.docx', '.xlsx', '.pptx', '.pdf', '.odt', '.ods', '.odp'].includes(ext)) throw new Error(mt('此文件格式暂不支持直接提取正文；请在编辑器中打开后重试，或转换为 PDF、Office 新格式或纯文本'))
  let text: string | null
  if (ext === '.pdf') text = await pdfText(bytes, 8000, signal)
  else if (['.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp'].includes(ext)) text = structuredOfficeText(bytes, ext)
  else if (ext === '.html' || ext === '.htm') text = cleanHtml(decodePlainText(bytes) ?? '').text
  else text = documentText(bytes, ext)
  signal?.throwIfAborted()
  if (!text?.trim()) throw new Error(mt('未提取到可读正文；文件可能为空、受密码保护、损坏或为扫描图片 PDF'))
  return contentExcerpt(text)
}

function structuredOfficeText(bytes: Uint8Array, ext: string): string {
  const entries = listZipEntries(bytes)
  const xml = (name: string): string => {
    const entry = entries.find(entry => entry.name === name)
    if (!entry) return ''
    const data = readZipEntry(bytes, entry)
    if (!data) throw new Error(mt('文档内容无法完整解析：{{name}}', { name }))
    return new TextDecoder().decode(data)
  }
  const attributes = (tag: string): Record<string, string> => Object.fromEntries([...tag.matchAll(/([\w:]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(match => [match[1], stripXmlText(match[2] ?? match[3])]))
  const relationships = (file: string, base: string): Map<string, string> => new Map([...xml(file).matchAll(/<Relationship\b[^>]*\/>/g)].flatMap(match => {
    const attr = attributes(match[0])
    return attr.Id && attr.Target && attr.TargetMode !== 'External' ? [[attr.Id, posix.normalize(attr.Target.startsWith('/') ? attr.Target.slice(1) : posix.join(base, attr.Target))]] : []
  }))
  if (ext === '.docx') {
    if (!entries.some(entry => entry.name === 'word/document.xml')) return ''
    return ['word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml'].map(name => stripXmlText(xml(name).replace(/<w:del\b[^>]*>[\s\S]*?<\/w:del>/g, ''))).join('\n')
  }
  if (ext === '.pptx') {
    const slides = entries.filter(entry => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    const rels = relationships('ppt/_rels/presentation.xml.rels', 'ppt')
    const ordered = [...xml('ppt/presentation.xml').matchAll(/<p:sldId\b[^>]*\/>/g)].map(match => rels.get(attributes(match[0])['r:id']) ?? '')
    let text = ''
    for (const [index, name] of (ordered.length ? ordered : slides.map(slide => slide.name)).entries()) {
      if (!name || !entries.some(entry => entry.name === name)) throw new Error(mt('文档内容无法完整解析：{{name}}', { name: 'slide' }))
      text += `[${index + 1}]\n${stripXmlText(xml(name))}\n`
      if (text.length > CURRENT_CONTENT_CHARS) break
    }
    return text
  }
  if (ext !== '.xlsx') return stripXmlText(xml('content.xml').replace(/<\/(?:text:p|text:h|table:table-row)>/g, '\n').replace(/<\/table:table-cell>/g, '\t'))
  const shared = [...xml('xl/sharedStrings.xml').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(match => stripXmlText(match[1]))
  const rels = relationships('xl/_rels/workbook.xml.rels', 'xl')
  const ordered = [...xml('xl/workbook.xml').matchAll(/<sheet\b[^>]*\/>/g)].map(match => attributes(match[0])).map(attr => ({ path: rels.get(attr['r:id']) ?? '', name: attr.name }))
  const sheets = ordered.length ? ordered : entries.filter(entry => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).map(entry => ({ path: entry.name, name: entry.name }))
  let text = ''
  for (const sheet of sheets) {
    if (!sheet.path || !entries.some(entry => entry.name === sheet.path)) throw new Error(mt('文档内容无法完整解析：{{name}}', { name: sheet.name }))
    text += `\n[${sheet.name}] (raw cell values; date/number formatting not applied)\n`
    for (const row of xml(sheet.path).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [...row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].map(cell => {
        const coordinate = /\br="([^"]+)"/.exec(cell[1])?.[1] ?? ''
        const value = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cell[2])?.[1] ?? ''
        const decoded = /\bt="s"/.test(cell[1]) ? shared[Number(value)] ?? '' : value ? stripXmlText(value) : /<f\b[^>]*>([\s\S]*?)<\/f>/.test(cell[2]) ? `=${stripXmlText(cell[2])} (no cached result)` : stripXmlText(cell[2])
        return `${coordinate}: ${decoded}`
      })
      text += cells.join('\t') + '\n'
      if (text.length > CURRENT_CONTENT_CHARS) return text
    }
  }
  return text
}
