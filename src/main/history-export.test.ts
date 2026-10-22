import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dialog } from 'electron'
import type { HistoryEntry } from '@shared/types'
import { setMainLanguage } from '@shared/mainI18n'
import { exportHistory, formatHistoryExport } from './history-export'

vi.mock('electron', () => ({ dialog: { showSaveDialog: vi.fn() } }))
const at = new Date(2026, 9, 22, 9, 30).getTime()
const entry = (id: string, patch: Partial<HistoryEntry> = {}): HistoryEntry => ({ id, createdAt: at, mode: 'ask', transcript: '原始问题\n第二行', final: '## 完整回答\n原始格式', durationMs: 1200, app: 'Editor', promptName: '代码卡片', ...patch })

describe('filtered history export', () => {
  let dir: string
  beforeEach(async () => { vi.resetAllMocks(); setMainLanguage('zh'); dir = await mkdtemp(join(tmpdir(), 'typeless-history-export-')) })
  afterEach(async () => { setMainLanguage('zh'); await rm(dir, { recursive: true, force: true }) })

  it('exports all selected pages in order, not only the first 200 rows, without modifying records', async () => {
    const records = Array.from({ length: 231 }, (_, i) => entry(String(i), { final: `result-${i}` }))
    const snapshot = structuredClone(records)
    const store = { get: (id: string) => records.find(record => record.id === id) }
    const target = join(dir, 'history.md')
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: target })
    const ids = records.map(record => record.id).reverse()
    expect(await exportHistory(store, [...ids, ids[0]], 'markdown')).toEqual({ path: target, count: 231 })
    const text = await readFile(target, 'utf8')
    expect(text.match(/result-/g)).toHaveLength(231)
    expect(text.indexOf('result-230')).toBeLessThan(text.indexOf('result-0\n'))
    expect(records).toEqual(snapshot)
  })

  it('preserves text and safe sources, escapes metadata and excludes private paths and legacy failed rows', async () => {
    const good = entry('good', { status: 'archived', app: '[Editor]\n# injected', audioPath: 'private-audio.wav', appPath: 'private-process.exe', sources: [{ title: 'Source', url: 'https://source.test', snippet: 'snippet' }, { title: 'unsafe', url: 'javascript:alert(1)', snippet: '' }] })
    const bad = entry('failed', { status: 'error', error: 'failed' })
    const target = join(dir, 'history.md')
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: target })
    expect(await exportHistory({ get: id => id === 'good' ? good : bad }, ['good', 'failed'], 'markdown')).toMatchObject({ count: 1 })
    const text = await readFile(target, 'utf8')
    expect(text).toContain('## 完整回答\n原始格式')
    expect(text).toContain('\\[Editor\\] \\# injected')
    expect(text).toContain('https://source.test')
    for (const hidden of ['javascript:', 'private-audio.wav', 'private-process.exe', 'snippet']) expect(text).not.toContain(hidden)
    setMainLanguage('en')
    const plain = formatHistoryExport([entry('one', { transcript: '', final: 'plain answer' })], 'text')
    expect(plain).toContain('History export')
    expect(plain).not.toMatch(/^#+ /m)
  })

  it('does not open a dialog for missing, empty or abnormal-only selections; cancel writes nothing', async () => {
    const store = { get: (id: string) => id === 'bad' ? entry(id, { status: 'error' }) : undefined }
    await expect(exportHistory(store, [], 'text')).rejects.toThrow('请选择')
    await expect(exportHistory(store, ['missing'], 'text')).rejects.toThrow('已不存在')
    await expect(exportHistory(store, ['bad'], 'text')).rejects.toThrow('正常记录')
    expect(dialog.showSaveDialog).not.toHaveBeenCalled()
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: true, filePath: '' })
    expect(await exportHistory({ get: () => entry('one') }, ['one'], 'text')).toBeNull()
  })

  it('surfaces write failures', async () => {
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: join(dir, 'missing', 'file.txt') })
    await expect(exportHistory({ get: () => entry('one') }, ['one'], 'text')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
