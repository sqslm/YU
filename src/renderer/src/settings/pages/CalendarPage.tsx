import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  MenuItem,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography
} from '@mui/material'
import Add from '@mui/icons-material/Add'
import ChevronLeft from '@mui/icons-material/ChevronLeft'
import ChevronRight from '@mui/icons-material/ChevronRight'
import type { CalendarEvent, CalendarEventInput, CalendarRange } from '@shared/calendar'
import { MAX_EVENT_LEAD_MINUTES, MAX_EVENT_NOTES, MAX_EVENT_TITLE, formatEventTime } from '@shared/calendar'
import { dayKeyOf, dayStart, dotDays, formatDayHeading, groupByDay, monthGrid, shiftDayKey, sortEvents } from './calendarView'
import i18n from '../../i18n'

/**
 * The hub's 日程 page: a month grid on the left, the selected day's plan on the
 * right, and the same event rows in both the month and the list view.
 *
 * Two things shape the code more than the layout does. First, the store is owned
 * by the main process and the assistant writes to it too, so every mutation is
 * followed by a reload and `onChanged` resubscribes the page to writes it never
 * made itself. Second, the IPC speaks named ranges, so the page asks for the one
 * range that matches what it paints: the whole visible grid.
 */

const DAY_MS = 24 * 60 * 60_000

/**
 * The whole visible month grid, leading and trailing days included: a dot on the
 * 1st has to be there while the grid still shows the previous month's tail.
 */
const RANGES: readonly CalendarRange[] = ['month']

/** Lead-time choices, per product spec: `null` means "do not remind me at all". */
const LEADS: readonly (number | null)[] = [null, 0, 5, 10, 15, 30, 60, MAX_EVENT_LEAD_MINUTES]

const WEEKDAY_PROBE = new Date(2024, 0, 1) // A Monday, so +index walks the headers.

interface Form {
  title: string
  /** `YYYY-MM-DD`, the shape `<input type="date">` speaks. */
  date: string
  /** `HH:MM`; ignored while `allDay` is on, kept so toggling back restores it. */
  start: string
  end: string
  allDay: boolean
  location: string
  notes: string
  /** `'none'` or a number of minutes as a string, because `<Select>` values are strings. */
  lead: string
  /** Preserved on edit: editing an imported event must not orphan its ICS UID. */
  source: CalendarEventInput['source']
}

const pad = (value: number): string => String(value).padStart(2, '0')

