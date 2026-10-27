import CalendarMonthOutlined from '@mui/icons-material/CalendarMonthOutlined'
import LinkOutlined from '@mui/icons-material/LinkOutlined'
import WbSunnyOutlined from '@mui/icons-material/WbSunnyOutlined'
import HistoryOutlined from '@mui/icons-material/HistoryOutlined'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Box, Button, MenuItem, Stack, Switch, TextField, Typography } from '@mui/material'
import type { ExternalCalendar, Settings } from '@shared/types'
import type { CalendarEvent, CalendarRange } from '@shared/calendar'
import { formatEventTime } from '@shared/calendar'
import type { Briefing, BriefingRecord } from '@shared/briefing'
import { MAX_BRIEFING_HISTORY, isWithinQuietHours, nextAllowedAt, normalizeBriefingTime } from '@shared/briefing'
import { MAX_EVENT_LEAD_MINUTES } from '@shared/calendar'
import { SettingsGroup, SettingsHint, SettingsRow, controlSx, narrowControlSx } from './General'
import i18n from '../../i18n'
import { BriefingDeliverySection } from './BriefingDelivery'

/**
 * The local calendar, the daily briefing and read-aloud.
 *
 * Everything here is a view onto a store the assistant also writes to: cancelling
 * an event here is what the next answer will read. Nothing is duplicated, so
 * there is no sync to reconcile.
 */

// Labels are keys, translated at render time: a module-level i18n.t() would
// freeze whichever language was active when the module first loaded.
const RANGES: { value: CalendarRange; label: string }[] = [
  { value: 'upcoming', label: '接下来的' },
  { value: 'today', label: '今天' },
  { value: 'week', label: '本周' },
  { value: 'tomorrow', label: '明天' }
]

/**
 * Quiet-hour slots: the night hours plus the shipped default `07:30`, because a
 * select whose value is not one of its options renders blank.
 *
 * The current pair is merged in at render time as well, so a settings file written
 * by an older build (or by hand) still shows what it holds instead of an empty box.
 */
const QUIET_CLOCKS = ['20:00', '21:00', '22:00', '23:00', '00:00', '01:00', '02:00', '03:00', '04:00', '05:00', '06:00', '07:00', '07:30', '08:00', '09:00']

