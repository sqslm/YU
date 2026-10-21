import { describe, expect, it } from 'vitest'
import type { HistoryEntry } from '@shared/types'
import {
  APP_FILTER_ALL,
  APP_FILTER_ALL_LABEL,
  APP_FILTER_MAX,
  CARD_MISSING_LABEL,
  CARD_UNKNOWN_TITLE,
  NO_AUDIO_REASON,
  PAGE_SIZE,
  REFRESH_MAX_SECONDS,
  REFRESH_OPTIONS,
  appFilterActive,
  appFilterLabel,
  appFilterStillValid,
  appOptions,
  autoRefreshBlocked,
  bodyOf,
  originalMatchesResult,
  originalText,
  canDownloadAudio,
  canNextPage,
  canPrevPage,
  canRestore,
  canRetry,
  cardLabel,
  cardTitle,
  clampPage,
  countLabel,
  emptyStateCopy,
  emptyStateKind,
  filterByApp,
  filterLabel,
  formatAttempts,
  hasAudio,
  hasCardName,
  hintText,
  modeLabel,
  normalizeRefreshSeconds,
  pageCount,
  pageLabel,
  providerLabel,
  providerTitle,
  reasonText,
  refreshEnabled,
  refreshLabel,
  refreshOptionLabel,
  refreshSpanText,
  retryBlockedReason,
  rowActions,
  slicePage,
  statusLabel,
  statusOf,
  statusTone
} from './historyView'

function entry(patch: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: 'id-1',
    createdAt: new Date(2026, 9, 19, 9, 30).getTime(),
    mode: 'dictation',
    transcript: '今天天气不错',
    final: '今天天气不错。',
    durationMs: 2400,
    app: 'Notepad',
    ...patch
  }
}

describe('statusOf', () => {
  it('defaults a missing status to completed', () => {
    expect(statusOf(entry())).toBe('completed')
    expect(statusOf({ status: 'completed' })).toBe('completed')
  })

  it('keeps every known status', () => {
    expect(statusOf({ status: 'error' })).toBe('error')
    expect(statusOf({ status: 'empty' })).toBe('empty')
    expect(statusOf({ status: 'dismissed' })).toBe('dismissed')
  })

  it('treats a legacy failure as error and an unknown value as completed', () => {
    expect(statusOf({ error: '连接被重置' })).toBe('error')
    expect(statusOf({ status: 'oops' as never })).toBe('completed')
    expect(statusOf({ error: '   ' })).toBe('completed')
  })
})

describe('statusLabel / statusTone', () => {
  it('stays silent for a completed take', () => {
    expect(statusLabel(entry())).toBeNull()
    expect(statusTone(entry())).toBeNull()
  })

  it('maps the three failure states', () => {
    expect(statusLabel(entry({ status: 'error', error: 'boom' }))).toBe('失败')
    expect(statusTone(entry({ status: 'error', error: 'boom' }))).toBe('error')
    expect(statusLabel(entry({ status: 'empty' }))).toBe('没听到声音')
    expect(statusTone(entry({ status: 'empty' }))).toBe('warn')
    expect(statusLabel(entry({ status: 'dismissed' }))).toBe('已取消')
    expect(statusTone(entry({ status: 'dismissed' }))).toBe('muted')
  })
})

describe('reasonText', () => {
  it('prefers the alert classification', () => {
    expect(reasonText(entry({ status: 'error', alertKind: 'asr_failed' }))).toBe('没听清')
    expect(reasonText(entry({ status: 'error', alertKind: 'no_network' }))).toBe('网络不通')
    expect(reasonText(entry({ status: 'error', alertKind: 'auth' }))).toBe('密钥无效')
    expect(reasonText(entry({ status: 'error', alertKind: 'rate_limit' }))).toBe('被限流')
  })

  it('falls back to the raw error text and then to a generic line', () => {
    expect(
      reasonText(entry({ status: 'error', alertKind: 'what', error: 'ECONNREFUSED 127.0.0.1:1' }))
    ).toBe('ECONNREFUSED 127.0.0.1:1')
    expect(reasonText(entry({ status: 'error', error: '  没有可用模型  ' }))).toBe('没有可用模型')
    expect(reasonText(entry({ status: 'error' }))).toBe('这次没成功')
    expect(reasonText(entry({ status: 'error', alertKind: 'mystery' }))).toBe('mystery')
  })

  it('is null outside the error state', () => {
    expect(reasonText(entry())).toBeNull()
    expect(reasonText(entry({ status: 'empty' }))).toBeNull()
  })
})

