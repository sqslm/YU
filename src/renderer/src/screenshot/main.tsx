import { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Alert, Box, Button, CssBaseline, MenuItem, Paper, Stack, TextField, ThemeProvider, Tooltip, Typography } from '@mui/material'
import { useTranslation } from 'react-i18next'
import type { CaptureRect, ScreenshotAction } from '@shared/screenshot'
import { screenshotCrop } from '@shared/screenshot'
import { resolveTranslateTargets } from '@shared/translate'
import { useSettings } from '../settings/useSettings'
import { makeTheme, resolveThemeMode, onSystemThemeChange } from '../settings/theme'
import { applyUiLanguage } from '../i18n'

type Point = { x: number; y: number }
type Tool = 'select' | 'rect' | 'ellipse' | 'arrow' | 'pen' | 'text' | 'mosaic'
type Mark = { tool: Exclude<Tool, 'select'>; color: string; points: Point[]; text?: string }
type Gesture = { kind: 'select' | 'move' | 'resize' | 'draw'; start: Point; rect: CaptureRect | null; marks: Mark[]; mark?: Mark }
const TOOLS: [Tool, string][] = [['select', '选区'], ['rect', '矩形'], ['ellipse', '椭圆'], ['arrow', '箭头'], ['pen', '画笔'], ['text', '文字'], ['mosaic', '马赛克']]
const COLORS = ['#ff4d5b', '#4c8dff', '#ffd54f', '#ffffff', '#202020']
const TOOL_ICONS: Record<Tool, string> = { select: '⌖', rect: '▭', ellipse: '○', arrow: '↗', pen: '✎', text: 'T', mosaic: '▦' }
const rectBetween = (a: Point, b: Point): CaptureRect => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) })
const inside = (p: Point, r: CaptureRect): boolean => p.x >= r.x && p.y >= r.y && p.x <= r.x + r.width && p.y <= r.y + r.height

function drawMark(ctx: CanvasRenderingContext2D, mark: Mark, source: HTMLImageElement, view: { width: number; height: number }): void {
  const a = mark.points[0], b = mark.points.at(-1)!
  ctx.save(); ctx.strokeStyle = mark.color; ctx.fillStyle = mark.color; ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.lineCap = 'round'
  const r = rectBetween(a, b)
  if (mark.tool === 'text') { ctx.font = '20px "Segoe UI", "Microsoft YaHei", sans-serif'; ctx.fillText(mark.text ?? '', a.x, a.y + 20) }
  else if (mark.tool === 'rect') ctx.strokeRect(r.x, r.y, r.width, r.height)
  else if (mark.tool === 'ellipse') { ctx.beginPath(); ctx.ellipse(r.x + r.width / 2, r.y + r.height / 2, r.width / 2, r.height / 2, 0, 0, Math.PI * 2); ctx.stroke() }
  else if (mark.tool === 'mosaic' && r.width > 0 && r.height > 0) {
    const tile = document.createElement('canvas'); tile.width = Math.max(1, Math.ceil(r.width / 12)); tile.height = Math.max(1, Math.ceil(r.height / 12))
    const small = tile.getContext('2d')!
    small.drawImage(source, r.x * source.naturalWidth / view.width, r.y * source.naturalHeight / view.height, r.width * source.naturalWidth / view.width, r.height * source.naturalHeight / view.height, 0, 0, tile.width, tile.height)
    ctx.imageSmoothingEnabled = false; ctx.drawImage(tile, r.x, r.y, r.width, r.height)
  } else if (mark.tool === 'arrow' || mark.tool === 'pen') {
    ctx.beginPath(); ctx.moveTo(a.x, a.y); for (const p of mark.points.slice(1)) ctx.lineTo(p.x, p.y); ctx.stroke()
    if (mark.tool === 'arrow') {
      const angle = Math.atan2(b.y - a.y, b.x - a.x)
      ctx.beginPath(); ctx.moveTo(b.x, b.y)
      ctx.lineTo(b.x - 13 * Math.cos(angle - .5), b.y - 13 * Math.sin(angle - .5))
      ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - 13 * Math.cos(angle + .5), b.y - 13 * Math.sin(angle + .5)); ctx.stroke()
    }
  }
  ctx.restore()
}

