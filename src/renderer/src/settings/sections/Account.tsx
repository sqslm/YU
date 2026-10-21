import { useCallback, useEffect, useState } from 'react'
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, MenuItem, Stack, Switch, TextField, Typography } from '@mui/material'
import type { AccountView, Settings, SyncStatus } from '@shared/types'
import type { SubscriptionInfo } from '@shared/types'
import { controlSx, IconFolder, IconUser, SettingsGroup, SettingsRow } from './General'
import i18n from '../../i18n'

interface SectionProps {
  settings: Settings
  patch: (patch: Partial<Settings>) => void
}

function planLabel(subscription: SubscriptionInfo | null): string {
  if (!subscription) return i18n.t('未获取')
  if (subscription.plan === 'trial') return subscription.active ? i18n.t('试用中') : i18n.t('试用已结束')
  if (subscription.plan === 'pro') {
    if (!subscription.active) return i18n.t('已过期')
    return subscription.cancelAtPeriodEnd ? i18n.t('专业版（到期不续）') : i18n.t('专业版')
  }
  return subscription.plan
}

function dayOf(ms: number | null): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleDateString()
}

function size(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 || value >= 10 ? 0 : 1)} ${units[unit]}`
}

export function AccountSection({ settings, patch }: SectionProps): JSX.Element {
  const [view, setView] = useState<AccountView | null>(null)
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [busy, setBusy] = useState<'' | 'signin' | 'sync' | 'wipe'>('')
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)
  const [wipeOpen, setWipeOpen] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setView(await window.api.account.status())
      setStatus(await window.api.sync.status())
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : i18n.t('无法读取账户状态'), error: true })
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => window.api.sync.onStatus(setStatus), [])
  useEffect(() => {
    const onFocus = (): void => { void refresh() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  const signedIn = view?.signedIn === true
  const subscription = view?.subscription ?? null
  const canSync = signedIn && settings.syncEnabled
  const syncing = busy === 'sync' || status?.state === 'syncing'
  const intervals = [0, 60, 300, 900, 1800, 3600]
  if (!intervals.includes(settings.syncIntervalSeconds)) intervals.push(settings.syncIntervalSeconds)

  const syncNow = async (): Promise<void> => {
    setBusy('sync')
    setNotice(null)
    try {
      const next = await window.api.sync.now()
      if (!next) throw new Error(i18n.t('同步服务尚未就绪'))
      setStatus(next)
      setView(await window.api.account.status())
      setNotice({
        text: next.lastError ? i18n.t('同步失败：{{error}}', { error: next.lastError })
          : next.pending > 0 ? i18n.t('已同步，仍有 {{n}} 项待上传', { n: next.pending }) : i18n.t('同步完成'),
        error: Boolean(next.lastError)
      })
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : i18n.t('同步失败'), error: true })
    } finally { setBusy('') }
  }

  const signOut = async (): Promise<void> => {
    setBusy('signin')
    setNotice(null)
    try {
      setView(await window.api.account.signOut())
      setStatus(await window.api.sync.status())
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : i18n.t('退出登录失败'), error: true })
    } finally { setBusy('') }
  }

  const wipe = async (): Promise<void> => {
    setWipeOpen(false)
    setBusy('wipe')
    setNotice(null)
    try {
      setStatus(await window.api.sync.wipeRemote())
      setView(await window.api.account.status())
      setNotice({ text: i18n.t('云端听写历史已清空'), error: false })
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : i18n.t('清空失败'), error: true })
    } finally { setBusy('') }
  }

  const stateLabel = !signedIn ? i18n.t('未登录') : !settings.syncEnabled ? i18n.t('同步已关闭')
    : syncing ? i18n.t('同步中…') : status?.lastError ? i18n.t('同步失败')
      : status?.pending ? i18n.t('{{n}} 项待上传', { n: status.pending }) : status?.lastSyncAt ? i18n.t('已同步') : i18n.t('等待首次同步')

  return (
    <Stack spacing={3}>
      <SettingsGroup icon={<IconUser />} title={i18n.t('登录状态')}>
        <SettingsRow
          label={signedIn ? i18n.t('当前账户') : i18n.t('未登录')}
          description={signedIn ? view.email : view?.needsSignIn ? i18n.t('登录已过期，请重新登录。') : i18n.t('登录后可跨设备同步历史、随记和录音。')}
        >
          {signedIn ? (
            <Button variant="outlined" data-account-signout disabled={busy !== '' || syncing} onClick={() => void signOut()}>{i18n.t('退出登录')}</Button>
          ) : (
            <Button variant="contained" data-account-open-login onClick={() => void window.api.account.openLogin()}>{i18n.t('登录 / 注册')}</Button>
          )}
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup icon={<IconFolder />} title={i18n.t('云同步')}>
        <SettingsRow label={i18n.t('同步历史与随记')} description={i18n.t('包含随记原始录音；听写录音不上传。')}>
          <Switch size="small" data-sync-enabled checked={settings.syncEnabled} disabled={!signedIn || syncing} onChange={(event) => patch({ syncEnabled: event.target.checked })} />
        </SettingsRow>
        <SettingsRow label={i18n.t('自动同步')} description={i18n.t('选择同步频率，也可随时手动同步。')}>
          <TextField select sx={controlSx} value={settings.syncIntervalSeconds} disabled={!canSync || syncing} onChange={(event) => patch({ syncIntervalSeconds: Number(event.target.value) })}>
            {intervals.sort((a, b) => a - b).map((seconds) => (
              <MenuItem key={seconds} value={seconds}>{seconds === 0 ? i18n.t('仅手动同步') : seconds % 60 === 0 ? i18n.t('每 {{n}} 分钟', { n: seconds / 60 }) : i18n.t('每 {{n}} 秒', { n: seconds })}</MenuItem>
            ))}
          </TextField>
        </SettingsRow>
        <SettingsRow label={i18n.t('同步状态')} description={status?.lastError || (status?.lastSyncAt ? i18n.t('上次同步：{{time}}', { time: new Date(status.lastSyncAt).toLocaleString() }) : i18n.t('尚未完成首次同步'))}>
          <Typography data-sync-state sx={{ fontSize: 12, color: status?.lastError ? 'error.main' : 'text.secondary' }}>{stateLabel}</Typography>
        </SettingsRow>
        <Box sx={{ px: 2, py: 1.75 }}>
          <Button variant="contained" data-sync-now disabled={!canSync || busy !== '' || syncing} onClick={() => void syncNow()}>{syncing ? i18n.t('同步中…') : i18n.t('立即同步')}</Button>
        </Box>
      </SettingsGroup>

      {notice && <Alert data-account-notice severity={notice.error ? 'error' : 'success'} onClose={() => setNotice(null)} sx={{ fontSize: 12, overflowWrap: 'anywhere' }}>{notice.text}</Alert>}

      {signedIn && (
        <SettingsGroup icon={<IconFolder />} title={i18n.t('云端存储')}>
          {subscription && <SettingsRow label={i18n.t('当前计划')} description={i18n.t('到期：{{date}}', { date: dayOf(subscription.plan === 'trial' ? subscription.trialEndsAt : subscription.currentPeriodEnd) })}>
            <Typography data-plan sx={{ fontSize: 12.5 }}>{planLabel(subscription)}</Typography>
          </SettingsRow>}
          <SettingsRow label={i18n.t('存储用量')} description={view.storage ? i18n.t('随记 {{notes}} 条 · 录音 {{audio}} 个', { notes: view.storage.noteCount, audio: view.storage.audioCount }) : i18n.t('正在读取云端用量…')}>
            <Typography data-storage sx={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>{view.storage ? `${size(view.storage.usedBytes)} / ${size(view.storage.quotaBytes)}` : '—'}</Typography>
          </SettingsRow>
          {view.remoteCount >= 0 && <SettingsRow label={i18n.t('云端听写历史')}><Typography sx={{ fontSize: 12.5 }}>{i18n.t('{{n}} 条', { n: view.remoteCount })}</Typography></SettingsRow>}
        </SettingsGroup>
      )}

      {signedIn && <SettingsGroup title={i18n.t('数据管理')} collapsible defaultOpen={false}>
        <SettingsRow label={i18n.t('清空云端听写历史')} description={i18n.t('本机历史保留；其他设备会同步删除。随记和录音不受影响。')}>
          <Button color="error" variant="outlined" data-sync-wipe disabled={busy !== '' || syncing} onClick={() => setWipeOpen(true)}>{i18n.t('清空…')}</Button>
        </SettingsRow>
      </SettingsGroup>}
      <Dialog open={wipeOpen} onClose={() => setWipeOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{i18n.t('清空云端听写历史？')}</DialogTitle>
        <DialogContent><DialogContentText>{i18n.t('本机历史保留；其他设备会同步删除。随记和录音不受影响。')}</DialogContentText></DialogContent>
        <DialogActions><Button onClick={() => setWipeOpen(false)}>{i18n.t('取消')}</Button><Button color="error" onClick={() => void wipe()}>{i18n.t('确认清空')}</Button></DialogActions>
      </Dialog>
    </Stack>
  )
}