describe('hintText', () => {
  it('advises on the microphone for an empty take', () => {
    expect(hintText(entry({ status: 'empty' }))).toContain('麦克风')
    expect(hintText(entry({ status: 'empty', alertKind: 'too_short' }))).toContain('太短')
  })

  it('tells the user to say it again for a cancelled take', () => {
    const plain = hintText(entry({ status: 'dismissed' }))
    expect(plain).toBe('这条被取消了，重新说一遍即可')
    const restorable = hintText(entry({ status: 'dismissed', audioPath: 'audio/a.wav' }))
    expect(restorable).toContain('这条被取消了，重新说一遍即可')
    expect(restorable).toContain('恢复')
  })

  it('is null for a completed take', () => {
    expect(hintText(entry())).toBeNull()
  })
})

describe('hasAudio / canDownloadAudio', () => {
  it('needs a non-blank audioPath', () => {
    expect(hasAudio(entry())).toBe(false)
    expect(hasAudio(entry({ audioPath: '' }))).toBe(false)
    expect(hasAudio(entry({ audioPath: '   ' }))).toBe(false)
    expect(hasAudio(entry({ audioPath: 'audio/1.wav' }))).toBe(true)
    expect(canDownloadAudio(entry({ audioPath: 'audio/1.wav' }))).toBe(true)
    expect(canDownloadAudio(entry())).toBe(false)
  })
})

describe('canRetry / retryBlockedReason', () => {
  it('only retries failed or empty takes', () => {
    expect(canRetry(entry())).toBe(false)
    expect(retryBlockedReason(entry())).toBe('这条不需要重试')
    expect(canRetry(entry({ status: 'dismissed', audioPath: 'audio/1.wav' }))).toBe(false)
  })

  it('needs the kept wav and says why when it is missing', () => {
    const failed = entry({ status: 'error', error: 'boom' })
    expect(canRetry(failed)).toBe(false)
    expect(retryBlockedReason(failed)).toBe(NO_AUDIO_REASON)
    expect(canRetry({ ...failed, audioPath: 'audio/1.wav' })).toBe(true)
    expect(retryBlockedReason({ ...failed, audioPath: 'audio/1.wav' })).toBeNull()
    expect(canRetry(entry({ status: 'empty', audioPath: 'audio/2.wav' }))).toBe(true)
  })
})

describe('canRestore', () => {
  it('restores a cancelled take only when the audio survived', () => {
    expect(canRestore(entry({ status: 'dismissed', audioPath: 'audio/1.wav' }))).toBe(true)
    expect(canRestore(entry({ status: 'dismissed' }))).toBe(false)
    expect(canRestore(entry({ status: 'error', audioPath: 'audio/1.wav' }))).toBe(false)
  })
})

describe('formatAttempts', () => {
  it('renders a count only after a real retry', () => {
    expect(formatAttempts(entry())).toBeNull()
    expect(formatAttempts(entry({ attempts: 0 }))).toBeNull()
    expect(formatAttempts(entry({ attempts: 1 }))).toBe('已重试 1 次')
    expect(formatAttempts(entry({ attempts: 3 }))).toBe('已重试 3 次')
  })
})

describe('bodyOf', () => {
  it('shows the final text for a completed take', () => {
    expect(bodyOf(entry())).toEqual({ text: '今天天气不错。', tone: 'normal', detail: null })
    expect(bodyOf(entry({ final: '  ', transcript: '原话' })).text).toBe('原话')
  })

  it('shows the reason plus the transcript for a failure', () => {
    const body = bodyOf(
      entry({ status: 'error', alertKind: 'llm_failed', final: '', transcript: '写一段话' })
    )
    expect(body).toEqual({ text: '失败：模型没答上来', tone: 'error', detail: '原话：写一段话' })
    expect(bodyOf(entry({ status: 'error', final: '', transcript: '' })).detail).toBeNull()
  })

  it('keeps an empty take text-free and a cancelled one muted', () => {
    expect(bodyOf(entry({ status: 'empty', final: '' }))).toEqual({
      text: '',
      tone: 'muted',
      detail: null
    })
    expect(bodyOf(entry({ status: 'dismissed' }))).toEqual({
      text: '今天天气不错。',
      tone: 'muted',
      detail: null
    })
  })
})

