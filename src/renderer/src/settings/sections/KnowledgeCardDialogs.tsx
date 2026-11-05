import { useEffect, useState } from 'react'
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
  Divider,
  MenuItem,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import { useTranslation } from 'react-i18next'
import type { CardKind, CardRevision, KnowledgeCard, KnowledgeSuggestion, RelationKind } from '@shared/knowledge'
import { KNOWLEDGE_LIMITS } from '@shared/knowledge'
import { formatStamp } from '../pages/notesView'
import { RELATION_KINDS, kindKey, mergePreview, mergeQuery, relationKey } from '../pages/knowledgeView'
import { KnowledgeCardPicker } from './KnowledgeCardPicker'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Delete states what goes with the card, then asks once. */
export function DeleteCardDialog({ card, relations, open, onClose, onDeleted }: {
  card: KnowledgeCard
  relations: number
  open: boolean
  onClose: () => void
  onDeleted: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const confirm = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await window.api.knowledge.deleteCard(card.id)
      setBusy(false)
      onDeleted()
    } catch (err) {
      setError(messageOf(err))
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="xs">
      <DialogTitle>{t('knowledge.deleteTitle')}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mb: 2 }}>
          {t('knowledge.deleteBody', { title: card.title, sources: card.sourceIds.length, relations })}
        </Typography>
        {error && <Alert severity="error">{error}</Alert>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
        <Button color="error" onClick={() => void confirm()} disabled={busy}>{t('common.delete')}</Button>
      </DialogActions>
    </Dialog>
  )
}

/** Read-only list of every earlier revision, newest first. */
export function RevisionsDialog({ cardId, open, onClose }: { cardId: string; open: boolean; onClose: () => void }): JSX.Element | null {
  const { t } = useTranslation()
  const [rows, setRows] = useState<CardRevision[] | null>(null)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  useEffect(() => {
    if (!open) return
    let live = true
    setRows(null)
    setError('')
    void window.api.knowledge
      .cardRevisions(cardId, KNOWLEDGE_LIMITS.revisions)
      .then((result) => { if (live) setRows(result.revisions) })
      .catch((err) => { if (live) setError(messageOf(err)) })
    return () => { live = false }
  }, [cardId, open, reload])
  if (!open) return null
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t('knowledge.revisions')}</DialogTitle>
      <DialogContent>
        {error && <Alert severity="error" action={<Button color="inherit" size="small" onClick={() => setReload((value) => value + 1)}>{t('common.retry')}</Button>}>{error}</Alert>}
        {!rows && !error && <CircularProgress size={20} aria-label={t('common.loading')} />}
        {rows && rows.length === 0 && <Typography variant="body2" color="text.secondary">{t('knowledge.revisionsEmpty')}</Typography>}
        {rows?.map((row) => (
          <Box key={row.revision} sx={{ py: 1.25, borderBottom: 1, borderColor: 'divider' }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
              <Typography variant="subtitle2" sx={{ flex: 1, minWidth: 0 }}>{row.title}</Typography>
              <Chip size="small" label={t('knowledge.revision', { revision: row.revision })} />
              {row.edited && <Chip size="small" variant="outlined" label={t('knowledge.edited')} />}
              <Typography variant="caption" color="text.secondary">{formatStamp(row.createdAt).full}</Typography>
            </Stack>
            <Box sx={{ maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12.5, color: 'text.secondary' }}>
              {row.body || row.summary}
            </Box>
          </Box>
        ))}
      </DialogContent>
      <DialogActions><Button onClick={onClose}>{t('common.close')}</Button></DialogActions>
    </Dialog>
  )
}

/**
 * Suggestions against this card. A suggestion written for an older revision is
 * shown as stale; accepting it is still the user's click, and a refusal shows
 * the backend's reason instead of touching the newer manual version.
 */
