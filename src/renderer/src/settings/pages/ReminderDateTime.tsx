import { useState, type MouseEvent, type KeyboardEvent } from 'react'
import { Box, Button, IconButton, InputAdornment, MenuItem, Popover, Stack, TextField, Typography } from '@mui/material'
import CalendarMonthOutlined from '@mui/icons-material/CalendarMonthOutlined'
import ChevronLeft from '@mui/icons-material/ChevronLeft'
import ChevronRight from '@mui/icons-material/ChevronRight'
import { useTranslation } from 'react-i18next'
import { localDateTime } from '@shared/reminders'

/** Uses the app theme and language rather than the OS-owned Chromium picker. */
export function ReminderDateTime({ value, onChange, required = false }: { value: string; onChange: (value: string) => void; required?: boolean }): JSX.Element {
  const { t, i18n } = useTranslation()
  const locale = i18n.language === 'en' ? 'en-US' : 'zh-CN'
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [draft, setDraft] = useState(() => new Date())
  const [month, setMonth] = useState(() => new Date())
  const open = (element: HTMLElement): void => {
    const selected = value ? new Date(value) : new Date()
    setDraft(selected)
    setMonth(new Date(selected.getFullYear(), selected.getMonth(), 1))
    setAnchor(element)
  }
  const click = (event: MouseEvent<HTMLElement>): void => open(event.currentTarget)
  const key = (event: KeyboardEvent<HTMLElement>): void => {
    if (['Enter', ' ', 'ArrowDown'].includes(event.key)) { event.preventDefault(); open(event.currentTarget) }
  }
  const chooseDay = (date: Date): void => {
    const selected = new Date(date)
    selected.setHours(draft.getHours(), draft.getMinutes(), 0, 0)
    setDraft(selected)
    setMonth(new Date(selected.getFullYear(), selected.getMonth(), 1))
  }
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const days = Array.from({ length: 42 }, (_, index) => new Date(first.getFullYear(), first.getMonth(), 1 - first.getDay() + index))
  const dateKey = (date: Date): string => localDateTime(date.getTime()).slice(0, 10)
  return <>
    <TextField label={t('提醒时间')} size="small" value={value ? new Date(value).toLocaleString(locale, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}
      placeholder={t('选择日期和时间')} InputLabelProps={{ shrink: true }} data-reminder-datetime
      inputProps={{ readOnly: true, 'aria-haspopup': 'dialog', 'aria-expanded': Boolean(anchor) }}
      InputProps={{ endAdornment: <InputAdornment position="end"><CalendarMonthOutlined sx={{ fontSize: 18, color: 'text.secondary' }} /></InputAdornment> }}
      onClick={click} onKeyDown={key} sx={{ '& input': { cursor: 'pointer' } }} helperText={t(required ? '请选择提醒时间' : '留空保存为待办，不会定时通知。')} />
    <Popover open={Boolean(anchor)} anchorEl={anchor} onClose={() => setAnchor(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      PaperProps={{ sx: { p: 2, width: 320, maxWidth: 'calc(100vw - 32px)', border: 1, borderColor: 'divider' } }}>
      <Box role="dialog" aria-label={t('选择日期和时间')} data-reminder-picker>
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
        <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
          {(['hour', 'minute'] as const).map(part => <TextField key={part} select fullWidth size="small" label={t(part === 'hour' ? '小时' : '分钟')}
            value={part === 'hour' ? draft.getHours() : draft.getMinutes()} data-reminder-time={part}
            onChange={event => { const next = new Date(draft); if (part === 'hour') next.setHours(Number(event.target.value)); else next.setMinutes(Number(event.target.value)); setDraft(next) }}>
            {Array.from({ length: part === 'hour' ? 24 : 60 }, (_, n) => <MenuItem key={n} value={n}>{String(n).padStart(2, '0')}</MenuItem>)}
          </TextField>)}
        </Stack>
        <Stack direction="row" spacing={0.5} sx={{ mt: 2 }}>
          <Button size="small" onClick={() => { onChange(''); setAnchor(null) }}>{t('清除')}</Button>
          <Button size="small" onClick={() => chooseDay(new Date())}>{t('今天')}</Button>
          <Box sx={{ flex: 1 }} />
          <Button size="small" variant="contained" onClick={() => { onChange(localDateTime(draft.getTime())); setAnchor(null) }}>{t('确定')}</Button>
        </Stack>
      </Box>
    </Popover>
  </>
}
