import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EMPTY_HISTORY_VIEW,
  EMPTY_NOTES_VIEW,
  HISTORY_VIEW_KEY,
  NOTES_VIEW_KEY,
  PAGE_STATE_WRITE_MS,
  createPageStateWriter,
  pageStateStorage,
  readPageState,
  validateHistoryView,
  validateNotesView,
  writePageState,
  type PageStateStorage
} from './pageState'

/** 内存里的 localStorage：测试不碰用户真实的存储，也不需要起 Electron。 */
function memoryStorage(seed: Record<string, string> = {}): PageStateStorage & { dump(): Record<string, string> } {
  const cells = new Map(Object.entries(seed))
  return {
    getItem: (key) => cells.get(key) ?? null,
    setItem: (key, value) => { cells.set(key, value) },
    dump: () => Object.fromEntries(cells)
  }
}

describe('readPageState', () => {
  it('没存过就回落默认', () => {
    expect(readPageState(NOTES_VIEW_KEY, EMPTY_NOTES_VIEW, validateNotesView, memoryStorage())).toBe(EMPTY_NOTES_VIEW)
  })

  it('坏 JSON 回落默认', () => {
    const storage = memoryStorage({ [NOTES_VIEW_KEY]: '{"version":1,"query":' })
    expect(readPageState(NOTES_VIEW_KEY, EMPTY_NOTES_VIEW, validateNotesView, storage)).toBe(EMPTY_NOTES_VIEW)
  })

  it('旧版本（键里是 v2）读不到，回落默认', () => {
    const storage = memoryStorage({ 'notes.view.v2': JSON.stringify({ version: 2, query: '旧' }) })
    expect(readPageState('notes.view.v2', EMPTY_NOTES_VIEW, validateNotesView, storage)).toBe(EMPTY_NOTES_VIEW)
    expect(readPageState(NOTES_VIEW_KEY, EMPTY_NOTES_VIEW, validateNotesView, storage)).toBe(EMPTY_NOTES_VIEW)
  })

  it('版本号对不上时校验器拒绝整块', () => {
    const storage = memoryStorage({ [NOTES_VIEW_KEY]: JSON.stringify({ version: 2, query: '旧' }) })
    expect(readPageState(NOTES_VIEW_KEY, EMPTY_NOTES_VIEW, validateNotesView, storage)).toBe(EMPTY_NOTES_VIEW)
  })

  it('不是对象的值也回落默认', () => {
    for (const stored of ['null', '42', '"text"', '[]']) {
      const storage = memoryStorage({ [NOTES_VIEW_KEY]: stored })
      expect(readPageState(NOTES_VIEW_KEY, EMPTY_NOTES_VIEW, validateNotesView, storage)).toBe(EMPTY_NOTES_VIEW)
    }
  })

  it('校验器返回 null 或直接抛错都回落默认', () => {
    const storage = memoryStorage({ [NOTES_VIEW_KEY]: '{"version":1}' })
    expect(readPageState(NOTES_VIEW_KEY, EMPTY_NOTES_VIEW, () => null, storage)).toBe(EMPTY_NOTES_VIEW)
    expect(readPageState(NOTES_VIEW_KEY, EMPTY_NOTES_VIEW, () => { throw new Error('boom') }, storage)).toBe(EMPTY_NOTES_VIEW)
  })

  it('存储本身抛错也不炸（隐私模式）', () => {
    const storage: PageStateStorage = {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') }
    }
    expect(readPageState(NOTES_VIEW_KEY, EMPTY_NOTES_VIEW, validateNotesView, storage)).toBe(EMPTY_NOTES_VIEW)
    expect(writePageState(NOTES_VIEW_KEY, EMPTY_NOTES_VIEW, storage)).toBe(false)
  })

  it('好的快照原样回来', () => {
    const saved = { ...EMPTY_NOTES_VIEW, query: '周报', sort: 'oldest' as const, selectedId: 'n1' }
    const storage = memoryStorage({ [NOTES_VIEW_KEY]: JSON.stringify(saved) })
    expect(readPageState(NOTES_VIEW_KEY, EMPTY_NOTES_VIEW, validateNotesView, storage)).toEqual(saved)
  })

  it('没有 window（node/测试环境）时按没存过处理', () => {
    expect(pageStateStorage()).toBeNull()
    expect(readPageState(NOTES_VIEW_KEY, EMPTY_NOTES_VIEW, validateNotesView)).toBe(EMPTY_NOTES_VIEW)
    expect(writePageState(NOTES_VIEW_KEY, EMPTY_NOTES_VIEW)).toBe(false)
  })
})

describe('writePageState', () => {
  it('写下去的是 JSON，读回来是同一个值', () => {
    const storage = memoryStorage()
    expect(writePageState(HISTORY_VIEW_KEY, { ...EMPTY_HISTORY_VIEW, page: 4 }, storage)).toBe(true)
    expect(JSON.parse(storage.dump()[HISTORY_VIEW_KEY])).toMatchObject({ page: 4 })
    expect(readPageState(HISTORY_VIEW_KEY, EMPTY_HISTORY_VIEW, validateHistoryView, storage).page).toBe(4)
  })
})

