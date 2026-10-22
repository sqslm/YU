import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Box,
  Button,
  ButtonBase,
  Chip,
  Dialog,
  IconButton,
  InputBase,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import { alpha } from '@mui/material/styles'
import type { HistoryEntry, Mode, Settings } from '@shared/types'
import { isSafeLink } from '@shared/links'
import { IconBook, IconCheck, IconCopy, IconSearch, IconTrash } from '../icons'
import {
  APP_FILTER_ALL,
  APP_FILTER_ALL_LABEL,
  PAGE_SIZE,
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
  canNextPage,
  canPrevPage,
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
  modeLabel,
  normalizeRefreshSeconds,
  pageLabel,
  providerLabel,
  providerTitle,
  refreshEnabled,
  refreshLabel,
  refreshOptionLabel,
  rowActions,
  slicePage,
  statusLabel,
  statusTone,
  type HistoryFilterId,
  type RowActionId
} from './historyView'
import i18n from '../../i18n'

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
  /** True while a `history.list` round trip is open (manual or automatic). */
  const [refreshing, setRefreshing] = useState(false)
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
        setEntries(await window.api.history.list(next))
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
    dialogRef.current = feedbackFor !== null
  }, [feedbackFor])

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
  }, [query, filter, refreshSeconds, appFilter])

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
  const visible = useMemo(() => {
    const byArchive = entries.filter((item) => (item.status === 'archived') === showArchived)
    const byMode =
      filter === 'all' ? byArchive : byArchive.filter((item) => item.mode === filter)
    return filterByApp(byMode, appFilter)
  }, [entries, filter, appFilter, showArchived])
  const total = visible.length
  // Read-time clamp: deleting the last row of the last page shrinks `total` and
  // this lands the list on the new last page without an extra state write.
  const safePage = clampPage(page, total)
  const pageItems = useMemo(() => slicePage(visible, safePage), [visible, safePage])
  const groups = useMemo(() => {
    const byDay = new Map<string, { label: string; items: HistoryEntry[] }>()
    for (const entry of pageItems) {
      const key = dayKeyOf(entry.createdAt)
      const bucket = byDay.get(key) ?? { label: dayLabel(entry.createdAt), items: [] }
      bucket.items.push(entry)
      byDay.set(key, bucket)
    }
    return [...byDay.entries()]
  }, [pageItems])

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
  const emptyKind = emptyStateKind({ query, filter, matches: total, app: appFilter })
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
    <Box sx={{ px: 4, py: 4 }}>
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

          {/* Search box and 窗口筛选 share one row: the box takes everything it
              can (flex: 1) and the dropdown keeps a fixed 180px cap, so adding
              the filter never squeezes what the user is typing into. */}
          <Box
            data-history-search-row
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.75,
              flex: '1 1 360px',
              minWidth: 360,
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
              size="small"
              value={appFilter}
              onChange={(event) => setAppFilter(event.target.value)}
              aria-label={i18n.t(i18n.t('按窗口筛选'))}
              data-history-filter="app"
              data-history-app-filter={appFilter}
              sx={{
                width: 180,
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
          title={i18n.t('每页 {{n}} 条', { n: PAGE_SIZE })}
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

        {/* Pagination: one page is 30 rows. The caption is derived from the
            clamped page, so it never names a page the filtered list cannot fill. */}
        <Box
          data-history-pagination
          sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 0.25 }}
        >
          <Button
            size="small"
            variant="text"
            data-history-prev
            disabled={!canPrevPage(safePage, total)}
            onClick={() => setPage(clampPage(safePage - 1, total))}
            sx={{
              minWidth: 0,
              px: 1,
              fontSize: 11.5,
              color: 'text.secondary',
              '&:hover': { color: 'text.primary' }
            }}
          >
            {i18n.t('上一页')}
          </Button>
          <Typography
            data-history-page={safePage}
            sx={{ fontSize: 11.5, color: 'text.secondary', px: 0.5, whiteSpace: 'nowrap' }}
          >
            {pageLabel(safePage, total)}
          </Typography>
          <Button
            size="small"
            variant="text"
            data-history-next
            disabled={!canNextPage(safePage, total)}
            onClick={() => setPage(clampPage(safePage + 1, total))}
            sx={{
              minWidth: 0,
              px: 1,
              fontSize: 11.5,
              color: 'text.secondary',
              '&:hover': { color: 'text.primary' }
            }}
          >
            {i18n.t('下一页')}
          </Button>
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
              const providerCaption = providerLabel(entry)
              return (
                <Box
                  key={entry.id}
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
                      {/* Which saved connection answered. A chain hides a dead
                          entry behind a healthy one, so the winner is the only way
                          to tell "did failover kick in". Nothing when unrecorded. */}
                      {providerCaption && (
                        <Typography
                          noWrap
                          title={providerTitle(entry) ?? undefined}
                          data-history-provider={entry.id}
                          sx={{
                            fontSize: 10,
                            color: 'text.disabled',
                            maxWidth: 120,
                            flexShrink: 1,
                            minWidth: 0
                          }}
                        >
                          {providerCaption}
                        </Typography>
                      )}
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

                  {body.text && (
                    <Typography
                      sx={{
                        mt: 0.75,
                        fontSize: 12.5,
                        lineHeight: 1.65,
                        color:
                          body.tone === 'error'
                            ? 'error.main'
                            : body.tone === 'muted'
                              ? 'text.secondary'
                              : 'text.primary',
                        whiteSpace: 'pre-wrap'
                      }}
                    >
                      {body.text}
                    </Typography>
                  )}
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

                  {entry.sources && entry.sources.length > 0 && (
                    <Box sx={{ mt: 1, display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                      {entry.sources
                        // Stored URLs came from a search result, so they are still
                        // external text: a `file://` entry here would be one click
                        // away from launching a local program.
                        .filter((source) => isSafeLink(source.url))
                        .slice(0, 4)
                        .map((source, index) => (
                        <Typography
                          key={`${index}-${source.url}`}
                          component="a"
                          href={source.url}
                          target="_blank"
                          rel="noreferrer"
                          sx={{
                            fontSize: 10.5,
                            color: 'primary.main',
                            textDecoration: 'none',
                            maxWidth: 220,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            '&:hover': { textDecoration: 'underline' }
                          }}
                        >
                          {source.title}
                        </Typography>
                      ))}
                    </Box>
                  )}
                </Box>
              )
            })}
          </Box>
        </Box>
      ))}

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
