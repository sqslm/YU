/**
 * Pure view-model helpers for the history page.
 *
 * Every decision that used to hide inside JSX lives here so it can be asserted
 * without a DOM: which badge a take gets, why it failed, whether the retry
 * button can actually do something, and what the row body should say. The page
 * component only renders what these functions return.
 *
 * The three-state model (REQ-02) is: `completed` (nothing to see), `error`
 * (red, retryable), `empty` (yellow, no audio was heard) and `dismissed`
 * (grey, the user cancelled). Entries written before v0.9 carry no `status`;
 * the only signal they have is `error`, so that is what they fall back to.
 */
import type { HistoryEntry, HistoryStatus, Mode, SearchResult } from '@shared/types'
import { isSafeLink } from '@shared/links'
import { PROMPT_KIND_LABEL } from '@shared/promptLibrary'
import i18n from '../../i18n'

const KNOWN_STATUSES: HistoryStatus[] = ['completed', 'dismissed', 'empty', 'error', 'archived']

/** Tooltip for every action that needs the kept wav but has none. */
export const NO_AUDIO_REASON = '这条没有保存音频'

/** True when the entry kept its wav under `<userData>/audio/`. */
export function hasAudio(entry: Pick<HistoryEntry, 'audioPath'>): boolean {
  return Boolean(entry.audioPath && entry.audioPath.trim())
}

/**
 * Effective status. A missing or unrecognised value is `completed` (the pre-v0.9
 * default and what ACC-02 step 6 asks for), except that a legacy failure still
 * carries `error` text and must stay visible as a failure.
 */
export function statusOf(entry: Pick<HistoryEntry, 'status' | 'error'>): HistoryStatus {
  if (entry.status && KNOWN_STATUSES.includes(entry.status)) return entry.status
  return entry.error && entry.error.trim() ? 'error' : 'completed'
}

export type StatusTone = 'error' | 'warn' | 'muted'

/** Badge caption; `null` for a normal take, which stays clean. */
export function statusLabel(entry: Pick<HistoryEntry, 'status' | 'error'>): string | null {
  switch (statusOf(entry)) {
    case 'error':
      return i18n.t('失败')
    case 'empty':
      return i18n.t('没听到声音')
    case 'dismissed':
      return i18n.t('已取消')
    case 'archived':
      return i18n.t('已归档')
    default:
      return null
  }
}

/** Drives the badge colour: red / yellow / grey / none. */
export function statusTone(entry: Pick<HistoryEntry, 'status' | 'error'>): StatusTone | null {
  switch (statusOf(entry)) {
    case 'error':
      return 'error'
    case 'empty':
      return 'warn'
    case 'dismissed':
      return 'muted'
    case 'archived':
      return 'muted'
    default:
      return null
  }
}

/**
 * `alertKind` → the short Chinese reason the bar already uses. Kept next to the
 * page instead of imported from the bar so a main-process rename cannot break
 * the settings window at load time.
 */
const REASONS: Record<string, string> = {
  asr_failed: '没听清',
  no_network: '网络不通',
  weak_network: '网络不稳',
  auth: '密钥无效',
  rate_limit: '被限流',
  server_error: '服务端出错',
  llm_failed: '模型没答上来',
  mic_missing: '找不到麦克风',
  mic_denied: '麦克风被拒绝了',
  busy: '刚才还在忙',
  empty_audio: '没听到声音',
  too_short: '说话太短',
  cancelled: '已取消'
}

/**
 * Why a failed take failed. `alertKind` wins because it is a classification we
 * ship; the raw `error` string is the fallback so nothing is ever swallowed.
 */
export function reasonText(
  entry: Pick<HistoryEntry, 'status' | 'error' | 'alertKind'>
): string | null {
  if (statusOf(entry) !== 'error') return null
  const kind = (entry.alertKind ?? '').trim()
  if (kind && REASONS[kind]) return i18n.t(REASONS[kind])
  const raw = (entry.error ?? '').trim()
  if (raw) return raw
  if (kind) return kind
  return i18n.t('这次没成功')
}

