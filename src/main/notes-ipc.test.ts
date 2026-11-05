import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const mock = vi.hoisted(() => ({ serve: null as null | ((request: Request) => Promise<Response>), handlers: new Map<string, (...args: any[]) => any>(), clipboard: vi.fn(), openDialog: vi.fn() }))
vi.mock('electron', () => ({ clipboard: { readText: mock.clipboard }, dialog: { showOpenDialog: mock.openDialog }, ipcMain: { handle: (key: string, handler: (...args: any[]) => any) => mock.handlers.set(key, handler) }, protocol: { handle: (_scheme: string, handler: typeof mock.serve) => { mock.serve = handler } } }))
vi.mock('./audio/decode', () => ({ decodeRecording: vi.fn() }))
import { markdownDocParts, registerNotesIpc } from './notes-ipc'
const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true }); vi.clearAllMocks() })

describe('recording audio ranges', () => {
  it('passes explicit answer text to the existing notes store without reading or overwriting the clipboard', async () => {
    const createText = vi.fn(async input => input), broadcast = vi.fn()
    registerNotesIpc({ store: { createText } as never, persistDir: vi.fn(), broadcast })
    expect(await mock.handlers.get('notes:createText')!(null, { text: '## Answer\n\nSaved content' })).toEqual({ text: '## Answer\n\nSaved content', categoryId: undefined })
    expect(mock.clipboard).not.toHaveBeenCalled(); expect(broadcast).toHaveBeenCalledOnce()
    mock.clipboard.mockReturnValue('Clipboard note')
    await mock.handlers.get('notes:createText')!(null, { fromClipboard: true, text: 'Ignored explicit text' })
    expect(createText).toHaveBeenLastCalledWith({ text: 'Clipboard note', categoryId: undefined })
  })
  it.each([
    ['bytes=-4', 206, '6789', 'bytes 6-9/10'],
    ['bytes=3-', 206, '3456789', 'bytes 3-9/10'],
    ['bytes=2-5', 206, '2345', 'bytes 2-5/10'],
    ['bytes=-100', 206, '0123456789', 'bytes 0-9/10'],
    ['bytes=-0', 416, '', 'bytes */10'],
    ['bytes=11-', 416, '', 'bytes */10']
  ])('serves %s without changing the requested byte positions', async (range, status, body, contentRange) => {
    const dir = await mkdtemp(join(tmpdir(), 'typeless-audio-range-')); dirs.push(dir)
    const file = join(dir, 'recording.ogg'); await writeFile(file, '0123456789')
    registerNotesIpc({ store: { audioPathOf: () => file } as never, persistDir: vi.fn(), broadcast: vi.fn() })
    const response = await mock.serve!(new Request('typeless-audio://note/qa', { headers: { Range: range } }))
    expect(response.status).toBe(status); expect(await response.text()).toBe(body)
    expect(response.headers.get('content-range')).toBe(contentRange)
  })
  it('serves copied attachments with the actual image MIME and refuses unknown targets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeless-attachment-')); dirs.push(dir)
    const file = join(dir, 'picture.png'); await writeFile(file, 'copied picture bytes')
    const attachmentPathOf = vi.fn((id, path) => id === 'qa' && path === 'attachments/7161/picture.png' ? file : null)
    registerNotesIpc({ store: { attachmentPathOf } as never, persistDir: vi.fn(), broadcast: vi.fn() })
    const response = await mock.serve!(new Request('typeless-audio://attachment/qa/attachments/7161/picture.png'))
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await response.text()).toBe('copied picture bytes')
    expect((await mock.serve!(new Request('typeless-audio://attachment/qa/other.pdf'))).status).toBe(404)
    expect((await mock.serve!(new Request('typeless-audio://unknown/qa'))).status).toBe(404)
  })
})

