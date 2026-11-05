import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded'
import AutorenewRounded from '@mui/icons-material/AutorenewRounded'
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded'
import FileDownloadRounded from '@mui/icons-material/FileDownloadRounded'
import ForumRounded from '@mui/icons-material/ForumRounded'
import HistoryRounded from '@mui/icons-material/HistoryRounded'
import MergeTypeRounded from '@mui/icons-material/MergeTypeRounded'
import ModeEditOutlineRounded from '@mui/icons-material/ModeEditOutlineRounded'
import NoteAddOutlined from '@mui/icons-material/NoteAddOutlined'
import OpenInNewRounded from '@mui/icons-material/OpenInNewRounded'
import PlaylistAddRounded from '@mui/icons-material/PlaylistAddRounded'
import StarBorderRounded from '@mui/icons-material/StarBorderRounded'
import StarRounded from '@mui/icons-material/StarRounded'
import TipsAndUpdatesRounded from '@mui/icons-material/TipsAndUpdatesRounded'
import { useTranslation } from 'react-i18next'
import type { CardKind, KnowledgeCard, KnowledgeSource, RelationKind, RelationList } from '@shared/knowledge'
import type { LocalRecord } from '@shared/workspace'
import { NoteMarkdownBody, noteMarkdownSx } from '../pages/NoteMarkdown'
import { formatStamp } from '../pages/notesView'
import { CARD_KINDS, extractStatus, groupRelations, kindKey, relationKey, sourceKindKey } from '../pages/knowledgeView'
import { DeleteCardDialog, MergeDialog, RelationDialog, RevisionsDialog, SuggestionsDialog } from './KnowledgeCardDialogs'

const RELATION_LIMIT = 40

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface Draft {
  title: string
  kind: CardKind
  body: string
  topics: string
}

function draftOf(card: KnowledgeCard): Draft {
  return { title: card.title, kind: card.kind, body: card.body, topics: card.topics.join(', ') }
}

function topicsOf(text: string): string[] {
  const seen = new Set<string>()
  return text
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter((item) => {
      if (!item || seen.has(item)) return false
      seen.add(item)
      return true
    })
}

/** One source row: the real id, where it came from, and why it is unusable when it is. */
function SourceRow({ source, openRecord }: {
  source: KnowledgeSource
  openRecord: (record: LocalRecord) => void
}): JSX.Element {
  const { t } = useTranslation()
  const [locating, setLocating] = useState(false)
  const [denied, setDenied] = useState('')
  const [extracting, setExtracting] = useState(false)
  const [extractNote, setExtractNote] = useState('')
  const active = source.state === 'active'

  // The main process owns the identity: a chat origin is a compound ref and only
  // `sourceTarget` can turn it back into a record with its thread.
  const locate = async (): Promise<void> => {
    setDenied('')
    setLocating(true)
    try {
      const target = await window.api.knowledge.sourceTarget(source.id)
      if (target.kind === 'record') return openRecord(target.record)
      if (target.kind === 'none') return setDenied(target.reason)
      const result = await window.api.knowledge.openSource(source.id)
      if (!result.opened) setDenied(result.reason)
    } catch (err) {
      setDenied(messageOf(err))
    } finally {
      setLocating(false)
    }
  }

  const extract = async (): Promise<void> => {
    setExtractNote('')
    setExtracting(true)
    try {
      const status = extractStatus(await window.api.knowledge.extractSource(source.id))
      setExtractNote(status.queued ? t('knowledge.extractQueued', { count: status.count }) : status.reason)
    } catch (err) {
      setExtractNote(messageOf(err))
    } finally {
      setExtracting(false)
    }
  }

  return (
    <Box sx={{ py: 0.75, borderBottom: 1, borderColor: 'divider' }}>
      <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
        <Chip size="small" label={t(sourceKindKey(source.kind))} />
        <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }} noWrap>{source.title || source.id}</Typography>
        {!active && <Chip size="small" color="warning" variant="outlined" label={t('knowledge.sourceInvalid')} />}
        <Tooltip title={t('knowledge.extract')}>
          <span>
            <IconButton size="small" aria-label={`${t('knowledge.extract')} ${source.title || source.id}`} disabled={extracting} onClick={() => void extract()}>
              <AutorenewRounded fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        {active && (
          <Tooltip title={t('knowledge.open')}>
            <span>
              <IconButton size="small" aria-label={t('knowledge.open')} disabled={locating} onClick={() => void locate()}>
                <OpenInNewRounded fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        )}
      </Stack>
      <Stack direction="row" spacing={1} sx={{ pl: 0.25, minWidth: 0 }}>
        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}>{source.id}</Typography>
        {source.locator && <Typography variant="caption" color="text.secondary" sx={{ minWidth: 0, overflowWrap: 'anywhere' }} noWrap>{source.locator}</Typography>}
      </Stack>
      {!active && (
        <Typography variant="caption" color="warning.main" sx={{ display: 'block', overflowWrap: 'anywhere' }}>{source.invalidReason}</Typography>
      )}
      {denied && <Typography variant="caption" color="warning.main" sx={{ display: 'block', overflowWrap: 'anywhere' }}>{denied}</Typography>}
      {extractNote && <Typography variant="caption" color="text.secondary" sx={{ display: 'block', overflowWrap: 'anywhere' }}>{extractNote}</Typography>}
    </Box>
  )
}