/** One advice line under the row; `null` for a completed take. */
export function hintText(
  entry: Pick<HistoryEntry, 'status' | 'error' | 'alertKind' | 'audioPath'>
): string | null {
  const status = statusOf(entry)
  if (status === 'empty') {
    return entry.alertKind === 'too_short'
      ? i18n.t('说得太短了：按住快捷键再多说一会儿')
      : i18n.t('检查麦克风有没有静音，或者离麦克风近一点')
  }
  if (status === 'dismissed') {
    return canRestore(entry)
      ? i18n.t('这条被取消了，重新说一遍即可；也可以点「恢复」从保留的音频重转')
      : i18n.t('这条被取消了，重新说一遍即可')
  }
  return null
}

/** Retry replays the kept wav; without audio main answers "没有保存音频". */
export function retryBlockedReason(
  entry: Pick<HistoryEntry, 'status' | 'error' | 'audioPath'>
): string | null {
  const status = statusOf(entry)
  if (status !== 'error' && status !== 'empty') return i18n.t('这条不需要重试')
  if (!hasAudio(entry)) return NO_AUDIO_REASON
  return null
}

export function canRetry(entry: Pick<HistoryEntry, 'status' | 'error' | 'audioPath'>): boolean {
  return retryBlockedReason(entry) === null
}

/** A cancelled take is restored through the same pipeline retry path. */
export function canRestore(
  entry: Pick<HistoryEntry, 'status' | 'error' | 'audioPath'>
): boolean {
  return statusOf(entry) === 'dismissed' && hasAudio(entry)
}

export function canDownloadAudio(entry: Pick<HistoryEntry, 'audioPath'>): boolean {
  return hasAudio(entry)
}

/** "已重试 2 次" — how many times this take was replayed, `null` when never. */
export function formatAttempts(entry: Pick<HistoryEntry, 'attempts'>): string | null {
  const count = entry.attempts ?? 0
  if (!Number.isFinite(count) || count <= 0) return null
  return i18n.t('已重试 {{n}} 次', { n: Math.floor(count) })
}

export interface RowBody {
  /** Main line: the produced text, or the failure reason. */
  text: string
  tone: 'normal' | 'error' | 'muted'
  /** Secondary line, e.g. the ASR text behind a failed LLM call. */
  detail: string | null
}

/**
 * What the row body renders. An `empty` take has no text by definition
 * (ACC-02 step 1: grey, no body), a cancelled one keeps its transcript so the
 * user can still read what was heard, and a failure shows why.
 */
export function bodyOf(
  entry: Pick<
    HistoryEntry,
    'status' | 'error' | 'alertKind' | 'transcript' | 'final'
  >
): RowBody {
  const status = statusOf(entry)
  if (status === 'error') {
    const reason = reasonText(entry) ?? i18n.t('这次没成功')
    const said = (entry.transcript ?? '').trim()
    return {
      text: i18n.t('失败：{{message}}', { message: reason }),
      tone: 'error',
      detail: said ? i18n.t('原话：{{said}}', { said }) : null
    }
  }
  if (status === 'empty') {
    return { text: '', tone: 'muted', detail: null }
  }
  const text = (entry.final ?? '').trim() || (entry.transcript ?? '').trim()
  if (status === 'dismissed') {
    return { text, tone: 'muted', detail: null }
  }
  return { text, tone: 'normal', detail: null }
}

export type RowActionId = 'retry' | 'restore' | 'download'

export interface RowAction {
  id: RowActionId
  label: string
  /** True when the button is shown greyed out instead of hidden. */
  disabled: boolean
  /** Tooltip explaining a disabled button; `null` when it can run. */
  tooltip: string | null
}

/**
 * The footer buttons for one row, in display order. A disabled button is only
 * emitted when the reason is worth showing (a take with no wav) — the page must
 * never offer an action that main would silently refuse.
 */
export function rowActions(
  entry: Pick<HistoryEntry, 'status' | 'error' | 'audioPath'>
): RowAction[] {
  const status = statusOf(entry)
  const actions: RowAction[] = []
  if (status === 'error' || status === 'empty') {
    const blocked = retryBlockedReason(entry)
    actions.push({
      id: 'retry',
      label: i18n.t('重试'),
      disabled: blocked !== null,
      tooltip: blocked
    })
  } else if (status === 'dismissed') {
    actions.push({
      id: 'restore',
      label: i18n.t('恢复'),
      disabled: !canRestore(entry),
      tooltip: canRestore(entry) ? null : NO_AUDIO_REASON
    })
  }
  if (hasAudio(entry)) {
    actions.push({ id: 'download', label: i18n.t('下载音频'), disabled: false, tooltip: null })
  }
  return actions
}

