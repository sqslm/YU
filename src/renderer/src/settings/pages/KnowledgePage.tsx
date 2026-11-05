import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  InputBase,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import HubRounded from '@mui/icons-material/HubRounded'
import PersonOutlineRounded from '@mui/icons-material/PersonOutlineRounded'
import SearchRounded from '@mui/icons-material/SearchRounded'
import StarBorderRounded from '@mui/icons-material/StarBorderRounded'
import StarRounded from '@mui/icons-material/StarRounded'
import TuneRounded from '@mui/icons-material/TuneRounded'
import { useTranslation } from 'react-i18next'
import type { CardKind } from '@shared/knowledge'
import type { Settings } from '@shared/types'
import type { LocalRecord } from '@shared/workspace'
import { formatStamp } from './notesView'
import {
  CARD_KINDS,
  EMPTY_FILTERS,
  EMPTY_LIST,
  cardRequest,
  createGate,
  emptyState,
  filtersActive,
  kindKey,
  mergePage,
  paneModeFor,
  splitFit,
  type CardFilters,
  type CardList
} from './knowledgeView'
import { KnowledgeCardDetail } from '../sections/KnowledgeCardDetail'
import { KnowledgeProfilePanel } from '../sections/KnowledgeProfilePanel'
import { KnowledgeSettingsDialog } from '../sections/KnowledgeSettingsDialog'

/** The force canvas is a heavy dependency, so it only loads when the view asks for it. */
const KnowledgeGraphPage = lazy(() => import('./KnowledgeGraphPage').then((module) => ({ default: module.KnowledgeGraphPage })))

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const SEARCH_DEBOUNCE_MS = 160

interface Props {
  settings: Settings
  patch: (delta: Partial<Settings>) => void
  openRecord: (record: LocalRecord) => void
}

