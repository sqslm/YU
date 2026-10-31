/**
 * 页面视图状态的记忆：切走再回来，筛选/排序/选中的随记都还在。
 *
 * `App.tsx` 切页时只渲染当前页（`body()`），除聊天页外都会卸载，React state
 * 随之丢失。这里把「用户看得见的视图选择」写进 localStorage，带版本键、
 * 读坏值回落默认、写入合并成一次（打字不会每个键都写），卸载时 flush。
 *
 * 两条纪律：
 * - 只存视图。批量选择、录音、草稿、附件队列、保存状态一概不进这里——它们
 *   重进页面时应该就是空的。
 * - 会过期的 id（选中的随记、分类）由页面在列表加载完之后自己校验，本模块
 *   只负责类型层面的清洗。
 */

import { useEffect, useMemo, useRef } from 'react'
import { ALL_CATEGORIES, TAG_FILTER_LIMIT, type NoteKind, type NoteSort } from './notesView'
import type { HistoryFilterId, HistoryPeriod } from './historyView'

/** 写入合并窗口：一次连打 + 一次筛选变动最多落一次 localStorage 写。 */
export const PAGE_STATE_WRITE_MS = 250

/** 只要能读写字符串就够；测试里换成内存实现，不碰真实 localStorage。 */
export interface PageStateStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** 校验器：解析出来的值不认识就返回 null，调用方回落到默认。 */
export type PageStateValidator<T> = (raw: unknown) => T | null

/**
 * 当前窗口的 localStorage，拿不到就算了。
 *
 * 三条失败路径都按「没有存储」处理：Node/测试环境没有 `window`、隐私模式下
 * 访问 `localStorage` 直接抛、以及被策略禁用。读写各自再兜一次 try/catch，
 * 因为配额满只有 `setItem` 会抛。
 */
export function pageStateStorage(): PageStateStorage | null {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage ?? null
  } catch {
    return null
  }
}

/**
 * 读一个带版本的视图快照。
 *
 * 没存过、存了坏 JSON、字段不认识（`validate` 返回 null）都回落到 `fallback`；
 * 版本不进 key 的旧数据同样如此，所以升级时换个键就等于「重新开始」。
 */
export function readPageState<T>(
  key: string,
  fallback: T,
  validate: PageStateValidator<T>,
  storage: PageStateStorage | null = pageStateStorage()
): T {
  if (!storage) return fallback
  let text: string | null
  try {
    text = storage.getItem(key)
  } catch {
    return fallback
  }
  if (!text) return fallback
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return fallback
  }
  try {
    return validate(raw) ?? fallback
  } catch {
    return fallback
  }
}

/** 写一次。返回 false 只说明这次没存上（配额、隐私模式），不是错误。 */
export function writePageState(
  key: string,
  value: unknown,
  storage: PageStateStorage | null = pageStateStorage()
): boolean {
  if (!storage) return false
  let text: string
  try {
    text = JSON.stringify(value)
  } catch {
    return false
  }
  try {
    storage.setItem(key, text)
    return true
  } catch {
    return false
  }
}

type PageStateWrite = (key: string, value: unknown) => void

/**
 * 带合并窗口的写入器。
 *
 * 第一次 `put` 开一个 {@link PAGE_STATE_WRITE_MS} 的窗口，窗口内后续的 `put`
 * 只覆盖「待写值」；窗口到点只落一次，写的是最后一次的值。`flush` 立刻落盘
 * （页面卸载时用），没有待写值就什么都不做。
 *
 * 纯计时逻辑，`write` 可注入，所以测试用假计时器就能钉住「合并成一次」。
 */
export interface PageStateWriter<T> {
  put(value: T): void
  flush(): void
  /** 有还没落盘的值。 */
  pending(): boolean
}

export function createPageStateWriter<T>(
  key: string,
  write: PageStateWrite = writePageState,
  delay = PAGE_STATE_WRITE_MS
): PageStateWriter<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  let waiting = false
  let latest: T | undefined

  const stop = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const flush = (): void => {
    stop()
    if (!waiting) return
    const value = latest as T
    waiting = false
    latest = undefined
    write(key, value)
  }

  const put = (value: T): void => {
    latest = value
    waiting = true
    // 窗口已经开着：只换待写值，不再排第二个计时器。
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      flush()
    }, delay)
  }

  return { put, flush, pending: () => waiting }
}

/**
 * 把当前视图写回去，节流 + 卸载 flush。
 *
 * 挂载那一次不写：值是刚从存储里读出来的，再写一遍没有意义（也省掉一次
 * 打开页面就动的 localStorage）。之后每次 `value` 变化都进合并窗口；页面被
 * 切走时组件卸载，cleanup 立刻 flush，所以「改完筛选马上切页」也存得住。
 */
export function usePageStateWriter<T>(key: string, value: T, delay = PAGE_STATE_WRITE_MS): void {
  const writer = useMemo(
    () => createPageStateWriter<T>(key, (k, v) => { writePageState(k, v) }, delay),
    [key, delay]
  )
  const first = useRef(true)

  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    writer.put(value)
  }, [writer, value])

  // 卸载（切页）走这里：待写值必须立刻落盘。key 变化时同一段 cleanup 会把旧
  // 键的待写值先写完，再换新键。
  useEffect(() => () => writer.flush(), [writer])
}

/* ──────────────────────────────── 随记 ──────────────────────────────── */