// ---------------------------------------------------------------------------
// Row header: time · mode · which prompt card · which provider answered
// ---------------------------------------------------------------------------

/**
 * Shown in place of a blank card caption. Takes written before the prompt card
 * was recorded per take carry no `promptName`, and an empty gap in the row is
 * indistinguishable from "the UI forgot to render it".
 */
export const CARD_MISSING_LABEL = '卡片未记录'

/** Hover text for a take that recorded neither a card kind nor an id. */
export const CARD_UNKNOWN_TITLE = '旧记录没有保存卡片信息'

/**
 * Chinese caption for a mode. The raw enum (`dictation` / `translate` / `ask`)
 * never reaches the screen; an unknown value from hand-edited or future data
 * degrades to the dictation word instead of printing the enum.
 */
export function modeLabel(mode: Mode): string {
  switch (mode) {
    case 'ask':
      return i18n.t('问答')
    case 'translate':
      return i18n.t('翻译')
    default:
      return i18n.t('听写')
  }
}

function trimmed(value: string | undefined | null): string {
  return (value ?? '').trim()
}

/** True when this take actually recorded which card shaped its text. */
export function hasCardName(entry: Pick<HistoryEntry, 'promptName'>): boolean {
  return trimmed(entry.promptName).length > 0
}

/**
 * Card caption for one row: the recorded name, or {@link CARD_MISSING_LABEL}
 * for a legacy take. Never blank, so the column always reads as a value.
 */
export function cardLabel(entry: Pick<HistoryEntry, 'promptName'>): string {
  return hasCardName(entry) ? trimmed(entry.promptName) : i18n.t(CARD_MISSING_LABEL)
}

/**
 * Hover text behind the card caption: "润色 · polish-default". The kind is a
 * Chinese label, the id stays verbatim because it is the handle a user can grep
 * for in `settings.json`. Missing parts are simply skipped, so a partial record
 * still names what is there.
 */
export function cardTitle(
  entry: Pick<HistoryEntry, 'promptName' | 'promptKind' | 'promptId'>
): string {
  const parts: string[] = []
  const kind = entry.promptKind
  if (kind && i18n.t(PROMPT_KIND_LABEL[kind])) parts.push(i18n.t(PROMPT_KIND_LABEL[kind]))
  const id = trimmed(entry.promptId)
  if (id) parts.push(id)
  return parts.length > 0 ? parts.join(' · ') : i18n.t(CARD_UNKNOWN_TITLE)
}

/**
 * Which saved connection answered, or `null` when the take did not record one
 * (legacy takes, or a build that predates provider profiles). A missing value
 * renders nothing at all — "未记录" here would be noise on most old rows.
 */
export function providerLabel(entry: Pick<HistoryEntry, 'providerName'>): string | null {
  const name = trimmed(entry.providerName)
  return name.length > 0 ? name : null
}

/** Hover text for the provider caption; `null` when there is no id to name. */
export function providerTitle(entry: Pick<HistoryEntry, 'providerId'>): string | null {
  const id = trimmed(entry.providerId)
  return id.length > 0 ? i18n.t('提供商配置 · {{id}}', { id }) : null
}

// ---------------------------------------------------------------------------
// Pagination — thirty rows a page, and a page number that cannot strand itself
// ---------------------------------------------------------------------------

/**
 * Rows per page. Fixed at 30: the page is a scroll surface, not a data grid, so
 * this is a reading decision rather than a preference the user has to manage.
 */
export const PAGE_SIZE = 30

/**
 * How many pages `total` rows need. An empty list still reports one page so the
 * header can print "第 1 / 1 页" instead of a meaningless "第 1 / 0 页", and an
 * absurd or negative count degrades to that same single page.
 */
