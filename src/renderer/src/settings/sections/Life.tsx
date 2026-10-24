import { useCallback, useEffect, useState } from 'react'
import { Alert, Box, Button, MenuItem, Stack, Switch, TextField, Typography } from '@mui/material'
import type { Settings } from '@shared/types'
import type { CalendarEvent, CalendarRange } from '@shared/calendar'
import { formatEventTime } from '@shared/calendar'
import type { Briefing } from '@shared/briefing'
import { normalizeBriefingTime } from '@shared/briefing'
import { MAX_EVENT_LEAD_MINUTES } from '@shared/calendar'
import { SettingsGroup, SettingsHint, SettingsRow, controlSx, narrowControlSx } from './General'
import i18n from '../../i18n'

/**
 * The local calendar, the daily briefing and read-aloud.
 *
 * Everything here is a view onto a store the assistant also writes to: cancelling
 * an event here is what the next answer will read. Nothing is duplicated, so
 * there is no sync to reconcile.
 */

const RANGES: { value: CalendarRange; label: string }[] = [
  { value: 'upcoming', label: '接下来的' },
  { value: 'today', label: '今天' },
  { value: 'week', label: '本周' },
  { value: 'tomorrow', label: '明天' }
]

function dayLabel(event: CalendarEvent, language: 'zh' | 'en'): string {
  const start = new Date(event.start)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const day = new Date(start)
  day.setHours(0, 0, 0, 0)
  const diff = Math.round((+day - +today) / (24 * 60 * 60_000))
  const prefix = diff === 0 ? '今天' : diff === 1 ? '明天' : diff === 2 ? '后天' : `${start.getMonth() + 1} 月 ${start.getDate()} 日`
  return `${prefix} ${formatEventTime(event, language)}`
}

