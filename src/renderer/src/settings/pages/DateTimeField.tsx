import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { Box, Button, IconButton, InputAdornment, Popover, Stack, TextField, Typography, type SxProps, type Theme } from '@mui/material'
import CalendarMonthOutlined from '@mui/icons-material/CalendarMonthOutlined'
import ScheduleOutlined from '@mui/icons-material/ScheduleOutlined'
import ChevronLeft from '@mui/icons-material/ChevronLeft'
import ChevronRight from '@mui/icons-material/ChevronRight'
import { useTranslation } from 'react-i18next'
import { localDateTime } from '@shared/reminders'
import { indexOffset, nearestIndex, pad2, stepIndex, WHEEL_PAD, WHEEL_ROW, WHEEL_VISIBLE } from './timeWheel'

/**
 * A themed date / date-time field.
 *
 * Two things this exists to fix, both about the *native* Chromium picker:
 * it ignored the theme pack (a blue Material calendar inside a jade/Apple/
 * brutalist window), and its calendar button was the only reliable way to open
 * it. Here the whole field is the button — the read-only input, the label and
 * the icon all open the same popover — and the popover is drawn with the app's
 * own components, so it inherits whichever pack is active.
 *
 * Time is picked on two snap-scrolling wheels rather than dropdowns: the native
 * picker's scrolling columns are what people are used to for hours and minutes,
 * and a wheel keeps 0–59 reachable in one gesture.
 */
export interface DateTimeFieldProps {
  label: string
  /**
   * `''`, or a local `YYYY-MM-DDTHH:mm` (datetime), `YYYY-MM-DD` (date) or
   * `HH:mm` (time) string, matching `mode`.
   */
  value: string
  onChange: (value: string) => void
  mode?: 'datetime' | 'date' | 'time'
  required?: boolean
  helperText?: string
  disabled?: boolean
  placeholder?: string
  sx?: SxProps<Theme>
  /** Extra attributes for the read-only input (automation hooks). */
  inputProps?: Record<string, unknown>
  /** Attribute used by tests/automation to find the picker dialog. */
  pickerAttribute?: string
}

/** Parses a stored value as *local* time; `'2026-11-01'` must not shift a day. */
function parse(value: string, mode: 'datetime' | 'date' | 'time'): Date {
  if (!value) return new Date()
  if (mode === 'time') {
    // A time-only field edits the clock of "today": the date is irrelevant and
    // is never written back.
    const [hours, minutes] = value.split(':')
    const base = new Date()
    const h = Number(hours)
    const m = Number(minutes)
    base.setHours(Number.isFinite(h) ? h : 0, Number.isFinite(m) ? m : 0, 0, 0)
    return base
  }
  const parsed = new Date(mode === 'date' ? `${value}T00:00:00` : value)
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed
}

/** Writes a draft back in the shape the caller's field stores. */
function format(date: Date, mode: 'datetime' | 'date' | 'time'): string {
  if (mode === 'time') return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  const stamp = localDateTime(date.getTime())
  return mode === 'date' ? stamp.slice(0, 10) : stamp
}

