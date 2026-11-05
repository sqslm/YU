import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
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
  Typography,
  useTheme
} from '@mui/material'
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded'
import CenterFocusStrongRounded from '@mui/icons-material/CenterFocusStrongRounded'
import HubRounded from '@mui/icons-material/HubRounded'
import OpenInNewRounded from '@mui/icons-material/OpenInNewRounded'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import SearchRounded from '@mui/icons-material/SearchRounded'
import ForceGraph2D, { type ForceGraphMethods } from 'react-force-graph-2d'
import { useTranslation } from 'react-i18next'
import { KNOWLEDGE_LIMITS } from '@shared/knowledge'
import type { CardKind, KnowledgeGraph, RelationKind } from '@shared/knowledge'
import { dampenNodeDrag } from '../sections/memoryGraphDrag'
import { acceptGraph, createGate, graphView, kindKey, relationKey, splitFit, type ForceNode } from './knowledgeView'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const SEARCH_DEBOUNCE_MS = 200

/** Node colours follow the card kinds, so the canvas and the lists agree. */
function kindColor(kind: CardKind, dark: boolean): string {
  const palette: Record<CardKind, [string, string]> = {
    concept: ['#286fc1', '#8bbdff'],
    method: ['#1f8a5f', '#7fd6ae'],
    question: ['#9a6b13', '#e0be79'],
    decision: ['#8b4ca5', '#d4a8ed'],
    comparison: ['#0f7d8c', '#79d6e2'],
    reading: ['#b0552f', '#f0a986'],
    review: ['#5b6474', '#aeb8c8']
  }
  return dark ? palette[kind][1] : palette[kind][0]
}

interface Props {
  onOpenCard: (id: string) => void
  onBack: () => void
}

/**
 * The knowledge graph. Its own data and selection — nothing here reads Mem0.
 * Every expansion is a backend question; the canvas never invents nodes, and it
 * draws exactly the newest answer rather than unioning the previous hop in.
 */
