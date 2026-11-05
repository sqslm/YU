/**
 * Opening a source is the only path from a stored row to the OS.
 *
 * The reverse cases matter more than the happy one: a locator written by
 * `source.save` must never reach the opener, and neither must a protocol the app
 * does not trust. The opener itself is injected, so nothing is really launched.
 */

import { describe, expect, it } from 'vitest'

import type { KnowledgeSource } from '@shared/knowledge'

import { openSource, type OpenDeps } from './open'
import { resolveSourceTarget, type TargetDeps } from './targets'
import { documentPath } from './documents'
import { fingerprintOf } from './engine'

function source(over: Partial<KnowledgeSource> = {}): KnowledgeSource {
  return {
    id: 's1',
    kind: 'document',
    originRef: 'x',
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

function targets(over: Partial<TargetDeps> = {}): TargetDeps {
  return {
    note: () => undefined,
    chat: () => undefined,
    attachment: () => undefined,
    document: value => documentPath(value, { read: () => null, file: () => null }),
    url: value => value.startsWith('https://'),
    ...over
  }
}

interface Calls {
  external: string[]
  file: string[]
}

function deps(calls: Calls, over: Partial<TargetDeps> = {}, failure = ''): OpenDeps {
  return {
    resolve: row => resolveSourceTarget(row, targets(over)),
    external: url => { calls.external.push(url) },
    file: async path => { calls.file.push(path); return failure }
  }
}

describe('openSource', () => {
  it('opens a trusted web source', async () => {
    const calls: Calls = { external: [], file: [] }
    const result = await openSource(source({ locator: 'https://example.com/a' }), deps(calls))
    expect(result).toEqual({ opened: true, reason: '' })
    expect(calls).toEqual({ external: ['https://example.com/a'], file: [] })
  })

  it('never hands a fabricated locator to the file opener', async () => {
    const calls: Calls = { external: [], file: [] }
    // Exactly what `knowledge:source-save` can write: a plain path on disk.
    const result = await openSource(source({ locator: 'C:/Users/someone/notes/fake.txt' }), deps(calls))
    expect(result).toEqual({ opened: false, reason: '该来源没有可核验的读取记录' })
    expect(calls).toEqual({ external: [], file: [] })
  })

  it('opens a document it really read and reports the opener failure verbatim', async () => {
    const calls: Calls = { external: [], file: [] }
    // The production decision, fed by a real read record for this exact text.
    const read = { read: () => 'PDF 正文', file: (value: string) => value }
    const readDeps = (failure = ''): Partial<TargetDeps> => ({ document: value => documentPath(value, read) })
    const body = { fingerprint: fingerprintOf('PDF 正文') }
    const ok = await openSource(source({ locator: 'C:/notes/a.pdf', ...body }), deps(calls, readDeps()))
    expect(ok).toEqual({ opened: true, reason: '' })
    const bad = await openSource(source({ locator: 'C:/notes/b.pdf', ...body }), deps(calls, readDeps(), '文件已被删除'))
    expect(bad).toEqual({ opened: false, reason: '文件已被删除' })
    expect(calls.file).toEqual(['C:/notes/a.pdf', 'C:/notes/b.pdf'])
  })

  it('refuses a script or an unread body even when the path exists', async () => {
    const calls: Calls = { external: [], file: [] }
    const read = { read: () => 'echo hi', file: (value: string) => value }
    const readDeps: Partial<TargetDeps> = { document: value => documentPath(value, read) }
    const digest = { fingerprint: fingerprintOf('echo hi') }
    // A readable script is still not a document.
    expect(await openSource(source({ locator: 'C:/notes/inert.cmd', ...digest }), deps(calls, readDeps)))
      .toEqual({ opened: false, reason: '这类文件不提供打开' })
    // A real document whose stored hash is not the hash that was read.
    expect(await openSource(source({ locator: 'C:/notes/c.pdf', fingerprint: fingerprintOf('别的正文') }), deps(calls, readDeps)))
      .toEqual({ opened: false, reason: '该来源的正文与读取记录不符' })
    // No read record at all, e.g. after a restart.
    expect(await openSource(source({ locator: 'C:/notes/d.pdf', ...digest }), deps(calls)))
      .toEqual({ opened: false, reason: '该来源没有可核验的读取记录' })
    expect(calls).toEqual({ external: [], file: [] })
  })

  it('refuses a protocol the app does not trust even if the resolver said url', async () => {
    const calls: Calls = { external: [], file: [] }
    const forced: OpenDeps = {
      resolve: () => ({ kind: 'url', url: 'file:///C:/Windows/System32/calc.exe' }),
      external: url => { calls.external.push(url) },
      file: async path => { calls.file.push(path); return '' }
    }
    const result = await openSource(source(), forced)
    expect(result.opened).toBe(false)
    expect(calls).toEqual({ external: [], file: [] })
  })

  it('reports a chat source as a record instead of opening anything', async () => {
    const calls: Calls = { external: [], file: [] }
    const result = await openSource(
      source({ kind: 'chat', originRef: 't1:u1:a1', locator: '' }),
      deps(calls, { chat: (threadId, messageId) => ({ kind: 'chat', id: messageId, threadId, title: '会话', text: '内容', at: 5 }) })
    )
    expect(result).toEqual({ opened: false, reason: '请打开对应记录' })
    expect(calls).toEqual({ external: [], file: [] })
  })

  it('refuses an invalid source through the resolver, not by guessing', async () => {
    const calls: Calls = { external: [], file: [] }
    const result = await openSource(source({ locator: 'https://example.com/a', state: 'invalid', invalidReason: '原记录已删除' }), deps(calls))
    expect(result.opened).toBe(false)
    expect(calls.external).toEqual([])
  })
})