describe('rowActions', () => {
  it('offers no footer for a clean take', () => {
    expect(rowActions(entry())).toEqual([])
  })

  it('offers a disabled retry that explains itself when there is no audio', () => {
    expect(rowActions(entry({ status: 'error', error: 'boom' }))).toEqual([
      { id: 'retry', label: '重试', disabled: true, tooltip: NO_AUDIO_REASON }
    ])
  })

  it('offers retry and download when the audio was kept', () => {
    expect(rowActions(entry({ status: 'empty', audioPath: 'audio/1.wav' }))).toEqual([
      { id: 'retry', label: '重试', disabled: false, tooltip: null },
      { id: 'download', label: '下载音频', disabled: false, tooltip: null }
    ])
  })

  it('swaps retry for restore on a cancelled take', () => {
    expect(rowActions(entry({ status: 'dismissed' }))).toEqual([
      { id: 'restore', label: '恢复', disabled: true, tooltip: NO_AUDIO_REASON }
    ])
    expect(rowActions(entry({ status: 'dismissed', audioPath: 'audio/1.wav' })).map((a) => a.id)).toEqual(
      ['restore', 'download']
    )
  })

  it('offers download alone on a completed take with audio', () => {
    expect(rowActions(entry({ audioPath: 'audio/1.wav' })).map((a) => a.id)).toEqual(['download'])
  })
})

describe('modeLabel', () => {
  it('names all three modes in Chinese', () => {
    expect(modeLabel('dictation')).toBe('听写')
    expect(modeLabel('translate')).toBe('翻译')
    expect(modeLabel('ask')).toBe('问答')
  })

  it('never prints the raw enum for an unknown value', () => {
    expect(modeLabel('whatever' as never)).toBe('听写')
  })
})

describe('cardLabel / hasCardName', () => {
  it('shows the recorded card name', () => {
    const take = entry({ promptKind: 'polish', promptId: 'polish-default', promptName: '日常润色' })
    expect(cardLabel(take)).toBe('日常润色')
    expect(hasCardName(take)).toBe(true)
  })

  it('says so instead of going blank on a legacy take', () => {
    const legacy = entry()
    expect(cardLabel(legacy)).toBe(CARD_MISSING_LABEL)
    expect(hasCardName(legacy)).toBe(false)
  })

  it('treats an empty or blank name as missing', () => {
    expect(cardLabel(entry({ promptName: '' }))).toBe(CARD_MISSING_LABEL)
    expect(cardLabel(entry({ promptName: '   ' }))).toBe(CARD_MISSING_LABEL)
    expect(hasCardName(entry({ promptName: '  ' }))).toBe(false)
  })
})

describe('cardTitle', () => {
  it('joins the kind label and the card id', () => {
    const take = entry({ promptKind: 'polish', promptId: 'polish-default', promptName: '日常润色' })
    expect(cardTitle(take)).toBe('润色 · polish-default')
    expect(cardTitle(entry({ promptKind: 'email', promptId: 'email-direct' }))).toBe(
      '邮件 · email-direct'
    )
  })

  it('names whichever half survived a partial record', () => {
    expect(cardTitle(entry({ promptKind: 'translate' }))).toBe('翻译')
    expect(cardTitle(entry({ promptId: 'polish-default' }))).toBe('polish-default')
  })

  it('explains itself when nothing was recorded', () => {
    expect(cardTitle(entry())).toBe(CARD_UNKNOWN_TITLE)
    expect(cardTitle(entry({ promptKind: 'polish', promptId: '  ' }))).toBe('润色')
  })
})

describe('providerLabel / providerTitle', () => {
  it('shows the provider that answered', () => {
    const take = entry({ providerId: 'groq-a1', providerName: 'Groq' })
    expect(providerLabel(take)).toBe('Groq')
    expect(providerTitle(take)).toBe('提供商配置 · groq-a1')
  })

  it('stays silent when no provider was recorded', () => {
    expect(providerLabel(entry())).toBeNull()
    expect(providerLabel(entry({ providerName: '' }))).toBeNull()
    expect(providerLabel(entry({ providerName: '   ' }))).toBeNull()
    expect(providerTitle(entry())).toBeNull()
    expect(providerTitle(entry({ providerName: 'Groq' }))).toBeNull()
  })
})

