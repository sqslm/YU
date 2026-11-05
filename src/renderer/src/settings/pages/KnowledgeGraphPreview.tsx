import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Box, Button, CircularProgress, Stack, Tooltip, Typography, useTheme } from '@mui/material'
import ForceGraph2D, { type ForceGraphMethods } from 'react-force-graph-2d'
import { useTranslation } from 'react-i18next'
import type { KnowledgeGraph } from '@shared/knowledge'
import {
  GRAPH_PREVIEW_HEIGHT,
  GRAPH_PREVIEW_NODES,
  acceptGraph,
  createGate,
  graphView,
  kindColor,
  kindKey,
  type ForceNode
} from './knowledgeView'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface Props {
  /** The page's current topic filter, so the preview draws the same scope. */
  topic: string
  /** The page's debounced search text. */
  query: string
  /** Bumped when cards change underneath, which is also when the graph changes. */
  refreshToken: number
  onOpenCard: (id: string) => void
}

/** How many node buttons the keyboard path offers before the full graph takes over. */
const KEYBOARD_NODES = 8

/**
 * A glance at the knowledge graph on the browsing page. It asks for a bounded
 * batch, draws exactly that one answer (never a union with an older one), and
 * leaves zoom and pan off so the wheel keeps scrolling the page. Nodes stay
 * clickable, and the same nodes are reachable from the keyboard.
 */
export function KnowledgeGraphPreview({ topic, query, refreshToken, onOpenCard }: Props): JSX.Element {
  const { t } = useTranslation()
  const theme = useTheme()
  const dark = theme.palette.mode === 'dark'
  const [data, setData] = useState<KnowledgeGraph | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [showNodes, setShowNodes] = useState(false)
  const [size, setSize] = useState({ width: 600, height: GRAPH_PREVIEW_HEIGHT })
  const gate = useRef(createGate())
  const container = useRef<HTMLDivElement>(null)
  const graph = useRef<ForceGraphMethods<ForceNode>>()
  const fitted = useRef(false)

  useEffect(() => {
    setLoading(true)
    setError('')
    setData(null)
    fitted.current = false
    const ticket = gate.current.next()
    void window.api.knowledge
      .graph({ topic: topic || undefined, query: query || undefined, limit: GRAPH_PREVIEW_NODES })
      .then((result) => setData((current) => acceptGraph(gate.current, ticket, result, current)))
      .catch((err) => { if (gate.current.isCurrent(ticket)) setError(messageOf(err)) })
      .finally(() => { if (gate.current.isCurrent(ticket)) setLoading(false) })
    return () => { gate.current.next() }
  }, [topic, query, refreshToken, retry])

  useEffect(() => {
    if (!container.current) return
    const observer = new ResizeObserver(([entry]) =>
      setSize({ width: Math.max(1, entry.contentRect.width), height: GRAPH_PREVIEW_HEIGHT })
    )
    observer.observe(container.current)
    return () => observer.disconnect()
  }, [])

  const view = useMemo(() => graphView(data), [data])
  const force = useMemo(() => ({ nodes: view.nodes, links: view.links }), [view])
  const counts = view.counts
  const notice = view.notice
  const keyboard = view.nodes.slice(0, KEYBOARD_NODES)

  return (
    <Box data-knowledge-graph-preview>
      {data && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }} data-knowledge-graph-counts>
          {t('knowledge.graphCounts', { matched: counts.matched, total: counts.total })}
        </Typography>
      )}

      {error && (
        <Alert
          severity="error"
          sx={{ mb: 1 }}
          action={<Button color="inherit" size="small" onClick={() => setRetry((value) => value + 1)}>{t('common.retry')}</Button>}
        >
          {error}
        </Alert>
      )}

      <Box
        ref={container}
        data-knowledge-preview-canvas
        sx={{
          height: GRAPH_PREVIEW_HEIGHT,
          position: 'relative',
          border: 1,
          borderColor: 'divider',
          borderRadius: '16px',
          overflow: 'hidden',
          bgcolor: dark ? '#181b20' : '#f6f8fb'
        }}
      >
        {view.nodes.length > 0 && (
          <ForceGraph2D<ForceNode>
            ref={graph}
            graphData={force}
            width={size.width}
            height={size.height}
            backgroundColor={dark ? '#181b20' : '#f6f8fb'}
            nodeLabel={() => ''}
            nodeRelSize={3}
            cooldownTicks={60}
            d3VelocityDecay={0.5}
            /* A preview scrolls the page, so the canvas must not eat the wheel. */
            enableZoomInteraction={false}
            enablePanInteraction={false}
            linkColor={() => (dark ? 'rgba(255,255,255,.16)' : 'rgba(20,26,35,.14)')}
            linkWidth={() => 0.6}
            nodeColor={(item) => kindColor(item.kind, dark)}
            nodeVal={() => 3}
            onNodeClick={(item) => onOpenCard(item.id)}
            nodeCanvasObjectMode={() => 'after'}
            nodeCanvasObject={(item, context, scale) => {
              if (scale < 1.1) return
              const label = item.title.length > 16 ? `${item.title.slice(0, 15)}…` : item.title
              context.font = `${9 / scale}px system-ui, sans-serif`
              context.textAlign = 'center'
              context.textBaseline = 'top'
              context.fillStyle = dark ? 'rgba(232,238,246,.82)' : 'rgba(24,32,44,.78)'
              context.fillText(label, item.x ?? 0, (item.y ?? 0) + 5 / scale)
            }}
            onEngineStop={() => {
              if (fitted.current) return
              fitted.current = true
              graph.current?.zoomToFit(220, 36)
            }}
          />
        )}
        {loading && !data && (
          <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
            <CircularProgress size={20} aria-label={t('common.loading')} />
          </Box>
        )}
        {!loading && view.nodes.length === 0 && (
          <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', p: 2, textAlign: 'center' }}>
            <Typography variant="body2" color="text.secondary">{t('knowledge.graphEmpty')}</Typography>
          </Box>
        )}
      </Box>

      {notice && (
        <Typography variant="caption" color="warning.main" sx={{ display: 'block', mt: 0.5 }} data-knowledge-graph-notice>
          {notice.limitedBy === 'bytes'
            ? t('knowledge.graphLimitedBytes', { matched: notice.matched, total: notice.total })
            : t('knowledge.graphLimitedNodes', { matched: notice.matched, total: notice.total })}
        </Typography>
      )}

      {keyboard.length > 0 && (
        <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 0.5, flexWrap: 'wrap', gap: 0.5 }}>
          <Tooltip title={t('knowledge.graphList')}>
            <Button
              size="small"
              onClick={() => setShowNodes((value) => !value)}
              aria-expanded={showNodes}
              data-knowledge-graph-nodes-toggle
            >
              {t('knowledge.graphList')}
            </Button>
          </Tooltip>
          {showNodes &&
            keyboard.map((row) => (
              <Button
                key={row.id}
                size="small"
                variant="outlined"
                onClick={() => onOpenCard(row.id)}
                aria-label={`${row.title} · ${t(kindKey(row.kind))}`}
                data-knowledge-graph-node={row.id}
                sx={{ textTransform: 'none', maxWidth: 220 }}
              >
                <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.title}</Box>
              </Button>
            ))}
        </Stack>
      )}
    </Box>
  )
}