export function pageCount(total: number, size = PAGE_SIZE): number {
  if (!Number.isFinite(total) || total <= 0) return 1
  return Math.max(1, Math.ceil(Math.floor(total) / Math.max(1, size)))
}

/**
 * Pull a page number back into range. Deleting the only row of the last page
 * shrinks `total`, and the page must land on the new last page instead of
 * rendering an empty page with live-looking arrows.
 */
export function clampPage(page: number, total: number, size = PAGE_SIZE): number {
  const last = pageCount(total, size)
  if (!Number.isFinite(page)) return 1
  const floored = Math.floor(page)
  if (floored < 1) return 1
  return Math.min(floored, last)
}

/** The rows of one page, always at most {@link PAGE_SIZE} long. */
export function slicePage<T>(items: readonly T[], page: number, size = PAGE_SIZE): T[] {
  const safe = clampPage(page, items.length, size)
  const start = (safe - 1) * size
  return items.slice(start, start + size)
}

/** True when 上一页 has somewhere to go. */
export function canPrevPage(page: number, total: number): boolean {
  return clampPage(page, total) > 1
}

/** True when 下一页 has somewhere to go. */
export function canNextPage(page: number, total: number): boolean {
  return clampPage(page, total) < pageCount(total)
}

/** "第 2 / 4 页" — always clamped, so the caption never names a missing page. */
export function pageLabel(page: number, total: number): string {
  return i18n.t('第 {{page}} / {{pages}} 页', { page: clampPage(page, total), pages: pageCount(total) })
}

// ---------------------------------------------------------------------------
// Window filter — the dropdown that sits to the right of the search box
// ---------------------------------------------------------------------------

/**
 * Sentinel for "no window picked". The dropdown is a controlled component, so
 * one option has to mean "everything"; the empty string keeps that value out of
 * the `app` namespace, where a title is never blank.
 */
export const APP_FILTER_ALL = ''

/** Caption of the sentinel option, and the label a blank value degrades to. */
export const APP_FILTER_ALL_LABEL = '全部'

/**
 * How many windows the dropdown offers. A long-running install can have met
 * dozens of foreground windows; forty is what still reads as a menu instead of
 * a scrollable dump, and anything past it is rare enough to stay unlisted.
 */
export const APP_FILTER_MAX = 40

/** True when `app` names a real window instead of the 全部 option. */
export function appFilterActive(app: string): boolean {
  return (app ?? '').trim() !== ''
}

/** Caption for one option value: the recorded title, or 全部 for the sentinel. */
export function appFilterLabel(app: string): string {
  return appFilterActive(app) ? app : i18n.t(APP_FILTER_ALL_LABEL)
}

/**
 * Collation shared by the dropdown and its tests. The locale is pinned to
 * `zh-Hans-CN` so Chinese titles sort by pinyin and 记事本/微信 order the way a
 * Chinese reader expects, while Latin titles stay alphabetical and embedded
 * numbers stay numeric. Two titles differing only in case are distinct windows,
 * so the code-unit order breaks the tie and keeps the list stable across reads.
 */
