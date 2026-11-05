/**
 * Whether a stored document source may be handed to the operating system.
 *
 * A source row is writable from the renderer (`knowledge:source-save`), so its
 * own kind, locator, title or fingerprint can never authorise anything. What
 * counts is the read record the main process itself kept for that source: the
 * text it actually read, whose hash has to be the hash stored with the source.
 * Losing that record — a restart, an evicted body, an old library — is answered
 * with the real reason instead of a path.
 *
 * Only document types the app read on purpose are openable; scripts, shortcuts
 * and executables are refused even when the record exists.
 */

import type { KnowledgeSource } from '@shared/knowledge'
import { fingerprintOf } from './engine'

/** Extensions a document source may carry. Everything else is refused. */
const DOCUMENTS = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.odt',
  '.rtf',
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.tsv',
  '.xls',
  '.xlsx',
  '.ods',
  '.ppt',
  '.pptx',
  '.epub',
  '.html',
  '.htm'
])

export interface DocumentDeps {
  /** The text the main process really read for this source, or null. */
  read(source: KnowledgeSource): string | null
  /** The canonical path of an existing regular file, or null. */
  file(value: string): string | null
}

export type DocumentDecision = { path: string } | { reason: string }

const NO_RECORD = '该来源没有可核验的读取记录'

/** The extension of a locator, lowercased. Query strings and fragments ignored. */
export function extensionOf(value: string): string {
  const cut = value.split(/[?#]/)[0]
  const dot = cut.lastIndexOf('.')
  const slash = Math.max(cut.lastIndexOf('/'), cut.lastIndexOf('\\'))
  return dot > slash ? cut.slice(dot).toLowerCase() : ''
}

/**
 * The path this document source may open, or why it may not.
 *
 * The order matters: a URL is not a file, an unknown type is refused before any
 * read happens, and the read record is checked before the file is touched.
 */
export function documentPath(source: KnowledgeSource, deps: DocumentDeps): DocumentDecision {
  const locator = source.locator
  // `C:/x.pdf` is a path, not a scheme: only an explicit `scheme://` is a URL.
  if (!locator || /^[a-z][a-z0-9+.-]*:\/\//i.test(locator)) return { reason: '该来源没有可打开的文件' }
  if (!DOCUMENTS.has(extensionOf(locator))) return { reason: '这类文件不提供打开' }
  const text = deps.read(source)
  if (!text) return { reason: NO_RECORD }
  if (fingerprintOf(text) !== source.fingerprint) return { reason: '该来源的正文与读取记录不符' }
  const path = deps.file(locator)
  return path ? { path } : { reason: '原文件已不存在' }
}
