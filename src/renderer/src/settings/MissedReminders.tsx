import { useEffect, useState } from 'react'
import { Box, Button, Paper, Stack, Typography } from '@mui/material'
import { useTranslation } from 'react-i18next'
import { isMissedReminder, type Reminder } from '@shared/reminders'

/** One missed occurrence at a time, without opening another notification window. */
export function MissedReminders(): JSX.Element | null {
  const { t, i18n } = useTranslation()
  const [items, setItems] = useState<Reminder[]>([])
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    let alive = true, revision = 0
    const load = (): void => {
      const request = ++revision
      void window.api.reminders.list().then(rows => {
        if (alive && request === revision) setItems(rows.filter(isMissedReminder))
      }).catch(err => { if (alive) setError(String(err)) })
    }
    load()
    const off = window.api.reminders.onChanged(load)
    return () => { alive = false; off() }
  }, [])
  const row = items[0]
  if (!row) return null
  const acknowledge = async (completed: boolean): Promise<void> => {
    setBusy(true); setError('')
    try { await window.api.reminders.acknowledgeMissed(row.id, row.dueAt!, completed) }
    catch (err) { setError(String(err)) }
    finally { setBusy(false) }
  }
  return <Paper role="alert" data-missed-reminder={row.id} variant="outlined"
    sx={{ mx: 3, my: 1, p: 2, borderColor: 'warning.main', borderLeftWidth: 4, borderRadius: 2, flexShrink: 0 }}>
    <Stack direction="row" spacing={2} alignItems="center" sx={{ flexWrap: 'wrap', rowGap: 1.5 }}>
      <Box sx={{ flex: 1, minWidth: 180 }}>
        <Typography color="warning.main" sx={{ fontSize: 12, fontWeight: 600 }}>{t('错过的提醒（{{count}}）', { count: items.length })}</Typography>
        <Typography sx={{ fontSize: 16, fontWeight: 600, my: .5, overflowWrap: 'anywhere' }}>{row.title}</Typography>
        <Typography color="text.secondary" sx={{ fontSize: 12 }}>{new Date(row.dueAt!).toLocaleString(i18n.language.startsWith('en') ? 'en-US' : 'zh-CN')} · {t(row.level === 'strong' ? '强提醒' : '普通提醒')}</Typography>
      </Box>
      <Stack direction="row" spacing={1}>
        <Button data-missed-complete variant="contained" disabled={busy} onClick={() => void acknowledge(true)}>{t('已完成')}</Button>
        <Button data-missed-acknowledge variant="outlined" disabled={busy} onClick={() => void acknowledge(false)}>{t('知道了')}</Button>
      </Stack>
    </Stack>
    <Typography color="text.secondary" sx={{ fontSize: 11.5, mt: 1 }}>{t('已做过可选「已完成」；「知道了」仅关闭告知，保留事项状态。')}</Typography>
    {error && <Typography color="error" sx={{ fontSize: 12, mt: 1 }}>{error}</Typography>}
  </Paper>
}
