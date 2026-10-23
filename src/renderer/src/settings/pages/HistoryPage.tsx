import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Box,
  Alert,
  Button,
  ButtonBase,
  Chip,
  Dialog,
  IconButton,
  InputBase,
  Menu,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import { alpha } from '@mui/material/styles'
import type { HistoryEntry, Mode, Settings } from '@shared/types'
import { IconBook, IconCheck, IconCopy, IconSearch, IconTrash } from '../icons'
import {
  APP_FILTER_ALL,
  APP_FILTER_ALL_LABEL,
  REFRESH_OPTIONS,
  appFilterLabel,
  appFilterStillValid,
  appOptions,
  autoRefreshBlocked,
  ORIGINAL_HIDE_LABEL,
  ORIGINAL_SAME_SUFFIX,
  ORIGINAL_SHOW_LABEL,
  bodyOf,
  originalMatchesResult,
  originalText,
  cardLabel,
  cardTitle,
  clampPage,
  countLabel,
  emptyStateCopy,
  emptyStateKind,
  filterByApp,
  filterLabel,
  formatAttempts,
  hasCardName,
  hintText,
  historyDateBounds,
  historyDateView,
  historyNote,
  modeLabel,
  normalizeRefreshSeconds,
  providerTitle,
  refreshEnabled,
  refreshLabel,
  refreshOptionLabel,
  rowActions,
  slicePage,
  statusLabel,
  statusTone,
  statusOf,
  type HistoryPeriod,
  type HistoryFilterId,
  type RowActionId
} from './historyView'
import i18n from '../../i18n'
import { Pager } from '../Pagination'
import { MarkdownView } from '../../card/MarkdownView'
import { HistorySources } from './HistorySources'

/** The tabs above the list, left to right. Captions come from historyView. */
const FILTERS: HistoryFilterId[] = ['all', 'dictation', 'ask', 'translate']

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/**
 * Local calendar date as `YYYY-MM-DD`. This — not the display label — is the
 * grouping key: "3 月 5 日" collides across years, and grouping by a string that
 * changes when the clock crosses midnight merges two different days into one.
 */