describe('PAGE_SIZE / pageCount', () => {
  it('pages thirty rows at a time', () => {
    expect(PAGE_SIZE).toBe(30)
  })

  it('counts pages and never reports zero for an empty list', () => {
    expect(pageCount(0)).toBe(1)
    expect(pageCount(-4)).toBe(1)
    expect(pageCount(Number.NaN)).toBe(1)
    expect(pageCount(1)).toBe(1)
    expect(pageCount(30)).toBe(1)
    expect(pageCount(31)).toBe(2)
    expect(pageCount(60)).toBe(2)
    expect(pageCount(61)).toBe(3)
    expect(pageCount(300)).toBe(10)
  })

  it('ignores a fractional row count instead of inventing a page', () => {
    expect(pageCount(30.9)).toBe(1)
    expect(pageCount(31.0001)).toBe(2)
  })
})

describe('clampPage', () => {
  it('pulls a page below the range up to the first page', () => {
    expect(clampPage(0, 90)).toBe(1)
    expect(clampPage(-3, 90)).toBe(1)
    expect(clampPage(0.4, 90)).toBe(1)
    expect(clampPage(Number.NaN, 90)).toBe(1)
    expect(clampPage(1, 0)).toBe(1)
  })

  it('pulls a page past the end back to the last page', () => {
    expect(clampPage(9, 90)).toBe(3)
    expect(clampPage(4, 31)).toBe(2)
    expect(clampPage(2, 90)).toBe(2)
  })

  it('floors a fractional page', () => {
    expect(clampPage(2.9, 90)).toBe(2)
  })
})

describe('slicePage', () => {
  const items = Array.from({ length: 75 }, (_, index) => index)

  it('returns the rows of one page', () => {
    expect(slicePage(items, 1)).toEqual(items.slice(0, 30))
    expect(slicePage(items, 2)).toEqual(items.slice(30, 60))
    expect(slicePage(items, 3)).toEqual(items.slice(60, 75))
    expect(slicePage(items, 3)).toHaveLength(15)
  })

  it('clamps an out-of-range page instead of returning a blank page', () => {
    expect(slicePage(items, 99)).toEqual(items.slice(60, 75))
    expect(slicePage(items, 0)).toEqual(items.slice(0, 30))
    expect(slicePage(items, -2)).toEqual(items.slice(0, 30))
  })

  it('handles an empty list and a page shorter than the size', () => {
    expect(slicePage([], 1)).toEqual([])
    expect(slicePage(items.slice(0, 4), 1)).toEqual([0, 1, 2, 3])
    expect(slicePage(items.slice(0, 4), 2)).toEqual([0, 1, 2, 3])
  })

  it('keeps rows contiguous across a page boundary', () => {
    // Day grouping runs on the slice, so page 2 must open with the very next
    // row of page 1 — that row is what carries the header for the rest of its
    // day instead of the page starting headerless.
    const firstPage = slicePage(items, 1)
    const secondPage = slicePage(items, 2)
    expect(secondPage[0]).toBe(firstPage[firstPage.length - 1]! + 1)
  })
})

describe('canPrevPage / canNextPage', () => {
  it('enables the arrows only where there is somewhere to go', () => {
    expect(canPrevPage(1, 90)).toBe(false)
    expect(canPrevPage(2, 90)).toBe(true)
    expect(canNextPage(1, 90)).toBe(true)
    expect(canNextPage(3, 90)).toBe(false)
    expect(canPrevPage(9, 90)).toBe(true)
    expect(canNextPage(9, 90)).toBe(false)
    expect(canPrevPage(1, 0)).toBe(false)
    expect(canNextPage(1, 0)).toBe(false)
  })
})

describe('pageLabel', () => {
  it('names the current page out of the total', () => {
    expect(pageLabel(1, 90)).toBe('第 1 / 3 页')
    expect(pageLabel(2, 90)).toBe('第 2 / 3 页')
    expect(pageLabel(1, 0)).toBe('第 1 / 1 页')
  })

  it('always prints a clamped page', () => {
    expect(pageLabel(99, 90)).toBe('第 3 / 3 页')
    expect(pageLabel(0, 90)).toBe('第 1 / 3 页')
  })
})

