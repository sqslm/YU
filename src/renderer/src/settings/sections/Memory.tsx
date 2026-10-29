import { lazy, Suspense, useEffect, useState } from 'react'
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, LinearProgress, MenuItem, Stack, Switch, TextField, Typography } from '@mui/material'
import type { Settings } from '@shared/types'
import type { MemoryEntry, MemoryKind, MemoryStatus } from '@shared/memory'
import { SettingsGroup, SettingsRow } from './General'
import { registerGameModePreparation } from '../gameModePreparation'
import i18n from '../../i18n'
const MemoryGraphDialog = lazy(() => import('./MemoryGraph'))

export function MemorySection({ settings, patch }: { settings: Settings; patch: (delta: Partial<Settings>) => void }): JSX.Element {
  const t = i18n.t.bind(i18n)
  const [status, setStatus] = useState<MemoryStatus | null>(null), [open, setOpen] = useState(false), [consent, setConsent] = useState(false)
  const [kind, setKind] = useState<MemoryKind>('assistant'), [rows, setRows] = useState<MemoryEntry[]>([]), [query, setQuery] = useState('')
  const [draft, setDraft] = useState<{ id?: string; text: string } | null>(null), [removing, setRemoving] = useState<MemoryEntry | 'all' | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [graphOpen, setGraphOpen] = useState(false)
  useEffect(() => {
    let disposed = false
    const refresh = (): void => { void window.api.memory.status().then(value => { if (!disposed) setStatus(value) }).catch(() => {}) }
    refresh(); const timer = setInterval(refresh, 1500)
    return () => { disposed = true; clearInterval(timer) }
  }, [])
  useEffect(() => draft ? registerGameModePreparation(async () => false) : undefined, [Boolean(draft)])
  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true); setError('')
    try { await fn() } catch (error) { setError(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) }
  }
  const load = async (category = kind): Promise<void> => { setRows(await window.api.memory.list(category)) }
  const found = rows.filter(row => row.text.toLowerCase().includes(query.toLowerCase()))
  const download = (): void => { void run(async () => { await window.api.memory.download(); setStatus(await window.api.memory.status()) }) }
  return <SettingsGroup title={t('长期记忆')}>
    <SettingsRow label={t('启用长期记忆')} description={t('记住助手对话中的个人事实和明确的写作偏好。记忆独立于历史保存。')}>
      <Switch size="small" checked={settings.memory.enabled} onChange={event => event.target.checked ? setConsent(true) : patch({ memory: { ...settings.memory, enabled: false } })} inputProps={{ 'aria-label': t('启用长期记忆') }} />
    </SettingsRow>
    <SettingsRow label={t('自动学习')} description={t('先暂存候选内容，积满 3 条或等待 5 分钟，再在电脑空闲且资源充足时整理。')}>
      <Switch size="small" checked={settings.memory.autoLearn} disabled={!settings.memory.enabled} onChange={event => patch({ memory: { ...settings.memory, autoLearn: event.target.checked } })} inputProps={{ 'aria-label': t('自动学习') }} />
    </SettingsRow>
    <Box sx={{ px: 2, pb: 2 }}>
      <Typography variant="caption" color="text.secondary">{t('本地存储和向量检索；提取与回答可能把允许的内容发送到当前 LLM，并产生额外调用费用。')}</Typography>
      <Typography variant="body2">{t('可说“记住……”或“忘记……”。以“临时对话”开头，本次会话不读取或保存长期记忆。')}</Typography>
      <Typography variant="caption" display="block" color="text.secondary">{t('最多暂存 30 条新交互，退出软件会丢弃尚未整理的候选内容。整理后释放模型；查看列表和图谱不加载向量模型。')}</Typography>
      <Typography variant="caption" display="block" color="text.secondary">{t('下载的是本地检索模型；记忆提炼使用已配置的 LLM，不是另一个生成模型。')}</Typography>
      <Typography variant="caption">{t('状态')}：{t(status?.state ?? 'off')}{status?.pending ? ` · ${t('待处理')} ${status.pending}` : ''}</Typography>
      {settings.memory.enabled && status?.error && <Alert severity="warning" sx={{ mt: 1 }} action={status.pending > 0 && settings.memory.autoLearn ? <Button disabled={busy || status.state === 'working' || status.state === 'paused'} onClick={() => void run(() => window.api.memory.retryLearning())}>{t('重试整理')}</Button> : undefined}>{t(status.error)}<Typography variant="caption" display="block">{t('原有记忆仍然保留。提炼使用当前 LLM，不需要重新下载本地检索模型。')}</Typography></Alert>}
      {status?.state === 'downloading' && <><LinearProgress variant="determinate" value={status.progress ?? 0} sx={{ my: 1 }} /><Button onClick={() => void window.api.memory.cancelDownload()}>{t('取消下载')}</Button></>}
      <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
        <Button onClick={() => { setOpen(true); void run(() => load()) }}>{t('管理记忆')}</Button>
        <Button onClick={() => setGraphOpen(true)}>{t('记忆关系图')}</Button>
        {!status?.modelReady && status?.state !== 'downloading' && <Button disabled={busy} onClick={download}>{t('下载 / 重试记忆模型')}</Button>}
      </Stack>
    </Box>
    <Dialog open={consent} onClose={() => setConsent(false)} maxWidth="sm" fullWidth>
      <DialogTitle>{t('开启长期记忆')}</DialogTitle><DialogContent>
        <Typography>{t('将下载约 24 MB 的本地中文向量模型。仅学习开启后的助手交互和明确偏好，不扫描旧数据。记忆独立保存，清空历史不会清空记忆。')}</Typography>
        <Typography sx={{ mt: 1 }}>{t('本地存储和向量检索；提取与回答可能把允许的内容发送到当前 LLM，并产生额外调用费用。')}</Typography>
      </DialogContent><DialogActions><Button onClick={() => setConsent(false)}>{t('取消')}</Button><Button variant="contained" onClick={() => { setConsent(false); patch({ memory: { ...settings.memory, enabled: true } }); if (!status?.modelReady) download() }}>{t('开启')}</Button></DialogActions>
    </Dialog>
    {graphOpen && <Suspense fallback={null}><MemoryGraphDialog onClose={() => setGraphOpen(false)} /></Suspense>}
    <Dialog open={open} onClose={() => { if (!busy) setOpen(false) }} maxWidth="md" fullWidth>
      <DialogTitle>{t('长期记忆')}</DialogTitle><DialogContent>
        <Stack direction="row" spacing={1} sx={{ my: 1 }}>
          <TextField select size="small" label={t('类别')} value={kind} onChange={event => { const next = event.target.value as MemoryKind; setKind(next); void run(() => load(next)) }} disabled={busy} sx={{ minWidth: 140 }}><MenuItem value="assistant">{t('助手事实')}</MenuItem><MenuItem value="style">{t('写作偏好')}</MenuItem></TextField>
          <TextField fullWidth size="small" label={t('搜索记忆')} value={query} onChange={event => setQuery(event.target.value)} />
          <Button disabled={busy || !status?.modelReady} onClick={() => setDraft({ text: '' })}>{t('添加')}</Button>
        </Stack>
        {error && <Alert severity="error">{error}</Alert>}
        {!found.length && <Typography color="text.secondary">{t('暂无匹配的记忆')}</Typography>}
        {found.slice(0, 200).map(row => <Stack key={row.id} direction="row" spacing={1} sx={{ py: 1, borderBottom: 1, borderColor: 'divider' }} alignItems="center">
          <Box sx={{ flex: 1, minWidth: 0 }}><Typography sx={{ overflowWrap: 'anywhere' }}>{row.text}</Typography><Typography variant="caption" color="text.secondary">{row.updatedAt ?? row.createdAt} · {t('来源')}：{row.sourceId || t('未知')}</Typography></Box>
          <Button disabled={busy || !status?.modelReady} onClick={() => setDraft({ id: row.id, text: row.text })}>{t('编辑')}</Button><Button disabled={busy} onClick={() => setRemoving(row)}>{t('删除')}</Button>
        </Stack>)}
        {found.length > 200 && <Typography variant="caption">{t('结果较多，显示前 200 项，请搜索缩小范围。')}</Typography>}
      </DialogContent><DialogActions><Button color="error" disabled={busy} onClick={() => setRemoving('all')}>{t('清空全部记忆')}</Button><Button disabled={busy} onClick={() => void run(() => load())}>{t('刷新')}</Button><Button disabled={busy} onClick={() => setOpen(false)}>{t('关闭')}</Button></DialogActions>
    </Dialog>
    <Dialog open={Boolean(draft)} onClose={() => { if (!busy) setDraft(null) }} fullWidth maxWidth="sm"><DialogTitle>{t(draft?.id ? '编辑记忆' : '添加记忆')}</DialogTitle><DialogContent><TextField fullWidth multiline minRows={3} value={draft?.text ?? ''} inputProps={{ maxLength: 2000 }} onChange={event => setDraft(previous => previous && ({ ...previous, text: event.target.value }))} sx={{ mt: 1 }} />{error && <Alert severity="error">{error}</Alert>}</DialogContent><DialogActions><Button disabled={busy} onClick={() => setDraft(null)}>{t('取消')}</Button><Button disabled={busy || !draft?.text.trim()} onClick={() => void run(async () => { if (draft?.id) await window.api.memory.update(kind, draft.id, draft.text); else await window.api.memory.add(kind, draft!.text); await load(); setDraft(null) })}>{t('保存')}</Button></DialogActions></Dialog>
    <Dialog open={Boolean(removing)} onClose={() => { if (!busy) setRemoving(null) }}><DialogTitle>{t(removing === 'all' ? '清空全部记忆？待处理的学习也会取消。' : '删除这条记忆？')}</DialogTitle><DialogActions><Button disabled={busy} onClick={() => setRemoving(null)}>{t('取消')}</Button><Button disabled={busy} color="error" onClick={() => void run(async () => { if (removing === 'all') await window.api.memory.clear(); else if (removing) await window.api.memory.delete(removing.kind, removing.id); await load(); setRemoving(null) })}>{t('删除')}</Button></DialogActions></Dialog>
  </SettingsGroup>
}
