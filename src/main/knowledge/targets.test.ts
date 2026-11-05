/**
 * Source resolution is the one place a stored source becomes something the
 * window may open, so every branch is exercised with synthetic stores: a chat
 * source only ever carries `threadId:userId:answerId`, and a reading material
 * may carry a URL, an attachment id or a path.
 */

import { describe, expect, it } from 'vitest'

import type { KnowledgeSource } from '@shared/knowledge'
import type { LocalRecord } from '@shared/workspace'
import type { NoteEntry } from '@shared/types'

import { parseChatRef, resolveSourceTarget, type TargetDeps } from './targets'

function source(over: Partial<KnowledgeSource> = {}): KnowledgeSource {
  return {
    id: 's1',
    kind: 'note',
    originRef: 'n1',
    locator: '',
    title: '标题',
    version: '1',
    scope: '',
    readAt: null,
    fingerprint: 'f',
    size: 10,
    state: 'active',
    invalidReason: null,
    createdAt: 1,
    updatedAt: 1,
    ...over
  }
}

function note(id: string): NoteEntry {
  return { id, title: '随记标题', transcript: '原文', polished: '', tags: [], durationMs: 0, polishStatus: 'ok', createdAt: 7, updatedAt: 7 } as NoteEntry
}

function chatRecord(id: string, threadId: string): LocalRecord {
  return { kind: 'chat', id, threadId, title: '会话', text: '内容', at: 5 }
}

function deps(over: Partial<TargetDeps> = {}): TargetDeps {
  return {
    note: () => undefined,
    chat: () => undefined,
    attachment: () => undefined,
    ownedFile: () => null,
    url: value => value.startsWith('https://'),
    ...over
  }
}

describe('parseChatRef', () => {
  it('splits the composite chat identity', () => {
    expect(parseChatRef('t1:u1:a1')).toEqual({ threadId: 't1', userId: 'u1', answerId: 'a1' })
  })

  it('refuses anything that is not three non-empty parts', () => {
    expect(parseChatRef('t1')).toBeNull()
    expect(parseChatRef('t1:u1')).toBeNull()
    expect(parseChatRef('t1::a1')).toBeNull()
  })
})

describe('resolveSourceTarget', () => {
  it('keeps an invalid source closed and repeats its real reason', () => {
    expect(resolveSourceTarget(source({ state: 'invalid', invalidReason: '会话已删除' }), deps()))
      .toEqual({ kind: 'none', reason: '会话已删除' })
  })

  it('opens the note it points at', () => {
    const target = resolveSourceTarget(source(), deps({ note: id => (id === 'n1' ? note('n1') : undefined) }))
    expect(target).toMatchObject({ kind: 'record', record: { kind: 'note', id: 'n1', title: '随记标题' } })
  })

  it('says the note is gone instead of opening nothing', () => {
    expect(resolveSourceTarget(source(), deps())).toEqual({ kind: 'none', reason: '原随记已不存在' })
  })

  it('turns the composite chat reference into the real thread and message', () => {
    const seen: string[] = []
    const target = resolveSourceTarget(
      source({ kind: 'chat', originRef: 't1:u1:a1' }),
      deps({ chat: (threadId, messageId) => { seen.push(`${threadId}/${messageId}`); return messageId === 'u1' ? chatRecord('u1', 't1') : undefined } })
    )
    expect(seen).toEqual(['t1/u1'])
    expect(target).toMatchObject({ kind: 'record', record: { kind: 'chat', id: 'u1', threadId: 't1' } })
  })

  it('falls back to the answer message when the question is gone', () => {
    const target = resolveSourceTarget(
      source({ kind: 'chat', originRef: 't1:u1:a1' }),
      deps({ chat: (_threadId, messageId) => (messageId === 'a1' ? chatRecord('a1', 't1') : undefined) })
    )
    expect(target).toMatchObject({ kind: 'record', record: { id: 'a1' } })
  })

  it('refuses a chat source with no usable thread', () => {
    expect(resolveSourceTarget(source({ kind: 'chat', originRef: 'u1' }), deps()))
      .toEqual({ kind: 'none', reason: '该来源没有可定位的会话' })
  })

  it('reports a deleted chat instead of opening the thread root', () => {
    expect(resolveSourceTarget(source({ kind: 'chat', originRef: 't1:u1:a1' }), deps()))
      .toEqual({ kind: 'none', reason: '原记录已不存在，请刷新后重试' })
  })

  it('opens a safe web locator and refuses an unsafe one', () => {
    expect(resolveSourceTarget(source({ kind: 'web', locator: 'https://example.com/a' }), deps()))
      .toEqual({ kind: 'url', url: 'https://example.com/a' })
    expect(resolveSourceTarget(source({ kind: 'web', locator: 'file:///C:/x.exe' }), deps()))
      .toEqual({ kind: 'none', reason: '该来源没有可打开的网页地址' })
  })

  it('resolves a document attachment through the message that owns it', () => {
    const target = resolveSourceTarget(
      source({ kind: 'document', locator: 'att1' }),
      deps({
        attachment: id => (id === 'att1' ? { threadId: 't9', messageId: 'm9' } : undefined),
        chat: (threadId, messageId) => (threadId === 't9' && messageId === 'm9' ? chatRecord('m9', 't9') : undefined)
      })
    )
    expect(target).toMatchObject({ kind: 'record', record: { id: 'm9', threadId: 't9' } })
  })

  it('opens an app-owned document and refuses a locator with no read credential', () => {
    expect(resolveSourceTarget(source({ kind: 'document', locator: 'C:/notes/a.pdf' }), deps({ ownedFile: value => value })))
      .toEqual({ kind: 'file', path: 'C:/notes/a.pdf' })
    // A locator written through `source.save` proves nothing: without an owned
    // read record it stays a metadata row.
    expect(resolveSourceTarget(source({ kind: 'document', locator: 'C:/anywhere/gone.pdf' }), deps()))
      .toEqual({ kind: 'none', reason: '该来源没有可核验的读取记录' })
  })

  it('prefers a safe web locator over the file branch for a reading source', () => {
    expect(resolveSourceTarget(source({ kind: 'document', locator: 'https://example.com/p' }), deps({ ownedFile: value => value })))
      .toEqual({ kind: 'url', url: 'https://example.com/p' })
  })
})