function dayKeyOf(ts: number): string {
  const date = new Date(ts)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function dayLabel(ts: number): string {
  const date = new Date(ts)
  const today = new Date()
  const sameDay = date.toDateString() === today.toDateString()
  if (sameDay) return i18n.t('今天')
  // Calendar subtraction: `today - 86_400_000` is 23:00 or 01:00 on a DST changeover.
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return i18n.t('昨天')
  const stamp = i18n.t('{{m}} 月 {{d}} 日', { m: date.getMonth() + 1, d: date.getDate() })
  return date.getFullYear() === today.getFullYear()
    ? stamp
    : i18n.t('{{year}} 年 {{stamp}}', { year: date.getFullYear(), stamp })
}

function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

/**
 * Per-row banner for the result of the last action that talked to main. A
 * failed retry must be readable ("重试没有开始：正在处理上一条") instead of the
 * button silently doing nothing.
 */
interface Notice {
  tone: 'error' | 'info'
  text: string
}

/**
 * The settings slice this page drives. Both fields are optional so a shell that
 * still mounts `<HistoryPage />` without props keeps working: manual refresh and
 * pagination need nothing from settings, and automatic refresh simply reads as
 * "off" until the interval has somewhere to be stored.
 */
interface HistoryPageProps {
  settings?: Settings | null
  /** Optimistic settings writer; the interval chips write through it. */
  patch?: (delta: Partial<Settings>) => void
  /** Search text the caller wants applied on arrival (e.g. a 热门场景 chip). */
  initialQuery?: string
}

export function HistoryPage({ settings, patch, initialQuery }: HistoryPageProps = {}): JSX.Element {
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [filter, setFilter] = useState<'all' | Mode>('all')
  /**
   * Selected window of the 窗口筛选 dropdown; {@link APP_FILTER_ALL} means
   * "every window". It narrows the mode tab rather than replacing it, so both
   * act on the same list and paging sees only what survived them.
   */
  const [appFilter, setAppFilter] = useState<string>(APP_FILTER_ALL)
  const [query, setQuery] = useState(initialQuery ?? '')
  const [period, setPeriod] = useState<HistoryPeriod>('all')
  const [dateFrom, setDateFrom] = useState(''), [dateTo, setDateTo] = useState('')
  const [order, setOrder] = useState<'newest' | 'oldest'>('newest')
  const [loadError, setLoadError] = useState('')
  const [saveNoteId, setSaveNoteId] = useState<string | null>(null)
  const [savedNoteIds, setSavedNoteIds] = useState(new Set<string>())
  const saveNoteInFlight = useRef(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  // Which rows have their raw transcript open. Collapsed by default: the rows
  // stay scannable and the original is one click away when a rule is in question.
  const [openOriginal, setOpenOriginal] = useState<Record<string, boolean>>({})
  /**
   * A 热门场景 chip can ask for a different name while this page stays mounted,
   * so the seed is applied on change and not only on mount.
   */
  useEffect(() => {
    if (initialQuery === undefined) return
    setQuery(initialQuery)
    setPage(1)
  }, [initialQuery])
  /** Which button of which entry has an IPC call in flight. */
  const [pending, setPending] = useState<{ id: string; action: RowActionId } | null>(null)
  const [notices, setNotices] = useState<Record<string, Notice>>({})
  /** 1-based page of the filtered list; clamped on read, so it may be stale. */
  const [page, setPage] = useState(1)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const pageSize = settings?.listPageSize ?? 30
  useEffect(() => setPage(1), [pageSize])
  /** True while a `history.list` round trip is open (manual or automatic). */
  const [refreshing, setRefreshing] = useState(false)
  const [loadedQuery, setLoadedQuery] = useState<string | null>(null)
  const [exportMenu, setExportMenu] = useState<HTMLElement | null>(null)
  const [exportBusy, setExportBusy] = useState(false)
  const [exportNotice, setExportNotice] = useState('')
  /** Automatic refresh holds back while the search box has the caret. */
  const [searchFocused, setSearchFocused] = useState(false)
  /** Clear-history confirmation. Destructive and irreversible, so never immediate. */
  const [clearAsk, setClearAsk] = useState<'all' | 'abnormal' | null>(null)
  const [cleanupNotice, setCleanupNotice] = useState<string | null>(null)
  /**
   * Archived rows are stored but hidden. The toggle swaps the list to the
   * archive instead of mixing the two: a take the user put away should not sit
   * between today's takes, and the archive is a place you visit, not a filter.
   */
  const [showArchived, setShowArchived] = useState(false)

  const [feedbackFor, setFeedbackFor] = useState<HistoryEntry | null>(null)
  const [feedbackText, setFeedbackText] = useState('')
  const [feedbackBusy, setFeedbackBusy] = useState(false)
  const [feedbackSaved, setFeedbackSaved] = useState<{ ok: boolean; path?: string } | null>(null)

  /**
   * One query at a time, latest search wins. Every caller (mount, debounced
   * typing, the refresh button, the timer) funnels through here, so a slow
   * first read can never be overtaken by a second overlapping one and a search
   * typed mid-flight is queued instead of dropped.
   */
  const inFlight = useRef(false)
  const queuedSearch = useRef<string | null>(null)
  const reload = useCallback(async (search: string) => {
    queuedSearch.current = search
    if (inFlight.current) return
    inFlight.current = true
    setRefreshing(true)
    try {
      for (;;) {
        const next = queuedSearch.current
        if (next === null) break
        queuedSearch.current = null
        try {
          const rows = await window.api.history.list(next)
          setEntries(rows); setLoadedQuery(next); setLoadError('')
        } catch (error) {
          setLoadError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(error))
        }
      }
    } finally {
      inFlight.current = false
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void reload('')
  }, [reload])

  useEffect(() => {
    const timer = setTimeout(() => void reload(query), 180)
    return () => clearTimeout(timer)
  }, [query, reload])

  /**
   * Automatic refresh. The interval is rebuilt only when the seconds value
   * changes (and torn down on unmount); everything the tick has to consult is
   * read through refs so typing or opening a dialog cannot reset the timer.
   */
  const refreshSeconds = normalizeRefreshSeconds(settings?.historyRefreshSeconds ?? 0)
  const queryRef = useRef(query)
  const focusRef = useRef(searchFocused)
  const dialogRef = useRef(feedbackFor !== null)
  useEffect(() => {
    queryRef.current = query
  }, [query])
  useEffect(() => {
    focusRef.current = searchFocused
  }, [searchFocused])
  useEffect(() => {
    dialogRef.current = feedbackFor !== null || exportBusy || exportMenu !== null
  }, [feedbackFor, exportBusy, exportMenu])

  const autoTick = useCallback(() => {
    const blocked = autoRefreshBlocked({
      searchFocused: focusRef.current,
      dialogOpen: dialogRef.current,
      inFlight: inFlight.current
    })
    if (blocked) return
    void reload(queryRef.current)
  }, [reload])

  useEffect(() => {
    if (!refreshEnabled(refreshSeconds)) return
    const timer = window.setInterval(autoTick, refreshSeconds * 1000)
    return () => window.clearInterval(timer)
  }, [autoTick, refreshSeconds])

  /** 刷新 — a manual re-read of the current search; ignores a second click. */
  const refreshNow = useCallback(() => {
    if (inFlight.current) return
    void reload(queryRef.current)
  }, [reload])

  // A new search, tab, window or interval starts the list from the top: page 4
  // of the previous result set means nothing for a different one.
  useEffect(() => {
    setPage(1)
  }, [query, filter, refreshSeconds, appFilter, period, dateFrom, dateTo, order, showArchived])

  // A retry produces its new entry only after ASR+LLM finish, so one delayed
  // re-read is what makes the fresh take show up without a manual refresh.
  const timers = useRef<number[]>([])
  useEffect(
    () => () => {
      for (const timer of timers.current) window.clearTimeout(timer)
      timers.current = []
    },
    []
  )

  const notify = useCallback((id: string, notice: Notice) => {
    setNotices((prev) => ({ ...prev, [id]: notice }))
  }, [])

  const clearNotice = useCallback((id: string) => {
    setNotices((prev) => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
  }, [])

  const saveToNotes = async (entry: HistoryEntry): Promise<void> => {
    if (saveNoteInFlight.current) return
    saveNoteInFlight.current = true; setSaveNoteId(entry.id); clearNotice(entry.id)
    try {
      await window.api.notes.createText({ text: historyNote(entry) })
      setSavedNoteIds(previous => new Set(previous).add(entry.id))
    } catch (error) {
      notify(entry.id, { tone: 'error', text: i18n.t(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(error)) })
    } finally { saveNoteInFlight.current = false; setSaveNoteId(null) }
  }

  /**
   * The window dropdown lists what the loaded list actually contains, so a
   * window that has no take left is not offered at all. Built from `entries`
   * (search-scoped, all modes) rather than from `visible`, so switching tabs
   * never reshuffles the menu under the pointer.
   */
  const windowOptions = useMemo(() => appOptions(entries), [entries])

  /**
   * Filter → total → clamped page → slice → day groups. Grouping happens after
   * the slice, so a page that starts in the middle of a day still carries that
   * day's header instead of opening with an unlabelled block of rows.
   */
  const dateBounds = historyDateBounds(period, dateFrom, dateTo)
  const visible = useMemo(() => {
    const byArchive = entries.filter((item) => (item.status === 'archived') === showArchived)
    const byMode =
      filter === 'all' ? byArchive : byArchive.filter((item) => item.mode === filter)
    return historyDateView(filterByApp(byMode, appFilter), dateBounds, order)
  }, [entries, filter, appFilter, showArchived, dateBounds.start, dateBounds.end, order])
  const total = visible.length
  const exportCurrent = async (format: 'markdown' | 'text'): Promise<void> => {
    setExportMenu(null)
    if (exportBusy || refreshing || loadError || dateBounds.error || loadedQuery !== query || !visible.length) return
    const ids = visible.map(entry => entry.id)
    setExportBusy(true)
    setExportNotice('')
    try {
      const result = await window.api.history.exportText(ids, format)
      if (result) setExportNotice(i18n.t('已导出 {{count}} 条历史记录', { count: result.count }))
    } catch (error) {
      setExportNotice(i18n.t('导出失败：{{error}}', { error: error instanceof Error ? error.message : String(error) }))
    } finally { setExportBusy(false) }
  }
  // Read-time clamp: deleting the last row of the last page shrinks `total` and
  // this lands the list on the new last page without an extra state write.
  const safePage = clampPage(page, total, pageSize)
  const pageItems = useMemo(() => slicePage(visible, safePage, pageSize), [visible, safePage, pageSize])
  const groups = useMemo(() => {
    const byDay = new Map<string, { label: string; items: HistoryEntry[] }>()
    for (const entry of pageItems) {
      const key = dayKeyOf(entry.createdAt)
      const bucket = byDay.get(key) ?? { label: dayLabel(entry.createdAt), items: [] }
      bucket.items.push(entry)
      byDay.set(key, bucket)
    }
    return [...byDay.entries()]
  }, [pageItems, settings?.uiLanguage, i18n.resolvedLanguage])

  // Keep the stored page honest once the list shrinks under it, so a later refresh
  // that grows the list again does not teleport the user back to the old page.
  useEffect(() => {
    if (page !== safePage) setPage(safePage)
  }, [page, safePage])

  // A refresh can retire the window the user picked: its last take was deleted,
  // or the new search no longer reaches it. Falling back to 全部 keeps the list
  // readable instead of parking an empty page under a selection that is gone.
  useEffect(() => {
    if (!appFilterStillValid(windowOptions, appFilter)) setAppFilter(APP_FILTER_ALL)
  }, [windowOptions, appFilter])

  /**
   * "Nothing matches" and "nothing recorded" are different screens: the first
   * asks the user to change the search or the tab, the second asks for a first
   * take. The decision lives in historyView so it is testable without a DOM.
   */
  const emptyKind = emptyStateKind({ query, filter, matches: total, app: appFilter, dateFiltered: period !== 'all' })
  const empty = emptyKind ? emptyStateCopy(emptyKind) : null

  /**
   * Retry (error/empty) and restore (dismissed) share the main-process path:
   * the kept wav is replayed through ASR+LLM. `ok:false` carries the reason the
   * run never started, which is shown on the row rather than swallowed.
   */
  const runRetry = useCallback(
    async (entry: HistoryEntry, action: 'retry' | 'restore') => {
      if (pending) return
      setPending({ id: entry.id, action })
      clearNotice(entry.id)
      try {
        const result = await window.api.pipeline.retry(entry.id)
        notify(entry.id, {
          tone: result.ok ? 'info' : 'error',
          text: result.message || (result.ok ? i18n.t('已重新处理') : i18n.t('重试没有开始'))
        })
        await reload(query)
        // The new take lands a moment later; re-read once so it appears.
        if (result.ok) {
          const timer = window.setTimeout(() => void reload(query), 1600)
          timers.current.push(timer)
        }
      } catch (error) {
        notify(entry.id, { tone: 'error', text: i18n.t('重试失败：{{error}}', { error: String(error) }) })
      } finally {
        setPending(null)
      }
    },
    [pending, clearNotice, notify, query, reload]
  )

  const runDownload = useCallback(
    async (entry: HistoryEntry) => {
      if (pending) return
      setPending({ id: entry.id, action: 'download' })
      clearNotice(entry.id)
      try {
        const result = await window.api.history.downloadAudio(entry.id)
        notify(entry.id, {
          tone: result.ok ? 'info' : 'error',
          text: result.ok
            ? result.path
              ? i18n.t('已保存到 {{path}}', { path: result.path })
              : i18n.t('已保存到下载文件夹')
            : result.message || i18n.t('音频没有导出成功')
        })
      } catch (error) {
        notify(entry.id, { tone: 'error', text: i18n.t('导出失败：{{error}}', { error: String(error) }) })
      } finally {
        setPending(null)
      }
    },
    [pending, clearNotice, notify]
  )

  const runAction = useCallback(
    (entry: HistoryEntry, id: RowActionId) => {
      if (id === 'download') {
        void runDownload(entry)
        return
      }
      void runRetry(entry, id)
    },
    [runDownload, runRetry]
  )

  const openFeedback = useCallback((entry: HistoryEntry) => {
    setFeedbackFor(entry)
    setFeedbackText('')
    setFeedbackSaved(null)
  }, [])

  const closeFeedback = useCallback(() => {
    setFeedbackFor(null)
    setFeedbackText('')
    setFeedbackSaved(null)
  }, [])

  const submitFeedback = useCallback(async () => {
    const text = feedbackText.trim()
    if (!feedbackFor || !text || feedbackBusy) return
    setFeedbackBusy(true)
    try {
      const result = await window.api.history.feedback({ id: feedbackFor.id, text })
      setFeedbackSaved(result)
      if (result.ok) setFeedbackText('')
    } catch {
      setFeedbackSaved({ ok: false })
    } finally {
      setFeedbackBusy(false)
    }
  }, [feedbackBusy, feedbackFor, feedbackText])

  return (
    <Box sx={{ px: { xs: 2.5, md: 4 }, py: 4 }}>
      {/* Toolbar: actions only. The heading lives in the section header below, so
          the page prints 历史记录 exactly once. */}
      <Box
        data-history-toolbar
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
          flexWrap: 'wrap',
          rowGap: 1.25,
          justifyContent: 'flex-end'
        }}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.75,
            flexWrap: 'wrap',
            rowGap: 0.75,
            width: '100%',
            justifyContent: 'flex-end'
          }}
        >
          {/* Interval chips: 关闭 / 5 秒 / … / 5 分钟. Writing through `patch`
              keeps the choice in settings.json, so it survives a restart. */}
          <Box
            role="group"
            aria-label={i18n.t(i18n.t('自动刷新间隔'))}
            data-history-refresh-picker
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.25,
              height: 26,
              px: 0.5,
              borderRadius: 99,
              border: 1,
              borderColor: 'divider',
              bgcolor: 'action.hover'
            }}
          >
            {REFRESH_OPTIONS.map((option) => {
              const active = refreshSeconds === option.value
              const writable = Boolean(patch)
              return (
                <Box
                  key={option.value}
                  role="button"
                  aria-pressed={active}
                  data-history-refresh-option={option.value}
                  title={
                    writable
                      ? option.value === 0
                        ? i18n.t('关闭自动刷新')
                        : i18n.t('每 {{label}} 自动刷新一次', { label: refreshOptionLabel(option.labelKey) })
                      : i18n.t('本页没有拿到设置写入权限，间隔无法保存')
                  }
                  onClick={() => {
                    if (!patch) return
                    patch({ historyRefreshSeconds: option.value })
                  }}
                  sx={{
                    px: 0.9,
                    height: 20,
                    display: 'grid',
                    placeItems: 'center',
                    borderRadius: 99,
                    fontSize: 10.5,
                    whiteSpace: 'nowrap',
                    cursor: writable ? 'pointer' : 'default',
                    color: active ? 'text.primary' : 'text.secondary',
                    bgcolor: active ? 'background.paper' : 'transparent',
                    border: 1,
                    borderColor: active ? 'divider' : 'transparent',
                    fontWeight: active ? 600 : 400,
                    opacity: writable ? 1 : 0.55,
                    '&:hover': { color: writable ? 'text.primary' : 'text.secondary' }
                  }}
                >
                  {refreshOptionLabel(option.labelKey)}
                </Box>
              )
            })}
          </Box>

          <Tooltip title={i18n.t(i18n.t('重新读取本机历史记录'))}>
            {/* The span keeps the tooltip readable while the button is disabled
                mid-refresh (a disabled button swallows pointer events). */}
            <Box component="span" sx={{ display: 'inline-flex' }}>
              <Button
                size="small"
                variant="text"
                data-history-refresh={refreshing ? 'busy' : 'idle'}
                disabled={refreshing}
                onClick={refreshNow}
                sx={{
                  minWidth: 0,
                  px: 1,
                  fontSize: 12,
                  color: 'text.secondary',
                  '&:hover': { color: 'text.primary' },
                  '&.Mui-disabled': { color: 'text.disabled' }
                }}
              >
                {refreshing ? i18n.t('刷新中…') : i18n.t('刷新')}
              </Button>
            </Box>
          </Tooltip>

          {/* Makes the automatic state readable without opening anything. */}
          <Typography
            data-history-refresh-hint={refreshSeconds}
            sx={{ fontSize: 10.5, color: 'text.disabled', flexShrink: 0, minWidth: 0 }}
          >
            {refreshLabel(refreshSeconds)}
          </Typography>

        </Box>
        <Box data-history-filter-toolbar sx={{ display: 'flex', alignItems: 'center', gap: 0.75, width: '100%', flexWrap: 'wrap' }}>
          {/* Search box and 窗口筛选 share one row: the box takes everything it
              can (flex: 1) and the dropdown keeps a fixed 180px cap, so adding
              the filter never squeezes what the user is typing into. */}
          <Box
            data-history-search-row
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.75,
              flex: '1 1 300px',
              minWidth: 0,
              flexWrap: 'nowrap',
              justifyContent: 'flex-end'
            }}
          >
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 0.75,
                height: 30,
                px: 1,
                flex: 1,
                minWidth: 0,
                borderRadius: '8px',
                bgcolor: 'action.hover',
                border: 1,
                borderColor: 'divider'
              }}
            >
              <Box sx={{ color: 'text.disabled', display: 'grid', placeItems: 'center' }}>
                <IconSearch size={14} />
              </Box>
              <InputBase
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setSearchFocused(false)}
                placeholder={i18n.t('搜索文字、应用或卡片')}
                sx={{
                  fontSize: 12.5,
                  flex: 1,
                  minWidth: 0,
                  color: 'text.primary',
                  '& input::placeholder': { color: 'text.disabled', opacity: 1 }
                }}
              />
            </Box>
            {/* 窗口筛选: the windows actually present in the loaded list, plus
                全部. Picking one narrows the tab, the search and the paging
                together instead of replacing any of them. */}
            <TextField
              select
              SelectProps={{ displayEmpty: true }}
              size="small"
              value={appFilter}
              onChange={(event) => setAppFilter(event.target.value)}
              aria-label={i18n.t(i18n.t('按窗口筛选'))}
              data-history-filter="app"
              data-history-app-filter={appFilter}
              sx={{
                width: { xs: 125, md: 180 },
                maxWidth: 180,
                flexShrink: 0,
                '& .MuiInputBase-input': { fontSize: 12.5, py: 0.75 },
                '& .MuiSelect-select': { fontSize: 12.5 }
              }}
            >
              <MenuItem value={APP_FILTER_ALL} sx={{ fontSize: 12.5 }}>
                {i18n.t(APP_FILTER_ALL_LABEL)}
              </MenuItem>
              {windowOptions.map((option) => (
                <MenuItem key={option} value={option} sx={{ fontSize: 12.5 }}>
                  {appFilterLabel(option)}
                </MenuItem>
              ))}
            </TextField>
            <Button
              size="small"
              data-history-archive-view={showArchived ? 'on' : 'off'}
              onClick={() => setShowArchived((value) => !value)}
              sx={{
                minWidth: 0,
                px: 1,
                flexShrink: 0,
                fontSize: 12.5,
                fontWeight: 500,
                color: showArchived ? 'text.primary' : 'text.secondary',
                '&:hover': { bgcolor: 'action.hover' }
              }}
            >
              {showArchived ? i18n.t('看全部记录') : i18n.t('已归档')}
            </Button>
          </Box>
          <Tooltip title={i18n.t('导出当前筛选和排序下的全部正常记录，包含所有分页。')}>
            <span><Button size="small" data-history-export disabled={exportBusy || refreshing || !!loadError || !!dateBounds.error || loadedQuery !== query || !total}
              sx={{ fontSize: 12 }} onClick={event => setExportMenu(event.currentTarget)}>
              {exportBusy ? i18n.t('正在导出…') : i18n.t('导出')}
            </Button></span>
          </Tooltip>
          <Menu anchorEl={exportMenu} open={!!exportMenu} onClose={() => setExportMenu(null)}>
            <MenuItem onClick={() => void exportCurrent('markdown')}>Markdown (.md)</MenuItem>
            <MenuItem onClick={() => void exportCurrent('text')}>{i18n.t('纯文本')} (.txt)</MenuItem>
          </Menu>
          <Button size="small" data-history-clean-abnormal
            sx={{ fontSize: 12, color: 'text.secondary' }}
            onClick={() => { setCleanupNotice(null); setClearAsk('abnormal') }}>
            {i18n.t('清理旧异常')}
          </Button>
          <Tooltip title={i18n.t(i18n.t('清空全部历史'))}>
            <Button
              size="small"
              variant="text"
              sx={{ fontSize: 12, color: 'text.secondary', '&:hover': { color: 'text.primary' } }}
              onClick={() => setClearAsk('all')}
            >
              {i18n.t('清空')}
            </Button>
          </Tooltip>
          {/* Wiping history also deletes every kept wav and cannot be undone, so
              the button asks first. It sits next to the refresh control at 12px,
              which made an accidental click indistinguishable from a reload. */}
          <Dialog open={clearAsk !== null} onClose={() => setClearAsk(null)}>
            <Box sx={{ p: 2.5, width: 340 }}>
              <Typography sx={{ fontSize: 14, fontWeight: 600 }}>{i18n.t(clearAsk === 'abnormal' ? '清理旧异常记录？' : '清空全部历史？')}</Typography>
              <Typography
                sx={{ fontSize: 12.5, color: 'text.secondary', mt: 1, lineHeight: 1.7 }}
              >
                {i18n.t(clearAsk === 'abnormal'
                  ? '将删除旧版保存的失败、取消和空记录及对应录音，成功记录及其归档会保留。删除会同步到云端，无法撤销。'
                  : '将永久删除全部历史记录以及对应的录音文件，无法撤销。')}
              </Typography>
              <Stack direction="row" spacing={1} sx={{ mt: 2, justifyContent: 'flex-end' }}>
                <Button size="small" onClick={() => setClearAsk(null)}>
                  {i18n.t('取消')}
                </Button>
                <Button
                  size="small"
                  variant="contained"
                  color="error"
                  data-history-clear-confirm
                  onClick={async () => {
                    const choice = clearAsk
                    setClearAsk(null)
                    try {
                      if (choice === 'abnormal') {
                        const n = await window.api.history.clearAbnormal()
                        setCleanupNotice(i18n.t('已清理 {{n}} 条旧异常记录', { n }))
                      } else {
                        await window.api.history.clear()
                        setCleanupNotice(null)
                      }
                      await reload(query)
                    } catch (error) {
                      setCleanupNotice(i18n.t('清理失败：{{error}}', { error: String(error) }))
                    }
                  }}
                >
                  {i18n.t(clearAsk === 'abnormal' ? '确认清理' : '全部删除')}
                </Button>
              </Stack>
            </Box>
          </Dialog>
        </Box>
      </Box>

      {cleanupNotice && <Typography role="status" data-history-clean-result sx={{ mt: 1, fontSize: 12, color: 'text.secondary' }}>{cleanupNotice}</Typography>}
      {exportNotice && <Typography role="status" data-history-export-result sx={{ mt: 1, fontSize: 12, color: 'text.secondary' }}>{exportNotice}</Typography>}
      <Box data-history-date-toolbar sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, mt: 1.5 }}>
        <TextField select size="small" label={i18n.t('日期范围')} value={period} sx={{ width: 145 }}
          inputProps={{ 'aria-label': i18n.t('日期范围') }} onChange={event => setPeriod(event.target.value as HistoryPeriod)}>
          {[['all', '全部时间'], ['today', '今天'], ['week', '近 7 天'], ['month', '近 30 天'], ['custom', '自定义日期']].map(([value, label]) =>
            <MenuItem key={value} value={value}>{i18n.t(label!)}</MenuItem>)}
        </TextField>
        {period === 'custom' && <>
          <TextField type="date" size="small" label={i18n.t('起始日期')} value={dateFrom} onChange={event => setDateFrom(event.target.value)}
            InputLabelProps={{ shrink: true }} sx={theme => ({ width: 165, '& input': { colorScheme: theme.palette.mode } })} />
          <TextField type="date" size="small" label={i18n.t('结束日期')} value={dateTo} onChange={event => setDateTo(event.target.value)}
            InputLabelProps={{ shrink: true }} sx={theme => ({ width: 165, '& input': { colorScheme: theme.palette.mode } })} />
        </>}
        <TextField select size="small" label={i18n.t('时间排序')} value={order} sx={{ width: 145 }}
          inputProps={{ 'aria-label': i18n.t('时间排序') }} onChange={event => setOrder(event.target.value as 'newest' | 'oldest')}>
          <MenuItem value="newest">{i18n.t('最新在前')}</MenuItem><MenuItem value="oldest">{i18n.t('最早在前')}</MenuItem>
        </TextField>
        {(period !== 'all' || order !== 'newest' || query || appFilter !== APP_FILTER_ALL || filter !== 'all' || showArchived) &&
          <Button size="small" onClick={() => { setPeriod('all'); setDateFrom(''); setDateTo(''); setOrder('newest'); setQuery(''); setAppFilter(APP_FILTER_ALL); setFilter('all'); setShowArchived(false) }}>{i18n.t('重置筛选')}</Button>}
      </Box>
      {dateBounds.error && <Alert severity="warning" sx={{ mt: 1 }}>{i18n.t(dateBounds.error)}</Alert>}
      {loadError && <Alert severity="error" data-history-load-error sx={{ mt: 1 }} action={<Button color="inherit" size="small" onClick={refreshNow}>{i18n.t('刷新')}</Button>}>
        {i18n.t('历史记录读取失败：{{error}}', { error: loadError })}
      </Alert>}

      {/* Section header for the list: one 13px heading on the left, the active
          tab's count on the right. The page title above it was removed so
          历史记录 is printed once, not twice. */}
      <Box
        data-history-header
        sx={{
          mt: 2,
          pb: 1,
          display: 'flex',
          alignItems: 'baseline',
          gap: 1,
          borderBottom: 1,
          borderColor: 'divider'
        }}
      >
        <Typography sx={{ fontSize: 13, fontWeight: 600, letterSpacing: -0.1 }}>
          {i18n.t('历史记录')}
        </Typography>
        <Chip
          size="small"
          label={i18n.t(i18n.t('仅本地'))}
          sx={{
            height: 18,
            fontSize: 10,
            bgcolor: 'action.hover',
            color: 'text.secondary',
            border: 1,
            borderColor: 'divider',
            '& .MuiChip-label': { px: 0.75 }
          }}
        />
        <Typography
          data-history-count={total}
          data-history-total={total}
          title={i18n.t('每页 {{n}} 条', { n: pageSize })}
          sx={{ ml: 'auto', fontSize: 11.5, color: 'text.secondary', whiteSpace: 'nowrap' }}
        >
          {countLabel(filter, total)}
        </Typography>
      </Box>

      {/* Tabs and paging share one row: both answer "which rows am I looking
          at", so stacking them would spend two rows of chrome on one question.
          10px under the header, and the list starts 12px under this row. */}
      <Box
        sx={{
          mt: '10px',
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          flexWrap: 'wrap',
          rowGap: 0.5
        }}
      >
        {FILTERS.map((id) => {
          const active = filter === id
          return (
            <Box
              key={id}
              role="button"
              aria-pressed={active}
              data-history-filter={id}
              onClick={() => setFilter(id)}
              sx={{
                px: 1.5,
                height: 26,
                display: 'grid',
                placeItems: 'center',
                borderRadius: 99,
                fontSize: 11.5,
                cursor: 'pointer',
                color: active ? 'text.primary' : 'text.secondary',
                bgcolor: active ? 'action.selected' : 'transparent',
                border: 1,
                borderColor: active ? 'divider' : 'transparent',
                fontWeight: active ? 600 : 400,
                '&:hover': { color: 'text.primary' }
              }}
            >
              {filterLabel(id)}
            </Box>
          )
        })}

        <Box data-history-pagination sx={{ width: '100%' }}>
          <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}><Pager name="history-top" page={safePage} total={total} size={pageSize} onPage={setPage} /></Box>
        </Box>
      </Box>

      {empty && (
        <Box sx={{ mt: '12px', py: 5, textAlign: 'center' }}>
          <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>{empty.title}</Typography>
          {empty.hint !== '' && (
            <Typography sx={{ fontSize: 11.5, mt: 0.5, color: 'text.disabled' }}>
              {empty.hint}
            </Typography>
          )}
        </Box>
      )}

      {groups.map(([day, group], index) => (
        <Box key={day} sx={{ mt: index === 0 ? '12px' : 2.5 }}>
          <Typography sx={{ fontSize: 11.5, color: 'text.disabled', mb: 1 }}>{group.label}</Typography>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {group.items.map((entry) => {
              const label = statusLabel(entry)
              const tone = statusTone(entry)
              const archived = entry.status === 'archived'
              const body = bodyOf(entry)
              // Revealed on demand: the raw ASR text is only interesting when
              // checking why a correction rule did or did not fire.
              const original = originalText(entry)
              const originalOpen = openOriginal[entry.id] === true
              const originalSame = originalMatchesResult(entry)
              const hint = hintText(entry)
              const attempts = formatAttempts(entry)
              const actions = rowActions(entry)
              const notice = notices[entry.id]
              // Only the pressed button shows a spinner label; its siblings just
              // go disabled so "处理中…" never appears on an idle download.
              const inFlight = pending?.id === entry.id ? pending : null
              // Header captions live in historyView so the wording is testable.
              const cardCaption = cardLabel(entry)
              const cardRecorded = hasCardName(entry)
              return (
                <Box
                  key={entry.id}
                  data-history-row={entry.id}
                  title={providerTitle(entry) ?? undefined}
                  sx={{
                    px: 2,
                    py: 1.5,
                    borderRadius: '10px',
                    bgcolor: 'background.paper',
                    border: 1,
                    borderColor: 'divider',
                    '&:hover .row-actions, &:focus-within .row-actions': { opacity: 1 }
                  }}
                >
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 1,
                      minWidth: 0,
                      // The metadata column shrinks and ellipsizes; the action
                      // buttons must never be pushed off the card at ~780px.
                      overflow: 'hidden'
                    }}
                  >
                    <Box
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 1,
                        minWidth: 0,
                        flex: '1 1 auto',
                        overflow: 'hidden'
                      }}
                    >
                      <Typography component="span" data-history-number={entry.id} sx={{ fontSize: 10.5, fontVariantNumeric: 'tabular-nums', color: 'text.disabled', flexShrink: 0 }}>
                        #{(safePage - 1) * pageSize + pageItems.indexOf(entry) + 1}
                      </Typography>
                      <Typography
                        noWrap
                        sx={{ fontSize: 11, color: 'text.disabled', flexShrink: 0 }}
                      >
                        {timeLabel(entry.createdAt)}
                      </Typography>
                      <Typography
                        noWrap
                        sx={{ fontSize: 10.5, color: 'text.secondary', flexShrink: 0 }}
                      >
                        {modeLabel(entry.mode)}
                      </Typography>
                      {/* Which card shaped this text — the answer to "why did this
                          one come out like that". Hover names the kind and the id so
                          a surprising result can be traced without opening logs. A
                          take written before cards were recorded says so in grey
                          instead of leaving an ambiguous blank. */}
                      <Typography
                        noWrap
                        title={cardTitle(entry)}
                        data-history-card={entry.id}
                        sx={{
                          fontSize: 10.5,
                          color: cardRecorded ? 'text.secondary' : 'text.disabled',
                          maxWidth: 160,
                          flexShrink: 1,
                          minWidth: 0
                        }}
                      >
                        {cardCaption}
                      </Typography>
                      {label && tone && (
                        <Chip
                          size="small"
                          label={label}
                          sx={(theme) => {
                            const color =
                              tone === 'error'
                                ? theme.palette.error.main
                                : tone === 'warn'
                                  ? theme.palette.warning.main
                                  : theme.palette.text.secondary
                            return {
                              height: 18,
                              fontSize: 10,
                              fontWeight: tone === 'error' ? 600 : 500,
                              flexShrink: 0,
                              color,
                              bgcolor:
                                tone === 'muted' ? theme.palette.action.hover : alpha(color, 0.12),
                              border: 1,
                              borderColor:
                                tone === 'muted' ? theme.palette.divider : alpha(color, 0.34),
                              '& .MuiChip-label': { px: 0.75 }
                            }
                          }}
                        />
                      )}
                      {attempts && (
                        <Typography
                          noWrap
                          sx={{ fontSize: 10, color: 'text.disabled', flexShrink: 0 }}
                        >
                          {attempts}
                        </Typography>
                      )}
                      {entry.route === 'multimodal' && (
                        <Chip
                          size="small"
                          label={i18n.t(i18n.t('多模态'))}
                          sx={{
                            height: 16,
                            fontSize: 9.5,
                            flexShrink: 0,
                            bgcolor: 'action.hover',
                            color: 'text.secondary',
                            border: 1,
                            borderColor: 'divider',
                            '& .MuiChip-label': { px: 0.75 }
                          }}
                        />
                      )}
                      {entry.app && (
                        <Typography
                          noWrap
                          sx={{
                            fontSize: 10.5,
                            color: 'text.disabled',
                            maxWidth: 220,
                            flexShrink: 1,
                            minWidth: 0
                          }}
                        >
                          {entry.app}
                        </Typography>
                      )}
                    </Box>
                    <Box
                      className="row-actions"
                      sx={{
                        ml: 'auto',
                        flexShrink: 0,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 0.25,
                        opacity: 0,
                        transition: 'opacity .15s'
                      }}
                    >
                      <Button
                        size="small"
                        variant="text"
                        aria-label={i18n.t(i18n.t('反馈'))}
                        sx={{
                          minWidth: 0,
                          px: 0.9,
                          py: 0.2,
                          fontSize: 11,
                          color: 'text.secondary',
                          '&:hover': { color: 'text.primary', bgcolor: 'action.hover' }
                        }}
                        onClick={() => openFeedback(entry)}
                      >
                        {i18n.t('反馈')}
                      </Button>
                      <IconButton
                        size="small"
                        aria-label={i18n.t(i18n.t('复制'))}
                        disabled={!entry.final}
                        sx={{
                          color: 'text.secondary',
                          '&:hover': { color: 'text.primary', bgcolor: 'action.hover' }
                        }}
                        onClick={async () => {
                          // Failed takes have no text; the button stays disabled so a
                          // click never silently writes nothing into the clipboard.
                          if (!entry.final) return
                          await window.api.app.copyText(entry.final)
                          setCopiedId(entry.id)
                          window.setTimeout(
                            () => setCopiedId((id) => (id === entry.id ? null : id)),
                            1200
                          )
                        }}
                      >
                        {copiedId === entry.id ? <IconCheck size={14} /> : <IconCopy size={14} />}
                      </IconButton>
                      <Button size="small" data-history-save-note={entry.id} sx={{ minWidth: 0, px: 0.75, fontSize: 11 }}
                        disabled={saveNoteId !== null || savedNoteIds.has(entry.id) || !entry.final.trim() || !!entry.error?.trim() || !['completed', 'archived'].includes(statusOf(entry))}
                        onClick={() => void saveToNotes(entry)}>{i18n.t(saveNoteId === entry.id ? '保存中…' : savedNoteIds.has(entry.id) ? '已保存到随记' : '保存到随记')}</Button>
                      <IconButton
                        size="small"
                        aria-label={archived ? i18n.t('取消归档') : i18n.t('归档')}
                        data-history-archive={entry.id}
                        sx={{
                          color: 'text.secondary',
                          '&:hover': { color: 'text.primary', bgcolor: 'action.hover' }
                        }}
                        onClick={async () => {
                          await window.api.history.archive(entry.id, !archived)
                          clearNotice(entry.id)
                          await reload(query)
                        }}
                      >
                        <IconBook size={14} />
                      </IconButton>
                      <IconButton
                        size="small"
                        aria-label={i18n.t(i18n.t('删除'))}
                        sx={{
                          color: 'text.secondary',
                          '&:hover': { color: 'error.main', bgcolor: 'action.hover' }
                        }}
                        onClick={async () => {
                          await window.api.history.remove(entry.id)
                          clearNotice(entry.id)
                          await reload(query)
                        }}
                      >
                        <IconTrash size={14} />
                      </IconButton>
                    </Box>
                  </Box>

                  {body.text && <>
                    <Box data-history-body={entry.id} sx={{ mt: 0.75, fontSize: 12.5, lineHeight: 1.65, overflow: 'hidden', ...(expanded[entry.id] ? {} : { maxHeight: '6.6em' }),
                      '& [data-card-markdown] *:not(a)': { color: 'inherit !important' }, '& [data-card-markdown] p': { fontSize: '12.5px' } }}>
                      {expanded[entry.id] || entry.mode === 'ask' ? <MarkdownView text={expanded[entry.id] ? body.text : body.text.slice(0, 400)} sources={entry.sources ?? []} />
                        : <Typography sx={{ fontSize: 'inherit', lineHeight: 'inherit', whiteSpace: 'pre-wrap', display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{body.text}</Typography>}
                    </Box>
                    {(body.text.length > 160 || body.text.split('\n').length > 4 || !!entry.sources?.length) && <Button size="small" data-history-expand={entry.id} aria-expanded={!!expanded[entry.id]}
                      sx={{ mt: 0.5, p: 0, minWidth: 0, fontSize: 11.5 }} onClick={() => setExpanded(prev => ({ ...prev, [entry.id]: !prev[entry.id] }))}>
                      {i18n.t(expanded[entry.id] ? '收起全文' : '展开全文')}
                    </Button>}
                  </>}
                  {body.detail && (
                    <Typography
                      sx={{
                        mt: 0.5,
                        fontSize: 11.5,
                        lineHeight: 1.6,
                        color: 'text.secondary',
                        whiteSpace: 'pre-wrap'
                      }}
                    >
                      {body.detail}
                    </Typography>
                  )}
                  {hint && (
                    <Typography sx={{ mt: 0.5, fontSize: 11, color: 'text.disabled' }}>
                      {hint}
                    </Typography>
                  )}

                  {original && (
                    <Box sx={{ mt: 0.5 }}>
                      <ButtonBase
                        data-history-original-toggle={entry.id}
                        aria-expanded={originalOpen ? 'true' : 'false'}
                        onClick={() =>
                          setOpenOriginal((open) => ({ ...open, [entry.id]: !open[entry.id] }))
                        }
                        sx={{
                          fontSize: 11,
                          color: 'text.disabled',
                          px: 0.5,
                          py: 0.1,
                          borderRadius: 0.75,
                          '&:hover': { color: 'text.secondary', bgcolor: 'action.hover' }
                        }}
                      >
                        {i18n.t(originalOpen ? ORIGINAL_HIDE_LABEL : ORIGINAL_SHOW_LABEL)}
                        {originalSame ? i18n.t(ORIGINAL_SAME_SUFFIX) : ''}
                      </ButtonBase>
                      {originalOpen && (
                        <Box
                          data-history-original={entry.id}
                          sx={{
                            mt: 0.5,
                            pl: 1,
                            borderLeft: 2,
                            borderColor: 'divider',
                            fontSize: 12,
                            lineHeight: 1.6,
                            color: 'text.secondary',
                            whiteSpace: 'pre-wrap'
                          }}
                        >
                          {original}
                        </Box>
                      )}
                    </Box>
                  )}

                  {actions.length > 0 && (
                    <Box sx={{ mt: 1, display: 'flex', alignItems: 'center', gap: 0.5 }}>
                      {actions.map((action) => (
                        <Tooltip key={action.id} title={action.tooltip ?? ''}>
                          {/* Disabled buttons swallow pointer events; the span keeps
                              the "why" readable instead of a dead grey pill. */}
                          <Box component="span" sx={{ display: 'inline-flex' }}>
                            {/* One IPC at a time: while a retry runs, every other
                                row greys out too, so a click can never look like
                                it did nothing. */}
                            <Button
                              size="small"
                              variant="outlined"
                              disabled={action.disabled || pending !== null}
                              onClick={() => runAction(entry, action.id)}
                              sx={{
                                height: 24,
                                px: 1.1,
                                minWidth: 0,
                                fontSize: 11,
                                color: 'text.secondary',
                                borderColor: 'divider',
                                '&:hover': { color: 'text.primary', borderColor: 'divider' }
                              }}
                            >
                              {inFlight && inFlight.action === action.id
                                ? i18n.t('处理中…')
                                : action.label}
                            </Button>
                          </Box>
                        </Tooltip>
                      ))}
                    </Box>
                  )}

                  {notice && (
                    <Typography
                      sx={{
                        mt: 0.75,
                        fontSize: 11,
                        color: notice.tone === 'error' ? 'error.main' : 'text.secondary',
                        whiteSpace: 'pre-wrap'
                      }}
                    >
                      {notice.text}
                    </Typography>
                  )}

                  {expanded[entry.id] && entry.sources?.length ? <HistorySources id={entry.id} sources={entry.sources} /> : null}
                </Box>
              )
            })}
          </Box>
        </Box>
      ))}

      <Pager name="history-bottom" page={safePage} total={total} size={pageSize} onPage={setPage} onSize={size => patch?.({ listPageSize: size })} />

      <FeedbackDialog
        entry={feedbackFor}
        text={feedbackText}
        busy={feedbackBusy}
        saved={feedbackSaved}
        onTextChange={setFeedbackText}
        onClose={closeFeedback}
        onSubmit={() => void submitFeedback()}
      />
    </Box>
  )
}