function compareApp(left: string, right: string): number {
  const collated = left.localeCompare(right, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
  if (collated !== 0) return collated
  return left === right ? 0 : left < right ? -1 : 1
}

/**
 * The window options for the loaded list: every distinct non-blank `app`,
 * alphabetically, capped at `limit`.
 *
 * When more than `limit` windows exist the ones that appear least often are
 * dropped, so the menu keeps the windows the user actually works in; the
 * survivors are then re-sorted alphabetically so the menu itself never
 * reshuffles as counts change. Values are otherwise verbatim: trimming them
 * here would produce an option that {@link filterByApp} cannot match back.
 */
export function appOptions(
  entries: readonly Pick<HistoryEntry, 'app'>[],
  limit: number = APP_FILTER_MAX
): string[] {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    const value = entry.app
    if (typeof value !== 'string' || value.trim() === '') continue
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : APP_FILTER_MAX
  const ranked = [...counts.entries()].sort((left, right) => {
    if (right[1] !== left[1]) return right[1] - left[1]
    return compareApp(left[0], right[0])
  })
  return ranked
    .slice(0, cap)
    .map(([value]) => value)
    .sort(compareApp)
}

/**
 * Rows whose `app` is exactly the selected window; the sentinel (or any
 * whitespace-only value) returns the list untouched.
 *
 * The comparison is verbatim on both sides — no case folding, no fuzzy or
 * prefix matching — so picking 记事本 can never pull in 记事本2 or 记事本 Beta.
 * Only the sentinel test trims, because a blank selection is 全部, not a window
 * named by spaces; the picked value is compared as-is so the option the menu
 * offered is exactly the value that matches its rows back.
 */
export function filterByApp<T extends Pick<HistoryEntry, 'app'>>(
  entries: readonly T[],
  app: string
): T[] {
  if (!appFilterActive(app)) return [...entries]
  return entries.filter((entry) => entry.app === app)
}

/**
 * True while the selected window still exists in the freshly loaded options.
 * A refresh can retire the picked window (its last take was deleted, or the new
 * search no longer reaches it), and the page falls back to 全部 instead of
 * leaving the list empty under a selection the user cannot see.
 */
export function appFilterStillValid(options: readonly string[], current: string): boolean {
  if (!appFilterActive(current)) return true
  return options.includes(current)
}

// ---------------------------------------------------------------------------
// Automatic refresh — the interval ladder and the reasons a tick is skipped
// ---------------------------------------------------------------------------

/**
 * Upper bound the settings merger already clamps to. Kept here as well so the
 * page never has to trust a value that slipped in through a hand-edited file.
 */
export const REFRESH_MAX_SECONDS = 600

/** Stable caption keys for the interval chips; resolved by {@link refreshOptionLabel}. */
export type HistoryRefreshLabelKey =
  | 'historyRefreshOff'
  | 'historyRefresh5'
  | 'historyRefresh15'
  | 'historyRefresh30'
  | 'historyRefresh60'
  | 'historyRefresh300'

export interface HistoryRefreshOption {
  /** Seconds between automatic re-reads; `0` turns automatic refresh off. */
  readonly value: number
  /** Caption key, so the chips and the hint share one source of wording. */
  readonly labelKey: HistoryRefreshLabelKey
}

/** The chips next to the refresh button, in display order. */
export const REFRESH_OPTIONS: readonly HistoryRefreshOption[] = [
  { value: 0, labelKey: 'historyRefreshOff' },
  { value: 5, labelKey: 'historyRefresh5' },
  { value: 15, labelKey: 'historyRefresh15' },
  { value: 30, labelKey: 'historyRefresh30' },
  { value: 60, labelKey: 'historyRefresh60' },
  { value: 300, labelKey: 'historyRefresh300' }
]

const REFRESH_CAPTIONS: Record<HistoryRefreshLabelKey, string> = {
  historyRefreshOff: '关闭',
  historyRefresh5: '5 秒',
  historyRefresh15: '15 秒',
  historyRefresh30: '30 秒',
  historyRefresh60: '60 秒',
  historyRefresh300: '5 分钟'
}

/** Chip caption: 关闭 / 5 秒 / 15 秒 / 30 秒 / 60 秒 / 5 分钟. */
export function refreshOptionLabel(labelKey: HistoryRefreshLabelKey): string {
  return i18n.t(REFRESH_CAPTIONS[labelKey])
}

/**
 * Interval validation. A missing, negative, fractional or absurd value becomes
 * a usable one: `0` (off) for anything at or below zero, otherwise a whole
 * number of seconds capped at ten minutes. `NaN` is off rather than an infinite
 * poll, because a garbage value must never turn into a busy loop.
 */
export function normalizeRefreshSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return 0
  const rounded = Math.round(seconds)
  if (rounded <= 0) return 0
  return Math.min(REFRESH_MAX_SECONDS, rounded)
}

/** True when automatic refresh is on at all. */
export function refreshEnabled(seconds: number): boolean {
  return normalizeRefreshSeconds(seconds) > 0
}

/** "30 秒" / "5 分钟" — the span alone, no "自动刷新" prefix. */
export function refreshSpanText(seconds: number): string {
  const safe = normalizeRefreshSeconds(seconds)
  if (safe >= 60 && safe % 60 === 0) return i18n.t('{{n}} 分钟', { n: safe / 60 })
  return i18n.t('{{n}} 秒', { n: safe })
}

