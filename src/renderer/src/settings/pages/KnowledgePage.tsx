import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Card,
  CardActionArea,
  Chip,
  CircularProgress,
  Dialog,
  IconButton,
  InputBase,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import PersonOutlineRounded from '@mui/icons-material/PersonOutlineRounded'
import SearchRounded from '@mui/icons-material/SearchRounded'
import StarBorderRounded from '@mui/icons-material/StarBorderRounded'
import StarRounded from '@mui/icons-material/StarRounded'
import TuneRounded from '@mui/icons-material/TuneRounded'
import { useTranslation } from 'react-i18next'
import type { CardKind, KnowledgeCardSummary } from '@shared/knowledge'
import type { Settings } from '@shared/types'
import type { LocalRecord } from '@shared/workspace'
import { formatStamp } from './notesView'
import {
  CARD_KINDS,
  EMPTY_FILTERS,
  EMPTY_LIST,
  GRID_TWO_WIDTH,
  cardRequest,
  cardTopics,
  createGate,
  emptyState,
  filtersActive,
  gridColumns,
  kindKey,
  mergePage,
  type CardFilters,
  type CardList
} from './knowledgeView'
import { KnowledgeCardDetail } from '../sections/KnowledgeCardDetail'
import { KnowledgeProfilePanel } from '../sections/KnowledgeProfilePanel'
import { KnowledgeSettingsDialog } from '../sections/KnowledgeSettingsDialog'

/**
 * Both canvases are a heavy dependency, so they only load when a view asks for
 * them: the full graph when it is opened, the preview once it is near the view.
 */
const KnowledgeGraphPage = lazy(() => import('./KnowledgeGraphPage').then((module) => ({ default: module.KnowledgeGraphPage })))
const KnowledgeGraphPreview = lazy(() => import('./KnowledgeGraphPreview').then((module) => ({ default: module.KnowledgeGraphPreview })))

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const SEARCH_DEBOUNCE_MS = 160

/** How close the graph section has to get before its chunk is worth loading. */
const GRAPH_PREVIEW_MARGIN = '600px'

interface Props {
  settings: Settings
  patch: (delta: Partial<Settings>) => void
  openRecord: (record: LocalRecord) => void
  /** A card another page asked to open; the dialog loads it by id, filter or not. */
  focusCardId?: string
  onOpenChat: (threadId: string) => void
  onOpenNote: (noteId: string) => void
}

/**
 * The library as one scrolling column: the title and its filters, a look at the
 * graph, then the cards themselves. Nothing is selected by default — the detail
 * is a dialog opened by a card, a node or another page, so the browser stays a
 * browser and closing the dialog puts the user back where they were.
 */