const clockOf = (at: number): string => {
  const date = new Date(at)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Local epoch for a day key plus a `HH:MM` clock; the two halves the form edits. */
function stampOf(dayKey: string, clock: string): number {
  const day = dayStart(dayKey)
  if (day === null) return Number.NaN
  const [hours, minutes] = clock.split(':').map(Number)
  const date = new Date(day)
  date.setHours(Number.isFinite(hours) ? hours! : 0, Number.isFinite(minutes) ? minutes! : 0, 0, 0)
  return date.getTime()
}

function emptyForm(dayKey: string): Form {
  const now = new Date()
  // Next hour on today, 09:00 elsewhere: a slot the user probably means, not midnight.
  const start = dayKey === dayKeyOf(now.getTime()) ? Math.min(23, now.getHours() + 1) : 9
  return {
    title: '',
    date: dayKey,
    start: `${pad(start)}:00`,
    end: `${pad(Math.min(23, start + 1))}:00`,
    allDay: false,
    location: '',
    notes: '',
    lead: 'none',
    source: 'manual'
  }
}

function formOf(row: CalendarEvent): Form {
  return {
    title: row.title,
    date: dayKeyOf(row.start),
    start: clockOf(row.start),
    end: clockOf(row.end),
    allDay: row.allDay,
    location: row.location ?? '',
    notes: row.notes ?? '',
    lead: row.leadMinutes === null || row.leadMinutes === undefined ? 'none' : String(row.leadMinutes),
    source: row.source
  }
}

/** Form → IPC payload. Throws the message the dialog shows verbatim. */
function toInput(form: Form): CalendarEventInput {
  const title = form.title.trim()
  if (!title) throw new Error(i18n.t('请填写日程标题'))
  const day = dayStart(form.date)
  if (day === null) throw new Error(i18n.t('请选择日期'))
  const leadMinutes = form.lead === 'none' ? null : Number(form.lead)
  if (form.allDay) {
    // An all-day event is exactly one local day; the store normalises it the same way.
    return { title, start: day, end: day + DAY_MS, allDay: true, leadMinutes, source: form.source }
  }
  const start = stampOf(form.date, form.start)
  const end = stampOf(form.date, form.end)
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error(i18n.t('请填写开始和结束时间'))
  if (end <= start) throw new Error(i18n.t('结束时间要晚于开始时间'))
  return {
    title,
    start,
    end,
    allDay: false,
    ...(form.location.trim() ? { location: form.location.trim() } : {}),
    ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
    leadMinutes,
    source: form.source
  }
}

/** Strips Electron's `Error invoking remote method …` wrapper so the dialog reads like a sentence. */
function messageOf(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    : String(error)
}

function LeadField({ value, onChange }: { value: string; onChange: (value: string) => void }): JSX.Element {
  return (
    <TextField select label={i18n.t('提前提醒')} size="small" value={value} onChange={event => onChange(event.target.value)}>
      {LEADS.map(lead => (
        <MenuItem key={String(lead)} value={lead === null ? 'none' : String(lead)}>
          {lead === null ? i18n.t('不提醒') : lead === 0 ? i18n.t('到点提醒') : i18n.t('{{n}} 分钟前', { n: lead })}
        </MenuItem>
      ))}
    </TextField>
  )
}

function EventRow({ row, language, busy, onEdit, onSettle }: {
  row: CalendarEvent
  language: 'zh' | 'en'
  busy: boolean
  onEdit: (row: CalendarEvent) => void
  onSettle: (row: CalendarEvent, action: 'cancel' | 'restore') => void
}): JSX.Element {
  const cancelled = row.status === 'cancelled'
  return (
    <Box
      data-calendar-row={row.id}
      sx={{
        display: 'flex',
        gap: 1,
        px: 1,
        py: 0.75,
        borderRadius: '8px',
        opacity: cancelled ? 0.55 : 1,
        '&:hover': { bgcolor: 'action.hover' },
        '&:hover .calendar-row-actions': { opacity: 1, pointerEvents: 'auto' }
      }}
    >
      {/* 3px spine: all-day rows get the secondary hue so a whole-day plan reads apart. */}
      <Box sx={{ flex: '0 0 3px', width: 3, borderRadius: '2px', bgcolor: row.allDay ? 'secondary.main' : 'primary.main' }} />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography sx={{ fontSize: 13, fontWeight: 600, overflowWrap: 'anywhere', textDecoration: cancelled ? 'line-through' : 'none' }}>
          {row.title}
        </Typography>
        <Typography sx={{ fontSize: 12, color: 'text.secondary', overflowWrap: 'anywhere' }}>
          {formatEventTime(row, language)}
          {row.location ? ` · ${row.location}` : ''}
          {cancelled ? ` · ${i18n.t('已取消')}` : ''}
        </Typography>
      </Box>
      {/* A cancelled row keeps its restore button visible: it is the only way back. */}
      <Stack direction="row" spacing={0.5} className="calendar-row-actions"
        sx={{
          alignSelf: 'flex-start',
          opacity: cancelled ? 1 : 0,
          // Hidden buttons must not swallow clicks meant for the row itself.
          pointerEvents: cancelled ? 'auto' : 'none',
          transition: 'opacity .12s'
        }}>
        {cancelled
          ? <Button size="small" disabled={busy} onClick={() => onSettle(row, 'restore')} sx={{ minWidth: 0, fontSize: 12, px: 1 }}>{i18n.t('恢复')}</Button>
          : <>
            <Button size="small" disabled={busy} onClick={() => onEdit(row)} sx={{ minWidth: 0, fontSize: 12, px: 1 }}>{i18n.t('编辑')}</Button>
            <Button size="small" disabled={busy} onClick={() => onSettle(row, 'cancel')} sx={{ minWidth: 0, fontSize: 12, px: 1 }}>{i18n.t('取消')}</Button>
          </>}
      </Stack>
    </Box>
  )
}

export function CalendarPage(): JSX.Element {
  const language: 'zh' | 'en' = i18n.resolvedLanguage === 'en' ? 'en' : 'zh'
  /** Recomputed per render: the page can sit open past midnight. */
  const today = dayKeyOf(Date.now())
  const [rows, setRows] = useState<CalendarEvent[]>([])
  const [selected, setSelected] = useState(today)
  const [cursor, setCursor] = useState(() => {
    const date = new Date()
    return { year: date.getFullYear(), month: date.getMonth() + 1 }
  })
  const [view, setView] = useState<'month' | 'list'>('month')
  const [editor, setEditor] = useState<{ id?: string; form: Form } | null>(null)
  const [dialogError, setDialogError] = useState('')
  const [notice, setNotice] = useState<{ severity: 'success' | 'info' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async (): Promise<void> => {
    try {
      const lists = await Promise.all(RANGES.map(range => window.api.life.events(range)))
      const byId = new Map<string, CalendarEvent>()
      for (const list of lists) for (const row of list) byId.set(row.id, row)
      setRows(sortEvents([...byId.values()]))
    } catch (error) {
      setNotice({ severity: 'error', text: messageOf(error) })
    }
  }, [])

  // The assistant and the settings section write to the same store, so the page
  // refreshes on any broadcast instead of trusting its own copy.
  useEffect(() => {
    void reload()
    return window.api.life.onChanged(() => { void reload() })
  }, [reload])

  const byDay = useMemo(() => groupByDay(rows), [rows])
  const dots = useMemo(() => dotDays(rows), [rows])
  const grid = useMemo(() => monthGrid(cursor.year, cursor.month), [cursor])
  const dayRows = byDay.get(selected) ?? []
  const listKeys = useMemo(() => [...byDay.keys()].sort(), [byDay])

  const weekdays = useMemo(
    () => Array.from({ length: 7 }, (_, index) =>
      new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'zh-CN', { weekday: 'short' })
        .format(new Date(WEEKDAY_PROBE.getFullYear(), WEEKDAY_PROBE.getMonth(), WEEKDAY_PROBE.getDate() + index))),
    [language]
  )

  /** Selecting a day also pulls the month view to it, so the two panes never disagree. */
  const select = useCallback((dayKey: string) => {
    setSelected(dayKey)
    const start = dayStart(dayKey)
    if (start === null) return
    const date = new Date(start)
    setCursor({ year: date.getFullYear(), month: date.getMonth() + 1 })
  }, [])

  const toggleView = (next: string | null): void => { if (next === 'month' || next === 'list') setView(next) }

  // Left/right walk a week, `T` comes home. Ignored while typing or while the
  // editor is open, so the dialog's own fields keep their arrow keys.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (editor || event.ctrlKey || event.metaKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return
      if (event.key === 'ArrowLeft') { event.preventDefault(); select(shiftDayKey(selected, -7)) }
      else if (event.key === 'ArrowRight') { event.preventDefault(); select(shiftDayKey(selected, 7)) }
      else if (event.key === 't' || event.key === 'T') { event.preventDefault(); select(today) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editor, selected, select, today])

  const settle = async (row: CalendarEvent, action: 'cancel' | 'restore'): Promise<void> => {
    if (busy) return
    setBusy(true)
    try { await window.api.life.cancelEvent(row.id, action); await reload() }
    catch (error) { setNotice({ severity: 'error', text: messageOf(error) }) }
    finally { setBusy(false) }
  }

  const save = async (): Promise<void> => {
    if (!editor || busy) return
    setBusy(true)
    setDialogError('')
    try {
      const saved = await window.api.life.saveEvent(toInput(editor.form), editor.id)
      if (!saved) throw new Error(i18n.t('日程没有保存成功'))
      setEditor(null)
      select(dayKeyOf(saved.start))
      await reload()
    } catch (error) {
      // Errors stay in the dialog: the user is still looking at the field that caused them.
      setDialogError(messageOf(error))
    } finally { setBusy(false) }
  }

  const runImport = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const result = await window.api.life.importIcs()
      // `null` is a cancelled file dialog, not a failure: say nothing.
      if (result) {
        setNotice({
          severity: 'success',
          text: `${i18n.t('导入完成')}：${i18n.t('新增')} ${result.added} / ${i18n.t('更新')} ${result.updated} / ${i18n.t('跳过')} ${result.skipped}`
        })
        await reload()
      }
    } catch (error) { setNotice({ severity: 'error', text: messageOf(error) }) }
    finally { setBusy(false) }
  }

  const runExport = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const result = await window.api.life.exportIcs()
      if (result) setNotice({ severity: 'success', text: `${i18n.t('已导出到')} ${result.path}` })
    } catch (error) { setNotice({ severity: 'error', text: messageOf(error) }) }
    finally { setBusy(false) }
  }

  const emptyHint = i18n.t('对语说「明天下午三点到四点安排项目讨论」，日程会出现在这里。')

  return (
    <Box sx={{ p: 3 }} data-calendar-page>
      <Stack direction="row" alignItems="center" spacing={1} useFlexGap flexWrap="wrap" sx={{ mb: 1 }}>
        <Typography variant="h6" sx={{ fontWeight: 650, mr: 1 }}>{i18n.t('日程')}</Typography>
        <Tooltip title={i18n.t('上一周')}>
          <IconButton size="small" disabled={busy} aria-label={i18n.t('上一周')} onClick={() => select(shiftDayKey(selected, -7))}>
            <ChevronLeft fontSize="small" />
          </IconButton>
        </Tooltip>
        <Button size="small" variant="outlined" onClick={() => select(today)} sx={{ minWidth: 56, fontSize: 12 }}>{i18n.t('今天')}</Button>
        <Tooltip title={i18n.t('下一周')}>
          <IconButton size="small" disabled={busy} aria-label={i18n.t('下一周')} onClick={() => select(shiftDayKey(selected, 7))}>
            <ChevronRight fontSize="small" />
          </IconButton>
        </Tooltip>
        <ToggleButtonGroup size="small" exclusive value={view} onChange={(_event, next) => toggleView(next)} data-calendar-view sx={{ ml: 1 }}>
          <ToggleButton value="month" sx={{ px: 1.5, py: 0.25, fontSize: 12 }}>{i18n.t('月')}</ToggleButton>
          <ToggleButton value="list" sx={{ px: 1.5, py: 0.25, fontSize: 12 }}>{i18n.t('列表')}</ToggleButton>
        </ToggleButtonGroup>
        <Box sx={{ flex: 1 }} />
        <Button size="small" variant="outlined" disabled={busy} data-calendar-import onClick={() => void runImport()}>{i18n.t('导入 ICS')}</Button>
        <Button size="small" variant="outlined" disabled={busy} data-calendar-export onClick={() => void runExport()}>{i18n.t('导出 ICS')}</Button>
        <Button size="small" variant="contained" startIcon={<Add />} data-calendar-new
          onClick={() => { setDialogError(''); setEditor({ form: emptyForm(selected) }) }}>{i18n.t('新建日程')}</Button>
      </Stack>

      {notice && (
        <Alert severity={notice.severity} sx={{ mb: 1.5 }} onClose={() => setNotice(null)}>{notice.text}</Alert>
      )}

      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'minmax(0, 1.55fr) minmax(280px, .8fr)' } }}>
        {view === 'month' ? (
          <Box sx={{ border: 1, borderColor: 'divider', borderRadius: '10px', bgcolor: 'background.paper', p: 1.25 }}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ px: 0.5, mb: 0.75 }}>
              <Typography sx={{ fontSize: 14, fontWeight: 650 }}>{`${cursor.year} ${i18n.t('年')} ${cursor.month} ${i18n.t('月')}`}</Typography>
              <Box>
                <IconButton size="small" aria-label={i18n.t('上个月')}
                  onClick={() => setCursor(({ year, month }) => month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 })}>
                  <ChevronLeft fontSize="small" />
                </IconButton>
                <IconButton size="small" aria-label={i18n.t('下个月')}
                  onClick={() => setCursor(({ year, month }) => month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 })}>
                  <ChevronRight fontSize="small" />
                </IconButton>
              </Box>
            </Stack>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 0.25, mb: 0.25 }}>
              {weekdays.map((label, index) => (
                <Typography key={`${label}-${index}`} data-calendar-weekday={label} color="text.secondary" sx={{ textAlign: 'center', fontSize: 11, py: 0.5 }}>{label}</Typography>
              ))}
            </Box>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 0.5 }}>
              {grid.flat().map(cell => {
                const key = dayKeyOf(cell)
                const date = new Date(cell)
                const inMonth = date.getMonth() + 1 === cursor.month
                const isToday = key === today
                const isSelected = key === selected
                const count = dots.has(key) ? Math.min(3, (byDay.get(key) ?? []).filter(row => row.status === 'confirmed').length) : 0
                return (
                  <Box
                    key={key}
                    component="button"
                    type="button"
                    data-calendar-day={key}
                    aria-pressed={isSelected}
                    aria-label={date.toLocaleDateString(language === 'en' ? 'en-US' : 'zh-CN', { dateStyle: 'full' })}
                    onClick={() => select(key)}
                    sx={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      gap: 0.25,
                      minHeight: 54,
                      p: 0.5,
                      font: 'inherit',
                      cursor: 'pointer',
                      borderRadius: '10px',
                      border: 1,
                      borderColor: isSelected ? 'primary.main' : 'divider',
                      bgcolor: isSelected ? 'primary.main' : 'transparent',
                      color: isSelected ? '#fff' : inMonth ? 'text.primary' : 'text.disabled',
                      transition: 'background-color .12s, border-color .12s',
                      '&:hover': { borderColor: 'primary.main' },
                      '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 1 }
                    }}
                  >
                    <Box sx={{
                      display: 'grid',
                      placeItems: 'center',
                      width: 21,
                      height: 21,
                      borderRadius: '50%',
                      fontSize: 12.5,
                      fontWeight: isToday || isSelected ? 650 : 500,
                      border: isToday ? '1px solid' : 'none',
                      borderColor: isSelected ? 'rgba(255,255,255,.75)' : 'primary.main'
                    }}>{date.getDate()}</Box>
                    <Stack direction="row" spacing={0.25} sx={{ pl: 0.5, height: 5 }}>
                      {Array.from({ length: count }, (_, index) => (
                        <Box key={index} sx={{
                          width: 4,
                          height: 4,
                          borderRadius: '50%',
                          bgcolor: isSelected ? 'rgba(255,255,255,.8)' : 'primary.main'
                        }} />
                      ))}
                    </Stack>
                  </Box>
                )
              })}
            </Box>
          </Box>
        ) : (
          <Box sx={{ border: 1, borderColor: 'divider', borderRadius: '10px', bgcolor: 'background.paper', p: 1.25 }}>
            {listKeys.length === 0
              ? <Typography color="text.secondary" sx={{ fontSize: 13, py: 4, px: 1 }}>{emptyHint}</Typography>
              : listKeys.map(key => (
                <Box key={key} sx={{ mb: 1 }}>
                  <Typography sx={{ fontSize: 12.5, fontWeight: 650, color: 'text.secondary', px: 1, py: 0.5 }}>
                    {formatDayHeading(key, language)}
                  </Typography>
                  {byDay.get(key)!.map(row => (
                    <EventRow key={row.id} row={row} language={language} busy={busy}
                      onEdit={target => { setDialogError(''); setEditor({ id: target.id, form: formOf(target) }) }}
                      onSettle={(target, action) => void settle(target, action)} />
                  ))}
                </Box>
              ))}
          </Box>
        )}

        <Box sx={{ border: 1, borderColor: 'divider', borderRadius: '10px', bgcolor: 'background.paper', p: 1.25, alignSelf: 'start' }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ px: 0.5, mb: 0.5 }}>
            <Typography sx={{ fontSize: 13.5, fontWeight: 650 }}>{formatDayHeading(selected, language)}</Typography>
            <Button size="small" sx={{ minWidth: 0, fontSize: 12, px: 1 }}
              onClick={() => { setDialogError(''); setEditor({ form: emptyForm(selected) }) }}>{i18n.t('新建')}</Button>
          </Stack>
          {dayRows.length === 0
            ? <Typography color="text.secondary" sx={{ fontSize: 12, px: 0.5, py: 2 }}>
              {rows.length === 0 ? emptyHint : i18n.t('这一天没有安排。')}
            </Typography>
            : dayRows.map(row => (
              <EventRow key={row.id} row={row} language={language} busy={busy}
                onEdit={target => { setDialogError(''); setEditor({ id: target.id, form: formOf(target) }) }}
                onSettle={(target, action) => void settle(target, action)} />
            ))}
        </Box>
      </Box>

      <Dialog open={Boolean(editor)} onClose={() => { if (!busy) setEditor(null) }} fullWidth maxWidth="sm">
        <DialogTitle>{i18n.t(editor?.id ? '编辑日程' : '新建日程')}</DialogTitle>
        <DialogContent sx={{ pt: '12px !important' }}>
          {dialogError && <Alert severity="error" sx={{ mb: 2 }}>{dialogError}</Alert>}
          {editor && (
            <Stack spacing={1.5}>
              <TextField label={i18n.t('标题')} autoFocus value={editor.form.title} inputProps={{ maxLength: MAX_EVENT_TITLE }} required
                onChange={event => setEditor({ ...editor, form: { ...editor.form, title: event.target.value } })} />
              <Stack direction="row" spacing={1} alignItems="center">
                <TextField label={i18n.t('日期')} type="date" fullWidth InputLabelProps={{ shrink: true }}
                  value={editor.form.date} sx={{ colorScheme: theme => theme.palette.mode }}
                  onChange={event => setEditor({ ...editor, form: { ...editor.form, date: event.target.value } })} />
                <FormControlLabel sx={{ m: 0, whiteSpace: 'nowrap' }}
                  control={<Switch size="small" checked={editor.form.allDay}
                    onChange={event => setEditor({ ...editor, form: { ...editor.form, allDay: event.target.checked } })} />}
                  label={<Typography sx={{ fontSize: 12.5 }}>{i18n.t('全天')}</Typography>} />
              </Stack>
              {!editor.form.allDay && (
                <Stack direction="row" spacing={1} alignItems="center">
                  <TextField label={i18n.t('开始时间')} type="time" fullWidth InputLabelProps={{ shrink: true }}
                    value={editor.form.start} sx={{ colorScheme: theme => theme.palette.mode }}
                    onChange={event => setEditor({ ...editor, form: { ...editor.form, start: event.target.value } })} />
                  <TextField label={i18n.t('结束时间')} type="time" fullWidth InputLabelProps={{ shrink: true }}
                    value={editor.form.end} sx={{ colorScheme: theme => theme.palette.mode }}
                    onChange={event => setEditor({ ...editor, form: { ...editor.form, end: event.target.value } })} />
                </Stack>
              )}
              <TextField label={i18n.t('地点（可选）')} value={editor.form.location}
                onChange={event => setEditor({ ...editor, form: { ...editor.form, location: event.target.value } })} />
              <LeadField value={editor.form.lead} onChange={lead => setEditor({ ...editor, form: { ...editor.form, lead } })} />
              <TextField label={i18n.t('备注（可选）')} multiline minRows={2} maxRows={4} value={editor.form.notes} inputProps={{ maxLength: MAX_EVENT_NOTES }}
                onChange={event => setEditor({ ...editor, form: { ...editor.form, notes: event.target.value } })} />
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={() => setEditor(null)}>{i18n.t('取消')}</Button>
          <Button variant="contained" disabled={busy} onClick={() => void save()}>{i18n.t('保存')}</Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
