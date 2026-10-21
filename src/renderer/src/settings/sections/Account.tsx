import { useCallback, useEffect, useState } from 'react'
import { Box, Button, CircularProgress, Switch, TextField, Typography } from '@mui/material'
import type { AccountView, Settings, SubscriptionInfo, SyncStatus } from '@shared/types'
import { IconFolder, IconSliders, IconUser, SettingsGroup, SettingsRow, SettingsHint, SettingsNumber } from './General'
import { DEFAULT_SETTINGS, normalizeServerUrl } from '@shared/defaults'
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
  const [server, setServer] = useState(settings.syncServerUrl)
  const [busy, setBusy] = useState<'' | 'signin' | 'sync' | 'plan' | 'wipe'>('')
  const [notice, setNotice] = useState('')

  const refresh = useCallback(async () => {
    const next = await window.api.account.status()
    setView(next)
    if (next?.signedIn && next.serverUrl) setServer(next.serverUrl)
    setStatus(await window.api.sync.status())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => setServer(settings.syncServerUrl), [settings.syncServerUrl])

  useEffect(() => {
    return window.api.sync.onStatus((next) => setStatus(next))
  }, [])

  useEffect(() => {
    const onFocus = (): void => {
      void refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  const signedIn = view?.signedIn === true
  const subscription = view?.subscription ?? null

  const syncNow = async (): Promise<void> => {
    setBusy('sync')
    setNotice('')
    try {
      const next = await window.api.sync.now()
      setStatus(next)
      setView(await window.api.account.status())
      setNotice(next?.lastError ? i18n.t('同步失败：{{error}}', { error: next.lastError }) : i18n.t('同步完成'))
    } catch (err) {
      setNotice(err instanceof Error ? err.message : i18n.t('同步失败'))
    } finally {
      setBusy('')
    }
  }

  const wipe = async (): Promise<void> => {
    setBusy('wipe')
    try {
      const next = await window.api.sync.wipeRemote()
      setStatus(next)
      setNotice(i18n.t('服务器上的听写历史已清空，本机历史保留；其他设备会同步删除'))
    } catch (err) {
      setNotice(err instanceof Error ? err.message : i18n.t('清空失败'))
    } finally {
      setBusy('')
    }
  }

  return (
    <Box>
      <SettingsGroup icon={<IconUser />} title={i18n.t('账户')}>
        {signedIn ? (
          <>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, px: 2, py: 2 }}>
              <Box
                sx={{
                  width: 40,
                  height: 40,
                  flex: '0 0 auto',
                  borderRadius: '50%',
                  display: 'grid',
                  placeItems: 'center',
                  background: 'linear-gradient(140deg,#4d7cfe,#8f7cff)',
                  color: '#fff',
                  fontSize: 15,
                  fontWeight: 600
                }}
              >
                {(view?.email ?? '?').slice(0, 1).toUpperCase()}
              </Box>
              <Box sx={{ minWidth: 0 }}>
                <Typography sx={{ fontSize: 13.5, fontWeight: 600 }} noWrap>
                  {view?.email}
                </Typography>
                <Typography sx={{ fontSize: 11.5, color: 'text.secondary', mt: 0.25 }} noWrap>
                  {planLabel(subscription)}
                </Typography>
              </Box>
              <Box sx={{ flex: 1 }} />
              <Button
                size="small"
                variant="outlined"
                data-account-signout
                disabled={busy !== ''}
                onClick={() => {
                  void (async () => {
                    setBusy('signin')
                    const next = await window.api.account.signOut()
                    setView(next)
                    setStatus(await window.api.sync.status())
                    setBusy('')
                    setNotice(i18n.t('已退出'))
                  })()
                }}
                sx={{ textTransform: 'none', fontSize: 12 }}
              >
                {i18n.t('退出登录')}
              </Button>
            </Box>
          </>
        ) : (
          <>
            {view?.needsSignIn ? (
              <Box sx={{ px: 2, pt: 2 }}>
                <Box
                  data-account-expired
                  sx={{
                    px: 1.25,
                    py: 1,
                    borderRadius: '8px',
                    bgcolor: 'rgba(240,150,60,.12)',
                    border: 1,
                    borderColor: 'rgba(240,150,60,.28)'
                  }}
                >
                  <Typography sx={{ fontSize: 11.5, lineHeight: 1.5, color: 'text.secondary' }}>
                    {i18n.t('上次的登录状态已失效，重新输入密码即可')}
                  </Typography>
                </Box>
              </Box>
            ) : null}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, px: 2, py: 2 }}>
              <Typography sx={{ flex: 1, fontSize: 12.5, color: 'text.secondary', lineHeight: 1.55 }}>
                {i18n.t('还没有登录。听写、历史与随记都只写在这台机器上。')}
              </Typography>
              <Button
                size="small"
                variant="contained"
                data-account-open-login
                onClick={() => void window.api.account.openLogin()}
                sx={{ textTransform: 'none', fontSize: 12, boxShadow: 'none', flex: '0 0 auto' }}
              >
                {i18n.t('登录 / 注册')}
              </Button>
            </Box>
          </>
        )}
        {notice ? (
          <Typography data-account-notice sx={{ px: 2, pt: 1.25, pb: 2, fontSize: 11.5, color: 'text.secondary' }}>
            {notice}
          </Typography>
        ) : null}
        {!signedIn ? (
          <SettingsHint>
            {i18n.t('登录用于跨设备同步听写历史、随记及随记录音；未登录时数据保存在本机。')}
          </SettingsHint>
        ) : null}
      </SettingsGroup>

      <Box sx={{ mt: 2.5 }}>
        <SettingsGroup icon={<IconFolder />} title={i18n.t('云同步')}>
          <SettingsRow
            label={i18n.t('同步历史与随记')}
            description={i18n.t('同步听写文字、随记及随记录音；听写录音仅保存在本机')}
          >
            {busy === 'sync' ? (
              <CircularProgress size={18} />
            ) : (
              <Switch
                data-sync-enabled
                checked={settings.syncEnabled}
                disabled={!signedIn}
                onChange={(event) => patch({ syncEnabled: event.target.checked })}
              />
            )}
          </SettingsRow>
          <SettingsRow label={i18n.t('自动同步间隔')} description={i18n.t('秒；0 表示只在你点「立即同步」时同步')}>
            <SettingsNumber
              value={settings.syncIntervalSeconds}
              min={0}
              max={86400}
              step={60}
              disabled={!signedIn || !settings.syncEnabled}
              onChange={(next) => patch({ syncIntervalSeconds: next })}
            />
          </SettingsRow>
          <SettingsRow
            label={i18n.t('当前状态')}
            description={
              status?.lastError
                ? status.lastError
                : status?.lastSyncAt
                  ? `${i18n.t('上次同步')} ${new Date(status.lastSyncAt).toLocaleTimeString()}`
                  : i18n.t('还没有同步过')
            }
          >
            <Typography data-sync-state sx={{ fontSize: 12, color: 'text.secondary' }}>
              {!settings.syncEnabled ? i18n.t('同步已关闭') : status?.state === 'syncing'
                ? i18n.t('同步中…')
                : `${status?.pending ?? 0} ${i18n.t('条待推送')}`}
              {typeof view?.remoteCount === 'number' && view.remoteCount >= 0 ? ` · ${i18n.t('服务器')} ${view.remoteCount} ${i18n.t('条')}` : ''}
            </Typography>
          </SettingsRow>
          <Box sx={{ display: 'flex', gap: 1, px: 2, pt: 1.75, pb: 2 }}>
            <Button
              size="small"
              variant="contained"
              data-sync-now
              disabled={!signedIn || !settings.syncEnabled || busy !== ''}
              onClick={() => void syncNow()}
              sx={{ textTransform: 'none', fontSize: 12 }}
            >
              {i18n.t('立即同步')}
            </Button>
            <Button
              size="small"
              variant="outlined"
              data-sync-wipe
              disabled={!signedIn || busy !== ''}
              onClick={() => void wipe()}
              sx={{ textTransform: 'none', fontSize: 12 }}
            >
              {i18n.t('清空服务器历史')}
            </Button>
          </Box>
          {!signedIn ? <SettingsHint>{i18n.t('先在上面登录，同步才有地方可去。')}</SettingsHint> : null}
        </SettingsGroup>
      </Box>

      <Box sx={{ mt: 2.5 }}>
        <SettingsGroup icon={<IconUser />} title={i18n.t('套餐与存储')}>
          <SettingsRow
            label={i18n.t('当前计划')}
            description={
              subscription
                ? `${i18n.t('到期')} ${dayOf(subscription.plan === 'trial' ? subscription.trialEndsAt : subscription.currentPeriodEnd)}`
                : i18n.t('登录后从服务器读取')
            }
          >
            <Typography data-plan sx={{ fontSize: 12.5, fontWeight: 600 }}>
              {signedIn ? planLabel(subscription) : '—'}
            </Typography>
          </SettingsRow>
          <SettingsRow
            label={i18n.t('服务器存储')}
            description={
              view?.storage
                ? i18n.t('随记 {{notes}} 条 · 录音 {{audio}} 个', {
                    notes: view.storage.noteCount,
                    audio: view.storage.audioCount
                  })
                : i18n.t('登录后从服务器读取')
            }
          >
            <Typography data-storage sx={{ fontSize: 12.5, fontWeight: 600 }}>
              {view?.storage ? `${size(view.storage.usedBytes)} / ${size(view.storage.quotaBytes)}` : '—'}
            </Typography>
          </SettingsRow>
          <SettingsHint>
            {i18n.t('套餐和存储配额由服务器管理员在命令行里设置，客户端只读。')}
          </SettingsHint>
        </SettingsGroup>
      </Box>

      <Box sx={{ mt: 2.5 }}>
        <SettingsGroup icon={<IconSliders />} title={i18n.t('高级')}>
          <SettingsRow
            label={i18n.t('自定义服务器地址')}
            description={i18n.t('登录期间使用当前服务器；退出登录后可修改地址')}
          >
            <TextField
              size="small"
              value={server}
              disabled={signedIn}
              error={server.trim() !== '' && !normalizeServerUrl(server)}
              helperText={server.trim() !== '' && !normalizeServerUrl(server) ? i18n.t('请输入有效的 HTTP 或 HTTPS 地址') : undefined}
              placeholder="https://typeless.example.com"
              onChange={(event) => setServer(event.target.value)}
              // Committed on blur, not per keystroke: every intermediate "htt" would
              // otherwise fail normalisation and restart the sync timer twice a second.
              onBlur={() => {
                const normalized = normalizeServerUrl(server, server.trim() ? '' : DEFAULT_SETTINGS.syncServerUrl)
                if ((normalized || !server.trim()) && normalized !== settings.syncServerUrl) {
                  setServer(normalized)
                  patch({ syncServerUrl: normalized })
                }
              }}
              sx={{ width: 300 }}
              inputProps={{ 'data-advanced-server': true }}
            />
          </SettingsRow>
          <SettingsHint>
            {i18n.t('填写自己的服务端地址，本机或内网地址也可以；留空表示未配置。')}
          </SettingsHint>
        </SettingsGroup>
      </Box>

    </Box>
  )
}
