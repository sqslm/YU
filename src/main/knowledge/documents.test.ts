/**
 * A document is openable only through a read record the main process kept.
 *
 * Two things are being pinned here. First, directory ownership is not evidence:
 * a file inside the notes root without a read record is refused, and a file
 * outside it with a matching record is allowed. Second, a readable script stays a
 * script — the record is necessary but not sufficient.
 *
 * The last case drives the real release helper, so the fingerprint the decision
 * compares against is the one Rust itself computed for the text YU read.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import type { KnowledgeSource } from '@shared/knowledge'

import { documentPath, extensionOf } from './documents'
import { fingerprintOf } from './engine'
import { KnowledgeHost } from './host'

function source(over: Partial<KnowledgeSource> = {}): KnowledgeSource {
  return {
    id: 's1',
    kind: 'document',
    originRef: 'file:1',
    locator: '',
    title: '标题',
    version: '1',
    scope: '',
    readAt: null,
    fingerprint: '',
    size: 10,
    state: 'active',
    invalidReason: null,
    createdAt: 1,
    updatedAt: 1,
    ...over
  }
}

const roots: string[] = []

function scratch(): { notes: string; outside: string } {
  const base = mkdtempSync(join(tmpdir(), 'yu-knowledge-doc-'))
  const notes = join(base, 'notes')
  const outside = join(base, 'outside')
  mkdirSync(notes, { recursive: true })
  mkdirSync(outside, { recursive: true })
  roots.push(base)
  return { notes, outside }
}

/** The production file check: a canonical existing regular file, or null. */
function file(value: string): string | null {
  try {
    const real = realpathSync(value)
    return statSync(real).isFile() ? real : null
  } catch {
    return null
  }
}

function write(path: string, text: string): string {
  writeFileSync(path, text, 'utf8')
  return realpathSync(path)
}

afterAll(() => {
  for (const base of roots) rmSync(base, { recursive: true, force: true })
})

describe('extensionOf', () => {
  it('reads the extension and ignores queries, fragments and directories', () => {
    expect(extensionOf('C:/notes/报告.PDF?x=1#p2')).toBe('.pdf')
    expect(extensionOf('/home/a.b/report.docx')).toBe('.docx')
    expect(extensionOf('C:/notes/no-extension')).toBe('')
  })
})

describe('documentPath', () => {
  it('opens a document it read, wherever the file lives', () => {
    const { notes, outside } = scratch()
    const inside = write(join(notes, 'a.pdf'), 'PDF 正文')
    const away = write(join(outside, 'b.docx'), 'DOCX 正文')
    expect(documentPath(source({ locator: inside, fingerprint: fingerprintOf('PDF 正文') }), { read: () => 'PDF 正文', file }))
      .toEqual({ path: inside })
    // Ownership is irrelevant: the record is what authorises the path.
    expect(documentPath(source({ locator: away, fingerprint: fingerprintOf('DOCX 正文') }), { read: () => 'DOCX 正文', file }))
      .toEqual({ path: away })
  })

  it('refuses a file inside the notes root that was never read', () => {
    const { notes } = scratch()
    const path = write(join(notes, 'unread.txt'), '没人读过我')
    expect(documentPath(source({ locator: path }), { read: () => null, file }))
      .toEqual({ reason: '该来源没有可核验的读取记录' })
  })

  it('refuses a body that no longer matches the stored hash', () => {
    const { notes } = scratch()
    const path = write(join(notes, 'edited.md'), '改过的正文')
    expect(documentPath(source({ locator: path, fingerprint: fingerprintOf('原来的正文') }), { read: () => '改过的正文', file }))
      .toEqual({ reason: '该来源的正文与读取记录不符' })
  })

  it('refuses a script even when the read record exists', () => {
    const { notes } = scratch()
    const cmd = write(join(notes, 'inert.cmd'), 'echo hi')
    expect(documentPath(source({ locator: cmd, fingerprint: fingerprintOf('echo hi') }), { read: () => 'echo hi', file }))
      .toEqual({ reason: '这类文件不提供打开' })
    const exe = write(join(notes, 'setup.exe'), 'MZ')
    expect(documentPath(source({ locator: exe, fingerprint: fingerprintOf('MZ') }), { read: () => 'MZ', file }))
      .toEqual({ reason: '这类文件不提供打开' })
  })

  it('refuses a URL, a missing file and an empty locator', () => {
    const { notes } = scratch()
    expect(documentPath(source({ locator: 'https://example.com/a.pdf' }), { read: () => 'x', file }))
      .toEqual({ reason: '该来源没有可打开的文件' })
    expect(documentPath(source({ locator: '' }), { read: () => 'x', file }))
      .toEqual({ reason: '该来源没有可打开的文件' })
    const gone = join(notes, 'gone.pdf')
    expect(documentPath(source({ locator: gone, fingerprint: fingerprintOf('x') }), { read: () => 'x', file }))
      .toEqual({ reason: '原文件已不存在' })
  })

  it('lets the real helper mint the fingerprint that authorises a real file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yu-knowledge-docreal-'))
    roots.push(root)
    const host = new KnowledgeHost({ entry: join(process.cwd(), 'native', 'bin', 'yu-knowledge.exe'), root, requestMs: 20_000 })
    try {
      const { notes } = scratch()
      const text = '这是一份 YU 真的读过的文档正文。'
      const path = write(join(notes, 'read.pdf'), text)
      const saved = await host.saveSource({
        kind: 'document',
        originRef: 'file:read',
        locator: path,
        title: '读过的文档',
        version: '1',
        scope: '',
        readAt: 1,
        text
      })
      // The hash comes from Rust, not from this test.
      expect(saved.fingerprint).toBe(fingerprintOf(text))
      expect(documentPath({ ...source({ locator: path }), fingerprint: saved.fingerprint }, { read: () => text, file }))
        .toEqual({ path })
      // Forgetting the read (a restart, an evicted body) keeps the row readable
      // and refuses the open with the real reason.
      expect(documentPath({ ...source({ locator: path }), fingerprint: saved.fingerprint }, { read: () => null, file }))
        .toEqual({ reason: '该来源没有可核验的读取记录' })
    } finally {
      await host.stop()
    }
  }, 60_000)
})
