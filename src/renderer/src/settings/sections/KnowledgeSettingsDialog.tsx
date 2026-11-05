import { useEffect, useState, type ReactNode } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import CloseRounded from '@mui/icons-material/CloseRounded'
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded'
import { useTranslation } from 'react-i18next'
import type { CollectChannel, ExclusionEntry, HistoryJob, QueueStatus, QueueTask } from '@shared/knowledge'
import type { Settings } from '@shared/types'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const EFFORTS = ['', 'off', 'low', 'high', 'max'] as const
const CHANNELS: CollectChannel[] = ['note', 'chat', 'reading']
const CHANNEL_KEY: Record<CollectChannel, string> = {
  note: 'knowledge.channelNote',
  chat: 'knowledge.channelChat',
  reading: 'knowledge.channelReading'
}
const FAILED_LIMIT = 5

function Row({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ py: 0.75, borderBottom: 1, borderColor: 'divider' }}>
      <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }}>{label}</Typography>
      {children}
    </Stack>
  )
}

interface Props {
  settings: Settings
  patch: (delta: Partial<Settings>) => void
  open: boolean
  onClose: () => void
}

/** Collection switches, the model that reads them, and what is waiting. */
export function KnowledgeSettingsDialog({ settings, patch, open, onClose }: Props): JSX.Element | null {
  const { t } = useTranslation()
  const knowledge = settings.knowledge
  const [status, setStatus] = useState<QueueStatus | null>(null)
  const [failed, setFailed] = useState<QueueTask[]>([])
  const [exclusions, setExclusions] = useState<ExclusionEntry[]>([])
  const [job, setJob] = useState<HistoryJob | null>(null)
  const [scopes, setScopes] = useState({ notes: true, chat: true })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [reload, setReload] = useState(0)

  useEffect(() => {
    if (!open) return
    let live = true
    setError('')
    void Promise.all([
      window.api.knowledge.queueStatus(),
      window.api.knowledge.listQueue({ state: 'failed', offset: 0, limit: FAILED_LIMIT }),
      window.api.knowledge.listExclusions(),
      window.api.knowledge.latestHistory()
    ])
      .then(([queueStatus, queuePage, exclusionList, latest]) => {
        if (!live) return
        setStatus(queueStatus)
        setFailed(queuePage.items)
        setExclusions(exclusionList)
        setJob(latest.job)
      })
      .catch((err) => { if (live) setError(messageOf(err)) })
    return () => { live = false }
  }, [open, reload])

  useEffect(() => {
    if (!open) return
    return window.api.knowledge.onChanged((scope) => {
      if (scope === 'queue' || scope === 'cards' || scope === 'sources') {
        void window.api.knowledge.queueStatus().then(setStatus).catch(() => undefined)
        void window.api.knowledge.listQueue({ state: 'failed', offset: 0, limit: FAILED_LIMIT }).then((page) => setFailed(page.items)).catch(() => undefined)
      }
      if (scope === 'history') void window.api.knowledge.latestHistory().then((latest) => setJob(latest.job)).catch(() => undefined)
      if (scope === 'sources') void window.api.knowledge.listExclusions().then(setExclusions).catch(() => undefined)
    })
  }, [open])

  if (!open) return null

  const llmProfiles = settings.profiles.filter((profile) => profile.kind === 'llm')
  const paused = status?.paused ?? false

  const run = async (key: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(key)
    setError('')
    try {
      await action()
      setReload((value) => value + 1)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy('')
    }
  }

  const patchKnowledge = (delta: Partial<typeof knowledge>): void => {
    patch({ knowledge: { ...knowledge, ...delta } })
  }

  const beginHistory = (): void => {
    if (!scopes.notes && !scopes.chat) return
    void run('history', async () => {
      const result = await window.api.knowledge.beginHistory(scopes)
      setJob(result.job)
    })
  }

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm" PaperProps={{ sx: { height: 'min(720px, 88vh)' } }}>
      <DialogTitle sx={{ pb: 1 }}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography component="h2" variant="h6" sx={{ flex: 1, fontWeight: 600 }}>{t('knowledge.settingsTitle')}</Typography>
          <Tooltip title={t('common.close')}>
            <IconButton size="small" aria-label={t('common.close')} onClick={onClose}><CloseRounded fontSize="small" /></IconButton>
          </Tooltip>
        </Stack>
      </DialogTitle>
      <DialogContent sx={{ pb: 2 }}>
        {error && <Alert severity="error" sx={{ mb: 1.5 }} action={<Button color="inherit" size="small" onClick={() => setReload((value) => value + 1)}>{t('common.retry')}</Button>}>{error}</Alert>}

        <Row label={t('knowledge.master')}>
          <Switch size="small" checked={knowledge.enabled} onChange={(event) => patchKnowledge({ enabled: event.target.checked })} inputProps={{ 'aria-label': t('knowledge.master') }} />
        </Row>
        <Typography variant="caption" color="text.secondary">{t('knowledge.masterHint')}</Typography>

        <Box sx={{ mt: 1 }}>
          {CHANNELS.map((channel) => (
            <Row key={channel} label={t(CHANNEL_KEY[channel])}>
              <Switch
                size="small"
                checked={channel === 'note' ? knowledge.notes : channel === 'chat' ? knowledge.chat : knowledge.reading}
                disabled={!knowledge.enabled}
                onChange={(event) => patchKnowledge(channel === 'note' ? { notes: event.target.checked } : channel === 'chat' ? { chat: event.target.checked } : { reading: event.target.checked })}
                inputProps={{ 'aria-label': t(CHANNEL_KEY[channel]) }}
              />
            </Row>
          ))}
        </Box>

        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mt: 1.5 }}>
          <TextField
            select
            size="small"
            fullWidth
            label={t('knowledge.model')}
            value={knowledge.profileId ?? ''}
            onChange={(event) => patchKnowledge({ profileId: event.target.value || null })}
          >
            <MenuItem value="">{t('knowledge.modelDefault')}</MenuItem>
            {llmProfiles.map((profile) => <MenuItem key={profile.id} value={profile.id}>{profile.model || profile.name}</MenuItem>)}
          </TextField>
          <TextField
            select
            size="small"
            fullWidth
            label={t('knowledge.effort')}
            value={knowledge.effort ?? ''}
            onChange={(event) => patchKnowledge({ effort: event.target.value })}
          >
            {EFFORTS.map((value) => <MenuItem key={value || 'default'} value={value}>{t(value ? `knowledge.effort${value[0].toUpperCase()}${value.slice(1)}` : 'knowledge.effortDefault')}</MenuItem>)}
          </TextField>
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>{t('knowledge.modelHint')}</Typography>

        <Divider sx={{ my: 2 }} />

        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
          <Typography variant="subtitle2" sx={{ flex: 1 }}>{t('knowledge.queue')}</Typography>
          {paused && <Chip size="small" color="warning" variant="outlined" label={t('knowledge.queuePaused')} />}
          <Button
            size="small"
            disabled={busy !== ''}
            onClick={() => void run('pause', () => window.api.knowledge.pauseCollect('manual', !paused))}
          >
            {t(paused ? 'knowledge.queueResume' : 'knowledge.queuePause')}
          </Button>
        </Stack>
        {status && (
          <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
            {(['stabilizing', 'ready', 'working', 'needs_reread', 'failed'] as const).map((state) => (
              <Chip key={state} size="small" variant="outlined" label={`${t(`knowledge.queueState.${state}`)} ${status.counts[state] ?? 0}`} />
            ))}
            <Chip size="small" label={`${t('knowledge.queueTotal')} ${status.total}`} />
          </Stack>
        )}
        {failed.length > 0 && (
          <Box sx={{ mt: 1 }}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>{t('knowledge.queueFailed')}</Typography>
              <Button size="small" disabled={busy !== ''} onClick={() => void run('retry', async () => {
                for (const task of failed) await window.api.knowledge.retryTask({ channel: task.channel, groupKey: task.groupKey })
              })}>{t('knowledge.queueRetryFailed')}</Button>
            </Stack>
            {failed.map((task) => (
              <Stack key={task.id} direction="row" spacing={1} alignItems="center" sx={{ py: 0.25 }}>
                <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }} noWrap>{task.title}</Typography>
                <Typography variant="caption" color="error.main" sx={{ maxWidth: '50%', overflowWrap: 'anywhere' }} noWrap>{task.error || task.reason || ''}</Typography>
              </Stack>
            ))}
          </Box>
        )}

        <Box sx={{ mt: 1.5 }}>
          <Typography variant="subtitle2">{t('knowledge.exclusions')}</Typography>
          {exclusions.length === 0 && <Typography variant="caption" color="text.secondary">{t('knowledge.exclusionEmpty')}</Typography>}
          {exclusions.map((row) => (
            <Stack key={`${row.kind}:${row.key}`} direction="row" spacing={1} alignItems="center" sx={{ py: 0.25 }}>
              <Chip size="small" label={t(CHANNEL_KEY[row.kind])} />
              <Typography variant="caption" sx={{ flex: 1, minWidth: 0, fontFamily: 'monospace', overflowWrap: 'anywhere' }} noWrap>{row.key}</Typography>
              <Tooltip title={t('knowledge.unexclude')}>
                <IconButton size="small" aria-label={t('knowledge.unexclude')} onClick={() => void run('exclude', () => window.api.knowledge.unexclude(row.kind, row.key))}>
                  <DeleteOutlineRounded fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
          ))}
        </Box>

        <Divider sx={{ my: 2 }} />

        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
          <Typography variant="subtitle2" sx={{ flex: 1 }}>{t('knowledge.history')}</Typography>
          {job && <Chip size="small" variant="outlined" label={t(`knowledge.historyState.${job.state}`)} />}
        </Stack>
        {!job || job.state === 'completed' || job.state === 'cancelled' ? (
          <>
            <Stack direction="row" spacing={1.5} alignItems="center">
              <Stack direction="row" spacing={0.5} alignItems="center">
                <Switch size="small" checked={scopes.notes} onChange={(event) => setScopes({ ...scopes, notes: event.target.checked })} inputProps={{ 'aria-label': t('knowledge.channelNote') }} />
                <Typography variant="body2">{t('knowledge.channelNote')}</Typography>
              </Stack>
              <Stack direction="row" spacing={0.5} alignItems="center">
                <Switch size="small" checked={scopes.chat} onChange={(event) => setScopes({ ...scopes, chat: event.target.checked })} inputProps={{ 'aria-label': t('knowledge.channelChat') }} />
                <Typography variant="body2">{t('knowledge.channelChat')}</Typography>
              </Stack>
              <Box sx={{ flex: 1 }} />
              <Button size="small" variant="outlined" disabled={busy !== '' || (!scopes.notes && !scopes.chat)} onClick={beginHistory}>
                {t('knowledge.historyStart')}
              </Button>
            </Stack>
            <Typography variant="caption" color="text.secondary">{t('knowledge.historyHint')}</Typography>
          </>
        ) : (
          <Box>
            <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
              <Chip size="small" label={`${t('knowledge.historyScanned')} ${job.scanned}`} />
              <Chip size="small" label={`${t('knowledge.historyReady')} ${job.ready}`} />
              <Chip size="small" label={`${t('knowledge.historySkipped')} ${job.skipped}`} />
              <Chip size="small" label={`${t('knowledge.historyDeduped')} ${job.deduped}`} />
              <Chip size="small" label={`${t('knowledge.historyFailed')} ${job.failed}`} />
            </Stack>
            <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
              <Button size="small" disabled={busy !== ''} onClick={() => void run('history', async () => {
                const result = job.state === 'paused' ? await window.api.knowledge.resumeHistory(job.id) : await window.api.knowledge.pauseHistory(job.id)
                setJob(result.job)
              })}>
                {t(job.state === 'paused' ? 'knowledge.historyResume' : 'knowledge.historyPause')}
              </Button>
              <Button size="small" disabled={busy !== ''} onClick={() => void run('history', async () => {
                const result = await window.api.knowledge.cancelHistory(job.id)
                setJob(result.job)
              })}>{t('knowledge.historyCancel')}</Button>
            </Stack>
          </Box>
        )}
        {busy !== '' && <CircularProgress size={14} sx={{ mt: 1 }} aria-label={t('common.loading')} />}
      </DialogContent>
    </Dialog>
  )
}