export function SuggestionsDialog({ cardId, cardRevision, open, onClose, onAccepted }: {
  cardId: string
  cardRevision: number
  open: boolean
  onClose: () => void
  onAccepted: () => void
}): JSX.Element | null {
  const { t } = useTranslation()
  const [rows, setRows] = useState<KnowledgeSuggestion[] | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState('')
  const [reload, setReload] = useState(0)
  const [detail, setDetail] = useState<Record<string, KnowledgeSuggestion>>({})
  const [offset, setOffset] = useState(0)
  const [more, setMore] = useState<number | null>(null)
  useEffect(() => {
    if (!open) return
    let live = true
    setRows(null)
    setError('')
    void window.api.knowledge
      .listSuggestions({ state: 'open', offset, limit: 10 })
      .then((page) => {
        if (!live) return
        setRows((current) => (offset === 0 || !current ? page.items : [...current.filter((row) => !page.items.some((next) => next.id === row.id)), ...page.items]))
        setMore(page.nextOffset ?? null)
      })
      .catch((err) => { if (live) setError(messageOf(err)) })
    return () => { live = false }
  }, [open, offset, reload])
  if (!open) return null
  const accept = async (row: KnowledgeSuggestion): Promise<void> => {
    setBusy(row.id)
    setNotice('')
    setError('')
    try {
      await window.api.knowledge.acceptSuggestion(row.id)
      setRows((current) => current?.filter((item) => item.id !== row.id) ?? null)
      setNotice(t('knowledge.suggestionAccepted'))
      onAccepted()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy('')
    }
  }
  const reject = async (row: KnowledgeSuggestion): Promise<void> => {
    setBusy(row.id)
    setError('')
    try {
      await window.api.knowledge.rejectSuggestion(row.id)
      setRows((current) => current?.filter((item) => item.id !== row.id) ?? null)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy('')
    }
  }
  const expand = async (row: KnowledgeSuggestion): Promise<void> => {
    if (detail[row.id]) {
      setDetail((current) => {
        const next = { ...current }
        delete next[row.id]
        return next
      })
      return
    }
    try {
      const full = await window.api.knowledge.getSuggestion(row.id)
      setDetail((current) => ({ ...current, [row.id]: full }))
    } catch (err) {
      setError(messageOf(err))
    }
  }
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t('knowledge.suggestions')}</DialogTitle>
      <DialogContent>
        {error && <Alert severity="error" sx={{ mb: 1 }} action={<Button color="inherit" size="small" onClick={() => setReload((value) => value + 1)}>{t('common.retry')}</Button>}>{error}</Alert>}
        {notice && <Alert severity="success" sx={{ mb: 1 }}>{notice}</Alert>}
        {!rows && !error && <CircularProgress size={20} aria-label={t('common.loading')} />}
        {rows && rows.length === 0 && <Typography variant="body2" color="text.secondary">{t('knowledge.suggestionsEmpty')}</Typography>}
        {rows?.map((row) => {
          const stale = row.targetCardId === cardId && row.targetRevision !== cardRevision
          const body = detail[row.id] ?? row
          return (
            <Box key={row.id} sx={{ py: 1.25, borderBottom: 1, borderColor: 'divider' }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                <Typography variant="subtitle2" sx={{ flex: 1, minWidth: 0 }} noWrap>{body.draft.title || body.reason}</Typography>
                <Chip size="small" label={t(kindKey(body.draft.kind as CardKind))} />
                {stale && <Chip size="small" color="warning" variant="outlined" label={t('knowledge.suggestionStale')} />}
              </Stack>
              <Typography variant="caption" color="text.secondary" display="block" sx={{ overflowWrap: 'anywhere' }}>{body.reason}</Typography>
              {detail[row.id] && (
                <Box sx={{ mt: 1, maxHeight: 180, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12.5 }}>{body.draft.body}</Box>
              )}
              <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
                <Button size="small" onClick={() => void expand(row)}>{t(detail[row.id] ? 'knowledge.collapse' : 'knowledge.expand')}</Button>
                <Button size="small" variant="contained" disabled={busy === row.id} onClick={() => void accept(row)}>{t('knowledge.accept')}</Button>
                <Button size="small" disabled={busy === row.id} onClick={() => void reject(row)}>{t('knowledge.reject')}</Button>
              </Stack>
            </Box>
          )
        })}
        {more !== null && <Button size="small" sx={{ mt: 1 }} onClick={() => setOffset(more)}>{t('knowledge.loadMore')}</Button>}
      </DialogContent>
      <DialogActions><Button onClick={onClose}>{t('common.close')}</Button></DialogActions>
    </Dialog>
  )
}