describe('markdown import', () => {
  it('takes the first H1 as the title and strips it from the body', () => {
    expect(markdownDocParts('\uFEFF# 周会记录\n\n讨论了三件事。\n\n- 一\n', 'notes.md'))
      .toEqual({ title: '周会记录', body: '讨论了三件事。\n\n- 一' })
    expect(markdownDocParts('<br>\n\n## 次级标题不能当标题\n', '带前缀.txt'))
      .toEqual({ title: '带前缀', body: '<br>\n\n## 次级标题不能当标题' })
  })
  it('keeps a heading-only file readable instead of creating an empty note', () => {
    expect(markdownDocParts('# 只有标题\n', 'x.md')).toEqual({ title: '只有标题', body: '# 只有标题' })
    expect(markdownDocParts('', '空文件.md')).toEqual({ title: '空文件', body: '' })
  })
  it('imports every selected file, skipping the unreadable ones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeless-md-')); dirs.push(dir)
    const ok = join(dir, 'first.md'); await writeFile(ok, '# 一篇\n\n甲')
    const plain = join(dir, 'second.markdown'); await writeFile(plain, '没有标题的正文')
    const missing = join(dir, 'gone.md')
    mock.openDialog.mockResolvedValue({ canceled: false, filePaths: [ok, missing, plain] })
    let created = 0
    const createText = vi.fn(async (input: { text: string }) => { created += 1; return { id: `note-${created}`, title: '', text: input.text } })
    const update = vi.fn()
    const broadcast = vi.fn()
    registerNotesIpc({ store: { createText, update } as never, persistDir: vi.fn(), broadcast })
    const result = await mock.handlers.get('notes:importMarkdown')!(null, undefined)
    expect(result).toEqual({ count: 2, ids: ['note-1', 'note-2'], failed: ['gone.md'] })
    expect(createText).toHaveBeenNthCalledWith(1, { text: '甲', categoryId: undefined })
    expect(createText).toHaveBeenNthCalledWith(2, { text: '没有标题的正文', categoryId: undefined })
    // 有 H1 的那篇补标题，没有的用文件名
    expect(update).toHaveBeenCalledWith('note-1', { title: '一篇' })
    expect(update).toHaveBeenCalledWith('note-2', { title: 'second' })
    expect(broadcast).toHaveBeenCalledOnce()
  })
  it('does nothing when the picker is cancelled', async () => {
    mock.openDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    const createText = vi.fn()
    registerNotesIpc({ store: { createText } as never, persistDir: vi.fn(), broadcast: vi.fn() })
    expect(await mock.handlers.get('notes:importMarkdown')!(null, undefined)).toBeNull()
    expect(createText).not.toHaveBeenCalled()
  })

