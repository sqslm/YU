import { useState } from 'react'
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Typography } from '@mui/material'
import type { BackupSummary } from '@shared/backup'
import { SettingsGroup, SettingsHint } from './General'
import { useTranslation } from 'react-i18next'

export function BackupSection(): JSX.Element {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState<BackupSummary | null>(null), [preview, setPreview] = useState<BackupSummary | null>(null)
  const run = async (action: 'create' | 'preview' | 'restore'): Promise<void> => {
    setBusy(true); setError('')
    try {
      if (action === 'create') { const result = await window.api.backup.create(); if (result) setSaved(result) }
      else if (action === 'preview') setPreview(await window.api.backup.preview())
      else { await window.api.backup.restore(); setPreview(null) }
    } catch (error) { setError(t(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error))) }
    finally { setBusy(false) }
  }
  const details = (value: BackupSummary): JSX.Element => <Stack spacing={1}>
    <Typography variant="body2">{new Date(value.createdAt).toLocaleString()} · {value.files} {t('个文件')} · {(value.bytes / 1024 / 1024).toFixed(1)} MiB</Typography>
    <Typography variant="body2">{Object.entries(value.counts).map(([kind, count]) => `${t(kind)} ${count}`).join(' · ')}</Typography>
    <Typography variant="caption" sx={{ overflowWrap: 'anywhere' }}>{value.path}</Typography>
  </Stack>
  return <SettingsGroup title={t('备份与恢复')}>
    <SettingsHint>{t('完整保存本地用户数据与附件，不包含模型缓存和登录态。密钥仍使用系统加密，换电脑后可能需要重新填写。')}</SettingsHint>
    <Stack direction="row" spacing={1}><Button disabled={busy} variant="outlined" onClick={() => void run('create')}>{t('创建备份')}</Button><Button disabled={busy} variant="outlined" onClick={() => void run('preview')}>{t('从备份恢复')}</Button></Stack>
    {saved && <Alert severity="success">{details(saved)}</Alert>}
    {error && <Alert severity="error">{error}</Alert>}
    <Dialog open={busy && !preview} disableEscapeKeyDown><DialogTitle>{t('正在处理用户数据…')}</DialogTitle><DialogContent>{t('请等待操作完成。')}</DialogContent></Dialog>
    <Dialog open={Boolean(preview)} onClose={() => { if (!busy) setPreview(null) }} fullWidth maxWidth="sm">
      <DialogTitle>{t('恢复备份')}</DialogTitle><DialogContent>{preview && details(preview)}<Alert severity="warning" sx={{ mt: 2 }}>{t('恢复会替换当前本地数据并重启软件。恢复前副本会保留在各数据目录中，恢复后同步默认关闭。')}</Alert>{error && <Alert severity="error">{error}</Alert>}</DialogContent>
      <DialogActions><Button disabled={busy} onClick={() => setPreview(null)}>{t('取消')}</Button><Button disabled={busy} color="warning" onClick={() => void run('restore')}>{t('恢复并重启')}</Button></DialogActions>
    </Dialog>
  </SettingsGroup>
}