describe('REFRESH_OPTIONS / refreshOptionLabel', () => {
  it('offers the six intervals in display order', () => {
    expect(REFRESH_OPTIONS.map((option) => option.value)).toEqual([0, 5, 15, 30, 60, 300])
    expect(REFRESH_OPTIONS.map((option) => option.labelKey)).toEqual([
      'historyRefreshOff',
      'historyRefresh5',
      'historyRefresh15',
      'historyRefresh30',
      'historyRefresh60',
      'historyRefresh300'
    ])
  })

  it('captions every chip, with zero meaning off', () => {
    expect(refreshOptionLabel('historyRefreshOff')).toBe('关闭')
    expect(refreshOptionLabel('historyRefresh5')).toBe('5 秒')
    expect(refreshOptionLabel('historyRefresh15')).toBe('15 秒')
    expect(refreshOptionLabel('historyRefresh30')).toBe('30 秒')
    expect(refreshOptionLabel('historyRefresh60')).toBe('60 秒')
    expect(refreshOptionLabel('historyRefresh300')).toBe('5 分钟')
  })
})

describe('normalizeRefreshSeconds', () => {
  it('keeps a usable interval and rounds it to whole seconds', () => {
    expect(normalizeRefreshSeconds(0)).toBe(0)
    expect(normalizeRefreshSeconds(5)).toBe(5)
    expect(normalizeRefreshSeconds(30)).toBe(30)
    expect(normalizeRefreshSeconds(300)).toBe(300)
    expect(normalizeRefreshSeconds(3.6)).toBe(4)
  })

  it('treats garbage as off instead of polling forever', () => {
    expect(normalizeRefreshSeconds(Number.NaN)).toBe(0)
    expect(normalizeRefreshSeconds(Number.POSITIVE_INFINITY)).toBe(0)
    expect(normalizeRefreshSeconds(-10)).toBe(0)
    expect(normalizeRefreshSeconds(0.4)).toBe(0)
  })

  it('caps the interval at ten minutes', () => {
    expect(REFRESH_MAX_SECONDS).toBe(600)
    expect(normalizeRefreshSeconds(601)).toBe(600)
    expect(normalizeRefreshSeconds(999999)).toBe(600)
  })
})

describe('refreshSpanText / refreshLabel / refreshEnabled', () => {
  it('formats seconds and whole minutes', () => {
    expect(refreshSpanText(5)).toBe('5 秒')
    expect(refreshSpanText(30)).toBe('30 秒')
    expect(refreshSpanText(60)).toBe('1 分钟')
    expect(refreshSpanText(300)).toBe('5 分钟')
    expect(refreshSpanText(90)).toBe('90 秒')
  })

  it('makes the automatic state readable next to the button', () => {
    expect(refreshLabel(0)).toBe('自动刷新已关闭')
    expect(refreshLabel(30)).toBe('自动刷新 30 秒')
    expect(refreshLabel(300)).toBe('自动刷新 5 分钟')
    expect(refreshLabel(601)).toBe('自动刷新 10 分钟')
    expect(refreshLabel(Number.NaN)).toBe('自动刷新已关闭')
  })

  it('says whether the timer runs at all', () => {
    expect(refreshEnabled(0)).toBe(false)
    expect(refreshEnabled(-1)).toBe(false)
    expect(refreshEnabled(Number.NaN)).toBe(false)
    expect(refreshEnabled(5)).toBe(true)
  })
})

describe('autoRefreshBlocked', () => {
  const idle = { searchFocused: false, dialogOpen: false, inFlight: false }

  it('lets the tick through when nothing else is happening', () => {
    expect(autoRefreshBlocked(idle)).toBeNull()
  })

  it('yields to the search box, an open dialog and a running query', () => {
    expect(autoRefreshBlocked({ ...idle, searchFocused: true })).toBe('search')
    expect(autoRefreshBlocked({ ...idle, dialogOpen: true })).toBe('dialog')
    expect(autoRefreshBlocked({ ...idle, inFlight: true })).toBe('busy')
  })

  it('reports the first reason when several apply', () => {
    expect(autoRefreshBlocked({ searchFocused: true, dialogOpen: true, inFlight: true })).toBe(
      'search'
    )
    expect(autoRefreshBlocked({ searchFocused: false, dialogOpen: true, inFlight: true })).toBe(
      'dialog'
    )
  })
})