/**
 * The hint that makes the automatic state visible next to the button:
 * "自动刷新 30 秒", or "自动刷新已关闭" when it is off.
 */
export function refreshLabel(seconds: number): string {
  return refreshEnabled(seconds)
    ? i18n.t('自动刷新 {{span}}', { span: refreshSpanText(seconds) })
    : i18n.t('自动刷新已关闭')
}

/** Why one automatic tick was skipped; `null` means "go ahead". */
export type AutoRefreshBlock = 'search' | 'dialog' | 'busy'

export interface AutoRefreshContext {
  /** The user is typing a search; re-reading would move rows under the caret. */
  searchFocused: boolean
  /** A dialog owns the screen, so a silent re-sort would be disorienting. */
  dialogOpen: boolean
  /** A query is already running; a second one must never overlap it. */
  inFlight: boolean
}

/**
 * Decision for one interval tick. Automatic refresh is a convenience, so it
 * yields to everything the user is doing: focus, dialogs and any in-flight
 * query all cancel the tick instead of racing it.
 */
export function autoRefreshBlocked(context: AutoRefreshContext): AutoRefreshBlock | null {
  if (context.searchFocused) return 'search'
  if (context.dialogOpen) return 'dialog'
  if (context.inFlight) return 'busy'
  return null
}

// ---------------------------------------------------------------------------
// Section header — one tab's caption and the row count next to it
// ---------------------------------------------------------------------------

/** The tabs above the list: "every mode" plus one per dictation mode. */
export type HistoryFilterId = 'all' | Mode

/**
 * Tab caption. Same wording as {@link modeLabel}, so the chip a row prints and
 * the tab that selected it can never drift apart.
 */
export function filterLabel(filterId: HistoryFilterId): string {
  return filterId === 'all' ? i18n.t('全部') : modeLabel(filterId)
}

/**
 * Section-header counter: "听写 42 条". A negative, fractional or non-finite
 * total degrades to "0 条" instead of printing NaN into the header.
 */
export function countLabel(filterId: HistoryFilterId, total: number): string {
  const safe = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0
  return i18n.t('{{label}} {{n}} 条', { label: filterLabel(filterId), n: safe })
}

// ---------------------------------------------------------------------------
// Empty state — "nothing matches" is not the same screen as "nothing recorded"
// ---------------------------------------------------------------------------

export type HistoryEmptyKind = 'records' | 'search' | 'filter' | 'app' | 'date'

export interface EmptyStateInput {
  /** Raw search text; `trim` decides whether it counts as a search at all. */
  query: string
  /** Active tab. A mode tab can hide rows the search did not remove. */
  filter: HistoryFilterId
  /** Rows left after filtering; `0` when the caller renders an empty list. */
  matches: number
  /** Selected window; blank (or absent) when the whole history is in scope. */
  app?: string
  dateFiltered?: boolean
}

/**
 * Which empty screen to show, or `null` when there is something to render.
 * Search wins over the tab because a search is the more specific intent, and a
 * whitespace-only query is not a search. A picked window sits between the two:
 * it is more specific than the tab, but a search still explains best why the
 * list came back empty.
 */
export function emptyStateKind(input: EmptyStateInput): HistoryEmptyKind | null {
  if (input.matches > 0) return null
  if (input.query.trim() !== '') return 'search'
  if (appFilterActive(input.app ?? '')) return 'app'
  if (input.filter !== 'all') return 'filter'
  if (input.dateFiltered) return 'date'
  return 'records'
}

export interface EmptyStateCopy {
  readonly title: string
  readonly hint: string
}

/** Copy for one empty screen; `hint` may be empty and is then not rendered. */
export function emptyStateCopy(kind: HistoryEmptyKind): EmptyStateCopy {
  switch (kind) {
    case 'search':
      return { title: i18n.t('没有匹配的记录'), hint: i18n.t('换个关键词试试。') }
    case 'filter':
      return { title: i18n.t('这个分类下还没有记录'), hint: '' }
    case 'app':
      return { title: i18n.t('这个窗口下还没有记录'), hint: i18n.t('换一个窗口，或者切回「全部」。') }
    case 'date':
      return { title: i18n.t('这个日期范围内没有记录'), hint: i18n.t('换一个日期范围试试。') }
    default:
      return { title: i18n.t('还没有记录'), hint: i18n.t('按下快捷键说一句，记录会出现在这里。') }
  }
}

