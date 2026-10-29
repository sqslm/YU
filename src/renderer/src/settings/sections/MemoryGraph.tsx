import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Box, Button, Chip, CircularProgress, Dialog, DialogContent, DialogTitle, IconButton, MenuItem, Stack, TextField, Typography, useTheme } from '@mui/material'
import CloseRounded from '@mui/icons-material/CloseRounded'
import ForceGraph2D, { type ForceGraphMethods } from 'react-force-graph-2d'
import type { MemoryEntry, MemoryGraph, MemoryKind } from '@shared/memory'
import i18n from '../../i18n'
import { dampenNodeDrag } from './memoryGraphDrag'

export default function MemoryGraphDialog({ onClose }: { onClose(): void }): JSX.Element {
  const t = i18n.t.bind(i18n), theme = useTheme(), dark = theme.palette.mode === 'dark'
  const [kind, setKind] = useState<MemoryKind | 'all'>('all'), [query, setQuery] = useState(''), [refresh, setRefresh] = useState(0)
  const [data, setData] = useState<MemoryGraph | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [selected, setSelected] = useState<string | null>(null), [size, setSize] = useState({ width: 600, height: 440 })
  const container = useRef<HTMLDivElement>(null), graph = useRef<ForceGraphMethods<MemoryEntry>>()
  const fitted = useRef(false)
  const dragOrigin = useRef<{ id: string; x: number; y: number } | null>(null)
  useEffect(() => {
    let disposed = false
    setLoading(true); setError(''); setSelected(null); fitted.current = false
    const timer = setTimeout(() => {
      void window.api.memory.graph(kind === 'all' ? undefined : kind, query).then(result => { if (!disposed) { setData(result); setSelected(null) } })
        .catch(error => { if (!disposed) setError(error instanceof Error ? error.message : String(error)) })
        .finally(() => { if (!disposed) setLoading(false) })
    }, 250)
    return () => { disposed = true; clearTimeout(timer) }
  }, [kind, query, refresh])
  useEffect(() => {
    if (!container.current) return
    const observer = new ResizeObserver(([entry]) => setSize({ width: Math.max(1, entry.contentRect.width), height: Math.max(1, entry.contentRect.height) }))
    observer.observe(container.current)
    return () => observer.disconnect()
  }, [])
  const graphData = useMemo(() => ({ nodes: data?.nodes.map(row => ({ ...row })) ?? [], links: data?.links.map(link => ({ ...link })) ?? [] }), [data])
  useEffect(() => {
    if (loading) return
    graph.current?.d3Force('link')?.distance(125)
    graph.current?.d3Force('charge')?.strength(-140)
    graph.current?.d3ReheatSimulation()
  }, [graphData, loading])
  const entry = data?.nodes.find(row => row.id === selected)
  const neighbors = data?.links.filter(link => link.source === selected || link.target === selected).map(link => ({
    link, node: data.nodes.find(row => row.id === (link.source === selected ? link.target : link.source))!
  })) ?? []
  const color = (kind: MemoryKind): string => kind === 'assistant' ? (dark ? '#8bbdff' : '#286fc1') : (dark ? '#d4a8ed' : '#8b4ca5')
  const focus = (node: MemoryEntry & { x?: number; y?: number }): void => {
    setSelected(node.id)
    if (node.x != null && node.y != null) graph.current?.centerAt(node.x, node.y, 300)
  }
  return <Dialog open onClose={onClose} fullWidth maxWidth="lg" PaperProps={{ sx: { height: 'min(740px, 88vh)' } }}>
    <DialogTitle sx={{ pb: 1 }}><Stack direction="row" alignItems="center" justifyContent="space-between"><Box>{t('记忆关系图')}<Typography variant="caption" display="block" color="text.secondary">{t('探索记忆之间的联系，点击节点查看详情')}</Typography></Box><IconButton aria-label={t('关闭关系图')} onClick={onClose}><CloseRounded /></IconButton></Stack></DialogTitle>
    <DialogContent sx={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <Stack direction="row" spacing={1} sx={{ py: 1 }}>
        <TextField select fullWidth={false} size="small" label={t('类别')} value={kind} onChange={event => setKind(event.target.value as MemoryKind | 'all')} sx={{ width: 150, flexShrink: 0 }}><MenuItem value="all">{t('全部记忆')}</MenuItem><MenuItem value="assistant">{t('助手事实')}</MenuItem><MenuItem value="style">{t('写作偏好')}</MenuItem></TextField>
        <TextField size="small" fullWidth label={t('搜索记忆')} value={query} inputProps={{ maxLength: 200 }} onChange={event => setQuery(event.target.value)} />
        <Button sx={{ whiteSpace: 'nowrap', minWidth: 80, flexShrink: 0 }} onClick={() => graph.current?.zoomToFit(300, 50)}>{t('适应画布')}</Button><Button sx={{ flexShrink: 0 }} disabled={loading} onClick={() => setRefresh(value => value + 1)}>{t('刷新')}</Button>
      </Stack>
      {error && <Alert severity="error">{error}</Alert>}
      <Box sx={{ display: 'flex', flex: 1, minHeight: 0, border: 1, borderColor: 'divider', borderRadius: 2, overflow: 'hidden', flexDirection: { xs: 'column', md: 'row' } }}>
        <Box ref={container} sx={{ flex: '1 1 auto', minWidth: 0, minHeight: 200, position: 'relative', bgcolor: dark ? '#181b20' : '#f6f8fb' }}>
          {loading ? <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}><CircularProgress size={24} aria-label={t('正在读取记忆')} /></Box> : !data?.nodes.length ? <Box sx={{ p: 4, textAlign: 'center', color: 'text.secondary' }}>{t('暂无匹配的记忆')}</Box> : <ForceGraph2D<MemoryEntry>
            ref={graph} graphData={graphData} width={size.width} height={size.height} backgroundColor={dark ? '#181b20' : '#f6f8fb'}
            nodeLabel={() => ''} nodeColor={node => color(node.kind)} nodeVal={node => node.id === selected ? 4 : 2}
            linkColor={link => link.type === 'source' ? (dark ? '#717d90' : '#98a9bd') : (dark ? '#394453' : '#ced7e3')}
            linkLineDash={link => link.type === 'similar' ? [3, 3] : []} linkWidth={1}
            onNodeClick={focus} cooldownTicks={80} d3VelocityDecay={.5}
            onNodeDrag={(node, delta) => {
              fitted.current = true
              if (dragOrigin.current?.id !== node.id) dragOrigin.current = { id: node.id, x: (node.x ?? 0) - delta.x, y: (node.y ?? 0) - delta.y }
              dampenNodeDrag(node, dragOrigin.current)
            }} onNodeDragEnd={() => { dragOrigin.current = null }}
            onEngineStop={() => { if (!fitted.current) { fitted.current = true; graph.current?.zoomToFit(250, 45) } }}
            nodeCanvasObjectMode={() => 'after'} nodeCanvasObject={(node, context, scale) => {
              if (scale < 0.8 && node.id !== selected) return
              context.font = `${11 / scale}px sans-serif`; context.textAlign = 'center'; context.textBaseline = 'top'
              context.fillStyle = dark ? '#c8d0de' : '#354154'
              context.fillText(node.text.length > 8 ? node.text.slice(0, 8) + '…' : node.text, node.x ?? 0, (node.y ?? 0) + 8)
            }} />}
          <Typography variant="caption" sx={{ position: 'absolute', left: 14, bottom: 10, color: 'text.secondary', pointerEvents: 'none' }}>{t('滚轮缩放 · 拖动画布 · 点击节点')}</Typography>
        </Box>
        <Box sx={{ flex: { xs: '0 0 auto', md: '0 0 280px' }, maxHeight: { xs: 180, md: 'none' }, p: 2, overflow: 'auto', borderLeft: { md: 1 }, borderColor: 'divider' }}>
          {entry ? <><Chip size="small" label={t(entry.kind === 'assistant' ? '助手事实' : '写作偏好')} sx={{ mb: 2, color: color(entry.kind) }} /><Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', mb: 2 }}>{entry.text}</Typography>
            <Typography variant="caption" display="block" color="text.secondary">{t('创建时间')}：{entry.createdAt ? new Date(entry.createdAt).toLocaleString() : '—'}</Typography>
            <Typography variant="caption" display="block" color="text.secondary">{t('更新时间')}：{entry.updatedAt ? new Date(entry.updatedAt).toLocaleString() : '—'}</Typography>
            <Typography variant="caption" display="block" sx={{ overflowWrap: 'anywhere' }} color="text.secondary">{t('来源')}：{entry.sourceId || t('未知')}</Typography>
            <Typography variant="subtitle2" sx={{ mt: 3, mb: 1 }}>{t('关联记忆')} · {neighbors.length}</Typography>
            {neighbors.map(({ link, node }) => <Button key={node.id} size="small" fullWidth sx={{ display: 'block', textAlign: 'left', mb: 1, textTransform: 'none' }} onClick={() => focus(graphData.nodes.find(row => row.id === node.id)!)}><Typography variant="caption" color="text.secondary" display="block">{t(link.type === 'source' ? '共同来源' : '内容相似')}</Typography>{node.text}</Button>)}
          </> : <><Typography variant="subtitle2" sx={{ mb: 1 }}>{t('选择一条记忆')}</Typography><Typography variant="body2" color="text.secondary">{t('点击节点查看完整内容、来源和关联记忆。')}</Typography></>}
        </Box>
      </Box>
      <Stack direction="row" spacing={2} sx={{ pt: 1 }}><Typography variant="caption" sx={{ color: color('assistant') }}>● {t('助手事实')}</Typography><Typography variant="caption" sx={{ color: color('style') }}>● {t('写作偏好')}</Typography><Typography variant="caption" color="text.secondary">{t('实线：共同来源；虚线：向量相似，不代表已确认的事实关系。')}</Typography></Stack>
      <Typography variant="caption" color="text.secondary">{data ? `${data.nodes.length} / ${data.total} · ` : ''}{t('最多显示 200 个节点，可搜索缩小范围。图谱不调用模型。')}</Typography>
    </DialogContent>
  </Dialog>
}
