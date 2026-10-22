import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Alert, Box, Button, Chip, CssBaseline, Stack, ThemeProvider, Typography } from '@mui/material'
import { useTranslation } from 'react-i18next'
import type { Reminder, ReminderAction } from '@shared/reminders'
import type { Settings } from '@shared/types'
import { makeTheme, onSystemThemeChange, resolveThemeMode } from '../settings/theme'
import { applyUiLanguage } from '../i18n'
import { disposeCues, playCue } from '../bar/cues'

function StrongReminder(): JSX.Element {
  const { t, i18n } = useTranslation()
  const [rows, setRows] = useState<Reminder[]>([]), [settings, setSettings] = useState<Settings | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [systemTheme, setSystemTheme] = useState(() => resolveThemeMode('system'))
  useEffect(() => onSystemThemeChange(() => setSystemTheme(resolveThemeMode('system'))), [])
  useEffect(() => {
    const refresh = (): void => { void window.api.reminders.strong().then(setRows).catch(e => setError(String(e.message ?? e))) }
    const apply = (value: Settings): void => { setSettings(value); applyUiLanguage(value.uiLanguage) }
    refresh(); void window.api.settings.get().then(apply)
    const off = window.api.reminders.onChanged(refresh), offSettings = window.api.settings.onChanged(apply)
    return () => { off(); offSettings(); disposeCues() }
  }, [])
  const current = rows[0]
  useEffect(() => {
    if (!current || !settings?.reminders.strongSound) return
    playCue('reminder', true)
    const timer = setInterval(() => playCue('reminder', true), 30_000)
    return () => { clearInterval(timer); disposeCues() }
  }, [current?.id, settings?.reminders.strongSound])
  const act = async (action: ReminderAction): Promise<void> => {
    if (!current || busy) return
    setBusy(true); setError('')
    try { await window.api.reminders.action(current.id, action); setRows(await window.api.reminders.strong()) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  return <ThemeProvider theme={makeTheme(settings?.themeMode === 'system' ? systemTheme : settings?.themeMode ?? 'dark')}><CssBaseline />
    <Box sx={{ p: 3 }} data-strong-reminder>
      <Stack direction="row" alignItems="center" justifyContent="space-between"><Chip color="warning" variant="outlined" label={t('强提醒')} />
        <Typography color="text.secondary" sx={{ fontSize: 12 }}>{t('待处理 {{n}} 项', { n: rows.length })}</Typography></Stack>
      {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
      <Typography sx={{ mt: 2.5, fontSize: 23, fontWeight: 650, lineHeight: 1.5, overflowWrap: 'anywhere' }}>{current?.title ?? t('没有待处理的强提醒')}</Typography>
      {current?.dueAt && <Typography color="text.secondary" sx={{ mt: 1, fontSize: 13 }}>{new Date(current.dueAt).toLocaleString(i18n.language === 'en' ? 'en-US' : 'zh-CN')}</Typography>}
      <Stack direction="row" spacing={1} sx={{ mt: 3 }}>
        <Button variant="contained" disabled={!current || busy} onClick={() => void act('complete')}>{t('确认完成')}</Button>
        <Button variant="outlined" disabled={!current || busy} onClick={() => void act('snooze')}>{t('{{n}} 分钟后提醒', { n: settings?.reminders.snoozeMinutes ?? 5 })}</Button>
      </Stack>
      <Button color="inherit" size="small" sx={{ mt: 2 }} onClick={() => window.api.reminders.closeStrong()}>{t('关闭窗口，保留待处理事项')}</Button>
    </Box>
  </ThemeProvider>
}
const root = document.getElementById('root')
if (!root) throw new Error('#root missing')
createRoot(root).render(<StrongReminder />)