/** Caption of the per-row toggle that reveals the ASR text. */
export const ORIGINAL_SHOW_LABEL = '显示原文'
export const ORIGINAL_HIDE_LABEL = '收起原文'
/** Appended when the reveal would show the same string twice. */
export const ORIGINAL_SAME_SUFFIX = '（与结果相同）'

export type HistoryPeriod = 'all' | 'today' | 'week' | 'month' | 'custom'
export function historyDateBounds(period: HistoryPeriod, from = '', to = '', now = Date.now()): { start: number; end: number; error?: string } {
  const invalid = (error: string): ReturnType<typeof historyDateBounds> => ({ start: 0, end: 0, error })
  const date = (value: string): Date | null => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
    if (!match) return null
    const d = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    return d.getFullYear() === Number(match[1]) && d.getMonth() + 1 === Number(match[2]) && d.getDate() === Number(match[3]) ? d : null
  }
  if (period === 'all') return { start: -Infinity, end: Infinity }
  if (period === 'custom') {
    if (!from && !to) return invalid('请选择起始或结束日期')
    const start = from ? date(from) : null, end = to ? date(to) : null
    if (from && !start || to && !end) return invalid('日期无效，请重新选择')
    if (start && end && start > end) return invalid('起始日期不能晚于结束日期')
    if (end) end.setDate(end.getDate() + 1)
    return { start: start?.getTime() ?? -Infinity, end: end?.getTime() ?? Infinity }
  }
  const today = new Date(now), start = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const end = new Date(start); end.setDate(end.getDate() + 1)
  start.setDate(start.getDate() - (period === 'week' ? 6 : period === 'month' ? 29 : 0))
  return { start: start.getTime(), end: end.getTime() }
}

/** Filter before paging; use calendar boundaries so DST days are not forced to 24h. */
export function historyDateView(entries: readonly HistoryEntry[], bounds: { start: number; end: number }, order: 'newest' | 'oldest'): HistoryEntry[] {
  return entries.filter(entry => entry.createdAt >= bounds.start && entry.createdAt < bounds.end)
    .sort((a, b) => order === 'oldest' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt)
}

export function historySources(sources: readonly SearchResult[]): Array<{ source: SearchResult; number: number }> {
  return sources.flatMap((source, index) => isSafeLink(source.url) ? [{ source, number: index + 1 }] : [])
}

export function historyNote(entry: HistoryEntry): string {
  const literal = (text: string): string => text.replace(/[\r\n]+/g, ' ').replace(/[\\`*_{}\[\]<>#!|]/g, '\\$&')
  const sources = historySources(entry.sources ?? [])
  return [
    `## ${i18n.t('模式')} · ${modeLabel(entry.mode)}`,
    ...(entry.promptName ? [`${i18n.t('卡片')}：${literal(entry.promptName)}`] : []),
    `### ${i18n.t('原始转写')}`, entry.transcript,
    `### ${i18n.t('识别结果')}`, entry.final,
    ...(sources.length ? [`### ${i18n.t('来源')}`, sources.map(({ source, number }) => `${number}. ${literal(source.title || source.url)} — ${source.url}`).join('\n')] : [])
  ].join('\n\n')
}

/**
 * The transcript exactly as the recogniser returned it — before cards, cleanup
 * and the correction rules. This is what a rule has to appear in to count as a
 * hit, so it is also the only way to check a rule by eye.
 */
export function originalText(entry: Pick<HistoryEntry, 'transcript'>): string | null {
  const raw = (entry.transcript ?? '').trim()
  return raw ? raw : null
}

/** True when revealing the original would only repeat the result. */
export function originalMatchesResult(
  entry: Pick<HistoryEntry, 'transcript' | 'final'>
): boolean {
  const raw = (entry.transcript ?? '').trim()
  return raw !== '' && raw === (entry.final ?? '').trim()
}
