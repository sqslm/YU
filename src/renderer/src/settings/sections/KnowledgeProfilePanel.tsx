import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import CloseRounded from '@mui/icons-material/CloseRounded'
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded'
import ModeEditOutlineRounded from '@mui/icons-material/ModeEditOutlineRounded'
import OpenInNewRounded from '@mui/icons-material/OpenInNewRounded'
import StarBorderRounded from '@mui/icons-material/StarBorderRounded'
import StarRounded from '@mui/icons-material/StarRounded'
import { useTranslation } from 'react-i18next'
import type { ProfileContext, ProfileEvidence, ProfileItem, ProfileStatus } from '@shared/knowledge'
import type { Settings } from '@shared/types'
import type { LocalRecord } from '@shared/workspace'
import { formatStamp } from '../pages/notesView'
import { groupProfile, sourceKindKey, type ProfileGroup } from '../pages/knowledgeView'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * One piece of evidence. The compound origin ref never becomes a record id here —
 * the main process resolves the identity, and a withdrawn evidence is not a
 * target at all, so it says so instead of failing on click.
 */
function EvidenceRow({ evidence, openRecord }: {
  evidence: ProfileEvidence
  openRecord: (record: LocalRecord) => void
}): JSX.Element {
  const { t } = useTranslation()
  const [denied, setDenied] = useState('')
  const [busy, setBusy] = useState(false)
  const withdrawn = evidence.withdrawn === true

  const locate = async (): Promise<void> => {
    setDenied('')
    setBusy(true)
    try {
      const target = await window.api.knowledge.sourceTarget(evidence.sourceId)
      if (target.kind === 'record') return openRecord(target.record)
      if (target.kind === 'none') return setDenied(target.reason)
      const result = await window.api.knowledge.openSource(evidence.sourceId)
      if (!result.opened) setDenied(result.reason)
    } catch (err) {
      setDenied(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Stack direction="row" spacing={0.75} alignItems="center" sx={{ pl: 1, minWidth: 0 }}>
        <Chip size="small" variant="outlined" label={t(sourceKindKey(evidence.sourceKind))} />
        <Typography variant="caption" color="text.secondary" sx={{ flex: 1, minWidth: 0 }} noWrap>
          {evidence.locator || evidence.originRef}
        </Typography>
        <Typography variant="caption" color="text.secondary">{formatStamp(evidence.createdAt).full}</Typography>
        {withdrawn
          ? <Chip size="small" color="warning" variant="outlined" label={t('knowledge.profileWithdrawn')} />
          : (
            <Tooltip title={t('knowledge.profileSource')}>
              <span>
                <IconButton size="small" aria-label={t('knowledge.profileSource')} disabled={busy} onClick={() => void locate()}>
                  <OpenInNewRounded sx={{ fontSize: 14 }} />
                </IconButton>
              </span>
            </Tooltip>
          )}
      </Stack>
      {denied && <Typography variant="caption" color="warning.main" sx={{ display: 'block', pl: 1, overflowWrap: 'anywhere' }}>{denied}</Typography>}
    </>
  )
}

const PAGE_SIZE = 20
const CATEGORY_KEY: Record<string, string> = {
  explicit: 'knowledge.profileExplicit',
  observed: 'knowledge.profileObserved',
  inferred: 'knowledge.profileInferred'
}

interface Props {
  settings: Settings
  patch: (delta: Partial<Settings>) => void
  open: boolean
  onClose: () => void
  openRecord: (record: LocalRecord) => void
}

/**
 * Profile items with their real evidence. Every write shows the value the backend
 * returns, so a correction that the helper clamped or dropped is visible here.
 */
export function KnowledgeProfilePanel({ settings, patch, open, onClose, openRecord }: Props): JSX.Element | null {
  const { t } = useTranslation()
  const [items, setItems] = useState<ProfileItem[]>([])
  const [total, setTotal] = useState(0)
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [status, setStatus] = useState<ProfileStatus | null>(null)
  const [context, setContext] = useState<ProfileContext | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [reload, setReload] = useState(0)
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)

  useEffect(() => {
    if (!open) return
    let live = true
    setLoading(true)
    setError('')
    void Promise.all([
      window.api.profile.list({ offset: 0, limit: PAGE_SIZE }),
      window.api.profile.status(),
      window.api.profile.context()
    ])
      .then(([page, nextStatus, nextContext]) => {
        if (!live) return
        setItems(page.items)
        setTotal(page.total)
        setNextOffset(page.nextOffset ?? null)
        setStatus(nextStatus)
        setContext(nextContext)
      })
      .catch((err) => { if (live) setError(messageOf(err)) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [open, reload])

  useEffect(() => {
    if (!open) return
    return window.api.knowledge.onChanged((scope) => {
      if (scope === 'profile') setReload((value) => value + 1)
    })
  }, [open])

  const loadMore = useCallback(async (): Promise<void> => {
    if (nextOffset === null) return
    setBusy('more')
    setError('')
    try {
      const page = await window.api.profile.list({ offset: nextOffset, limit: PAGE_SIZE })
      setItems((current) => [...current.filter((row) => !page.items.some((next) => next.id === row.id)), ...page.items])
      setTotal(page.total)
      setNextOffset(page.nextOffset ?? null)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy('')
    }
  }, [nextOffset])

  const replace = (next: ProfileItem): void => {
    setItems((current) => current.map((row) => (row.id === next.id ? next : row)))
  }

  const correct = async (): Promise<void> => {
    if (!editing) return
    setBusy(editing.id)
    setError('')
    try {
      const next = await window.api.profile.update({ id: editing.id, value: editing.value.trim(), corrected: true })
      replace(next)
      setEditing(null)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy('')
    }
  }

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

  if (!open) return null

  const userProfile = settings.userProfile
  const recent = new Set((context?.items ?? []).filter((item) => item.recent).map((item) => item.id))
  const groups: ProfileGroup[] = groupProfile(items)

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="md" PaperProps={{ sx: { height: 'min(720px, 88vh)' } }}>
      <DialogTitle sx={{ pb: 1 }}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography component="h2" variant="h6" sx={{ flex: 1, fontWeight: 600 }}>{t('knowledge.profileTitle')}</Typography>
          <Tooltip title={t('common.close')}>
            <IconButton size="small" aria-label={t('common.close')} onClick={onClose}><CloseRounded fontSize="small" /></IconButton>
          </Tooltip>
        </Stack>
      </DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {error && <Alert severity="error" action={<Button color="inherit" size="small" onClick={() => setReload((value) => value + 1)}>{t('common.retry')}</Button>}>{error}</Alert>}

        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ flexWrap: 'wrap', gap: 0.5 }}>
          <Stack direction="row" spacing={0.25} alignItems="center">
            <Switch size="small" checked={userProfile.enabled} onChange={(event) => patch({ userProfile: { ...userProfile, enabled: event.target.checked } })} inputProps={{ 'aria-label': t('knowledge.profileEnable') }} />
            <Typography variant="caption">{t('knowledge.profileEnable')}</Typography>
          </Stack>
          <Stack direction="row" spacing={0.25} alignItems="center">
            <Switch size="small" checked={userProfile.usage} onChange={(event) => patch({ userProfile: { ...userProfile, usage: event.target.checked } })} inputProps={{ 'aria-label': t('knowledge.profileUsageSwitch') }} />
            <Typography variant="caption">{t('knowledge.profileUsageSwitch')}</Typography>
          </Stack>
          <Stack direction="row" spacing={0.25} alignItems="center">
            <Switch size="small" checked={userProfile.chat} onChange={(event) => patch({ userProfile: { ...userProfile, chat: event.target.checked } })} inputProps={{ 'aria-label': t('knowledge.profileChat') }} />
            <Typography variant="caption">{t('knowledge.profileChat')}</Typography>
          </Stack>
          <Box sx={{ flex: 1 }} />
          <Button size="small" disabled={busy !== ''} onClick={() => void run('pause', () => window.api.profile.pause(!(status?.pausedManual ?? false)))}>
            {t(status?.pausedManual ? 'knowledge.profileResume' : 'knowledge.profilePause')}
          </Button>
          <Button size="small" disabled={busy !== ''} onClick={() => void run('retry', () => window.api.profile.retry())}>{t('knowledge.profileRetry')}</Button>
          <Button size="small" color="error" disabled={busy !== ''} onClick={() => setConfirmClear(true)}>{t('knowledge.profileClear')}</Button>
        </Stack>

        <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
          <Chip size="small" label={`${t('knowledge.profileItems')} ${status?.items ?? total}`} />
          <Chip size="small" variant="outlined" label={`${t('knowledge.profileUsage')} ${status?.usageTotal ?? 0}`} />
          <Chip size="small" variant="outlined" label={`${t('knowledge.profilePending')} ${status?.pending ?? 0}`} />
          <Chip size="small" variant="outlined" color={(status?.failed ?? 0) > 0 ? 'warning' : 'default'} label={`${t('knowledge.profileFailed')} ${status?.failed ?? 0}`} />
        </Stack>

        <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', pr: 0.5 }}>
          {loading && items.length === 0 && <CircularProgress size={20} aria-label={t('common.loading')} />}
          {!loading && items.length === 0 && <Typography variant="body2" color="text.secondary">{t('knowledge.profileEmpty')}</Typography>}
          {groups.map((group) => (
            <Box key={group.category} sx={{ mb: 1.5 }}>
              <Typography variant="subtitle2" sx={{ mb: 0.5 }}>{t(CATEGORY_KEY[group.category] ?? group.category)}</Typography>
              {group.items.map((item) => (
                <Box key={item.id} sx={{ py: 0.75, borderBottom: 1, borderColor: 'divider' }}>
                  <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
                    {editing?.id === item.id
                      ? (
                        <TextField
                          size="small"
                          fullWidth
                          autoFocus
                          value={editing.value}
                          onChange={(event) => setEditing({ id: item.id, value: event.target.value })}
                          onKeyDown={(event) => { if (event.key === 'Enter') void correct() }}
                        />
                      )
                      : <Typography variant="body2" sx={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{item.value}</Typography>}
                    {recent.has(item.id) && <Chip size="small" label={t('knowledge.profileRecent')} />}
                    {item.pinned && <Chip size="small" color="primary" variant="outlined" label={t('knowledge.profilePinned')} />}
                    {item.corrected && <Chip size="small" variant="outlined" label={t('knowledge.profileCorrected')} />}
                    {editing?.id === item.id
                      ? (
                        <>
                          <Button size="small" variant="contained" disabled={busy === item.id} onClick={() => void correct()}>{t('common.save')}</Button>
                          <Button size="small" disabled={busy === item.id} onClick={() => setEditing(null)}>{t('common.cancel')}</Button>
                        </>
                      )
                      : (
                        <>
                          <Tooltip title={t(item.pinned ? 'knowledge.unpin' : 'knowledge.pin')}>
                            <IconButton
                              size="small"
                              aria-label={t(item.pinned ? 'knowledge.unpin' : 'knowledge.pin')}
                              disabled={busy === item.id}
                              onClick={() => void run(item.id, async () => replace(await window.api.profile.update({ id: item.id, pinned: !item.pinned })))}
                            >
                              {item.pinned ? <StarRounded fontSize="small" color="primary" /> : <StarBorderRounded fontSize="small" />}
                            </IconButton>
                          </Tooltip>
                          <Tooltip title={t('knowledge.correct')}>
                            <IconButton size="small" aria-label={t('knowledge.correct')} disabled={busy === item.id} onClick={() => setEditing({ id: item.id, value: item.value })}>
                              <ModeEditOutlineRounded fontSize="small" />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title={t('knowledge.remove')}>
                            <IconButton
                              size="small"
                              aria-label={t('knowledge.remove')}
                              disabled={busy === item.id}
                              onClick={() => void run(item.id, () => window.api.profile.delete(item.id))}
                            >
                              <DeleteOutlineRounded fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        </>
                      )}
                  </Stack>
                  <Typography variant="caption" color="text.secondary">{item.dimension}</Typography>
                  {item.evidence.map((evidence, index) => (
                    <EvidenceRow key={`${evidence.sourceId}:${index}`} evidence={evidence} openRecord={openRecord} />
                  ))}
                </Box>
              ))}
            </Box>
          ))}
          {nextOffset !== null && (
            <Button size="small" disabled={busy === 'more'} onClick={() => void loadMore()}>{t('knowledge.loadMore')}</Button>
          )}
        </Box>
      </DialogContent>

      <Dialog open={confirmClear} onClose={() => setConfirmClear(false)} fullWidth maxWidth="xs">
        <DialogTitle>{t('knowledge.profileClearTitle')}</DialogTitle>
        <DialogContent>
          <Typography variant="body2">{t('knowledge.profileClearBody')}</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmClear(false)}>{t('common.cancel')}</Button>
          <Button
            color="error"
            disabled={busy !== ''}
            onClick={() => { setConfirmClear(false); void run('clear', () => window.api.profile.clear()) }}
          >
            {t('knowledge.profileClear')}
          </Button>
        </DialogActions>
      </Dialog>
    </Dialog>
  )
}