export function DateTimeField({
  label,
  value,
  onChange,
  mode = 'datetime',
  required = false,
  helperText,
  disabled = false,
  placeholder,
  sx,
  inputProps,
  pickerAttribute = 'data-datetime-picker'
}: DateTimeFieldProps): JSX.Element {
  const { t, i18n } = useTranslation()
  const locale = i18n.language === 'en' ? 'en-US' : 'zh-CN'
  const labelId = useId()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [draft, setDraft] = useState(() => new Date())
  const [month, setMonth] = useState(() => new Date())

  const openAt = (element: HTMLElement): void => {
    if (disabled) return
    const selected = parse(value, mode)
    setDraft(selected)
    setMonth(new Date(selected.getFullYear(), selected.getMonth(), 1))
    setAnchor(element)
  }
  const click = (event: MouseEvent<HTMLElement>): void => openAt(event.currentTarget)
  const key = (event: KeyboardEvent<HTMLElement>): void => {
    if (['Enter', ' ', 'ArrowDown'].includes(event.key)) { event.preventDefault(); openAt(event.currentTarget) }
  }
  /** A day click keeps the time already chosen on the wheels. */
  const chooseDay = (date: Date): void => {
    const selected = new Date(date)
    selected.setHours(draft.getHours(), draft.getMinutes(), 0, 0)
    setDraft(selected)
    setMonth(new Date(selected.getFullYear(), selected.getMonth(), 1))
  }
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const days = Array.from({ length: 42 }, (_, index) => new Date(first.getFullYear(), first.getMonth(), 1 - first.getDay() + index))
  const dateKey = (date: Date): string => localDateTime(date.getTime()).slice(0, 10)
  const display = value
    ? mode === 'time'
      // Times are their own format everywhere in the app; round-tripping them
      // through a locale string would print "下午 02:30" in a 24-hour field.
      ? format(parse(value, mode), mode)
      : new Date(parse(value, mode)).toLocaleString(locale, mode === 'datetime'
        ? { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
        : { year: 'numeric', month: '2-digit', day: '2-digit' })
    : ''
  const showCalendar = mode !== 'time'
  const showWheels = mode !== 'date'

  return <>
    <TextField label={label} size="small" fullWidth value={display} placeholder={placeholder ?? t(mode === 'time' ? '选择时间' : '选择日期和时间')}
      autoComplete="off" disabled={disabled} InputLabelProps={{ shrink: true, id: labelId }}
      inputProps={{ readOnly: true, 'aria-haspopup': 'dialog', 'aria-expanded': Boolean(anchor), 'aria-labelledby': labelId, ...inputProps }}
      InputProps={{ endAdornment: <InputAdornment position="end">{mode === 'time' ? <ScheduleOutlined sx={{ fontSize: 18, color: 'text.secondary' }} /> : <CalendarMonthOutlined sx={{ fontSize: 18, color: 'text.secondary' }} />}</InputAdornment> }}
      onClick={click} onKeyDown={key} sx={[{ '& input': { cursor: 'pointer' } }, ...(Array.isArray(sx) ? sx : [sx])]}
      helperText={helperText} />
    <Popover open={Boolean(anchor)} anchorEl={anchor} onClose={() => setAnchor(null)}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }} transformOrigin={{ vertical: 'top', horizontal: 'left' }}
      PaperProps={{ sx: { p: 2, width: mode === 'datetime' ? 468 : mode === 'time' ? 208 : 320, maxWidth: 'calc(100vw - 32px)', border: 1, borderColor: 'divider' } }}>
      <Box role="dialog" aria-label={t(showCalendar ? '选择日期和时间' : '选择时间')} {...{ [pickerAttribute]: true }}>
        {/* Calendar on the left, the two time wheels beside it — the arrangement
            people know from the system picker, instead of stacking the columns
            under the grid and making the popover tall. A time-only field is just
            the wheels. */}
        <Stack direction="row" spacing={1.5} alignItems="flex-start">
          {showCalendar && <Box sx={{ flex: '1 1 auto', minWidth: 0 }}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
              <Typography sx={{ fontSize: 14, fontWeight: 600 }}>{month.toLocaleDateString(locale, { year: 'numeric', month: 'long' })}</Typography>
              <Box><IconButton size="small" aria-label={t('上个月')} onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><ChevronLeft fontSize="small" /></IconButton>
                <IconButton size="small" aria-label={t('下个月')} onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><ChevronRight fontSize="small" /></IconButton></Box>
            </Stack>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 0.25 }}>
              {Array.from({ length: 7 }, (_, day) => <Typography key={day} color="text.secondary" sx={{ textAlign: 'center', fontSize: 11, py: 0.5 }}>{new Date(2024, 0, 7 + day).toLocaleDateString(locale, { weekday: 'short' })}</Typography>)}
              {days.map(day => <Button key={dateKey(day)} data-reminder-day={dateKey(day)} aria-label={day.toLocaleDateString(locale, { dateStyle: 'full' })}
                aria-pressed={dateKey(day) === dateKey(draft)} size="small" variant={dateKey(day) === dateKey(draft) ? 'contained' : 'text'}
                sx={{ minWidth: 0, height: 32, p: 0, color: dateKey(day) === dateKey(draft) ? undefined : day.getMonth() === month.getMonth() ? 'text.primary' : 'text.disabled' }}
                onClick={() => chooseDay(day)}>{day.getDate()}</Button>)}
            </Box>
          </Box>}
          {showWheels && <Stack direction="row" spacing={1} sx={{ flex: '0 0 auto', pl: showCalendar ? 1.5 : 0, borderLeft: showCalendar ? 1 : 0, borderColor: 'divider', alignSelf: 'stretch' }}>
            <Wheel label={t('小时')} count={24} value={draft.getHours()} slot="hour"
              onChange={hour => { const next = new Date(draft); next.setHours(hour); setDraft(next) }} />
            <Wheel label={t('分钟')} count={60} value={draft.getMinutes()} slot="minute"
              onChange={minute => { const next = new Date(draft); next.setMinutes(minute); setDraft(next) }} />
          </Stack>}
        </Stack>
        <Stack direction="row" spacing={0.5} sx={{ mt: 2 }}>
          <Button size="small" onClick={() => { onChange(''); setAnchor(null) }}>{t('清除')}</Button>
          <Button size="small" onClick={() => { if (showCalendar) chooseDay(new Date()); else setDraft(new Date()) }}>{t(showCalendar ? '今天' : '现在')}</Button>
          <Box sx={{ flex: 1 }} />
          <Button size="small" variant="contained" onClick={() => { onChange(format(draft, mode)); setAnchor(null) }}>{t('确定')}</Button>
        </Stack>
      </Box>
    </Popover>
  </>
}

