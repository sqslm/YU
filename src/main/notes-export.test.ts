import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dialog } from 'electron'
import { setMainLanguage } from '@shared/mainI18n'
import type { NoteEntry, NoteStore } from '@shared/types'
import type { NotesStore } from './notes'
import { exportNoteAudio, exportNoteText, formatNotesExport } from './notes-export'

vi.mock('electron', () => ({ dialog: { showSaveDialog: vi.fn() } }))

const at = new Date(2026, 9, 22, 9, 30, 0).getTime()
function note(id: string, patch: Partial<NoteEntry> = {}): NoteEntry {
  return { id, createdAt: at, updatedAt: at, transcript: `原文 ${id}\n第二行`, polished: `润色 ${id}`, durationMs: 12_300, polishStatus: 'ok', tags: ['重点'], ...patch }
}

describe('portable notes export', () => {
  let dir: string
  let snapshot: NoteStore
  let store: NotesStore
  let source: string
  beforeEach(async () => {
    vi.resetAllMocks()
    setMainLanguage('zh')
    dir = await mkdtemp(join(tmpdir(), 'typeless-export-'))
    source = join(dir, 'original.ogg')
    await writeFile(source, Buffer.from('OggS original recording bytes'))
    snapshot = { notes: [note('one', { categoryId: 'meeting', audioPath: 'audio/original.ogg', version: 42, audioUploaded: true }), note('two')], categories: [{ id: 'meeting', name: '每周会议' }] }
    store = { list: () => structuredClone(snapshot), audioPathOf: (id: string) => id === 'one' ? source : null } as unknown as NotesStore
  })
  afterEach(async () => { setMainLanguage('zh'); await rm(dir, { recursive: true, force: true }) })

  it('writes selected Markdown with metadata and both unmodified texts, without private bookkeeping', async () => {
    const target = join(dir, 'notes.md')
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: target })
    const original = structuredClone(snapshot)
    expect(await exportNoteText(store, ['one'], 'markdown')).toEqual({ path: target, count: 1 })
    const body = await readFile(target, 'utf8')
    expect(body).toContain('# 随记导出\n')
    expect(body).toContain('## 2026-10-22 09:30:00')
    expect(body).toContain('- 分类：每周会议')
    expect(body).toContain('- 标签：重点')
    expect(body).toContain('原文 one\n第二行')
    expect(body).toContain('润色 one')
    for (const hidden of ['原文 two', 'audio/original.ogg', 'version', 'audioUploaded', 'pending', dir]) expect(body).not.toContain(hidden)
    expect(snapshot).toEqual(original)
    expect(await readFile(source, 'utf8')).toBe('OggS original recording bytes')
  })

  it('preserves requested order, removes duplicate IDs and writes plain text without generated Markdown headings', async () => {
    const target = join(dir, 'notes.txt')
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: target })
    expect((await exportNoteText(store, ['two', 'one', 'two'], 'text'))?.count).toBe(2)
    const body = await readFile(target, 'utf8')
    expect(body.indexOf('原文 two')).toBeLessThan(body.indexOf('原文 one'))
    expect(body.match(/原文 two/g)).toHaveLength(1)
    expect(body).not.toMatch(/^#+ /m)
    expect(body).not.toMatch(/^- /m)
  })

  it('handles empty text, missing categories, Markdown metacharacters and English labels', () => {
    const entry = note('n', { transcript: '', polished: '', categoryId: 'missing', tags: ['[tag]', '#topic'] })
    const md = formatNotesExport([entry], [], 'markdown')
    expect(md).toContain('\\[tag\\] / \\#topic')
    expect(md).not.toContain('分类：')
    expect(md.match(/（无内容）/g)).toHaveLength(2)
    setMainLanguage('en')
    const en = formatNotesExport([entry], [], 'text')
    expect(en).toContain('Voice notes export')
    expect(en).toContain('Transcript')
    expect(en).toContain('(empty)')
  })

  it('does not open a dialog for empty, malformed or stale selections or invalid formats', async () => {
    await expect(exportNoteText(store, [], 'markdown')).rejects.toThrow('请选择')
    await expect(exportNoteText(store, [123] as never, 'markdown')).rejects.toThrow('请选择')
    await expect(exportNoteText(store, ['one', 'deleted'], 'markdown')).rejects.toThrow('已不存在')
    await expect(exportNoteText(store, ['one'], 'html' as never)).rejects.toThrow('不支持')
    expect(dialog.showSaveDialog).not.toHaveBeenCalled()
  })

  it('canceling either dialog leaves the source and destination directory untouched', async () => {
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: true, filePath: '' })
    expect(await exportNoteText(store, ['one'], 'markdown')).toBeNull()
    expect(await exportNoteAudio(store, 'one')).toBeNull()
    expect(await readdir(dir)).toEqual(['original.ogg'])
    expect(await readFile(source, 'utf8')).toBe('OggS original recording bytes')
  })

  it.each(['ogg', 'wav'])('copies the original %s bytes without modifying or transcoding the recording', async (format) => {
    source = join(dir, `source.${format}`)
    const bytes = Buffer.from([0, 10, 255, 128, 11])
    await writeFile(source, bytes)
    const target = join(dir, `copy.${format}`)
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: target })
    expect(await exportNoteAudio(store, 'one')).toBe(target)
    expect(await readFile(target)).toEqual(bytes)
    expect(await readFile(source)).toEqual(bytes)
    expect(vi.mocked(dialog.showSaveDialog).mock.calls[0][0]).toMatchObject({ filters: [{ extensions: [format] }] })
  })

  it('refuses missing recordings and saving over the original', async () => {
    await expect(exportNoteAudio(store, 'two')).rejects.toThrow('没有可保存')
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: source })
    await expect(exportNoteAudio(store, 'one')).rejects.toThrow('原始录音以外')
    expect(await readFile(source, 'utf8')).toBe('OggS original recording bytes')
    await rm(source)
    await expect(exportNoteAudio(store, 'one')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('surfaces write errors instead of reporting an export success', async () => {
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: join(dir, 'missing', 'note.md') })
    await expect(exportNoteText(store, ['one'], 'markdown')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
