import MailOutline from '@mui/icons-material/MailOutline'
import NotificationsNoneOutlined from '@mui/icons-material/NotificationsNoneOutlined'
import HistoryOutlined from '@mui/icons-material/HistoryOutlined'
import { useEffect, useState } from 'react'
import { Alert, Box, Button, Chip, Stack, Switch, TextField, Typography } from '@mui/material'
import type { Settings } from '@shared/types'
import type { BriefingDeliveryReceipt } from '@shared/briefingDelivery'
import { SettingsGroup, SettingsRow, SettingsHint } from './General'
import i18n from '../../i18n'

export function BriefingDeliverySection({ settings, patch, saving = false, saveError = '' }: {
  settings: Settings
  patch: (value: Partial<Settings>) => void
  saving?: boolean
  saveError?: string
}): JSX.Element {
  const [draft, setDraft] = useState(settings.briefingDelivery)
  const [receipts, setReceipts] = useState<BriefingDeliveryReceipt[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const signature = JSON.stringify(settings.briefingDelivery)
  const dirty = JSON.stringify(draft) !== signature
  useEffect(() => setDraft(settings.briefingDelivery), [signature])
  useEffect(() => {
    const load = (): void => { void window.api.life.briefingDeliveryHistory().then(setReceipts).catch(error => setError(String(error))) }
    load()
    return window.api.life.onBriefingDelivery(load)
  }, [])
  const send = async (): Promise<void> => {
    setBusy(true); setError('')
    try { await window.api.life.sendBriefing(); setReceipts(await window.api.life.briefingDeliveryHistory()) }
    catch (error) { setError(String(error)) }
    finally { setBusy(false) }
  }

  return <Stack spacing={3}>
    <SettingsGroup icon={<MailOutline fontSize="small" />} title={i18n.t('邮件投递')} hint={i18n.t('邮件使用 Resend，需要已验证的发件域名。')}>
      <SettingsRow label={i18n.t('启用邮件投递')}><Switch checked={draft.email.enabled} inputProps={{ 'aria-label': i18n.t('启用邮件投递') }} onChange={(_, enabled) => setDraft({ ...draft, email: { ...draft.email, enabled } })} /></SettingsRow>
      <Box sx={{ px: 2.5, py: 2.5, display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' }, gap: 2 }}>
        <TextField type="password" label="Resend API Key" value={draft.email.apiKey} onChange={event => setDraft({ ...draft, email: { ...draft.email, apiKey: event.target.value } })} sx={{ gridColumn: '1 / -1' }} />
        <TextField label={i18n.t('发件邮箱（已验证域名）')} value={draft.email.from} onChange={event => setDraft({ ...draft, email: { ...draft.email, from: event.target.value } })} />
        <TextField label={i18n.t('收件邮箱')} value={draft.email.to} onChange={event => setDraft({ ...draft, email: { ...draft.email, to: event.target.value } })} />
      </Box>
    </SettingsGroup>
    <SettingsGroup icon={<NotificationsNoneOutlined fontSize="small" />} title={i18n.t('手机推送')}>
      <SettingsRow label={i18n.t('启用手机推送')}><Switch checked={draft.push.enabled} inputProps={{ 'aria-label': i18n.t('启用手机推送') }} onChange={(_, enabled) => setDraft({ ...draft, push: { ...draft.push, enabled } })} /></SettingsRow>
      <Box sx={{ px: 2.5, py: 2.5, display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' }, gap: 2 }}>
        <TextField label={i18n.t('ntfy HTTPS 服务')} value={draft.push.baseUrl} onChange={event => setDraft({ ...draft, push: { ...draft.push, baseUrl: event.target.value } })} />
        <TextField label={i18n.t('ntfy 主题')} value={draft.push.topic} onChange={event => setDraft({ ...draft, push: { ...draft.push, topic: event.target.value } })} />
        <TextField type="password" label={i18n.t('ntfy 访问令牌（可选）')} value={draft.push.apiKey} onChange={event => setDraft({ ...draft, push: { ...draft.push, apiKey: event.target.value } })} sx={{ gridColumn: '1 / -1' }} />
      </Box>
      <SettingsHint>{i18n.t('手机安装 ntfy 并订阅相同服务和主题。公共主题可能被他人订阅，请使用私有主题与访问令牌。')}</SettingsHint>
    </SettingsGroup>
    {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}
    <Box>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
        <Button variant="contained" disabled={!dirty || saving} onClick={() => patch({ briefingDelivery: draft })}>{i18n.t('保存')}</Button>
        <Button variant="outlined" disabled={busy || dirty || saving || Boolean(saveError)} onClick={() => void send()}>{i18n.t(busy ? '投递中' : '立即投递当前简报')}</Button>
        {dirty && <Typography role="status" sx={{ fontSize: 11.5, color: 'text.secondary', alignSelf: 'center' }}>{i18n.t('有未保存的投递配置')}</Typography>}
      </Stack>
      <Typography sx={{ mt: 1.5, fontSize: 11.5, lineHeight: 1.8, color: 'text.secondary' }}>{i18n.t('先保存配置再投递；服务已受理表示获得消息 ID，不代表收件人已收到或阅读。')}</Typography>
    </Box>
    <SettingsGroup icon={<HistoryOutlined fontSize="small" />} title={i18n.t('投递记录')} collapsible defaultOpen={false}>
      {receipts.length === 0 && <SettingsHint>{i18n.t('还没有投递记录。')}</SettingsHint>}
      {receipts.slice(-12).reverse().map(row => <Box key={row.id} sx={{ px: 2.5, py: 1.75, overflowWrap: 'anywhere' }}>
        <Stack direction="row" spacing={1} alignItems="center" useFlexGap sx={{ flexWrap: 'wrap', mb: .75 }}>
          <Chip size="small" label={i18n.t(({ sending: '投递中', accepted: '服务已受理', failed: '投递失败', unknown: '送达状态未知' })[row.status])} color={row.status === 'failed' ? 'error' : 'default'} />
          <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>{new Date(row.at).toLocaleString()} · {row.channel}</Typography>
        </Stack>
        <Typography sx={{ fontSize: 12 }}>{row.target}{row.providerId ? ` · ${row.providerId}` : ''}</Typography>
        {row.error && <Typography sx={{ color: 'error.main', fontSize: 11.5, mt: .5 }}>{i18n.t(row.error)}</Typography>}
      </Box>)}
    </SettingsGroup>
  </Stack>
}