/**
 * One snap-scrolling column of numbers.
 *
 * The list is padded by half a viewport at each end so the first and last value
 * can sit under the selection band; `scroll-snap-type: mandatory` does the
 * visual snapping, while the debounced settle below makes the *value* follow
 * the scroll (snapping alone would leave the stored value behind on a flick).
 */
function Wheel({ label, count, value, onChange, slot }: {
  label: string
  count: number
  value: number
  onChange: (value: number) => void
  /** Automation hook: `hour` / `minute`. */
  slot: 'hour' | 'minute'
}): JSX.Element {
  const list = useRef<HTMLDivElement | null>(null)
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const scrollTo = (index: number): void => {
    const element = list.current
    if (element) element.scrollTop = indexOffset(index)
  }
  // Position on mount (the popover remounts its children each time it opens).
  useLayoutEffect(() => { scrollTo(value) }, [])
  // Follow the value when it changes from outside the wheel: a day click, 今天,
  // or the field being re-opened with a different time.
  useEffect(() => {
    const element = list.current
    if (element && Math.abs(element.scrollTop - indexOffset(value)) > 1) element.scrollTop = indexOffset(value)
  }, [value])
  useEffect(() => () => { if (settleTimer.current) clearTimeout(settleTimer.current) }, [])

  const settle = (): void => {
    const element = list.current
    if (!element) return
    const next = nearestIndex(element.scrollTop, count)
    if (next !== value) onChange(next)
    const target = indexOffset(next)
    if (Math.abs(element.scrollTop - target) > 1) element.scrollTop = target
  }
  const keys = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const next = event.key === 'Home' ? 0 : count - 1
      onChange(next); scrollTo(next); return
    }
    const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : event.key === 'PageUp' ? -5 : event.key === 'PageDown' ? 5 : 0
    if (!delta) return
    event.preventDefault(); event.stopPropagation()
    const next = stepIndex(value, delta, count)
    onChange(next); scrollTo(next)
  }

  return <Box sx={{ flex: '0 0 auto', width: 56 }}>
    <Typography component="span" sx={{ display: 'block', textAlign: 'center', fontSize: 11, color: 'text.secondary', mb: 0.5 }}>{label}</Typography>
    <Box sx={{ position: 'relative' }}>
      {/* The selection band: what the wheel is currently pointing at. */}
      <Box aria-hidden sx={{ position: 'absolute', left: 0, right: 0, top: WHEEL_PAD, height: WHEEL_ROW, borderRadius: 1, bgcolor: 'action.hover', border: 1, borderColor: 'divider', pointerEvents: 'none' }} />
      <Box ref={list} role="listbox" aria-label={label} tabIndex={0} data-reminder-time={slot}
        onScroll={() => {
          if (settleTimer.current) clearTimeout(settleTimer.current)
          settleTimer.current = setTimeout(settle, 90)
        }}
        onKeyDown={keys}
        sx={{
          position: 'relative', height: WHEEL_VISIBLE * WHEEL_ROW, overflowY: 'auto', overscrollBehavior: 'contain',
          scrollSnapType: 'y mandatory', scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' },
          '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2, borderRadius: 1 }
        }}>
        <Box sx={{ height: WHEEL_PAD }} />
        {Array.from({ length: count }, (_, n) => <Box key={n} role="option" aria-selected={n === value} aria-label={pad2(n)}
          sx={{
            height: WHEEL_ROW, scrollSnapAlign: 'center', display: 'grid', placeItems: 'center',
            fontSize: n === value ? 15 : 13, fontWeight: n === value ? 650 : 400, fontVariantNumeric: 'tabular-nums',
            color: n === value ? 'text.primary' : 'text.secondary'
          }}>{pad2(n)}</Box>)}
        <Box sx={{ height: WHEEL_PAD }} />
      </Box>
    </Box>
  </Box>
}