interface DetailProps {
  cardId: string
  wide: boolean
  refreshToken: number
  onChanged: () => void
  onSelect: (id: string) => void
  openRecord: (record: LocalRecord) => void
  /** Opens the chat the card seeded; the main process already created it. */
  onOpenChat: (threadId: string) => void
  /** Opens the note `saveCardAsNote` created. */
  onOpenNote: (noteId: string) => void
  onPickTopic: (topic: string) => void
  onBack: () => void
  onDeleted: () => void
}

/**
 * What one of the three explicit actions produced. The row keeps the real
 * answer — the todo's own title, the new thread's id, the new note's id — so the
 * user can open it through the normal navigation instead of trusting a toast.
 */
type CardAction =
  | { kind: 'chat'; threadId: string }
  | { kind: 'todo'; id: string; title: string }
  | { kind: 'note'; noteId: string }

export function KnowledgeCardDetail({ cardId, wide, refreshToken, onChanged, onSelect, openRecord, onOpenChat, onOpenNote, onPickTopic, onBack, onDeleted }: DetailProps): JSX.Element {
  const { t } = useTranslation()
  const [card, setCard] = useState<KnowledgeCard | null>(null)
  const [sources, setSources] = useState<KnowledgeSource[]>([])
  const [relations, setRelations] = useState<RelationList>({ items: [], total: 0 })
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [reload, setReload] = useState(0)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [notice, setNotice] = useState('')
  const [dialog, setDialog] = useState('')
  const [relationError, setRelationError] = useState('')
  /** Which of the three card actions is running, so all of them stay disabled. */
  const [running, setRunning] = useState<'' | CardAction['kind']>('')
  const [actionError, setActionError] = useState('')
  const [actionResult, setActionResult] = useState<CardAction | null>(null)

  // Switching cards drops the previous card, its unsaved draft and any stale notice.
  useEffect(() => {
    setCard(null)
    setSources([])
    setRelations({ items: [], total: 0 })
    setDraft(null)
    setSaveError('')
    setNotice('')
    setRelationError('')
    setRunning('')
    setActionError('')
    setActionResult(null)
  }, [cardId])

  useEffect(() => {
    let live = true
    setLoading(true)
    setLoadError('')
    void (async () => {
      try {
        const next = await window.api.knowledge.getCard(cardId)
        const ids = Array.from(new Set(next.sourceIds))
        const found = await Promise.all(
          ids.map((id) => window.api.knowledge.getSource(id).catch(() => null))
        )
        const list = await window.api.knowledge.listRelations(cardId, RELATION_LIMIT)
        if (!live) return
        setCard(next)
        setSources(found.filter((item): item is KnowledgeSource => Boolean(item)))
        setRelations(list)
      } catch (err) {
        if (live) setLoadError(messageOf(err))
      } finally {
        if (live) setLoading(false)
      }
    })()
    return () => { live = false }
  }, [cardId, reload, refreshToken])

  const reloadAll = useCallback(() => setReload((value) => value + 1), [])

  const toggleFavorite = async (next: KnowledgeCard): Promise<void> => {
    setNotice('')
    setSaveError('')
    try {
      await window.api.knowledge.updateCard({ id: next.id, favorite: !next.favorite })
      setNotice(t(next.favorite ? 'knowledge.unfavorited' : 'knowledge.favorited'))
      reloadAll()
      onChanged()
    } catch (err) {
      setSaveError(messageOf(err))
    }
  }

  const save = async (): Promise<void> => {
    if (!card || !draft) return
    setSaving(true)
    setSaveError('')
    setNotice('')
    try {
      await window.api.knowledge.updateCard({
        id: card.id,
        kind: draft.kind,
        title: draft.title.trim(),
        body: draft.body,
        topics: topicsOf(draft.topics)
      })
      setDraft(null)
      setNotice(t('knowledge.saved'))
      reloadAll()
      onChanged()
    } catch (err) {
      setSaveError(messageOf(err))
    } finally {
      setSaving(false)
    }
  }

  const exportCard = async (): Promise<void> => {
    if (!card) return
    setNotice('')
    setSaveError('')
    try {
      const result = await window.api.knowledge.saveExport(card.id)
      setNotice(result.saved ? t('knowledge.exported', { path: result.path }) : t('knowledge.exportCanceled'))
    } catch (err) {
      setSaveError(messageOf(err))
    }
  }

  const removeRelation = async (relationId: string): Promise<void> => {
    setRelationError('')
    try {
      await window.api.knowledge.removeRelation(relationId)
      reloadAll()
      onChanged()
    } catch (err) {
      setRelationError(messageOf(err))
    }
  }

  /**
   * One click, one request, one real answer. Nothing here runs on mount: the
   * three actions are the only path that creates a chat, a todo or a note, and
   * a failure keeps the thrown message instead of a fake success.
   */
  const runAction = async (kind: CardAction['kind'], work: () => Promise<CardAction>): Promise<void> => {
    setRunning(kind)
    setActionError('')
    setActionResult(null)
    try {
      setActionResult(await work())
    } catch (err) {
      setActionError(messageOf(err))
    } finally {
      setRunning('')
    }
  }

  const continueDiscussion = (): Promise<void> =>
    runAction('chat', async () => {
      const { threadId } = await window.api.knowledge.continueDiscussion(cardId)
      return { kind: 'chat', threadId }
    })

  const makeTodo = (): Promise<void> =>
    runAction('todo', async () => {
      const todo = await window.api.knowledge.cardTodo(cardId)
      return { kind: 'todo', id: todo.id, title: todo.title }
    })

  const saveAsNote = (): Promise<void> =>
    runAction('note', async () => {
      const { noteId } = await window.api.knowledge.saveCardAsNote(cardId)
      return { kind: 'note', noteId }
    })

  const openAction = (result: CardAction): void => {
    if (result.kind === 'chat') return onOpenChat(result.threadId)
    if (result.kind === 'note') return onOpenNote(result.noteId)
    // A todo is a reminder, so the record path the app already has opens it.
    openRecord({ kind: 'reminder', id: result.id, title: result.title, text: '', at: 0 })
  }

  const actionText = (result: CardAction): string => {
    if (result.kind === 'chat') return t('knowledge.chatStarted')
    if (result.kind === 'note') return t('knowledge.noteCreated')
    return t('knowledge.todoCreated', { title: result.title })
  }

  if (loading && !card) {
    return <Box sx={{ p: 3 }}><CircularProgress size={22} aria-label={t('common.loading')} /></Box>
  }
  if (!card) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity="error" action={<Button color="inherit" size="small" onClick={reloadAll}>{t('common.retry')}</Button>}>{loadError || t('knowledge.detailEmpty')}</Alert>
      </Box>
    )
  }

  const grouped = groupRelations(relations)
  const known = new Set(sources.map((item) => item.id))
  const missing = card.sourceIds.filter((id) => !known.has(id))
  const relationRow = (row: (typeof relations.items)[number]): JSX.Element => (
    <Stack key={row.id} direction="row" spacing={1} alignItems="center" sx={{ py: 0.5 }}>
      <Chip size="small" label={t(relationKey(row.kind as RelationKind))} />
      <Button size="small" sx={{ flex: 1, minWidth: 0, justifyContent: 'flex-start', textTransform: 'none' }} onClick={() => onSelect(row.card.id)}>
        {row.card.title}
      </Button>
      <Tooltip title={t('knowledge.relationRemove')}>
        <IconButton size="small" aria-label={t('knowledge.relationRemove')} onClick={() => void removeRelation(row.id)}>
          <DeleteOutlineRounded fontSize="small" />
        </IconButton>
      </Tooltip>
    </Stack>
  )

  return (
    <Box data-knowledge-detail sx={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ flex: '0 0 auto', px: 2, pt: 1.5, pb: 1, borderBottom: 1, borderColor: 'divider' }}>
        <Stack direction="row" spacing={0.5} alignItems="center" sx={{ minWidth: 0 }}>
          {!wide && (
            <Tooltip title={t('knowledge.back')}>
              <IconButton size="small" aria-label={t('knowledge.back')} onClick={onBack}><ArrowBackRounded fontSize="small" /></IconButton>
            </Tooltip>
          )}
          <Typography variant="subtitle1" component="h2" sx={{ flex: 1, minWidth: 0, fontWeight: 600 }} noWrap>{draft?.title || card.title}</Typography>
          <Tooltip title={t(card.favorite ? 'knowledge.unfavorite' : 'knowledge.favorite')}>
            <IconButton size="small" aria-label={t('knowledge.favorite')} aria-pressed={card.favorite} onClick={() => void toggleFavorite(card)}>
              {card.favorite ? <StarRounded fontSize="small" color="warning" /> : <StarBorderRounded fontSize="small" />}
            </IconButton>
          </Tooltip>
          <Tooltip title={t('knowledge.edit')}>
            <span>
              <IconButton size="small" aria-label={t('knowledge.edit')} disabled={Boolean(draft)} onClick={() => setDraft(draftOf(card))}>
                <ModeEditOutlineRounded fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title={t('knowledge.suggestions')}>
            <IconButton size="small" aria-label={t('knowledge.suggestions')} onClick={() => setDialog('suggestions')}>
              <TipsAndUpdatesRounded fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title={t('knowledge.revisions')}>
            <IconButton size="small" aria-label={t('knowledge.revisions')} onClick={() => setDialog('revisions')}>
              <HistoryRounded fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title={t('knowledge.mergeTitle')}>
            <IconButton size="small" aria-label={t('knowledge.mergeTitle')} onClick={() => setDialog('merge')}>
              <MergeTypeRounded fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title={t('knowledge.export')}>
            <IconButton size="small" aria-label={t('knowledge.export')} onClick={() => void exportCard()}>
              <FileDownloadRounded fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title={t('knowledge.delete')}>
            <IconButton size="small" aria-label={t('knowledge.delete')} onClick={() => setDialog('delete')}>
              <DeleteOutlineRounded fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mt: 0.5, flexWrap: 'wrap' }}>
          <Chip size="small" label={t(kindKey(card.kind))} />
          <Chip size="small" variant="outlined" label={t('knowledge.revision', { revision: card.revision })} />
          {card.edited && <Chip size="small" variant="outlined" label={t('knowledge.edited')} />}
          <Typography variant="caption" color="text.secondary">{formatStamp(card.updatedAt).full}</Typography>
        </Stack>
        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mt: 0.75, flexWrap: 'wrap', gap: 0.75 }} data-knowledge-actions>
          <Button size="small" startIcon={<ForumRounded fontSize="small" />} disabled={running !== ''} onClick={() => void continueDiscussion()}>
            {t('knowledge.continueDiscussion')}
          </Button>
          <Button size="small" startIcon={<PlaylistAddRounded fontSize="small" />} disabled={running !== ''} onClick={() => void makeTodo()}>
            {t('knowledge.makeTodo')}
          </Button>
          <Button size="small" startIcon={<NoteAddOutlined fontSize="small" />} disabled={running !== ''} onClick={() => void saveAsNote()}>
            {t('knowledge.saveAsNote')}
          </Button>
          {running !== '' && <CircularProgress size={14} aria-label={t('common.loading')} />}
        </Stack>
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', px: 2, py: 1.5 }}>
        {loadError && <Alert severity="error" sx={{ mb: 1 }} action={<Button color="inherit" size="small" onClick={reloadAll}>{t('common.retry')}</Button>}>{loadError}</Alert>}
        {notice && <Alert severity="success" sx={{ mb: 1 }} onClose={() => setNotice('')}>{notice}</Alert>}
        {saveError && (
          <Alert severity="error" sx={{ mb: 1 }} action={draft ? <Button color="inherit" size="small" onClick={() => void save()}>{t('common.retry')}</Button> : undefined}>
            {saveError}
          </Alert>
        )}
        {actionError && (
          <Alert severity="error" sx={{ mb: 1 }} onClose={() => setActionError('')}>{actionError}</Alert>
        )}
        {actionResult && (
          <Alert
            severity="success"
            sx={{ mb: 1 }}
            onClose={() => setActionResult(null)}
            action={<Button color="inherit" size="small" onClick={() => openAction(actionResult)}>{t('knowledge.actionOpen')}</Button>}
          >
            {actionText(actionResult)}
          </Alert>
        )}

        {draft ? (
          <Stack spacing={1}>
            <TextField size="small" label={t('knowledge.fieldTitle')} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
            <TextField select size="small" label={t('knowledge.fieldKind')} value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as CardKind })}>
              {CARD_KINDS.map((kind) => <MenuItem key={kind} value={kind}>{t(kindKey(kind))}</MenuItem>)}
            </TextField>
            <TextField size="small" label={t('knowledge.fieldTopics')} value={draft.topics} onChange={(event) => setDraft({ ...draft, topics: event.target.value })} />
            <TextField
              size="small"
              label={t('knowledge.fieldBody')}
              value={draft.body}
              onChange={(event) => setDraft({ ...draft, body: event.target.value })}
              multiline
              minRows={12}
            />
            <Stack direction="row" spacing={1}>
              <Button variant="contained" size="small" disabled={saving} onClick={() => void save()}>{t('common.save')}</Button>
              <Button size="small" disabled={saving} onClick={() => { setDraft(null); setSaveError('') }}>{t('common.cancel')}</Button>
            </Stack>
          </Stack>
        ) : (
          <>
            {card.topics.length > 0 && (
              <Stack direction="row" spacing={0.5} sx={{ mb: 1, flexWrap: 'wrap', gap: 0.5 }} data-knowledge-topics>
                {card.topics.map((topic) => (
                  <Chip key={topic} size="small" variant="outlined" label={topic} onClick={() => onPickTopic(topic)} />
                ))}
              </Stack>
            )}
            <Box data-knowledge-body sx={{ ...noteMarkdownSx }}>
              {card.body
                ? <NoteMarkdownBody text={card.body} noteId={card.id} onAttachment={() => undefined} />
                : <Typography variant="body2" color="text.secondary">{card.summary}</Typography>}
            </Box>

            <Divider sx={{ my: 1.5 }} />
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>{t('knowledge.sourcesTitle')}</Typography>
            {sources.length === 0 && missing.length === 0 && (
              <Typography variant="caption" color="text.secondary">{t('knowledge.sourcesEmpty')}</Typography>
            )}
            {sources.map((source) => (
              <SourceRow key={source.id} source={source} openRecord={openRecord} />
            ))}
            {missing.map((id) => (
              <Box key={id} sx={{ py: 0.75, borderBottom: 1, borderColor: 'divider' }}>
                <Stack direction="row" spacing={0.75} alignItems="center">
                  <Chip size="small" color="warning" variant="outlined" label={t('knowledge.sourceMissing')} />
                  <Typography variant="caption" sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}>{id}</Typography>
                </Stack>
              </Box>
            ))}

            <Divider sx={{ my: 1.5 }} />
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
              <Typography variant="subtitle2" sx={{ flex: 1 }}>{t('knowledge.relationsTitle')}</Typography>
              <Button size="small" startIcon={<AddRounded fontSize="small" />} onClick={() => setDialog('relation')}>{t('knowledge.relationAdd')}</Button>
            </Stack>
            {relationError && <Alert severity="error" sx={{ mb: 1 }}>{relationError}</Alert>}
            {grouped.total === 0 && <Typography variant="caption" color="text.secondary">{t('knowledge.relationEmpty')}</Typography>}
            {grouped.out.length > 0 && <Typography variant="caption" color="text.secondary">{t('knowledge.outgoing')}</Typography>}
            {grouped.out.map(relationRow)}
            {grouped.in.length > 0 && <Typography variant="caption" color="text.secondary">{t('knowledge.incoming')}</Typography>}
            {grouped.in.map(relationRow)}
          </>
        )}
      </Box>

      <DeleteCardDialog
        card={card}
        relations={relations.total}
        open={dialog === 'delete'}
        onClose={() => setDialog('')}
        onDeleted={() => { setDialog(''); onDeleted() }}
      />
      <RevisionsDialog cardId={card.id} open={dialog === 'revisions'} onClose={() => setDialog('')} />
      <SuggestionsDialog
        cardId={card.id}
        cardRevision={card.revision}
        open={dialog === 'suggestions'}
        onClose={() => setDialog('')}
        onAccepted={reloadAll}
      />
      <MergeDialog keep={card} open={dialog === 'merge'} onClose={() => setDialog('')} onMerged={(title) => { setDialog(''); setNotice(t('knowledge.merged', { title })); onChanged() }} />
      <RelationDialog from={card} open={dialog === 'relation'} onClose={() => setDialog('')} onAdded={() => { setDialog(''); reloadAll(); onChanged() }} />
    </Box>
  )
}