/** 键里带版本：改了字段含义就换 v2，旧数据自然作废。 */
export const NOTES_VIEW_KEY = 'notes.view.v1'
export const NOTES_VIEW_VERSION = 1

export const NOTE_SORTS: readonly NoteSort[] = ['newest', 'oldest', 'updated']
export const NOTE_KINDS: readonly NoteKind[] = ['all', 'text', 'audio', 'failed']

/**
 * 随记页要记住的视图。故意不含：批量选择、录音/转写状态、草稿、附件队列、
 * 保存状态——这些重进页面必须是干净的。
 */
export interface NotesViewState {
  version: typeof NOTES_VIEW_VERSION
  /** 搜索框里的词，以及防抖之后真正生效的词（两者恢复成同一个值，不重放输入）。 */
  query: string
  categoryId: string
  sort: NoteSort
  kind: NoteKind
  activeTags: string[]
  /** 编辑区默认是富文本预览；上一次选了 Markdown 源码就记住。 */
  markdownPreview: boolean
  /** 选中项只是候选：列表回来后页面自己校验它还在不在。 */
  selectedId: string | null
}

export const EMPTY_NOTES_VIEW: NotesViewState = {
  version: NOTES_VIEW_VERSION,
  query: '',
  categoryId: ALL_CATEGORIES,
  sort: 'newest',
  kind: 'all',
  activeTags: [],
  markdownPreview: true,
  selectedId: null
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  return raw as Record<string, unknown>
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

function tagList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const tags: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const tag = item.trim()
    if (!tag) continue
    if (tags.length >= TAG_FILTER_LIMIT) break
    if (tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) continue
    tags.push(tag)
  }
  return tags
}

/**
 * 逐字段清洗：整块不认识才返回 null，单个字段坏了只回落到该字段的默认
 * （非法 sort → `newest`，非法 kind → `all`）。这样一次手改 localStorage
 * 或者旧版本残留不会把整页筛选都清空。
 */
export function validateNotesView(raw: unknown): NotesViewState | null {
  const value = asRecord(raw)
  if (!value) return null
  if (value.version !== NOTES_VIEW_VERSION) return null
  return {
    version: NOTES_VIEW_VERSION,
    query: typeof value.query === 'string' ? value.query : EMPTY_NOTES_VIEW.query,
    categoryId: typeof value.categoryId === 'string' ? value.categoryId : ALL_CATEGORIES,
    sort: oneOf(NOTE_SORTS, value.sort, 'newest'),
    kind: oneOf(NOTE_KINDS, value.kind, 'all'),
    activeTags: tagList(value.activeTags),
    markdownPreview: typeof value.markdownPreview === 'boolean' ? value.markdownPreview : true,
    selectedId: typeof value.selectedId === 'string' && value.selectedId ? value.selectedId : null
  }
}

/* ──────────────────────────────── 历史 ──────────────────────────────── */

export const HISTORY_VIEW_KEY = 'history.view.v1'
export const HISTORY_VIEW_VERSION = 1

export const HISTORY_PERIODS: readonly HistoryPeriod[] = ['all', 'today', 'week', 'month', 'custom']
/**
 * Every tab the history page offers. Must list the categories, not the modes: a
 * saved 润色 / 任务 tab has to survive a reload instead of being reset to 全部.
 */
export const HISTORY_FILTERS: readonly HistoryFilterId[] = [
  'all',
  'dictation',
  'translate',
  'polish',
  'ask',
  'task'
]

/**
 * 历史页要记住的视图：搜索词、时间范围（含自定义起止日期）、状态标签页、
 * 排序和页码。窗口筛选（`appFilter`）和归档开关故意不存：前者依赖当前列表
 * 里实际出现的窗口，后者会让下次打开像「历史空了」。
 */
export interface HistoryViewState {
  version: typeof HISTORY_VIEW_VERSION
  query: string
  period: HistoryPeriod
  dateFrom: string
  dateTo: string
  order: 'newest' | 'oldest'
  filter: HistoryFilterId
  /** 候选页码：超出范围时页面回落到第 1 页。 */
  page: number
}

export const EMPTY_HISTORY_VIEW: HistoryViewState = {
  version: HISTORY_VIEW_VERSION,
  query: '',
  period: 'all',
  dateFrom: '',
  dateTo: '',
  order: 'newest',
  filter: 'all',
  page: 1
}

/** 日期输入框的事实格式是 `YYYY-MM-DD`；别的字符串只会把范围算成空的。 */
function dateField(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : ''
}

function pageField(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 1
  const page = Math.floor(raw)
  return page >= 1 ? page : 1
}

export function validateHistoryView(raw: unknown): HistoryViewState | null {
  const value = asRecord(raw)
  if (!value) return null
  if (value.version !== HISTORY_VIEW_VERSION) return null
  const period = oneOf(HISTORY_PERIODS, value.period, 'all')
  return {
    version: HISTORY_VIEW_VERSION,
    query: typeof value.query === 'string' ? value.query : '',
    period,
    // 不是自定义范围时起止日期没有意义，恢复出来只会误导工具栏。
    dateFrom: period === 'custom' ? dateField(value.dateFrom) : '',
    dateTo: period === 'custom' ? dateField(value.dateTo) : '',
    order: oneOf(['newest', 'oldest'] as const, value.order, 'newest'),
    filter: oneOf(HISTORY_FILTERS, value.filter, 'all'),
    page: pageField(value.page)
  }
}