export function KnowledgeGraphPage({ onOpenCard, onBack }: Props): JSX.Element {
  const { t } = useTranslation()
  const theme = useTheme()
  const dark = theme.palette.mode === 'dark'
  const [topic, setTopic] = useState('')
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [data, setData] = useState<KnowledgeGraph | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [hop, setHop] = useState(1)
  const [size, setSize] = useState({ width: 600, height: 420 })
  /** The page's own width decides the column layout; the window is a guess. */
  const [available, setAvailable] = useState(0)
  const [topics, setTopics] = useState<string[]>([])
  const container = useRef<HTMLDivElement>(null)
  const measure = useRef<ResizeObserver | null>(null)
  /** Only the newest graph answer may write; a superseded request takes a stale ticket. */
  const gate = useRef(createGate())
  const graph = useRef<ForceGraphMethods<ForceNode>>()
  const fitted = useRef(false)
  const dragOrigin = useRef<{ x: number; y: number } | null>(null)
  const resetKey = useRef('')
  const wide = splitFit(available)
  const attachPage = useCallback((node: HTMLElement | null) => {
    measure.current?.disconnect()
    measure.current = null
    if (!node) return
    const observer = new ResizeObserver(([entry]) => setAvailable(entry.contentRect.width))
    observer.observe(node)
    measure.current = observer
  }, [])

  // Cards changing underneath → refetch. Nothing is polled; the subscription lives with the view.
  useEffect(() => window.api.knowledge.onChanged((scope) => {
    if (scope === 'cards') setRefresh((value) => value + 1)
  }), [])

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])

  useEffect(() => {
    let live = true
    void window.api.knowledge
      .listTopics(60)
      .then((result) => { if (live) setTopics(result.topics.map((item) => item.topic)) })
      .catch(() => undefined)
    return () => { live = false }
  }, [refresh])

  useEffect(() => {
    setLoading(true)
    setError('')
    const key = `${topic}\u0000${debounced}\u0000${refresh}`
    const sameScope = resetKey.current === key
    resetKey.current = key
    if (!sameScope) fitted.current = false
    // A scope change drops the old canvas; a focus change keeps it while the hop loads.
    setData((current) => (sameScope ? current : null))
    const ticket = gate.current.next()
    void window.api.knowledge
      .graph({
        topic: topic || undefined,
        query: debounced || undefined,
        focusId: focusId ?? undefined,
        depth: focusId ? hop : undefined,
        limit: KNOWLEDGE_LIMITS.nodes
      })
      .then((result) => { setData((current) => acceptGraph(gate.current, ticket, result, current)) })
      .catch((err) => { if (gate.current.isCurrent(ticket)) setError(messageOf(err)) })
      .finally(() => { if (gate.current.isCurrent(ticket)) setLoading(false) })
    // Leaving the selection invalidates whatever is still in flight for it.
    return () => { gate.current.next() }
  }, [topic, debounced, focusId, hop, refresh])

  useEffect(() => {
    if (!container.current) return
    const observer = new ResizeObserver(([entry]) => setSize({ width: Math.max(1, entry.contentRect.width), height: Math.max(1, entry.contentRect.height) }))
    observer.observe(container.current)
    return () => observer.disconnect()
  }, [])

  /** One answer, one collection: the canvas, the list and the counts read this. */
  const view = useMemo(() => graphView(data), [data])
  const force = useMemo(() => ({ nodes: view.nodes, links: view.links }), [view])

  useEffect(() => {
    if (loading) return
    graph.current?.d3Force('link')?.distance(110)
    graph.current?.d3Force('charge')?.strength(-160)
    graph.current?.d3ReheatSimulation()
  }, [force, loading])

  const notice = view.notice
  const counts = view.counts
  const node = data?.nodes.find((row) => row.id === selected) ?? null
  const neighbours = useMemo(() => {
    if (!data || !selected) return []
    return data.edges
      .filter((edge) => edge.fromId === selected || edge.toId === selected)
      .map((edge) => ({
        edge,
        direction: edge.fromId === selected ? ('out' as const) : ('in' as const),
        card: data.nodes.find((row) => row.id === (edge.fromId === selected ? edge.toId : edge.fromId))
      }))
      .filter((row): row is { edge: (typeof data.edges)[number]; direction: 'out' | 'in'; card: (typeof data.nodes)[number] } => Boolean(row.card))
  }, [data, selected])

  const focusNode = (id: string): void => {
    setSelected(id)
    setFocusId(id)
    setHop((value) => (focusId === id ? value : 1))
  }

  const expand = (): void => {
    if (!selected) return
    setFocusId(selected)
    setHop((value) => Math.min(3, focusId === selected ? value + 1 : 1))
  }

  const reset = (): void => {
    setSelected(null)
    setFocusId(null)
    setHop(1)
    setRefresh((value) => value + 1)
  }

  return (
    <Box ref={attachPage} data-knowledge-graph sx={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ flex: '0 0 auto', px: { xs: 2, lg: 4 }, pt: 2, pb: 1.5, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <Stack direction="row" spacing={1} alignItems="center">
          <Tooltip title={t('knowledge.graphBack')}>
            <IconButton size="small" aria-label={t('knowledge.graphBack')} onClick={onBack}><ArrowBackRounded fontSize="small" /></IconButton>
          </Tooltip>
          <HubRounded fontSize="small" />
          <Typography component="h1" variant="h6" sx={{ fontWeight: 600 }}>{t('knowledge.graphTitle')}</Typography>
          <Box sx={{ flex: 1 }} />
          <Tooltip title={t('knowledge.graphFit')}>
            <span>
              <IconButton size="small" aria-label={t('knowledge.graphFit')} disabled={view.nodes.length === 0} onClick={() => graph.current?.zoomToFit(300, 40)}>
                <CenterFocusStrongRounded fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title={t('knowledge.graphRefresh')}>
            <IconButton size="small" aria-label={t('knowledge.graphRefresh')} onClick={reset}><RefreshRounded fontSize="small" /></IconButton>
          </Tooltip>
        </Stack>
        <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, flexWrap: 'wrap', gap: 1, alignItems: { sm: 'center' } }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, border: 1, borderColor: 'divider', borderRadius: 2, px: 1, height: 36, flex: '1 1 200px', minWidth: 120 }}>
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
            label={t('knowledge.graphTopic')}
            value={topic}
            onChange={(event) => { setTopic(event.target.value); setSelected(null); setFocusId(null) }}
            sx={{ width: { xs: '100%', sm: 152 }, flex: { sm: '0 1 152px' }, minWidth: 0 }}
          >
            <MenuItem value="">{t('knowledge.topicAll')}</MenuItem>
            {topics.map((item) => <MenuItem key={item} value={item}>{item}</MenuItem>)}
          </TextField>
          <Button size="small" variant="outlined" disabled={!selected} onClick={expand}>{t('knowledge.graphExpand')}</Button>
          {notice && (
            <Chip
              size="small"
              color="warning"
              variant="outlined"
              label={notice.limitedBy === 'bytes'
                ? t('knowledge.graphLimitedBytes', { matched: notice.matched, total: notice.total })
                : t('knowledge.graphLimitedNodes', { matched: notice.matched, total: notice.total })}
            />
          )}
        </Box>
      </Box>

      {error && (
        <Box sx={{ px: { xs: 2, lg: 4 }, pb: 1 }}>
          <Alert severity="error" action={<Button color="inherit" size="small" onClick={() => setRefresh((value) => value + 1)}>{t('common.retry')}</Button>}>{error}</Alert>
        </Box>
      )}

      <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: wide ? 'row' : 'column', gap: 1.5, px: { xs: 2, lg: 4 }, pb: 2 }}>
        <Box
          ref={container}
          data-knowledge-canvas
          sx={{ flex: 1, minHeight: 220, position: 'relative', border: 1, borderColor: 'divider', borderRadius: '16px', overflow: 'hidden', bgcolor: dark ? '#181b20' : '#f6f8fb' }}
        >
          {view.nodes.length > 0 && (
            <ForceGraph2D<ForceNode>
              ref={graph}
              graphData={force}
              width={size.width}
              height={size.height}
              backgroundColor={dark ? '#181b20' : '#f6f8fb'}
              nodeLabel={() => ''}
              nodeRelSize={4}
              cooldownTicks={80}
              d3VelocityDecay={0.5}
              linkColor={() => (dark ? 'rgba(255,255,255,.18)' : 'rgba(20,26,35,.16)')}
              linkWidth={(link) => (link.source === selected || link.target === selected ? 1.6 : 0.7)}
              nodeColor={(item) => kindColor(item.kind, dark)}
              nodeVal={(item) => (item.id === selected ? 9 : 4)}
              onNodeClick={(item) => onOpenCard(item.id)}
              onNodeDrag={(item) => {
                if (!dragOrigin.current) dragOrigin.current = { x: item.x ?? 0, y: item.y ?? 0 }
                dampenNodeDrag(item, dragOrigin.current)
              }}
              onNodeDragEnd={(item) => { item.fx = undefined; item.fy = undefined; dragOrigin.current = null }}
              nodeCanvasObjectMode={() => 'after'}
              nodeCanvasObject={(item, context, scale) => {
                const label = item.title.length > 22 ? `${item.title.slice(0, 21)}…` : item.title
                if (scale < 0.9 && item.id !== selected) return
                context.font = `${10 / scale}px system-ui, sans-serif`
                context.textAlign = 'center'
                context.textBaseline = 'top'
                context.fillStyle = dark ? 'rgba(232,238,246,.86)' : 'rgba(24,32,44,.82)'
                context.fillText(label, item.x ?? 0, (item.y ?? 0) + 6 / scale)
              }}
              onEngineStop={() => {
                if (fitted.current) return
                fitted.current = true
                graph.current?.zoomToFit(250, 45)
              }}
            />
          )}
          {loading && !data && (
            <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
              <CircularProgress size={22} aria-label={t('common.loading')} />
            </Box>
          )}
          {view.nodes.length === 0 && !loading && (
            <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', p: 3, textAlign: 'center' }}>
              <Typography variant="body2" color="text.secondary">{t('knowledge.graphEmpty')}</Typography>
            </Box>
          )}
        </Box>

        <Box
          data-knowledge-graph-list
          sx={{ flex: wide ? '0 0 300px' : '0 0 auto', maxHeight: wide ? 'none' : 260, minHeight: 0, display: 'flex', flexDirection: 'column', border: 1, borderColor: 'divider', borderRadius: '16px', bgcolor: 'background.paper', overflow: 'hidden' }}
        >
          <Box sx={{ px: 1.5, py: 1, borderBottom: 1, borderColor: 'divider' }}>
            <Typography variant="subtitle2">{t('knowledge.graphList')}</Typography>
            <Typography variant="caption" color="text.secondary">
              {t('knowledge.graphCounts', { matched: counts.matched, total: counts.total })}
              {counts.expanded > 0 ? ` · ${t('knowledge.graphExpanded', { count: counts.expanded })}` : ''}
            </Typography>
          </Box>
          <List dense sx={{ flex: 1, minHeight: 0, overflow: 'auto' }} aria-label={t('knowledge.graphList')}>
            {view.nodes.map((row) => (
              <ListItem key={row.id} disablePadding secondaryAction={
                <Tooltip title={t('knowledge.open')}>
                  <IconButton edge="end" size="small" aria-label={`${t('knowledge.open')} ${row.title}`} onClick={() => onOpenCard(row.id)}>
                    <OpenInNewRounded fontSize="small" />
                  </IconButton>
                </Tooltip>
              }>
                <ListItemButton selected={row.id === selected} onClick={() => focusNode(row.id)}>
                  <ListItemText
                    primary={row.title}
                    secondary={t(kindKey(row.kind))}
                    primaryTypographyProps={{ noWrap: true, variant: 'body2' }}
                    secondaryTypographyProps={{ variant: 'caption' }}
                  />
                </ListItemButton>
              </ListItem>
            ))}
          </List>
          {node && (
            <>
              <Divider />
              <Box sx={{ px: 1.5, py: 1, maxHeight: 180, overflow: 'auto' }}>
                <Typography variant="caption" color="text.secondary">{t('knowledge.graphNeighbours')}</Typography>
                {neighbours.length === 0 && <Typography variant="caption" color="text.secondary" display="block">{t('knowledge.relationEmpty')}</Typography>}
                {neighbours.map((row) => (
                  <Stack key={row.edge.id} direction="row" spacing={0.5} alignItems="center">
                    <Chip size="small" label={t(relationKey(row.edge.kind as RelationKind))} />
                    <Button size="small" sx={{ flex: 1, minWidth: 0, justifyContent: 'flex-start', textTransform: 'none' }} onClick={() => onOpenCard(row.card.id)}>
                      {row.card.title}
                    </Button>
                  </Stack>
                ))}
              </Box>
            </>
          )}
        </Box>
      </Box>
    </Box>
  )
}