function ScreenshotEditor(): JSX.Element {
  const { settings } = useSettings(), { t } = useTranslation()
  const [systemMode, setSystemMode] = useState(() => resolveThemeMode('system'))
  useEffect(() => onSystemThemeChange(() => setSystemMode(resolveThemeMode('system'))), [])
  const mode = settings?.themeMode === 'system' ? systemMode : settings?.themeMode ?? 'dark'
  const theme = useMemo(() => makeTheme(mode), [mode])
  useEffect(() => { if (settings) applyUiLanguage(settings.uiLanguage) }, [settings?.uiLanguage])
  const [view, setView] = useState(() => ({ width: innerWidth, height: innerHeight }))
  const canvas = useRef<HTMLCanvasElement>(null), image = useRef<HTMLImageElement | null>(null), gesture = useRef<Gesture | null>(null)
  const [loaded, setLoaded] = useState(false), [selection, setSelection] = useState<CaptureRect | null>(null)
  const [tool, setTool] = useState<Tool>('select'), [color, setColor] = useState(COLORS[0])
  const [marks, setMarks] = useState<Mark[]>([]), [draft, setDraft] = useState<Mark | null>(null)
  const [text, setText] = useState<{ point: Point; value: string } | null>(null)
  const [busy, setBusy] = useState(false), [result, setResult] = useState(''), [error, setError] = useState('')
  const [question, setQuestion] = useState(''), [target, setTarget] = useState('auto')
  const reportError = (err: unknown): void => setError(String(err instanceof Error ? err.message : err).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''))
  useEffect(() => {
    let previous = view
    const resize = (): void => {
      const next = { width: innerWidth, height: innerHeight }
      if (next.width === previous.width && next.height === previous.height) return
      const sx = next.width / previous.width, sy = next.height / previous.height
      setView(next)
      setSelection(r => r ? { x: r.x * sx, y: r.y * sy, width: r.width * sx, height: r.height * sy } : null)
      setMarks(items => items.map(mark => ({ ...mark, points: mark.points.map(p => ({ x: p.x * sx, y: p.y * sy })) })))
      gesture.current = null; setDraft(null); previous = next
    }
    resize(); window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  useEffect(() => {
    let alive = true
    void window.api.screenshot.frame().then(frame => {
      const img = new Image()
      img.onload = () => { if (alive) { image.current = img; setLoaded(true) } }
      img.onerror = () => { if (alive) setError(t('屏幕截图失败，请重试')) }
      img.src = frame.dataUrl
    }).catch(reportError)
    return () => { alive = false; image.current = null }
  }, [])
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d')
    if (!ctx || !loaded || !image.current) return
    ctx.clearRect(0, 0, view.width, view.height); ctx.drawImage(image.current, 0, 0, view.width, view.height)
    if (selection) {
      ctx.save(); ctx.beginPath(); ctx.rect(selection.x, selection.y, selection.width, selection.height); ctx.clip()
      for (const mark of [...marks, ...(draft ? [draft] : [])]) drawMark(ctx, mark, image.current, view)
      ctx.restore()
    }
    ctx.fillStyle = 'rgba(0,0,0,.48)'; ctx.beginPath(); ctx.rect(0, 0, view.width, view.height)
    if (selection) ctx.rect(selection.x, selection.y, selection.width, selection.height)
    ctx.fill('evenodd')
    if (selection) {
      ctx.strokeStyle = '#4c8dff'; ctx.lineWidth = 1; ctx.strokeRect(selection.x + .5, selection.y + .5, selection.width, selection.height)
      ctx.fillStyle = '#fff'; ctx.fillRect(selection.x + selection.width - 4, selection.y + selection.height - 4, 8, 8)
    }
  }, [loaded, selection, marks, draft, view])

  const commitText = (): void => {
    if (text?.value.trim()) setMarks(items => [...items, { tool: 'text', color, points: [text.point], text: text.value }])
    setText(null)
  }
  const point = (event: React.PointerEvent): Point => ({ x: Math.max(0, Math.min(view.width, event.clientX)), y: Math.max(0, Math.min(view.height, event.clientY)) })
  const begin = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (event.button !== 0 || busy || !loaded || result) return
    event.preventDefault()
    const p = point(event); setError(''); commitText()
    if (selection && inside(p, selection) && tool === 'text') { setText({ point: p, value: '' }); return }
    let kind: Gesture['kind'] = 'select'
    if (selection && inside(p, selection)) {
      kind = tool === 'select' ? 'move' : 'draw'
      if (tool === 'select' && Math.abs(p.x - selection.x - selection.width) < 10 && Math.abs(p.y - selection.y - selection.height) < 10) kind = 'resize'
    } else { setMarks([]); setSelection({ ...p, width: 0, height: 0 }) }
    const g: Gesture = { kind, start: p, rect: selection, marks }
    if (kind === 'draw') { g.mark = { tool: tool as Mark['tool'], color, points: [p] }; setDraft(g.mark) }
    gesture.current = g; event.currentTarget.setPointerCapture(event.pointerId)
  }
  const move = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const g = gesture.current; if (!g) return
    const p = point(event)
    if (g.kind === 'select') setSelection(rectBetween(g.start, p))
    else if (g.kind === 'resize') setSelection(rectBetween(g.rect!, p))
    else if (g.kind === 'move' && g.rect) {
      const dx = Math.max(-g.rect.x, Math.min(view.width - g.rect.x - g.rect.width, p.x - g.start.x))
      const dy = Math.max(-g.rect.y, Math.min(view.height - g.rect.y - g.rect.height, p.y - g.start.y))
      setSelection({ ...g.rect, x: g.rect.x + dx, y: g.rect.y + dy })
      setMarks(g.marks.map(mark => ({ ...mark, points: mark.points.map(old => ({ x: old.x + dx, y: old.y + dy })) })))
    } else if (g.mark && g.rect) {
      const end = { x: Math.max(g.rect.x, Math.min(g.rect.x + g.rect.width, p.x)), y: Math.max(g.rect.y, Math.min(g.rect.y + g.rect.height, p.y)) }
      g.mark = { ...g.mark, points: g.mark.tool === 'pen' ? [...g.mark.points, end] : [g.mark.points[0], end] }
      setDraft(g.mark)
    }
  }
  const end = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    move(event)
    const mark = gesture.current?.mark
    if (mark && mark.points.length > 1) setMarks(items => [...items, mark])
    gesture.current = null; setDraft(null)
  }
  const exportImage = (): string => {
    if (!image.current || !selection || selection.width < 4 || selection.height < 4) throw new Error(t('请先框选截图区域'))
    const source = image.current, crop = screenshotCrop(selection, view, { width: source.naturalWidth, height: source.naturalHeight })
    const output = document.createElement('canvas'); output.width = crop.width; output.height = crop.height
    const ctx = output.getContext('2d')!
    ctx.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height)
    const sx = source.naturalWidth / view.width, sy = source.naturalHeight / view.height
    ctx.scale(sx, sy); ctx.translate(-crop.x / sx, -crop.y / sy)
    for (const mark of marks) drawMark(ctx, mark, source, view)
    return output.toDataURL('image/png')
  }
  const run = async (action: ScreenshotAction): Promise<void> => {
    if (busy) return
    setError(''); setBusy(true)
    try {
      const response = await window.api.screenshot.run(action, exportImage(), question.trim() || t('请分析这张截图'), target)
      if (response.text) setResult(response.text)
    } catch (err) { reportError(err) } finally { setBusy(false) }
  }
  const runRef = useRef(run); runRef.current = run
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); void window.api.screenshot.close(); return }
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
      if (event.key === 'Enter') { event.preventDefault(); void runRef.current('copy') }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') { event.preventDefault(); void runRef.current('copy') }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void runRef.current('save') }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); setMarks(items => items.slice(0, -1)) }
    }
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key)
  }, [])
  const ready = selection && selection.width >= 4 && selection.height >= 4
  const dimensions = ready && image.current ? screenshotCrop(selection, view, { width: image.current.naturalWidth, height: image.current.naturalHeight }) : null
  const toolbarTop = ready ? Math.max(8, Math.min(view.height - 160, selection.y + selection.height + 12)) : view.height - 100
  return <ThemeProvider theme={theme}><CssBaseline />
    <canvas ref={canvas} width={view.width} height={view.height} data-screenshot-canvas data-screenshot-loaded={loaded || undefined}
      style={{ position: 'fixed', inset: 0, cursor: tool === 'select' && ready ? 'move' : 'crosshair', touchAction: 'none' }}
      onPointerDown={begin} onPointerMove={move} onPointerUp={end} onPointerCancel={() => { gesture.current = null; setDraft(null) }}
      onDoubleClick={() => { if (tool === 'select' && ready) void run('copy') }}
      onContextMenu={event => { event.preventDefault(); if (selection) { setSelection(null); setMarks([]); setResult('') } else void window.api.screenshot.close() }} />
    {text && <input autoFocus data-screenshot-text value={text.value} maxLength={160} onChange={event => setText({ ...text, value: event.target.value })}
      onBlur={commitText} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitText() } }}
      style={{ position: 'fixed', left: Math.min(text.point.x, view.width - 240), top: Math.min(text.point.y, view.height - 40), width: 240, color, background: 'rgba(0,0,0,.7)', border: '1px solid #4c8dff', fontSize: 20 }} />}
    {!ready && <Paper sx={{ position: 'fixed', top: 24, left: '50%', transform: 'translateX(-50%)', p: 1.5 }}>
      <Stack direction="row" alignItems="center" spacing={2}><Typography>{t('拖动框选区域 · Esc 退出')}</Typography><Button onClick={() => window.api.screenshot.close()}>{t('取消')}</Button></Stack>
    </Paper>}
    {ready && <Paper data-screenshot-toolbar elevation={4} sx={{ position: 'fixed', top: toolbarTop, left: Math.max(8, Math.min(view.width - Math.min(790, view.width - 16) - 8, selection.x)),
      width: Math.min(790, view.width - 16), p: 1, borderRadius: 2 }}>
      <Stack direction="row" useFlexGap flexWrap="wrap" spacing={.5} alignItems="center">
        <Typography variant="caption" sx={{ px: 1 }}>{dimensions?.width} × {dimensions?.height}</Typography>
        {TOOLS.map(([id, label]) => <Tooltip key={id} title={t(label)}><span><Button size="small" variant={tool === id ? 'contained' : 'text'} disabled={busy} data-screenshot-tool={id}
          aria-label={t(label)} sx={{ minWidth: 32, fontSize: 19, lineHeight: 1.4 }} onClick={() => { commitText(); setTool(id) }}>{TOOL_ICONS[id]}</Button></span></Tooltip>)}
        {COLORS.map(value => <button key={value} aria-label={value} disabled={busy} onClick={() => setColor(value)}
          style={{ width: 18, height: 18, background: value, border: value === color ? '2px solid #8caeff' : '1px solid #888', borderRadius: 4, cursor: 'pointer' }} />)}
        <Button size="small" disabled={busy || !marks.length} onClick={() => setMarks(items => items.slice(0, -1))}>{t('撤销')}</Button>
        <Button size="small" disabled={busy} onClick={() => { setSelection(null); setMarks([]); setResult('') }}>{t('重新框选')}</Button>
      </Stack>
      <Stack direction="row" useFlexGap flexWrap="wrap" alignItems="center" spacing={1} sx={{ mt: .75 }}>
        <Button size="small" disabled={busy} data-screenshot-action="ocr" onClick={() => run('ocr')}>OCR</Button>
        <TextField select size="small" fullWidth={false} value={target} onChange={event => setTarget(event.target.value)} sx={{ width: 120, flexShrink: 0 }} aria-label={t('翻译目标')}>
          <MenuItem value="auto">{t('智能翻译')}</MenuItem>
          {[...new Set(['en', 'zh', 'ja', 'ko', 'de', 'fr', 'es', ...resolveTranslateTargets(settings ?? {})])].map(code => <MenuItem key={code} value={code}>{({ en: 'English', zh: '中文', ja: '日本語', ko: '한국어', de: 'Deutsch', fr: 'Français', es: 'Español' } as Record<string, string>)[code] || code}</MenuItem>)}
        </TextField>
        <Button size="small" disabled={busy} data-screenshot-action="translate" onClick={() => run('translate')}>{t('翻译')}</Button>
        <TextField size="small" value={question} onChange={event => setQuestion(event.target.value)} placeholder={t('截图问题（可选）')} sx={{ width: 170 }} inputProps={{ maxLength: 4000 }} />
        <Button size="small" disabled={busy} data-screenshot-action="ask" onClick={() => run('ask')}>Ask</Button>
        <Box sx={{ flexGrow: 1 }} />
        <Button size="small" disabled={busy} data-screenshot-action="save" onClick={() => run('save')}>{t('另存为')}</Button>
        <Button size="small" disabled={busy} variant="contained" data-screenshot-action="copy" onClick={() => run('copy')}>{t('完成')}</Button>
        <Button size="small" onClick={() => window.api.screenshot.close()}>{t('取消')}</Button>
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: .75 }}>{busy ? t('处理中…') : t('OCR 在本机运行；翻译发送识别文字，Ask 发送所选截图给配置的模型。')}</Typography>
    </Paper>}
    {error && <Alert severity="error" sx={{ position: 'fixed', top: 8, left: 8, right: 8 }} onClose={() => setError('')}>{error}</Alert>}
    {result && <Paper data-screenshot-result elevation={5} sx={{ position: 'fixed', top: '8%', left: '50%', transform: 'translateX(-50%)', width: Math.min(700, view.width - 32), p: 2 }}>
      <Stack direction="row" justifyContent="space-between"><Typography fontWeight={600}>{t('处理结果')}</Typography><Button onClick={() => setResult('')}>{t('关闭')}</Button></Stack>
      <TextField multiline minRows={5} maxRows={14} fullWidth value={result} onChange={event => setResult(event.target.value)} sx={{ my: 1 }} />
      <Button variant="contained" onClick={() => window.api.screenshot.copyText(result).catch(reportError)}>{t('复制文字')}</Button>
    </Paper>}
  </ThemeProvider>
}

createRoot(document.getElementById('root')!).render(<ScreenshotEditor />)