describe('filterLabel / countLabel', () => {
  it('captions the four tabs with the same words the rows use', () => {
    expect(filterLabel('all')).toBe('全部')
    expect(filterLabel('dictation')).toBe('听写')
    expect(filterLabel('ask')).toBe('问答')
    expect(filterLabel('translate')).toBe('翻译')
    expect(filterLabel('dictation')).toBe(modeLabel('dictation'))
  })

  it('counts the active tab in the header', () => {
    expect(countLabel('dictation', 42)).toBe('听写 42 条')
    expect(countLabel('all', 0)).toBe('全部 0 条')
    expect(countLabel('ask', 1)).toBe('问答 1 条')
  })

  it('never prints a negative or fractional count', () => {
    expect(countLabel('all', -3)).toBe('全部 0 条')
    expect(countLabel('all', 4.6)).toBe('全部 4 条')
    expect(countLabel('all', Number.NaN)).toBe('全部 0 条')
  })
})

describe('emptyStateKind', () => {
  it('stays silent when there are rows to show', () => {
    expect(emptyStateKind({ query: '', filter: 'all', matches: 30 })).toBeNull()
    expect(emptyStateKind({ query: '会议', filter: 'ask', matches: 2 })).toBeNull()
  })

  it('separates a search that found nothing from a tab that hid everything', () => {
    expect(emptyStateKind({ query: '会议', filter: 'all', matches: 0 })).toBe('search')
    expect(emptyStateKind({ query: '', filter: 'ask', matches: 0 })).toBe('filter')
    expect(emptyStateKind({ query: '', filter: 'all', matches: 0 })).toBe('records')
  })

  it('does not count whitespace as a search', () => {
    expect(emptyStateKind({ query: '   ', filter: 'all', matches: 0 })).toBe('records')
    expect(emptyStateKind({ query: '\t', filter: 'ask', matches: 0 })).toBe('filter')
  })

  it('prefers the search screen when both a search and a tab are active', () => {
    expect(emptyStateKind({ query: '会议', filter: 'translate', matches: 0 })).toBe('search')
  })
})

describe('emptyStateCopy', () => {
  it('gives every empty screen its own title', () => {
    const titles = (['records', 'search', 'filter'] as const).map(
      (kind) => emptyStateCopy(kind).title
    )
    expect(new Set(titles).size).toBe(3)
    expect(emptyStateCopy('records').title).toBe('还没有记录')
    expect(emptyStateCopy('search').title).toBe('没有匹配的记录')
    expect(emptyStateCopy('filter').title).toBe('这个分类下还没有记录')
  })

  it('keeps a hint only where there is something to do', () => {
    expect(emptyStateCopy('records').hint).not.toBe('')
    expect(emptyStateCopy('search').hint).not.toBe('')
    expect(emptyStateCopy('filter').hint).toBe('')
  })
})

describe('appOptions', () => {
  it('去重后按字母排序，并跳过空窗口名', () => {
    const list = [
      entry({ id: 'a', app: 'Slack' }),
      entry({ id: 'b', app: 'Chrome' }),
      entry({ id: 'c', app: 'Slack' }),
      entry({ id: 'd', app: 'Notepad' }),
      entry({ id: 'e', app: 'Chrome' }),
      entry({ id: 'f', app: '' }),
      entry({ id: 'g', app: '   ' })
    ]
    expect(appOptions(list)).toEqual(['Chrome', 'Notepad', 'Slack'])
    expect(appOptions([])).toEqual([])
  })

  it('中文标题按拼音排序', () => {
    const list = ['微信', '终端', '钉钉', '浏览器'].map((app, index) =>
      entry({ id: `c${index}`, app })
    )
    expect(appOptions(list)).toEqual(['钉钉', '浏览器', '微信', '终端'])
  })

  it('超过上限时只留下出现次数最多的窗口', () => {
    const many = Array.from({ length: 45 }, (_, index) =>
      entry({ id: `m${index}`, app: `App ${String(index + 1).padStart(2, '0')}` })
    )
    const heavy = Array.from({ length: 3 }, (_, index) =>
      entry({ id: `h${index}`, app: 'Zzz 常用' })
    )
    const options = appOptions([...many, ...heavy], APP_FILTER_MAX)
    expect(APP_FILTER_MAX).toBe(40)
    expect(options).toHaveLength(40)
    // 出现次数压过字母顺序：只有一个条目的窗口被挤掉，常驻窗口留下。
    expect(options[0]).toBe('App 01')
    expect(options).toContain('App 39')
    expect(options).not.toContain('App 40')
    expect(options[options.length - 1]).toBe('Zzz 常用')
    expect(appOptions([...many, ...heavy], 2)).toEqual(['App 01', 'Zzz 常用'])
  })
})