export function KnowledgePage({ settings, patch, openRecord }: Props): JSX.Element {
  const { t } = useTranslation()
  const [view, setView] = useState<'cards' | 'graph'>('cards')
  const [filters, setFilters] = useState<CardFilters>(EMPTY_FILTERS)
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [list, setList] = useState<CardList>(EMPTY_LIST)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detailToken, setDetailToken] = useState(0)
  const [reload, setReload] = useState(0)
  const [topics, setTopics] = useState<string[]>([])
  const [dialog, setDialog] = useState('')
  /** Width the page itself got, which is what decides the split — not the window. */
  const [available, setAvailable] = useState(0)
  const gate = useRef(createGate())
  const measure = useRef<ResizeObserver | null>(null)
  const scrollBox = useRef<HTMLElement | null>(null)
  const scrollTop = useRef(0)
  const wide = splitFit(available)
  const mode = paneModeFor(available, Boolean(selectedId))
  const attachPage = useCallback((node: HTMLElement | null) => {
    measure.current?.disconnect()
    measure.current = null
    if (!node) return
    const observer = new ResizeObserver(([entry]) => setAvailable(entry.contentRect.width))
    observer.observe(node)
    measure.current = observer
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])

  const active: CardFilters = useMemo(() => ({ ...filters, query: debounced }), [filters, debounced])

  useEffect(() => {
    let live = true
    void window.api.knowledge.listTopics(60).then((result) => { if (live) setTopics(result.topics.map((item) => item.topic)) }).catch(() => undefined)
    return () => { live = false }
  }, [reload])

  const fetchPage = useCallback(async (offset: number, filter: CardFilters): Promise<void> => {
    const ticket = gate.current.next()
    setLoading(true)
    setError('')
    try {
      const request = cardRequest(filter, offset)
      const page = request.search
        ? await window.api.knowledge.searchCards({ ...request.query, query: request.query.query ?? '' })
        : await window.api.knowledge.listCards(request.query)
      if (!gate.current.isCurrent(ticket)) return
      setList((current) => mergePage(offset === 0 ? null : current, page))
    } catch (err) {
      if (gate.current.isCurrent(ticket)) setError(messageOf(err))
    } finally {
      if (gate.current.isCurrent(ticket)) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (view !== 'cards') return
    void fetchPage(0, active)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, reload, view, fetchPage])

  // A filter change drops the narrow-mode detail (master list comes back); wide mode keeps it.
  useEffect(() => {
    if (!wide) setSelectedId(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, wide])

  useEffect(() => {
    const off = window.api.knowledge.onChanged((scope) => {
      if (scope !== 'cards') return
      void fetchPage(0, active)
      if (selectedId) setDetailToken((value) => value + 1)
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, selectedId, fetchPage])

  const restoreScroll = (): void => {
    const box = scrollBox.current
    if (box) box.scrollTop = scrollTop.current
  }

  const select = (id: string): void => {
    setSelectedId(id)
    scrollTop.current = scrollBox.current?.scrollTop ?? 0
  }

  const back = (): void => {
    setSelectedId(null)
    window.requestAnimationFrame(restoreScroll)
  }

  const empty = emptyState({ shown: list.items.length, filters: active })
  const filtering = filtersActive(active)

  if (view === 'graph') {
    return (
      <Suspense fallback={<Box sx={{ height: '100%', display: 'grid', placeItems: 'center' }}><CircularProgress size={22} aria-label={t('common.loading')} /></Box>}>
        <KnowledgeGraphPage
          onBack={() => setView('cards')}
          onOpenCard={(id) => { setView('cards'); setSelectedId(id) }}
        />
      </Suspense>
    )
  }

  const listPane = (
    <Box
      ref={(node: HTMLElement | null) => { scrollBox.current = node }}
      onScroll={(event) => { scrollTop.current = event.currentTarget.scrollTop }}
      sx={{ flex: wide ? '0 0 320px' : '1 1 auto', minWidth: 0, minHeight: 0, overflow: 'auto', borderRight: wide ? 1 : 0, borderColor: 'divider', bgcolor: 'background.default' }}
      data-knowledge-list
    >
      {error && (
        <Alert severity="error" sx={{ m: 1 }} action={<Button color="inherit" size="small" onClick={() => setReload((value) => value + 1)}>{t('common.retry')}</Button>}>{error}</Alert>
      )}
      {loading && list.items.length === 0 && (
        <Box sx={{ p: 3, display: 'grid', placeItems: 'center' }}><CircularProgress size={22} aria-label={t('common.loading')} /></Box>
      )}
      {empty === 'library' && (
        <Box sx={{ p: 3 }}>
          <Typography variant="body2" color="text.secondary">{t('knowledge.emptyLibrary')}</Typography>
          <Typography variant="caption" color="text.secondary">{t('knowledge.emptyLibraryHint')}</Typography>
        </Box>
      )}
      {empty === 'filters' && (
        <Box sx={{ p: 3 }}>
          <Typography variant="body2" color="text.secondary">{t('knowledge.emptyFilters')}</Typography>
          <Button size="small" sx={{ mt: 1 }} onClick={() => { setQuery(''); setFilters(EMPTY_FILTERS) }}>{t('knowledge.clearFilters')}</Button>
        </Box>
      )}
      <List dense disablePadding aria-label={t('knowledge.title')}>
        {list.items.map((row) => (
          <ListItem key={row.id} disablePadding>
            <ListItemButton selected={row.id === selectedId} onClick={() => select(row.id)}>
              <ListItemText
                primary={(
                  <Stack direction="row" spacing={0.5} alignItems="center" sx={{ minWidth: 0 }}>
                    {row.favorite && <StarRounded sx={{ fontSize: 14 }} color="warning" />}
                    <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0 }}>{row.title}</Typography>
                  </Stack>
                )}
                secondary={(
                  <Stack direction="row" spacing={0.5} alignItems="center">
                    <Typography variant="caption" color="text.secondary">{t(kindKey(row.kind))}</Typography>
                    {row.edited && <Typography variant="caption" color="text.secondary">· {t('knowledge.edited')}</Typography>}
                    <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }} noWrap>{formatStamp(row.updatedAt).day}</Typography>
                  </Stack>
                )}
              />
            </ListItemButton>
          </ListItem>
        ))}
      </List>
      {list.nextOffset !== null && (
        <Box sx={{ px: 1.5, py: 1 }}>
          <Button size="small" disabled={loading} onClick={() => void fetchPage(list.nextOffset ?? 0, active)}>{t('knowledge.loadMore')}</Button>
        </Box>
      )}
    </Box>
  )

  return (
    <Box ref={attachPage} data-knowledge-page sx={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <Box data-knowledge-toolbar sx={{ px: { xs: 2, lg: 4 }, pt: 2.5, pb: 2, display: 'flex', flexDirection: 'column', gap: 1.5, flex: '0 0 auto' }}>
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography component="h1" variant="h5" sx={{ fontWeight: 600 }}>{t('knowledge.title')}</Typography>
          <Chip size="small" label={list.total} />
          <Box sx={{ flex: 1 }} />
          <Tooltip title={t('knowledge.profileTitle')}>
            <IconButton size="small" aria-label={t('knowledge.profileTitle')} onClick={() => setDialog('profile')}><PersonOutlineRounded fontSize="small" /></IconButton>
          </Tooltip>
          <Tooltip title={t('knowledge.graphTitle')}>
            <IconButton size="small" aria-label={t('knowledge.graphTitle')} onClick={() => setView('graph')}><HubRounded fontSize="small" /></IconButton>
          </Tooltip>
          <Tooltip title={t('knowledge.settingsTitle')}>
            <IconButton size="small" aria-label={t('knowledge.settingsTitle')} onClick={() => setDialog('settings')}><TuneRounded fontSize="small" /></IconButton>
          </Tooltip>
        </Stack>
        <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, flexWrap: 'wrap', gap: 1, alignItems: { sm: 'center' } }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, border: 1, borderColor: 'divider', borderRadius: 2, px: 1, height: 36, flex: '1 1 220px', minWidth: 120 }}>
            <SearchRounded fontSize="small" sx={{ color: 'text.secondary' }} />
            <InputBase
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('knowledge.searchPlaceholder')}
              inputProps={{ 'aria-label': t('knowledge.searchPlaceholder') }}
              sx={{ flex: 1, minWidth: 0, fontSize: 14 }}
            />
          </Box>
          <TextField
            select
            size="small"
            fullWidth={false}
            label={t('knowledge.topic')}
            value={filters.topic}
            onChange={(event) => setFilters({ ...filters, topic: event.target.value })}
            sx={{ width: { xs: '100%', sm: 152 }, flex: { sm: '0 1 152px' }, minWidth: 0 }}
          >
            <MenuItem value="">{t('knowledge.topicAll')}</MenuItem>
            {topics.map((topic) => <MenuItem key={topic} value={topic}>{topic}</MenuItem>)}
          </TextField>
          <TextField
            select
            size="small"
            fullWidth={false}
            label={t('knowledge.kind')}
            value={filters.kind}
            onChange={(event) => setFilters({ ...filters, kind: event.target.value as CardKind | '' })}
            sx={{ width: { xs: '100%', sm: 132 }, flex: { sm: '0 1 132px' }, minWidth: 0 }}
          >
            <MenuItem value="">{t('knowledge.kindAll')}</MenuItem>
            {CARD_KINDS.map((kind) => <MenuItem key={kind} value={kind}>{t(kindKey(kind))}</MenuItem>)}
          </TextField>
          <Tooltip title={t('knowledge.favoriteOnly')}>
            <IconButton
              size="small"
              aria-label={t('knowledge.favoriteOnly')}
              aria-pressed={filters.favorite}
              onClick={() => setFilters({ ...filters, favorite: !filters.favorite })}
              sx={{ border: 1, borderColor: filters.favorite ? 'warning.main' : 'divider', borderRadius: 2, width: 36, height: 36, flex: '0 0 36px' }}
            >
              {filters.favorite ? <StarRounded fontSize="small" color="warning" /> : <StarBorderRounded fontSize="small" />}
            </IconButton>
          </Tooltip>
          {filtering && <Button size="small" onClick={() => { setQuery(''); setFilters(EMPTY_FILTERS) }}>{t('knowledge.clearFilters')}</Button>}
        </Box>
      </Box>

      <Box
        data-knowledge-workspace
        sx={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden', mx: { xs: 2, lg: 4 }, mb: 2.5, border: 1, borderColor: 'divider', borderRadius: '16px', bgcolor: 'background.paper' }}
      >
        {mode !== 'detail' && listPane}
        {mode !== 'list' && selectedId && (
          <Box sx={{ flex: 1, minWidth: 0, minHeight: 0 }}>
            <KnowledgeCardDetail
              cardId={selectedId}
              wide={wide}
              refreshToken={detailToken}
              onChanged={() => { void fetchPage(0, active) }}
              onSelect={(id) => select(id)}
              openRecord={openRecord}
              onPickTopic={(topic) => setFilters({ ...filters, topic })}
              onBack={back}
              onDeleted={() => { setSelectedId(null); setReload((value) => value + 1) }}
            />
          </Box>
        )}
        {selectedId === null && wide && (
          <Box sx={{ flex: 1, minWidth: 0, display: 'grid', placeItems: 'center', p: 4 }}>
            <Box sx={{ textAlign: 'center' }}>
              <Typography variant="body2" color="text.secondary">{t('knowledge.detailEmpty')}</Typography>
              <Typography variant="caption" color="text.secondary">{t('knowledge.detailEmptyHint')}</Typography>
            </Box>
          </Box>
        )}
      </Box>

      <KnowledgeSettingsDialog settings={settings} patch={patch} open={dialog === 'settings'} onClose={() => setDialog('')} />
      <KnowledgeProfilePanel
        settings={settings}
        patch={patch}
        open={dialog === 'profile'}
        onClose={() => setDialog('')}
        openRecord={openRecord}
      />
    </Box>
  )
}