/** `HH:mm` in the user's local zone, for the "arrives after …" hint. */
function clockText(epoch: number): string {
  const date = new Date(epoch)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** `2026-10-25` → `10 月 25 日 周日` / `Sun, Oct 25`; malformed keys stay as they are. */
function historyDayText(dayKey: string, language: 'zh' | 'en'): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey)
  if (!match) return dayKey
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  if (language === 'en') return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).format(date)
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(date)}`
}

function dayLabel(event: CalendarEvent, language: 'zh' | 'en'): string {
  const start = new Date(event.start)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const day = new Date(start)
  day.setHours(0, 0, 0, 0)
  const diff = Math.round((+day - +today) / (24 * 60 * 60_000))
  const prefix = diff === 0
    ? i18n.t('今天')
    : diff === 1
      ? i18n.t('明天')
      : diff === 2
        ? i18n.t('后天')
        : language === 'en'
          ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(start)
          : `${start.getMonth() + 1} 月 ${start.getDate()} 日`
  return `${prefix} ${formatEventTime(event, language)}`
}

export function LifeSection({ settings, patch }: {
  settings: Settings
  patch: (patch: Partial<Settings>) => void
}): JSX.Element {
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [range, setRange] = useState<CalendarRange>('upcoming')
  const [briefing, setBriefing] = useState<Briefing | null>(null)
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<BriefingRecord[]>([])
  const [openDay, setOpenDay] = useState<string | null>(null)
  const [feeds, setFeeds] = useState<ExternalCalendar[]>([])
  const [feedName, setFeedName] = useState('')
  const [feedUrl, setFeedUrl] = useState('')

  const language: 'zh' | 'en' = i18n.language === 'en' ? 'en' : 'zh'
  const quiet = settings.briefing.quietHours
  const clocks = useMemo(() => [...new Set([...QUIET_CLOCKS, quiet.start, quiet.end])].sort(), [quiet.start, quiet.end])

  /** Today at the configured delivery time: the instant the quiet window can swallow. */
  const deliveryAt = useMemo(() => {
    const [hour, minute] = normalizeBriefingTime(settings.briefing.time).split(':').map(Number)
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour ?? 0, minute ?? 0).getTime()
  }, [settings.briefing.time])
  // Asking `nextAllowedAt` instead of comparing the two clock strings keeps the
  // midnight wrap in one place: this hint and the scheduler cannot disagree.
  const pushedTo = isWithinQuietHours(settings.briefing, deliveryAt) ? nextAllowedAt(settings.briefing, deliveryAt) : null

  /** Newest first, capped like the store: the list is a reading surface, not an archive. */
  const recent = useMemo(() => [...history].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_BRIEFING_HISTORY), [history])
  const lastGenerated = recent[0] ?? null

  const patchQuiet = (next: Partial<Settings['briefing']['quietHours']>): void =>
    patch({ briefing: { ...settings.briefing, quietHours: { ...quiet, ...next } } })

  const loadHistory = useCallback(async (): Promise<void> => {
    try { setHistory(await window.api.life.briefingHistory()) } catch (error) { setNotice({ error: true, text: String(error) }) }
  }, [])

  const loadFeeds = useCallback(async (): Promise<void> => {
    try { setFeeds(await window.api.life.feeds()) } catch (error) { setNotice({ error: true, text: String(error) }) }
  }, [])

  /**
   * Feed edits go through the main process and come back as the whole list: the
   * page never guesses what the stored rows look like after a validation that
   * only the main process can perform.
   */
  const addFeed = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.api.life.addFeed({ name: feedName, url: feedUrl })
      if (!result.ok) setNotice({ error: true, text: result.error })
      else {
        setFeeds(previous => [...previous, result.calendar])
        setFeedName(''); setFeedUrl('')
        setNotice({ error: false, text: i18n.t('已添加订阅：{{name}}', { name: result.calendar.name }) })
      }
    } catch (error) { setNotice({ error: true, text: String(error) }) }
    finally { setBusy(false) }
  }

  const refreshFeeds = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.api.life.refreshFeeds()
      if (!result.ok) setNotice({ error: true, text: result.error })
      else {
        const { added, updated, failed } = result.result
        setNotice({ error: false, text: failed
          ? i18n.t('订阅已刷新：新增 {{added}} 条，更新 {{updated}} 条，{{failed}} 个没有拉到', { added, updated, failed })
          : i18n.t('订阅已刷新：新增 {{added}} 条，更新 {{updated}} 条', { added, updated }) })
        await loadFeeds()
        await loadEvents(range)
      }
    } catch (error) { setNotice({ error: true, text: String(error) }) }
    finally { setBusy(false) }
  }

  const removeFeed = async (id: string): Promise<void> => {
    try { setFeeds((await window.api.life.removeFeed(id)).feeds) } catch (error) { setNotice({ error: true, text: String(error) }) }
  }

  const toggleFeed = async (feed: ExternalCalendar, enabled: boolean): Promise<void> => {
    try {
      const result = await window.api.life.updateFeed({ id: feed.id, patch: { enabled } })
      if (result.ok) setFeeds(result.feeds)
      else setNotice({ error: true, text: result.error })
    } catch (error) { setNotice({ error: true, text: String(error) }) }
  }

  const loadEvents = useCallback(async (next: CalendarRange) => {
    try { setEvents(await window.api.life.events(next)) } catch (error) { setNotice({ error: true, text: String(error) }) }
  }, [])

  useEffect(() => { void loadEvents(range) }, [loadEvents, range])
  useEffect(() => { void loadFeeds() }, [loadFeeds])
  // The hub calendar page and the assistant write the same store, so the list has
  // to follow their edits instead of showing what was true when the tab opened.
  useEffect(() => window.api.life.onChanged(() => { void loadEvents(range) }), [loadEvents, range])
  useEffect(() => {
    let alive = true
    void window.api.life.briefing().then(
      (value) => { if (alive) setBriefing(value) },
      (error) => { if (alive) setNotice({ error: true, text: String(error) }) }
    )
    void loadHistory()
    return () => { alive = false }
  }, [loadHistory])

  const cancelEvent = async (id: string, action: 'cancel' | 'restore'): Promise<void> => {
    try { await window.api.life.cancelEvent(id, action); await loadEvents(range) } catch (error) { setNotice({ error: true, text: String(error) }) }
  }
  const compose = async (): Promise<void> => {
    setBusy(true)
    try {
      setBriefing(await window.api.life.refreshBriefing())
      // The fresh run is written to the history too, and that is what proves the
      // feature is alive — so reload it in the same click.
      await loadHistory()
    } catch (error) { setNotice({ error: true, text: String(error) }) }
    finally { setBusy(false) }
  }

  return (
    <Stack spacing={2}>
      {notice && <Alert severity={notice.error ? 'error' : 'success'} onClose={() => setNotice(null)}>{notice.text}</Alert>}

      <SettingsGroup icon={<CalendarMonthOutlined fontSize="small"/>} title={i18n.t('本地日程')}>
        <SettingsRow label={i18n.t('启用日程与提醒')} description={i18n.t('日程独立于提醒：日程有起止时间，到点前按这里的提前量提示。')}>
          <Switch size="small" checked={settings.calendar.enabled}
            onChange={e => patch({ calendar: { ...settings.calendar, enabled: e.target.checked } })} />
        </SettingsRow>
        <SettingsRow label={i18n.t('默认提前提醒')} description={i18n.t('单条日程可以单独设置；设为 0 表示到点才提醒。')}>
          {/* Wide enough for "10 minutes before" and "整点提醒": a fixed 140px
              clipped the English label to "10 minutes bef…". */}
          <TextField select size="small" sx={{ minWidth: 180 }} value={settings.calendar.defaultLeadMinutes}
            onChange={e => patch({ calendar: { ...settings.calendar, defaultLeadMinutes: Number(e.target.value) } })}>
            {[0, 5, 10, 15, 30, 60, MAX_EVENT_LEAD_MINUTES].filter((n, index, all) => all.indexOf(n) === index).map(n => (
              <MenuItem key={n} value={n}>{n === 0 ? i18n.t('不提前') : i18n.t('{{n}} 分钟前', { n })}</MenuItem>
            ))}
          </TextField>
        </SettingsRow>
        <SettingsRow label={i18n.t('查看范围')}>
          <TextField select size="small" sx={{ width: 140 }} value={range} onChange={e => setRange(e.target.value as CalendarRange)}>
            {RANGES.map(item => <MenuItem key={item.value} value={item.value}>{i18n.t(item.label)}</MenuItem>)}
          </TextField>
        </SettingsRow>
        {events.length === 0 && <SettingsHint>{i18n.t('这个范围里没有日程。对语说「明天下午三点到四点安排项目讨论」就会出现在这里。')}</SettingsHint>}
        {events.map(row => (
          <SettingsRow key={row.id} label={row.title}
            description={`${dayLabel(row, i18n.language === 'en' ? 'en' : 'zh')}${row.location ? ` · ${row.location}` : ''}${row.status === 'cancelled' ? ` · ${i18n.t('已取消')}` : ''}`}>
            {row.status === 'cancelled'
              ? <Button size="small" onClick={() => void cancelEvent(row.id, 'restore')}>{i18n.t('恢复')}</Button>
              : <Button size="small" onClick={() => void cancelEvent(row.id, 'cancel')}>{i18n.t('取消')}</Button>}
          </SettingsRow>
        ))}
      </SettingsGroup>

      <SettingsGroup icon={<LinkOutlined fontSize="small"/>} title={i18n.t('订阅日历')}>
        <SettingsHint>{i18n.t('把别人分享的 ICS 地址填进来，日程会合并到本地：订阅是只读的，这里的改动不会回写。')}</SettingsHint>
        {feeds.map(feed => (
          <SettingsRow key={feed.id} label={feed.name}
            description={`${feed.url}${feed.lastFetchedAt ? ` · ${i18n.t('上次拉取：{{time}}', { time: historyDayText(
              new Date(feed.lastFetchedAt).toISOString().slice(0, 10), language) })}` : ` · ${i18n.t('还没拉取过')}`}`}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Switch size="small" checked={feed.enabled} onChange={e => void toggleFeed(feed, e.target.checked)} />
              <Button size="small" onClick={() => void removeFeed(feed.id)}>{i18n.t('移除')}</Button>
            </Stack>
          </SettingsRow>
        ))}
        <SettingsRow label={i18n.t('添加订阅')} description={i18n.t('支持 https 与 webcal 链接；本机地址和回环地址会被拒绝。')}>
          <Stack direction="row" spacing={1} alignItems="center">
            <TextField size="small" sx={narrowControlSx} placeholder={i18n.t('名称（可留空）')} value={feedName}
              onChange={e => setFeedName(e.target.value)} />
            <TextField size="small" sx={controlSx} placeholder="https://example.com/calendar.ics" value={feedUrl}
              onChange={e => setFeedUrl(e.target.value)} />
            <Button size="small" variant="contained" disabled={busy || !feedUrl.trim()} onClick={() => void addFeed()}>
              {i18n.t('添加')}
            </Button>
            <Button size="small" disabled={busy || feeds.length === 0} onClick={() => void refreshFeeds()}>
              {i18n.t('立即刷新')}
            </Button>
          </Stack>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup icon={<WbSunnyOutlined fontSize="small"/>} title={i18n.t('每日简报')}>
        <SettingsRow label={i18n.t('每天定时生成简报')} description={i18n.t('汇总今天的日程、到期待办、已经过期的事和明天的预览。')}>
          <Switch size="small" checked={settings.briefing.enabled}
            onChange={e => patch({ briefing: { ...settings.briefing, enabled: e.target.checked } })} />
        </SettingsRow>
        <SettingsRow label={i18n.t('让模型写成一段话')} description={i18n.t('用同一份数据写成连贯的一段；模型没返回或拒绝时自动回落到模板，不会因此漏发。')}>
          <Switch size="small" checked={settings.briefing.narrative !== false}
            onChange={e => patch({ briefing: { ...settings.briefing, narrative: e.target.checked } })} />
        </SettingsRow>
        <SettingsRow label={i18n.t('生成时间')}>
          <TextField select size="small" sx={{ width: 140 }} value={settings.briefing.time}
            onChange={e => patch({ briefing: { ...settings.briefing, time: normalizeBriefingTime(e.target.value) } })}>
            {['06:00', '07:00', '07:30', '08:00', '08:30', '09:00', '10:00', '12:00', '18:00', '21:00'].map(time => (
              <MenuItem key={time} value={time}>{time}</MenuItem>
            ))}
          </TextField>
        </SettingsRow>
        <SettingsRow label={i18n.t('用 Windows 通知提示')} description={i18n.t('关闭后仍然可以随时问「今天的简报」。')}>
          <Switch size="small" checked={settings.briefing.notify}
            onChange={e => patch({ briefing: { ...settings.briefing, notify: e.target.checked } })} />
        </SettingsRow>
        <SettingsRow label={i18n.t('同时朗读')} description={i18n.t('请先在「AI 与模型 → TTS模型」中启用朗读。')}>
          <Switch size="small" checked={settings.briefing.speak} disabled={!settings.tts.enabled}
            onChange={e => patch({ briefing: { ...settings.briefing, speak: e.target.checked } })} />
        </SettingsRow>
        <SettingsRow label={i18n.t('空简报不打扰')} description={i18n.t('今天没有任何安排时不弹通知。')}>
          <Switch size="small" checked={settings.briefing.skipEmpty}
            onChange={e => patch({ briefing: { ...settings.briefing, skipEmpty: e.target.checked } })} />
        </SettingsRow>
        <SettingsRow label={i18n.t('免打扰')} description={i18n.t('这段时间不弹通知、不朗读。到点的简报会等到窗口结束后再送达，不会被丢掉。')}>
          <Switch size="small" checked={quiet.enabled} onChange={e => patchQuiet({ enabled: e.target.checked })} />
        </SettingsRow>
        <SettingsRow label={i18n.t('免打扰时段')} description={i18n.t('可以跨零点，例如从晚上十点到早上七点半。')}>
          <Stack direction="row" spacing={1} alignItems="center">
            <TextField select size="small" sx={{ width: 104 }} value={quiet.start} disabled={!quiet.enabled}
              inputProps={{ 'data-briefing-quiet': 'start' }} onChange={e => patchQuiet({ start: e.target.value })}>
              {clocks.map(clock => <MenuItem key={clock} value={clock}>{clock}</MenuItem>)}
            </TextField>
            <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>–</Typography>
            <TextField select size="small" sx={{ width: 104 }} value={quiet.end} disabled={!quiet.enabled}
              inputProps={{ 'data-briefing-quiet': 'end' }} onChange={e => patchQuiet({ end: e.target.value })}>
              {clocks.map(clock => <MenuItem key={clock} value={clock}>{clock}</MenuItem>)}
            </TextField>
          </Stack>
        </SettingsRow>
        {pushedTo !== null && <SettingsHint>{i18n.t('该时间在免打扰内，会在 {{time}} 之后送达', { time: clockText(pushedTo) })}</SettingsHint>}
        <Box sx={{ px: 2, py: 1.5 }}>
          <Button size="small" variant="outlined" disabled={busy} onClick={() => void compose()}>{i18n.t('立即生成一份看看')}</Button>
          {briefing && (
            <Box sx={{ mt: 1.25, p: 1.5, borderRadius: '8px', bgcolor: 'action.hover', maxHeight: 220, overflowY: 'auto' }}>
              <Typography sx={{ fontSize: 12, fontWeight: 600, mb: 0.75 }}>{briefing.title}</Typography>
              <Typography sx={{ fontSize: 11.5, whiteSpace: 'pre-wrap', lineHeight: 1.6, color: 'text.secondary' }}>{briefing.body}</Typography>
            </Box>
          )}
        </Box>
        {/* The scheduler skips empty days silently, so without a line like this a
            quiet week reads as a broken feature. */}
        <SettingsRow label={i18n.t('最近一次生成')} description={i18n.t('空简报被跳过的日子不会留下记录。')}>
          <Typography data-briefing-last sx={{ fontSize: 12, color: lastGenerated ? 'text.primary' : 'text.secondary' }}>
            {lastGenerated ? new Date(lastGenerated.createdAt).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN') : i18n.t('还没有生成过')}
          </Typography>
        </SettingsRow>
      </SettingsGroup>

      <BriefingDeliverySection settings={settings} patch={patch}/>
      <SettingsGroup icon={<HistoryOutlined fontSize="small"/>} title={i18n.t('最近的简报')}
        hint={i18n.t('只读。最多保留最近 {{n}} 份。', { n: MAX_BRIEFING_HISTORY })}>
        {recent.length === 0 && <SettingsHint>{i18n.t('还没有生成过简报。开启后每天会在这里留一份，方便回看。')}</SettingsHint>}
        {recent.map(record => (
          <Box key={record.dayKey} sx={{ px: 2, py: 1.25 }}>
            <Box
              role="button"
              tabIndex={0}
              aria-expanded={openDay === record.dayKey}
              onClick={() => setOpenDay(openDay === record.dayKey ? null : record.dayKey)}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpenDay(openDay === record.dayKey ? null : record.dayKey) }
              }}
              sx={{
                display: 'flex', alignItems: 'center', gap: 1, mx: -0.5, px: 0.5, py: 0.5, borderRadius: '8px', cursor: 'pointer',
                transition: 'background-color 120ms', '&:hover': { bgcolor: 'action.hover' },
                '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 }
              }}
            >
              <Typography sx={{ fontSize: 12, fontWeight: 650, flex: '0 0 auto' }}>{historyDayText(record.dayKey, language)}</Typography>
              <Typography sx={{ fontSize: 11.5, color: 'text.secondary', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{record.title}</Typography>
              <Box component="span" aria-hidden sx={{ display: 'grid', placeItems: 'center', width: 16, height: 16, color: 'text.secondary', transform: openDay === record.dayKey ? 'none' : 'rotate(-90deg)', transition: 'transform 120ms' }}>▾</Box>
            </Box>
            {openDay === record.dayKey && (
              <Typography data-briefing-history-body sx={{ mt: 1, fontSize: 11.5, whiteSpace: 'pre-wrap', lineHeight: 1.6, color: 'text.secondary' }}>{record.body}</Typography>
            )}
          </Box>
        ))}
      </SettingsGroup>
    </Stack>
  )
}