/** Manual merge: pick the card to absorb, read the result, then confirm once. */
export function MergeDialog({ keep, open, onClose, onMerged }: {
  keep: KnowledgeCard
  open: boolean
  onClose: () => void
  onMerged: (title: string) => void
}): JSX.Element | null {
  const { t } = useTranslation()
  const [merged, setMerged] = useState<KnowledgeCard | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) return
    setMerged(null)
    setError('')
  }, [open])
  if (!open) return null
  const preview = merged ? mergePreview(keep, merged) : null
  const confirm = async (): Promise<void> => {
    if (!merged) return
    setBusy(true)
    setError('')
    try {
      const result = await window.api.knowledge.mergeCards(mergeQuery(keep, merged))
      setBusy(false)
      onMerged(result.card.title)
    } catch (err) {
      setError(messageOf(err))
      setBusy(false)
    }
  }
  return (
    <Dialog open onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t('knowledge.mergeTitle')}</DialogTitle>
      <DialogContent>
        {error && <Alert severity="error" sx={{ mb: 1 }}>{error}</Alert>}
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>{t('knowledge.mergePick')}</Typography>
        <KnowledgeCardPicker excludeIds={[keep.id]} onPick={(card) => { setMerged(card); setError('') }} />
        {preview && (
          <Box sx={{ mt: 2, p: 1.5, border: 1, borderColor: 'divider', borderRadius: 2 }}>
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>{preview.title}</Typography>
            <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
              <Chip size="small" label={t('knowledge.mergeSources', { count: preview.sourceIds.length })} />
              <Chip size="small" label={t('knowledge.mergeTopics', { count: preview.topics.length })} />
            </Stack>
            <Box sx={{ maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12.5 }}>{preview.body}</Box>
            <Divider sx={{ my: 1 }} />
            <Typography variant="caption" color="text.secondary">{t('knowledge.mergeNote')}</Typography>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
        <Button variant="contained" disabled={!merged || busy} onClick={() => void confirm()}>{t('knowledge.mergeConfirm')}</Button>
      </DialogActions>
    </Dialog>
  )
}

/** Adds one relation from this card to another. */
export function RelationDialog({ from, open, onClose, onAdded }: {
  from: KnowledgeCard
  open: boolean
  onClose: () => void
  onAdded: () => void
}): JSX.Element | null {
  const { t } = useTranslation()
  const [target, setTarget] = useState<KnowledgeCard | null>(null)
  const [kind, setKind] = useState<RelationKind>('contains')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!open) return
    setTarget(null)
    setError('')
    setKind('contains')
  }, [open])
  if (!open) return null
  const add = async (): Promise<void> => {
    if (!target) return
    setBusy(true)
    setError('')
    try {
      await window.api.knowledge.addRelation({ fromId: from.id, toId: target.id, kind })
      setBusy(false)
      onAdded()
    } catch (err) {
      setError(messageOf(err))
      setBusy(false)
    }
  }
  return (
    <Dialog open onClose={busy ? undefined : onClose} fullWidth maxWidth="xs">
      <DialogTitle>{t('knowledge.relationAdd')}</DialogTitle>
      <DialogContent>
        {error && <Alert severity="error" sx={{ mb: 1 }}>{error}</Alert>}
        <TextField select size="small" fullWidth label={t('knowledge.relationKind')} value={kind} onChange={(event) => setKind(event.target.value as RelationKind)} sx={{ mb: 1.5 }}>
          {RELATION_KINDS.map((value) => <MenuItem key={value} value={value}>{t(relationKey(value))}</MenuItem>)}
        </TextField>
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>{t('knowledge.relationTarget')}</Typography>
        <KnowledgeCardPicker excludeIds={[from.id]} onPick={(card) => { setTarget(card); setError('') }} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
        <Button variant="contained" disabled={!target || busy} onClick={() => void add()}>{t('knowledge.relationAdd')}</Button>
      </DialogActions>
    </Dialog>
  )
}