describe('deleting a note with the knowledge option', () => {
  it('removes the dependent knowledge first so a refusal leaves the note readable', async () => {
    const order: string[] = []
    const purgeKnowledge = vi.fn(async (id: string) => { order.push('knowledge:' + id) })
    const remove = vi.fn(async (id: string) => { order.push('note:' + id) })
    const broadcast = vi.fn()
    registerNotesIpc({ store: { remove } as never, persistDir: vi.fn(), broadcast, purgeKnowledge })
    await mock.handlers.get('notes:remove')!(null, 'n1', { deleteKnowledge: true, ticket: 't1' })
    // The record really goes first; the knowledge settles afterwards, quoting the
    // snapshot the user confirmed.
    expect(order).toEqual(['note:n1', 'knowledge:n1'])
    expect(purgeKnowledge).toHaveBeenCalledWith('n1', { cards: true, ticket: 't1' })
    expect(broadcast).toHaveBeenCalledOnce()
  })

  it('reports a cleanup failure as a partial failure, never as a kept note', async () => {
    const remove = vi.fn(async () => undefined), broadcast = vi.fn()
    const purgeKnowledge = vi.fn(async () => { throw new Error('预览已失效，请重新确认') })
    registerNotesIpc({ store: { remove } as never, persistDir: vi.fn(), broadcast, purgeKnowledge })
    await expect(mock.handlers.get('notes:remove')!(null, 'n1', { deleteKnowledge: true, ticket: 'old' }))
      .rejects.toThrow('预览已失效，请重新确认')
    expect(remove).toHaveBeenCalledWith('n1')
    expect(broadcast).toHaveBeenCalledOnce()
  })

  it('hands the page a retry when a ticked cleanup fails after the note is gone', async () => {
    const remove = vi.fn(async () => undefined), broadcast = vi.fn()
    const purgeKnowledge = vi.fn(async () => { throw new Error('database is locked') })
    const pendingCleanup = vi.fn(() => ({ id: 'retry-1', reason: 'database is locked', cards: true }))
    registerNotesIpc({ store: { remove } as never, persistDir: vi.fn(), broadcast, purgeKnowledge, pendingCleanup })
    // The note is deleted either way, so the failure becomes a handle the user can
    // act on instead of an error about a record that no longer exists.
    await expect(mock.handlers.get('notes:remove')!(null, 'n1', { deleteKnowledge: true, ticket: 't1' }))
      .resolves.toEqual({ id: 'retry-1', reason: 'database is locked', cards: true })
    expect(remove).toHaveBeenCalledWith('n1')
    expect(purgeKnowledge).toHaveBeenCalledWith('n1', { cards: true, ticket: 't1' })
    expect(pendingCleanup).toHaveBeenCalledWith('n1', { reason: 'database is locked', ticket: 't1' })
    expect(broadcast).toHaveBeenCalledOnce()
  })

  it('never turns the default cleanup into a retry', async () => {
    const purgeKnowledge = vi.fn(async () => { throw new Error('database is locked') })
    const pendingCleanup = vi.fn()
    registerNotesIpc({ store: { remove: vi.fn(async () => undefined) } as never, persistDir: vi.fn(), broadcast: vi.fn(), purgeKnowledge, pendingCleanup })
    // Keeping the cards is the helper-driven path: it keeps its own wording and its
    // onReady recovery, so nothing about it becomes a manual retry.
    await expect(mock.handlers.get('notes:remove')!(null, 'n1')).rejects.toThrow('记录已删除，但关联知识清理失败')
    expect(pendingCleanup).not.toHaveBeenCalled()
  })

  it('still settles the source when the option was not ticked', async () => {
    const remove = vi.fn(async () => undefined), purgeKnowledge = vi.fn()
    registerNotesIpc({ store: { remove } as never, persistDir: vi.fn(), broadcast: vi.fn(), purgeKnowledge })
    await mock.handlers.get('notes:remove')!(null, 'n1')
    // The default keeps every card and only marks the source deleted.
    expect(purgeKnowledge).toHaveBeenCalledWith('n1', { cards: false })
    expect(remove).toHaveBeenCalledWith('n1')
  })
})

  it('registers one settle owner around the whole removal', async () => {
    // The store's own onRemoved callback must not claim the record first, and a
    // failed write must still run inside that registration.
    const settle = vi.fn(async (_id: string, body: () => Promise<void>) => body())
    const remove = vi.fn(async () => { throw new Error('disk is full') })
    registerNotesIpc({ store: { remove } as never, persistDir: vi.fn(), broadcast: vi.fn(), settle: settle as never })
    await expect(mock.handlers.get('notes:remove')!(null, 'n1', { deleteKnowledge: true, ticket: 't1' })).rejects.toThrow('disk is full')
    expect(settle.mock.calls[0][0]).toBe('n1')
    expect(remove).toHaveBeenCalledWith('n1')
  })

  it('keeps the record write error when the write itself fails', async () => {
    const settle = vi.fn(async (_id: string, body: () => Promise<void>) => body())
    const remove = vi.fn(async () => { throw new Error('disk is full') })
    registerNotesIpc({ store: { remove } as never, persistDir: vi.fn(), broadcast: vi.fn(), settle: settle as never, purgeKnowledge: vi.fn() })
    // The partial-failure wording belongs to a settle that failed after a real
    // removal; a failed write must reach the caller unchanged.
    await expect(mock.handlers.get('notes:remove')!(null, 'n1', { deleteKnowledge: true, ticket: 't1' })).rejects.toThrow('disk is full')
    await expect(mock.handlers.get('notes:remove')!(null, 'n1', { deleteKnowledge: true, ticket: 't1' })).rejects.not.toThrow('关联知识清理失败')
  })
})