export function KnowledgePage({ settings, patch, openRecord, focusCardId, onOpenChat, onOpenNote }: Props): JSX.Element {
  const { t } = useTranslation()
  const [view, setView] = useState<'browse' | 'graph'>('browse')
  const [filters, setFilters] = useState<CardFilters>(EMPTY_FILTERS)
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [list, setList] = useState<CardList>(EMPTY_LIST)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [detailId, setDetailId] = useState<string | null>(null)
  const [detailToken, setDetailToken] = useState(0)
  const [reload, setReload] = useState(0)
  const [topics, setTopics] = useState<string[]>([])
  const [dialog, setDialog] = useState('')
  const [graphMounted, setGraphMounted] = useState(false)
  /** The preview's keyboard list, kept here so a graph round trip keeps it. */
  const [nodesOpen, setNodesOpen] = useState(false)
  /** Bumped by card changes, which are also graph changes. */
  const [cardsToken, setCardsToken] = useState(0)
  /** Width the page itself got, which is what decides the column count. */
  const [available, setAvailable] = useState(0)
  const gate = useRef(createGate())
  const measure = useRef<ResizeObserver | null>(null)
  const scrollBox = useRef<HTMLElement | null>(null)
  const scrollTop = useRef(0)
  /** The control that opened the dialog, so focus goes back to it on close. */
  const opener = useRef<HTMLElement | null>(null)
  /** Where the browse page stood before the full graph took over. */
  const pendingScroll = useRef<number | null>(null)
  const graphSlot = useRef<HTMLElement | null>(null)
  const columns = gridColumns(available)
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

  // The list follows the filter, not the view: coming back from the graph keeps
  // the pages already loaded instead of refetching page 0 under the reader.
  useEffect(() => {
    void fetchPage(0, active)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, reload, fetchPage])

  // A card change is a graph change too: a deleted node must leave the canvas
  // and the keyboard list, and a new card or a relation has to appear without
  // leaving the page. The preview takes the same real topic and query back.
  useEffect(() => {
    const off = window.api.knowledge.onChanged((scope) => {
      if (scope !== 'cards') return
      void fetchPage(0, active)
      setCardsToken((value) => value + 1)
      if (detailId) setDetailToken((value) => value + 1)
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, detailId, fetchPage])

  /**
   * The graph chunk is worth loading only when the section is close to the
   * viewport: the browsing page is useful without it, and a user who came for a
   * card should not pay for a canvas they never scroll to.
   */
  useEffect(() => {
    if (view !== 'browse' || graphMounted) return
    const node = graphSlot.current
    if (!node) return
    const observer = new IntersectionObserver(
      (entries) => { if (entries.some((entry) => entry.isIntersecting)) setGraphMounted(true) },
      { rootMargin: GRAPH_PREVIEW_MARGIN }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [view, graphMounted])

  const restore = (): void => {
    const box = scrollBox.current
    if (box) box.scrollTop = scrollTop.current
    // The card that opened the detail can be gone by the time it closes (it was
    // deleted, or a filter moved it). Then focus goes to the page itself rather
    // than the document body, so Tab continues inside the grid.
    const start = opener.current
    if (start && start.isConnected) start.focus()
    else box?.focus()
  }

  const openCard = (id: string): void => {
    if (scrollBox.current) scrollTop.current = scrollBox.current.scrollTop
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setDetailId(id)
  }

  const closeCard = (): void => {
    setDetailId(null)
    window.requestAnimationFrame(restore)
  }

  /**
   * The graph replaces the browse page, so coming back rebuilds it. The scroll
   * offset is remembered here and put back once the rebuilt page is mounted,
   * the same way closing a detail puts it back.
   */
  const backToBrowse = (id?: string): void => {
    setView('browse')
    if (id) setDetailId(id)
  }

  useEffect(() => {
    if (view !== 'browse') return
    const pending = pendingScroll.current
    if (pending === null) return
    scrollTop.current = pending
    // The rebuilt grid finishes reflowing a few frames after the switch, and a
    // write made before that lands on a shorter page and gets clamped. Keep
    // asking until the position sticks, then stop.
    let tries = 0
    let frame = 0
    const write = (): void => {
      const box = scrollBox.current
      if (!box) return void (pendingScroll.current = null)
      box.scrollTop = pending
      if (box.scrollTop === pending) return void (pendingScroll.current = null)
      if (++tries >= 20) return void (pendingScroll.current = null)
      frame = window.requestAnimationFrame(write)
    }
    frame = window.requestAnimationFrame(write)
    return () => { window.cancelAnimationFrame(frame) }
  }, [view])

  /**
   * A card another page asked for — a chat citation, a note section, a floating
   * answer. It opens straight away and is loaded by id, so a card outside the
   * current filter (or one that has been deleted) reports its own real state
   * instead of being silently dropped from the grid.
   */
  useEffect(() => {
    if (!focusCardId) return
    setView('browse')
    setDetailId(focusCardId)
  }, [focusCardId])

  const empty = emptyState({ shown: list.items.length, filters: active })
  const filtering = filtersActive(active)
  const clearFilters = (): void => { setQuery(''); setFilters(EMPTY_FILTERS) }

  if (view === 'graph') {
    return (
      <Suspense fallback={<Box sx={{ height: '100%', display: 'grid', placeItems: 'center' }}><CircularProgress size={22} aria-label={t('common.loading')} /></Box>}>
        <KnowledgeGraphPage
          initialTopic={active.topic}
          initialQuery={active.query}
          onBack={() => backToBrowse()}
          onOpenCard={(id) => backToBrowse(id)}
        />
      </Suspense>
    )
  }

  const graphSection = (
    <Box
      data-knowledge-graph-section
      sx={{ border: 1, borderColor: 'divider', borderRadius: '16px', p: 2, bgcolor: 'background.paper', minWidth: 0 }}
    >
      <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
        <Typography variant="subtitle2" sx={{ flex: 1, minWidth: 0 }}>{t('knowledge.graphTitle')}</Typography>
        <Button size="small" onClick={() => { pendingScroll.current = scrollBox.current?.scrollTop ?? 0; setView('graph') }} data-knowledge-graph-expand>{t('knowledge.openGraph')}</Button>
      </Stack>
      <Box ref={graphSlot} data-knowledge-graph-slot sx={{ minWidth: 0 }}>
        {graphMounted && (
          <Suspense fallback={<Box sx={{ height: 160, display: 'grid', placeItems: 'center' }}><CircularProgress size={20} aria-label={t('common.loading')} /></Box>}>
            <KnowledgeGraphPreview
              topic={active.topic}
              query={active.query}
              refreshToken={reload + cardsToken}
              onOpenCard={openCard}
              nodesOpen={nodesOpen}
              onToggleNodes={() => setNodesOpen((value) => !value)}
            />
          </Suspense>
        )}
      </Box>
    </Box>
  )

  const cardsSection = (
    <Box data-knowledge-cards sx={{ minWidth: 0 }}>
      <Stack direction="row" spacing={1} alignItems="baseline" sx={{ mb: 1, minWidth: 0 }}>
        <Typography variant="subtitle2">{t('knowledge.cardsTitle')}</Typography>
        <Typography variant="caption" color="text.secondary" data-knowledge-cards-total>
          {t('knowledge.cardsTotal', { total: list.total })}
        </Typography>
      </Stack>
      {error && (
        <Alert severity="error" sx={{ mb: 1.5 }} action={<Button color="inherit" size="small" onClick={() => setReload((value) => value + 1)}>{t('common.retry')}</Button>}>{error}</Alert>
      )}
      {loading && list.items.length === 0 && (
        <Box sx={{ py: 6, display: 'grid', placeItems: 'center' }}><CircularProgress size={22} aria-label={t('common.loading')} /></Box>
      )}
      {!loading && empty === 'library' && (
        <Box sx={{ py: 6 }}>
          <Typography variant="body2" color="text.secondary">{t('knowledge.emptyLibrary')}</Typography>
          <Typography variant="caption" color="text.secondary">{t('knowledge.emptyLibraryHint')}</Typography>
        </Box>
      )}
      {!loading && empty === 'filters' && (
        <Box sx={{ py: 6 }}>
          <Typography variant="body2" color="text.secondary">{t('knowledge.emptyFilters')}</Typography>
          <Button size="small" sx={{ mt: 1 }} onClick={clearFilters}>{t('knowledge.clearFilters')}</Button>
        </Box>
      )}
      <Box
        data-knowledge-grid
        data-knowledge-columns={columns}
        sx={{ display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: 1.5 }}
      >
        {list.items.map((row) => (
          <CardFace key={row.id} row={row} onOpen={openCard} />
        ))}
      </Box>
      {list.nextOffset !== null && (
        <Box sx={{ mt: 1.5 }}>
          <Button size="small" disabled={loading} onClick={() => void fetchPage(list.nextOffset ?? 0, active)} data-knowledge-load-more>
            {t('knowledge.loadMore')}
          </Button>
        </Box>
      )}
    </Box>
  )

  return (
    <Box
      ref={(node: HTMLElement | null) => {
        attachPage(node)
        scrollBox.current = node
      }}
      data-knowledge-page
      // Focusable so closing a detail whose card is gone can hand focus back to
      // the page instead of the document body.
      tabIndex={-1}
      sx={{ height: '100%', minHeight: 0, overflow: 'auto', outline: 'none' }}
      onScroll={(event) => { scrollTop.current = event.currentTarget.scrollTop }}
    >
      <Box sx={{ maxWidth: 1180, mx: 'auto', px: { xs: 2, lg: 4 }, py: 2.5, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Box data-knowledge-toolbar sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography component="h1" variant="h5" sx={{ fontWeight: 600 }}>{t('knowledge.title')}</Typography>
            <Chip size="small" label={list.total} data-knowledge-total />
            <Box sx={{ flex: 1 }} />
            <Tooltip title={t('knowledge.profileTitle')}>
              <IconButton size="small" aria-label={t('knowledge.profileTitle')} onClick={() => setDialog('profile')}><PersonOutlineRounded fontSize="small" /></IconButton>
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
            {filtering && <Button size="small" onClick={clearFilters}>{t('knowledge.clearFilters')}</Button>}
          </Box>
        </Box>

        {/* A search or a filter is a card question, so the results come first. */}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, order: 0 }}>
          {filtering ? (
            <>
              {cardsSection}
              {graphSection}
            </>
          ) : (
            <>
              {graphSection}
              {cardsSection}
            </>
          )}
        </Box>
      </Box>

      <Dialog
        open={detailId !== null}
        onClose={closeCard}
        maxWidth="md"
        fullWidth
        fullScreen={available < GRID_TWO_WIDTH}
        PaperProps={{
          'data-knowledge-detail-dialog': '',
          sx: { height: available < GRID_TWO_WIDTH ? '100%' : 'min(86vh, 880px)', display: 'flex', flexDirection: 'column' }
        }}
      >
        {detailId !== null && (
          <KnowledgeCardDetail
            cardId={detailId}
            wide={false}
            closeLabel={t('common.close')}
            refreshToken={detailToken}
            onChanged={() => { void fetchPage(0, active) }}
            onSelect={(id) => setDetailId(id)}
            openRecord={openRecord}
            onOpenChat={onOpenChat}
            onOpenNote={onOpenNote}
            onPickTopic={(topic) => { closeCard(); setFilters({ ...filters, topic }) }}
            onBack={closeCard}
            onDeleted={() => { setDetailId(null); setReload((value) => value + 1) }}
          />
        )}
      </Dialog>

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

/**
 * One card as a face of the grid: title, a readable summary, a few topics and a
 * light footer. The whole face is the button, so the keyboard path is the normal
 * tab order and the focus ring is the only state it needs.
 */
function CardFace({ row, onOpen }: { row: KnowledgeCardSummary; onOpen: (id: string) => void }): JSX.Element {
  const { t } = useTranslation()
  const topics = cardTopics(row.topics)
  return (
    <Card variant="outlined" data-knowledge-card={row.id} sx={{ minWidth: 0, height: '100%', bgcolor: 'background.paper' }}>
      <CardActionArea
        onClick={() => onOpen(row.id)}
        aria-label={row.title}
        data-knowledge-card-open={row.id}
        sx={{ height: '100%', p: 1.75, display: 'flex', flexDirection: 'column', alignItems: 'stretch', justifyContent: 'flex-start' }}
      >
        <Typography
          variant="subtitle1"
          component="h2"
          sx={{ fontWeight: 600, lineHeight: 1.35, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' }}
        >
          {row.title}
        </Typography>
        {row.summary && (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ mt: 0.5, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' }}
          >
            {row.summary}
          </Typography>
        )}
        {topics.shown.length > 0 && (
          <Stack direction="row" sx={{ mt: 1, flexWrap: 'wrap', gap: 0.5 }}>
            {topics.shown.map((topic) => (
              <Chip key={topic} size="small" variant="outlined" label={topic} sx={{ maxWidth: 160 }} />
            ))}
            {topics.rest > 0 && <Chip size="small" variant="outlined" label={`+${topics.rest}`} />}
          </Stack>
        )}
        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mt: 'auto', pt: 1.25, minWidth: 0 }}>
          <Typography variant="caption" color="text.secondary" noWrap>{t(kindKey(row.kind))}</Typography>
          <Typography variant="caption" color="text.secondary" noWrap>· {formatStamp(row.updatedAt).day}</Typography>
          {row.edited && <Typography variant="caption" color="text.secondary" noWrap>· {t('knowledge.edited')}</Typography>}
          <Box sx={{ flex: 1 }} />
          {row.favorite && <StarRounded sx={{ fontSize: 14 }} color="warning" aria-label={t('knowledge.favorite')} />}
        </Stack>
      </CardActionArea>
    </Card>
  )
}