interface FeedbackDialogProps {
  entry: HistoryEntry | null
  text: string
  busy: boolean
  saved: { ok: boolean; path?: string } | null
  onTextChange: (value: string) => void
  onClose: () => void
  onSubmit: () => void
}

/**
 * One line of free text about one take, appended to `<userData>/feedback.log`
 * by main. Unlike a toast it stays open after saving so the written path and
 * "open data folder" stay reachable.
 */
function FeedbackDialog({
  entry,
  text,
  busy,
  saved,
  onTextChange,
  onClose,
  onSubmit
}: FeedbackDialogProps): JSX.Element {
  const summary = entry ? (entry.final || entry.transcript || '').trim() : ''
  return (
    <Dialog
      open={entry !== null}
      onClose={onClose}
      maxWidth="xs"
      fullWidth
      aria-labelledby="history-feedback-title"
      slotProps={{ paper: { sx: { borderRadius: '12px' } } }}
    >
      <Stack spacing={2} sx={{ p: 2.5 }}>
        <Box>
          <Typography
            id="history-feedback-title"
            sx={{ fontSize: 15, fontWeight: 600, letterSpacing: -0.2 }}
          >
            {i18n.t('反馈')}
          </Typography>
          <Typography sx={{ fontSize: 11.5, color: 'text.secondary', mt: 0.5 }}>
            {entry ? `${timeLabel(entry.createdAt)} · ${modeLabel(entry.mode)}` : ''}
            {summary ? ` · ${summary.slice(0, 40)}${summary.length > 40 ? '…' : ''}` : ''}
          </Typography>
        </Box>

        {saved?.ok ? (
          <>
            <Typography sx={{ fontSize: 12, color: 'text.secondary', lineHeight: 1.7 }}>
              {i18n.t('已写入反馈日志，谢谢。')}
            </Typography>
            {saved.path && (
              <Typography
                sx={{ fontSize: 11, color: 'text.disabled', wordBreak: 'break-all' }}
              >
                {saved.path}
              </Typography>
            )}
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
              <Button size="small" onClick={() => void window.api.app.openDataFolder()}>
                {i18n.t('打开数据目录')}
              </Button>
              <Button size="small" variant="contained" onClick={onClose}>
                {i18n.t('关闭')}
              </Button>
            </Box>
          </>
        ) : (
          <>
            <TextField
              label={i18n.t(i18n.t('哪里不对？'))}
              placeholder={i18n.t(i18n.t('比如「把 4 听成了事」「回答太啰嗦」'))}
              value={text}
              multiline
              minRows={4}
              maxRows={8}
              autoFocus
              onChange={(event) => onTextChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  onSubmit()
                }
              }}
            />
            {saved && !saved.ok && (
              <Typography sx={{ fontSize: 11.5, color: 'error.main' }}>
                {i18n.t('没有写入反馈日志，请检查数据目录是否可写后重试。')}
              </Typography>
            )}
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
              <Button size="small" onClick={onClose}>
                {i18n.t('取消')}
              </Button>
              <Button
                size="small"
                variant="contained"
                disabled={busy || !text.trim()}
                onClick={onSubmit}
              >
                {busy ? i18n.t('提交中…') : i18n.t('提交')}
              </Button>
            </Box>
          </>
        )}
      </Stack>
    </Dialog>
  )
}
