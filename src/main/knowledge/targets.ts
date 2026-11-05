/**
 * Turning a stored knowledge source into something the renderer may open.
 *
 * The renderer never receives a path or a chat id it can act on directly: it
 * asks for a target, the main process resolves it from the source record it
 * already trusts, and only then does anything get opened. A chat source stores
 * `threadId:userId:answerId`, so the raw `originRef` is never a message id.
 */

import type { KnowledgeSource, SourceTarget } from '@shared/knowledge'
import type { LocalRecord } from '@shared/workspace'
import type { NoteEntry } from '@shared/types'

export interface ChatRef {
  threadId: string
  userId: string
  answerId: string
}

/** Splits the composite chat reference. Anything else is not a chat source. */
export function parseChatRef(originRef: string): ChatRef | null {
  const parts = originRef.split(':')
  if (parts.length !== 3) return null
  const [threadId, userId, answerId] = parts
  if (!threadId || !userId || !answerId) return null
  return { threadId, userId, answerId }
}

export interface TargetDeps {
  /** The note with this id, or undefined when it is gone. */
  note(id: string): NoteEntry | undefined
  /** One message of one thread, resolved through the real chat store. */
  chat(threadId: string, messageId: string): LocalRecord | undefined
  /** Where an attachment lives, by attachment id alone. */
  attachment(id: string): { threadId: string; messageId: string } | undefined
  /**
   * The real path of a file the app itself owns, or null.
   *
   * A source row only carries a locator, and `knowledge.source-save` can write any
   * locator. A path therefore counts as openable only when the main process can
   * verify the file is one of its own records (the notes directory), which is the
   * only read credential that does not come from the source row itself.
   */
  ownedFile(path: string): string | null
  /** True for the http(s) links the app is willing to hand to the OS. */
  url(value: string): boolean
}

function noteRecord(note: NoteEntry): LocalRecord {
  return {
    kind: 'note',
    id: note.id,
    title: note.title || note.transcript.slice(0, 80),
    text: note.polished || note.transcript,
    at: note.createdAt
  }
}

/**
 * Resolves one source. The question and the answer of a turn are two messages,
 * so both are tried before the source is called missing.
 */
export function resolveSourceTarget(source: KnowledgeSource, deps: TargetDeps): SourceTarget {
  if (source.state !== 'active') {
    return { kind: 'none', reason: source.invalidReason || '来源已失效' }
  }
  if (source.kind === 'note') {
    const note = deps.note(source.originRef)
    return note ? { kind: 'record', record: noteRecord(note) } : { kind: 'none', reason: '原随记已不存在' }
  }
  if (source.kind === 'chat') {
    const ref = parseChatRef(source.originRef)
    if (!ref) return { kind: 'none', reason: '该来源没有可定位的会话' }
    const record = deps.chat(ref.threadId, ref.userId) ?? deps.chat(ref.threadId, ref.answerId)
    return record ? { kind: 'record', record } : { kind: 'none', reason: '原记录已不存在，请刷新后重试' }
  }
  if (source.kind === 'web') {
    return deps.url(source.locator) ? { kind: 'url', url: source.locator } : { kind: 'none', reason: '该来源没有可打开的网页地址' }
  }
  // A reading material stores whichever locator it had: a URL, an attachment id
  // or a file path. Each one resolves differently, and an unresolvable one says
  // so instead of pretending the row is openable.
  if (source.locator && deps.url(source.locator)) return { kind: 'url', url: source.locator }
  if (source.locator) {
    const attachment = deps.attachment(source.locator)
    if (attachment) {
      const record = deps.chat(attachment.threadId, attachment.messageId)
      if (record) return { kind: 'record', record }
    }
  }
  // A bare path is not evidence: only a file the app owns may be handed to the OS.
  const owned = source.locator ? deps.ownedFile(source.locator) : null
  if (owned) return { kind: 'file', path: owned }
  return { kind: 'none', reason: '该来源没有可核验的读取记录' }
}