describe('filterByApp', () => {
  const list = [
    entry({ id: 'chrome', app: 'Chrome' }),
    entry({ id: 'wechat', app: '微信' }),
    entry({ id: 'chrome-lower', app: 'chrome' })
  ]

  it('「全部」和空值都不过滤', () => {
    // 占位选项靠空值识别，标题本身不是窗口名。
    expect(APP_FILTER_ALL).toBe('')
    expect(appFilterLabel(APP_FILTER_ALL)).toBe(APP_FILTER_ALL_LABEL)
    expect(filterByApp(list, APP_FILTER_ALL)).toEqual(list)
    expect(filterByApp(list, '   ')).toEqual(list)
    expect(filterByApp([], 'Chrome')).toEqual([])
  })

  it('只保留 app 完全相等的条目', () => {
    expect(filterByApp(list, '微信').map((item) => item.id)).toEqual(['wechat'])
    expect(filterByApp(list, 'Chrome').map((item) => item.id)).toEqual(['chrome'])
  })

  it('大小写、前缀和空白差异都不会被误匹配', () => {
    expect(filterByApp(list, 'CHROME')).toEqual([])
    expect(filterByApp(list, 'Chrom')).toEqual([])
    expect(filterByApp([entry({ id: 'padded', app: ' Chrome' })], 'Chrome')).toEqual([])
    // 下拉里给的值原样比较，所以带空白的窗口名仍然选得中它自己的条目。
    expect(filterByApp([entry({ id: 'padded', app: ' Chrome' })], ' Chrome')).toHaveLength(1)
  })
})

describe('appFilterLabel / appFilterActive / appFilterStillValid', () => {
  it('给占位选项一个中文标题', () => {
    expect(appFilterLabel(APP_FILTER_ALL)).toBe(APP_FILTER_ALL_LABEL)
    expect(APP_FILTER_ALL_LABEL).toBe('全部')
    expect(appFilterLabel('Chrome')).toBe('Chrome')
    expect(appFilterActive('')).toBe(false)
    expect(appFilterActive('   ')).toBe(false)
    expect(appFilterActive('Chrome')).toBe(true)
  })

  it('选中的窗口消失后才回落到全部', () => {
    const options = ['Chrome', '微信']
    expect(appFilterStillValid(options, APP_FILTER_ALL)).toBe(true)
    expect(appFilterStillValid(options, 'Chrome')).toBe(true)
    expect(appFilterStillValid(options, 'chrome')).toBe(false)
    expect(appFilterStillValid([], 'Chrome')).toBe(false)
  })
})

describe('emptyStateKind 与窗口筛选', () => {
  it('窗口筛选筛空时单独说明', () => {
    expect(emptyStateKind({ query: '', filter: 'all', matches: 0, app: 'Chrome' })).toBe('app')
    expect(emptyStateKind({ query: '会议', filter: 'all', matches: 0, app: 'Chrome' })).toBe(
      'search'
    )
    expect(emptyStateKind({ query: '', filter: 'ask', matches: 0, app: '' })).toBe('filter')
    expect(emptyStateKind({ query: '', filter: 'all', matches: 0, app: '   ' })).toBe('records')
    expect(emptyStateKind({ query: '', filter: 'all', matches: 3, app: 'Chrome' })).toBeNull()
    expect(emptyStateCopy('app').title).toBe('这个窗口下还没有记录')
  })
})

describe('the original transcript', () => {
  it('returns the raw text for a row that was rewritten', () => {
    expect(originalText(entry({ transcript: '  Debug harness. ', final: 'DeepSeek Harness。' }))).toBe(
      'Debug harness.'
    )
  })

  it('has nothing to reveal when the recogniser returned no text', () => {
    expect(originalText(entry({ transcript: '', final: '说出来的' }))).toBeNull()
    expect(originalText(entry({ transcript: '   ', final: '说出来的' }))).toBeNull()
  })

  it('flags rows where the reveal would repeat the result', () => {
    expect(originalMatchesResult(entry({ transcript: '一样', final: '一样' }))).toBe(true)
    expect(originalMatchesResult(entry({ transcript: '一样', final: '不一样' }))).toBe(false)
    // No transcript at all is not "the same text": there is nothing to show.
    expect(originalMatchesResult(entry({ transcript: '', final: '' }))).toBe(false)
  })
})