export function LifeSection({ settings, patch }: {
  settings: Settings
  patch: (patch: Partial<Settings>) => void
}): JSX.Element {
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [range, setRange] = useState<CalendarRange>('upcoming')
  const [briefing, setBriefing] = useState<Briefing | null>(null)
  const [voices, setVoices] = useState<string[]>([])
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const loadEvents = useCallback(async (next: CalendarRange) => {
    try { setEvents(await window.api.life.events(next)) } catch (error) { setNotice({ error: true, text: String(error) }) }
  }, [])

  useEffect(() => { void loadEvents(range) }, [loadEvents, range])
  // The hub calendar page and the assistant write the same store, so the list has
  // to follow their edits instead of showing what was true when the tab opened.
  useEffect(() => window.api.life.onChanged(() => { void loadEvents(range) }), [loadEvents, range])
  useEffect(() => {
    let alive = true
    void window.api.life.briefing().then(
      (value) => { if (alive) setBriefing(value) },
      (error) => { if (alive) setNotice({ error: true, text: String(error) }) }
    )
    void window.api.life.voices().then(
      (result) => { if (alive && result.ok && result.voices) setVoices(result.voices) },
      () => undefined
    )
    return () => { alive = false }
  }, [])

  const cancelEvent = async (id: string, action: 'cancel' | 'restore'): Promise<void> => {
    try { await window.api.life.cancelEvent(id, action); await loadEvents(range) } catch (error) { setNotice({ error: true, text: String(error) }) }
  }
  const compose = async (): Promise<void> => {
    setBusy(true)
    try { setBriefing(await window.api.life.refreshBriefing()) } catch (error) { setNotice({ error: true, text: String(error) }) }
    finally { setBusy(false) }
  }
  const preview = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.api.life.speak(i18n.t('这是一段试听。语会用这里选择的声音朗读简报和你要听的内容。'))
      setNotice({ error: false, text: result.skipped ? i18n.t('没有可朗读的内容。') : i18n.t('已开始朗读。') })
    } catch (error) { setNotice({ error: true, text: String(error) }) }
    finally { setBusy(false) }
  }

  return (
    <Stack spacing={2}>
      {notice && <Alert severity={notice.error ? 'error' : 'success'} onClose={() => setNotice(null)}>{notice.text}</Alert>}

      <SettingsGroup icon={<Box sx={{ fontSize: 15 }}>📅</Box>} title={i18n.t('本地日程')}>
        <SettingsRow label={i18n.t('启用日程与提醒')} description={i18n.t('日程独立于提醒：日程有起止时间，到点前按这里的提前量提示。')}>
          <Switch size="small" checked={settings.calendar.enabled}
            onChange={e => patch({ calendar: { ...settings.calendar, enabled: e.target.checked } })} />
        </SettingsRow>
        <SettingsRow label={i18n.t('默认提前提醒')} description={i18n.t('单条日程可以单独设置；设为 0 表示到点才提醒。')}>
          <TextField select size="small" sx={{ width: 140 }} value={settings.calendar.defaultLeadMinutes}
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

      <SettingsGroup icon={<Box sx={{ fontSize: 15 }}>🌤</Box>} title={i18n.t('每日简报')}>
        <SettingsRow label={i18n.t('每天定时生成简报')} description={i18n.t('汇总今天的日程、到期待办、已经过期的事、明天预览和你让我记住的内容。')}>
          <Switch size="small" checked={settings.briefing.enabled}
            onChange={e => patch({ briefing: { ...settings.briefing, enabled: e.target.checked } })} />
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
        <SettingsRow label={i18n.t('同时朗读')} description={i18n.t('需要先在下面启用朗读。')}>
          <Switch size="small" checked={settings.briefing.speak} disabled={!settings.tts.enabled}
            onChange={e => patch({ briefing: { ...settings.briefing, speak: e.target.checked } })} />
        </SettingsRow>
        <SettingsRow label={i18n.t('空简报不打扰')} description={i18n.t('今天没有任何安排时不弹通知。')}>
          <Switch size="small" checked={settings.briefing.skipEmpty}
            onChange={e => patch({ briefing: { ...settings.briefing, skipEmpty: e.target.checked } })} />
        </SettingsRow>
        <Box sx={{ px: 2, py: 1.5 }}>
          <Button size="small" variant="outlined" disabled={busy} onClick={() => void compose()}>{i18n.t('立即生成一份看看')}</Button>
          {briefing && (
            <Box sx={{ mt: 1.25, p: 1.5, borderRadius: '8px', bgcolor: 'action.hover', maxHeight: 220, overflowY: 'auto' }}>
              <Typography sx={{ fontSize: 12, fontWeight: 600, mb: 0.75 }}>{briefing.title}</Typography>
              <Typography sx={{ fontSize: 11.5, whiteSpace: 'pre-wrap', lineHeight: 1.6, color: 'text.secondary' }}>{briefing.body}</Typography>
            </Box>
          )}
        </Box>
      </SettingsGroup>

      <SettingsGroup icon={<Box sx={{ fontSize: 15 }}>🔊</Box>} title={i18n.t('朗读')}>
        <SettingsRow label={i18n.t('启用朗读')}
          description={i18n.t('用 Windows 自带语音朗读简报和你要听的内容。默认关闭，只在你明确要求时发声。')}>
          <Switch size="small" checked={settings.tts.enabled}
            onChange={e => patch({ tts: { ...settings.tts, enabled: e.target.checked } })} />
        </SettingsRow>
        <SettingsRow label={i18n.t('声音')} description={voices.length ? i18n.t('来自本机的 Windows 语音。') : i18n.t('没有检测到可用的系统语音。')}>
          <TextField select size="small" sx={controlSx} value={settings.tts.voice} disabled={!voices.length}
            onChange={e => patch({ tts: { ...settings.tts, voice: e.target.value } })}>
            <MenuItem value="">{i18n.t('系统默认')}</MenuItem>
            {voices.map(voice => <MenuItem key={voice} value={voice}>{voice}</MenuItem>)}
          </TextField>
        </SettingsRow>
        <SettingsRow label={i18n.t('语速')} description={i18n.t('0 为正常速度，负数更慢，正数更快。')}>
          <TextField size="small" type="number" sx={narrowControlSx} value={settings.tts.rate}
            onChange={e => patch({ tts: { ...settings.tts, rate: Math.max(-10, Math.min(10, Number(e.target.value) || 0)) } })} />
        </SettingsRow>
        <SettingsRow label={i18n.t('音量')}>
          <TextField size="small" type="number" sx={narrowControlSx} value={settings.tts.volume}
            onChange={e => patch({ tts: { ...settings.tts, volume: Math.max(0, Math.min(100, Number(e.target.value) || 0)) } })} />
        </SettingsRow>
        <Box sx={{ px: 2, py: 1.5 }}>
          <Button size="small" variant="outlined" disabled={busy || !settings.tts.enabled} onClick={() => void preview()}>{i18n.t('试听')}</Button>
        </Box>
        <SettingsHint>{i18n.t('朗读失败时会如实告诉你，不会假装已经读过。')}</SettingsHint>
      </SettingsGroup>
    </Stack>
  )
}