describe('createPageStateWriter', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('窗口内的连续写入合成一次，写的是最后一次的值', () => {
    const writes: Array<[string, unknown]> = []
    const writer = createPageStateWriter<string>('notes.view.v1', (key, value) => { writes.push([key, value]) })

    writer.put('a')
    writer.put('ab')
    writer.put('abc')
    expect(writes).toHaveLength(0)
    expect(writer.pending()).toBe(true)

    vi.advanceTimersByTime(PAGE_STATE_WRITE_MS - 1)
    expect(writes).toHaveLength(0)

    vi.advanceTimersByTime(1)
    expect(writes).toEqual([['notes.view.v1', 'abc']])
    expect(writer.pending()).toBe(false)
  })

  it('窗口之间的写入分开落盘', () => {
    const writes: string[] = []
    const writer = createPageStateWriter<string>('k', (_key, value) => { writes.push(value as string) })

    writer.put('first')
    vi.advanceTimersByTime(PAGE_STATE_WRITE_MS)
    writer.put('second')
    vi.advanceTimersByTime(PAGE_STATE_WRITE_MS)
    expect(writes).toEqual(['first', 'second'])
  })

  it('flush 立刻落盘（页面卸载），没有待写值时不写', () => {
    const writes: string[] = []
    const writer = createPageStateWriter<string>('k', (_key, value) => { writes.push(value as string) })

    writer.flush()
    expect(writes).toEqual([])

    writer.put('late')
    writer.flush()
    expect(writes).toEqual(['late'])

    // flush 过的计时器不再回写一次。
    vi.advanceTimersByTime(PAGE_STATE_WRITE_MS * 2)
    expect(writes).toEqual(['late'])
  })
})

describe('validateNotesView', () => {
  it('非法 sort 回落 newest，非法 kind 回落 all', () => {
    const value = validateNotesView({ ...EMPTY_NOTES_VIEW, sort: 'popular', kind: 'video' })
    expect(value?.sort).toBe('newest')
    expect(value?.kind).toBe('all')
  })

  it('保留合法的 sort/kind', () => {
    const value = validateNotesView({ ...EMPTY_NOTES_VIEW, sort: 'updated', kind: 'audio' })
    expect(value?.sort).toBe('updated')
    expect(value?.kind).toBe('audio')
  })

  it('标签去空、去重（大小写不敏感）并截到上限', () => {
    const many = [' 工作 ', '工作', '', '  ', ...Array.from({ length: 20 }, (_, index) => `t${index}`)]
    const value = validateNotesView({ ...EMPTY_NOTES_VIEW, activeTags: many })
    expect(value?.activeTags[0]).toBe('工作')
    expect(value?.activeTags).toHaveLength(12)
    expect(value?.activeTags).not.toContain('')
    expect(value?.activeTags.filter((tag) => tag === '工作')).toHaveLength(1)
  })

  it('非数组标签当成没有标签', () => {
    expect(validateNotesView({ ...EMPTY_NOTES_VIEW, activeTags: '工作' })?.activeTags).toEqual([])
  })

  it('markdownPreview 只认布尔，坏值回到富文本；selectedId 空串当没选', () => {
    expect(validateNotesView({ ...EMPTY_NOTES_VIEW, markdownPreview: 'no' })?.markdownPreview).toBe(true)
    expect(validateNotesView({ ...EMPTY_NOTES_VIEW, markdownPreview: false })?.markdownPreview).toBe(false)
    expect(validateNotesView({ ...EMPTY_NOTES_VIEW, selectedId: '' })?.selectedId).toBeNull()
    expect(validateNotesView({ ...EMPTY_NOTES_VIEW, selectedId: 'n9' })?.selectedId).toBe('n9')
  })
})

describe('validateHistoryView', () => {
  it('页码非数字回落第 1 页', () => {
    for (const page of ['3', null, Number.NaN, Number.POSITIVE_INFINITY, 0, -2, 2.7]) {
      const value = validateHistoryView({ ...EMPTY_HISTORY_VIEW, page })
      expect(value?.page).toBe(page === 2.7 ? 2 : 1)
    }
  })

  it('非法时间范围回落 all，非法状态回落 all，非法排序回落 newest', () => {
    const value = validateHistoryView({ ...EMPTY_HISTORY_VIEW, period: 'year', filter: 'archive', order: 'shuffle' })
    expect(value?.period).toBe('all')
    expect(value?.filter).toBe('all')
    expect(value?.order).toBe('newest')
  })

  it('自定义范围保留合法日期，非自定义范围丢掉日期', () => {
    const custom = validateHistoryView({ ...EMPTY_HISTORY_VIEW, period: 'custom', dateFrom: '2026-10-01', dateTo: '2026-10-31' })
    expect(custom).toMatchObject({ period: 'custom', dateFrom: '2026-10-01', dateTo: '2026-10-31' })

    const week = validateHistoryView({ ...EMPTY_HISTORY_VIEW, period: 'week', dateFrom: '2026-10-01', dateTo: '2026-10-31' })
    expect(week).toMatchObject({ period: 'week', dateFrom: '', dateTo: '' })

    const broken = validateHistoryView({ ...EMPTY_HISTORY_VIEW, period: 'custom', dateFrom: '10/01', dateTo: 20261031 })
    expect(broken).toMatchObject({ dateFrom: '', dateTo: '' })
  })

  it('版本号对不上时整块作废', () => {
    expect(validateHistoryView({ ...EMPTY_HISTORY_VIEW, version: 2 })).toBeNull()
    expect(validateNotesView({ ...EMPTY_NOTES_VIEW, version: 9 })).toBeNull()
  })
})
