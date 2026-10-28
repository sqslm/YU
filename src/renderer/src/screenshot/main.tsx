import { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Alert, Box, Button, CssBaseline, MenuItem, Paper, Stack, TextField, ThemeProvider, Tooltip, Typography } from '@mui/material'
import { useTranslation } from 'react-i18next'
import type { CaptureRect, ScreenshotAction, ScrollCaptureProgress } from '@shared/screenshot'
import { captureWindowAt, screenshotCrop, CAPTURE_HANDLES, captureHandle, captureHit, resizeCapture, type ResizeHandle } from '@shared/screenshot'
import { CropSquare, RadioButtonUnchecked, NorthEast, Create, TextFields, GridOn, Mouse, Undo, RestartAlt, SaveAlt, Check, Close, Translate, TextSnippet, SmartToy, UnfoldMore, QrCodeScanner } from '@mui/icons-material'
import { qrWebUrl } from '@shared/qr'
import { decodeQr } from './qr'
import { dragged } from './gesture'
import { resolveTranslateTargets } from '@shared/translate'
import { useSettings } from '../settings/useSettings'
import { makeTheme, resolveThemeMode, onSystemThemeChange } from '../settings/theme'
import { applyUiLanguage } from '../i18n'
import { resizeMark, type Mark } from './layers'
import { paintScreenshotTranslation } from './translation'

type Point = { x: number; y: number }
type Tool = 'select' | 'rect' | 'ellipse' | 'arrow' | 'pen' | 'text' | 'mosaic'
type Gesture = { kind: 'select' | 'move' | 'resize' | 'draw' | 'mark' | 'mark-resize'; start: Point; rect: CaptureRect | null; marks: Mark[]; mark?: Mark; index?: number; handle?: ResizeHandle; bounds?: CaptureRect; moved?: boolean; snap?: CaptureRect | null }
const TOOLS: [Tool, string][] = [['select', '鼠标'], ['rect', '矩形'], ['ellipse', '椭圆'], ['arrow', '箭头'], ['pen', '画笔'], ['text', '文字'], ['mosaic', '马赛克']]
const COLORS = ['#ff4d5b', '#4c8dff', '#ffd54f', '#ffffff', '#202020']
const TOOL_ICONS = { select: Mouse, rect: CropSquare, ellipse: RadioButtonUnchecked, arrow: NorthEast, pen: Create, text: TextFields, mosaic: GridOn }
const rectBetween = (a: Point, b: Point): CaptureRect => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) })
const inside = (p: Point, r: CaptureRect): boolean => p.x >= r.x && p.y >= r.y && p.x <= r.x + r.width && p.y <= r.y + r.height

function drawMark(ctx: CanvasRenderingContext2D, mark: Mark, source: HTMLCanvasElement, view: { width: number; height: number }): void {
  const a = mark.points[0], b = mark.points.at(-1)!
  ctx.save(); ctx.strokeStyle = mark.color; ctx.fillStyle = mark.color; ctx.lineWidth = mark.width ?? 3; ctx.lineJoin = 'round'; ctx.lineCap = 'round'
  const r = rectBetween(a, b)
  if (mark.tool === 'text') { ctx.font = `${mark.fontSize ?? 20}px "Segoe UI", "Microsoft YaHei", sans-serif`; ctx.translate(a.x, a.y); ctx.scale(mark.scaleX ?? 1, mark.scaleY ?? 1); ctx.fillText(mark.text ?? '', 0, mark.fontSize ?? 20) }
  else if (mark.tool === 'rect') ctx.strokeRect(r.x, r.y, r.width, r.height)
  else if (mark.tool === 'ellipse') { ctx.beginPath(); ctx.ellipse(r.x + r.width / 2, r.y + r.height / 2, r.width / 2, r.height / 2, 0, 0, Math.PI * 2); ctx.stroke() }
  else if (mark.tool === 'mosaic' && r.width > 0 && r.height > 0) {
    const tile = document.createElement('canvas'); tile.width = Math.max(1, Math.ceil(r.width / (mark.width ?? 12))); tile.height = Math.max(1, Math.ceil(r.height / (mark.width ?? 12)))
    const small = tile.getContext('2d')!
    small.drawImage(source, r.x * source.width / view.width, r.y * source.height / view.height, r.width * source.width / view.width, r.height * source.height / view.height, 0, 0, tile.width, tile.height)
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

function markBounds(mark: Mark, ctx: CanvasRenderingContext2D | null): CaptureRect {
  const xs = mark.points.map(p => p.x), ys = mark.points.map(p => p.y)
  if (mark.tool === 'text') {
    const size = mark.fontSize ?? 20
    if (ctx) ctx.font = `${size}px "Segoe UI", "Microsoft YaHei", sans-serif`
    return { x: xs[0], y: ys[0], width: Math.max(4, (ctx?.measureText(mark.text ?? '').width ?? (mark.text?.length ?? 1) * size) * (mark.scaleX ?? 1)), height: Math.max(4, size * 1.3 * (mark.scaleY ?? 1)) }
  }
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(4, Math.max(...xs) - Math.min(...xs)), height: Math.max(4, Math.max(...ys) - Math.min(...ys)) }
}

function ScreenshotEditor(): JSX.Element {
  const { settings } = useSettings(), { t } = useTranslation()
  const [systemMode, setSystemMode] = useState(() => resolveThemeMode('system'))
  useEffect(() => onSystemThemeChange(() => setSystemMode(resolveThemeMode('system'))), [])
  const mode = settings?.themeMode === 'system' ? systemMode : settings?.themeMode ?? 'dark'
  const theme = useMemo(() => makeTheme(mode), [mode])
  useEffect(() => { if (settings) applyUiLanguage(settings.uiLanguage) }, [settings?.uiLanguage])
  const [view, setView] = useState(() => ({ width: innerWidth, height: innerHeight }))
  const canvas = useRef<HTMLCanvasElement>(null), image = useRef<HTMLCanvasElement | null>(null), gesture = useRef<Gesture | null>(null)
  const windows = useRef<CaptureRect[]>([])
  const [hover, setHover] = useState<CaptureRect | null>(null)
  const [loaded, setLoaded] = useState(false), [selection, setSelection] = useState<CaptureRect | null>(null)
  const [tool, setTool] = useState<Tool>('select'), [color, setColor] = useState(COLORS[0])
  const [panel, setPanel] = useState<Tool | 'ocr' | 'translate' | 'ask' | 'qr' | null>(null)
  const [resultKind, setResultKind] = useState<'text' | 'qr'>('text')
  const [stroke, setStroke] = useState(3), [fontSize, setFontSize] = useState(20), [mosaicSize, setMosaicSize] = useState(12)
  const [ocrLanguage, setOcrLanguage] = useState('auto'), [selectedMark, setSelectedMark] = useState<number | null>(null)
  const undoStack = useRef<Mark[][]>([])
  const [cursor, setCursor] = useState('crosshair')
  const [marks, setMarks] = useState<Mark[]>([]), [draft, setDraft] = useState<Mark | null>(null)
  const [text, setText] = useState<{ point: Point; value: string } | null>(null)
  const [busy, setBusy] = useState(false), [result, setResult] = useState(''), [error, setError] = useState('')
  const [question, setQuestion] = useState(''), [target, setTarget] = useState('auto')
  const [translated, setTranslated] = useState<{ canvas: HTMLCanvasElement; text: string; rect: CaptureRect } | null>(null)
  const [showOriginal, setShowOriginal] = useState(false)
  const [scrolling, setScrolling] = useState(false)
  const [allScreens,setAllScreens]=useState(false)
  const [scrollProgress, setScrollProgress] = useState<ScrollCaptureProgress | null>(null)
  const [longCapture, setLongCapture] = useState<HTMLCanvasElement | null>(null)
  const scrollControls = useRef<HTMLDivElement>(null)
  const longPreview = useMemo(() => longCapture?.toDataURL('image/png'), [longCapture])
  useEffect(() => window.api.screenshot.onScroll(next => setScrollProgress(previous => ({ ...next, preview: next.preview ?? previous?.preview }))), [])
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
      if (!alive) return
      const source = document.createElement('canvas'); source.width = frame.width; source.height = frame.height
      source.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(frame.pixels), frame.width, frame.height), 0, 0)
      image.current = source; windows.current = frame.windows; setHover(captureWindowAt(frame.cursor, frame.windows)); setLoaded(true)
      setAllScreens(frame.allScreens===true)
    }).catch(reportError)
    return () => { alive = false; image.current = null }
  }, [])
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d')
    if (!ctx || !loaded || !image.current) return
    ctx.clearRect(0, 0, view.width, view.height)
    if (scrolling && selection) {
      ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.rect(0, 0, view.width, view.height)
      ctx.rect(selection.x, selection.y, selection.width, selection.height); ctx.fill('evenodd')
      ctx.strokeStyle = '#4c8dff'; ctx.lineWidth = 2; ctx.strokeRect(selection.x, selection.y, selection.width, selection.height)
      return
    }
    ctx.drawImage(image.current, 0, 0, view.width, view.height)
    if (translated) {
      const r = translated.rect
      if (!showOriginal) ctx.drawImage(translated.canvas, r.x, r.y, r.width, r.height)
      ctx.fillStyle = 'rgba(0,0,0,.48)'; ctx.beginPath(); ctx.rect(0, 0, view.width, view.height)
      ctx.rect(r.x, r.y, r.width, r.height); ctx.fill('evenodd')
      ctx.strokeStyle = '#4c8dff'; ctx.lineWidth = 1; ctx.strokeRect(r.x + .5, r.y + .5, r.width, r.height)
      ctx.fillStyle = '#fff'; for (const id of CAPTURE_HANDLES) { const p = captureHandle(r, id); ctx.fillRect(p.x - 3, p.y - 3, 6, 6) }
      return
    }
    if (selection) {
      ctx.save(); ctx.beginPath(); ctx.rect(selection.x, selection.y, selection.width, selection.height); ctx.clip()
      for (const mark of [...marks, ...(draft ? [draft] : [])]) drawMark(ctx, mark, image.current, view)
      ctx.restore()
    }
    ctx.fillStyle = 'rgba(0,0,0,.48)'; ctx.beginPath(); ctx.rect(0, 0, view.width, view.height)
    const preview = selection ?? hover
    if (preview) ctx.rect(preview.x, preview.y, preview.width, preview.height)
    ctx.fill('evenodd')
    if (preview && !selection) { ctx.strokeStyle = '#4c8dff'; ctx.lineWidth = 2; ctx.strokeRect(preview.x, preview.y, preview.width, preview.height) }
    if (selection) {
      ctx.strokeStyle = '#4c8dff'; ctx.lineWidth = 1; ctx.strokeRect(selection.x + .5, selection.y + .5, selection.width, selection.height)
      ctx.fillStyle = '#fff'; for (const id of CAPTURE_HANDLES) { const p = captureHandle(selection, id); ctx.fillRect(p.x - 3, p.y - 3, 6, 6) }
      if (tool === 'select' && selectedMark !== null && marks[selectedMark]) {
        const r = markBounds(marks[selectedMark], ctx); ctx.setLineDash([4, 3]); ctx.strokeRect(r.x, r.y, r.width, r.height); ctx.setLineDash([])
        for (const id of CAPTURE_HANDLES) { const p = captureHandle(r, id); ctx.fillRect(p.x - 3, p.y - 3, 6, 6) }
      }
    }
  }, [loaded, selection, hover, marks, draft, view, selectedMark, tool, translated, showOriginal, scrolling])

  useEffect(() => {
    if (!loaded || !settings) return
    const frame = requestAnimationFrame(() => { void window.api.screenshot.ready().catch(reportError) })
    return () => cancelAnimationFrame(frame)
  }, [loaded, Boolean(settings)])

  const commitText = (): void => {
    if (text?.value.trim()) setMarks(items => { undoStack.current.push(items); return [...items, { tool: 'text', color, fontSize, points: [text.point], text: text.value }] })
    setText(null)
  }
  const point = (event: React.PointerEvent): Point => ({ x: Math.max(0, Math.min(view.width, event.clientX)), y: Math.max(0, Math.min(view.height, event.clientY)) })
  const begin = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (event.detail >= 2 || event.button !== 0 || busy || !loaded || result || translated || scrolling || longCapture) return
    event.preventDefault()
    const p = point(event); setError(''); commitText()
    if (selection && tool !== 'select' && !inside(p, selection)) return
    const bounds = tool === 'select' && selectedMark !== null && marks[selectedMark] ? markBounds(marks[selectedMark], canvas.current?.getContext('2d') ?? null) : null
    const layerEdge = bounds ? captureHit(p, bounds) : null
    const edge = tool === 'select' && selection ? captureHit(p, selection) : null
    const hit = tool === 'select' && selection && inside(p, selection) ? marks.findLastIndex(mark => inside(p, markBounds(mark, canvas.current?.getContext('2d') ?? null))) : -1
    let kind: Gesture['kind'] = 'select'
    if (layerEdge && layerEdge !== 'move') kind = 'mark-resize'
    else if (edge) kind = edge === 'move' ? 'move' : 'resize'
    else if (hit >= 0) { kind = 'mark'; setSelectedMark(hit) }
    else if (selection && inside(p, selection)) {
      setSelectedMark(null)
      if (tool === 'select') return
      if (tool === 'text') { setText({ point: p, value: '' }); return }
      kind = 'draw'
    } else { setSelectedMark(null) }
    const g: Gesture = { kind, start: p, rect: selection, marks, snap: !selection && !event.altKey ? captureWindowAt(p, windows.current) : null, ...(hit >= 0 ? { index: hit } : {}), ...(edge && edge !== 'move' ? { handle: edge } : {}) }
    if (kind === 'mark-resize') { g.index = selectedMark!; g.handle = layerEdge as ResizeHandle; g.bounds = bounds! }
    if (kind === 'draw') { g.mark = { tool: tool as Mark['tool'], color, width: tool === 'mosaic' ? mosaicSize : stroke, points: [p] } }
    gesture.current = g; event.currentTarget.setPointerCapture(event.pointerId)
  }
  const move = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (scrolling || translated || longCapture) return
    const g = gesture.current
    const p = point(event)
    if (!g) {
      if (!selection) setHover(event.altKey ? null : captureWindowAt(p, windows.current))
      const edge = tool === 'select' && selection ? captureHit(p, selection) : null
      const layerEdge = tool === 'select' && selectedMark !== null && marks[selectedMark] ? captureHit(p, markBounds(marks[selectedMark], canvas.current?.getContext('2d') ?? null)) : null
      const handle = layerEdge && layerEdge !== 'move' ? layerEdge : edge
      setCursor(handle === 'move' ? 'move' : handle ? `${handle}-resize` : tool === 'select' ? marks.some(mark => inside(p, markBounds(mark, canvas.current?.getContext('2d') ?? null))) ? 'move' : 'default' : 'crosshair')
      return
    }
    if (!g.moved && !dragged(g.start, p)) return
    g.moved = true
    if (g.kind === 'select') setSelection(rectBetween(g.start, p))
    else if (g.kind === 'resize') setSelection(resizeCapture(g.rect!, g.handle!, p, view))
    else if (g.kind === 'mark-resize' && g.rect && g.bounds && g.index !== undefined) {
      const next = resizeCapture(g.bounds, g.handle!, { x: Math.max(g.rect.x, Math.min(g.rect.x + g.rect.width, p.x)), y: Math.max(g.rect.y, Math.min(g.rect.y + g.rect.height, p.y)) }, { width: g.rect.x + g.rect.width, height: g.rect.y + g.rect.height })
      setMarks(g.marks.map((mark, index) => index === g.index ? resizeMark(mark, g.bounds!, next) : mark))
    }
    else if (g.kind === 'mark' && g.rect && g.index !== undefined) {
      const bounds = markBounds(g.marks[g.index], canvas.current?.getContext('2d') ?? null)
      const dx = Math.max(g.rect.x - bounds.x, Math.min(g.rect.x + g.rect.width - bounds.x - bounds.width, p.x - g.start.x))
      const dy = Math.max(g.rect.y - bounds.y, Math.min(g.rect.y + g.rect.height - bounds.y - bounds.height, p.y - g.start.y))
      setMarks(g.marks.map((mark, index) => index !== g.index ? mark : { ...mark, points: mark.points.map(old => ({ x: old.x + dx, y: old.y + dy })) }))
    }
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
    const g = gesture.current, mark = g?.mark
    if (g?.kind === 'select') {
      if (!g.moved) setSelection(g.snap ?? g.rect)
      else { undoStack.current = []; setMarks([]) }
    }
    if (g?.kind === 'move' && g.rect) {
      const p = point(event)
      const dx = Math.max(-g.rect.x, Math.min(view.width - g.rect.x - g.rect.width, p.x - g.start.x))
      const dy = Math.max(-g.rect.y, Math.min(view.height - g.rect.y - g.rect.height, p.y - g.start.y))
      undoStack.current = undoStack.current.map(items => items.map(item => ({ ...item, points: item.points.map(old => ({ x: old.x + dx, y: old.y + dy })) })))
    }
    if (g?.moved && (g.kind === 'mark' || g.kind === 'mark-resize')) undoStack.current.push(g.marks)
    if (g?.moved && mark && mark.points.length > 1) setMarks(items => { undoStack.current.push(items); return [...items, mark] })
    gesture.current = null; setDraft(null)
  }
  const undo = (): void => { const previous = undoStack.current.pop(); if (previous) setMarks(previous); setSelectedMark(null) }
  const reset = (): void => { setSelection(null); setMarks([]); setResult(''); setTranslated(null); setSelectedMark(null); undoStack.current = []; setPanel(null); setText(null); setDraft(null); gesture.current = null }
  const exportCanvas = (): HTMLCanvasElement => {
    if (longCapture) return longCapture
    if (translated) return translated.canvas
    if (!image.current || !selection || selection.width < 4 || selection.height < 4) throw new Error(t('请先框选截图区域'))
    const source = image.current, crop = screenshotCrop(selection, view, { width: source.width, height: source.height })
    const output = document.createElement('canvas'); output.width = crop.width; output.height = crop.height
    const ctx = output.getContext('2d')!
    ctx.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height)
    const sx = source.width / view.width, sy = source.height / view.height
    ctx.scale(sx, sy); ctx.translate(-crop.x / sx, -crop.y / sy)
    for (const mark of marks) drawMark(ctx, mark, source, view)
    return output
  }
  const run = async (action: ScreenshotAction): Promise<void> => {
    if (busy) return
    setError(''); setBusy(true); setResultKind('text')
    try {
      const source = exportCanvas()
      const response = await window.api.screenshot.run(action, source.toDataURL('image/png'), question.trim() || t('请分析这张截图'), target, ocrLanguage)
      if (response.translation) {
        const painted = paintScreenshotTranslation(source, response.translation)
        setTranslated({ canvas: painted.canvas, text: response.text ?? '', rect: { ...selection! } })
        if (painted.overflow) setError(t('部分译文过长，已用省略号标记；可复制文字查看完整译文'))
        setShowOriginal(false); setPanel(null); setResult('')
      } else if (response.text) setResult(response.text)
    } catch (err) { reportError(err) } finally { setBusy(false) }
  }
  const scanQr = async (): Promise<void> => {
    if (busy) return
    setError(''); setResult(''); setBusy(true); setResultKind('qr'); setPanel('qr')
    try {
      const source = exportCanvas()
      const pixels = source.getContext('2d')!.getImageData(0, 0, source.width, source.height)
      const text = await decodeQr(pixels.data, pixels.width, pixels.height)
      if (text === null || text === '') throw Error(t('未识别到二维码，请框选完整二维码并保留四周空白'))
      setResult(text)
    } catch (err) { reportError(err) } finally { setBusy(false) }
  }
  const runRef = useRef(run); runRef.current = run
  const undoRef = useRef(undo); undoRef.current = undo
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); void window.api.screenshot.close(); return }
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
      if (event.key === 'Enter') { event.preventDefault(); void runRef.current('copy') }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') { event.preventDefault(); void runRef.current('copy') }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void runRef.current('save') }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); undoRef.current() }
    }
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key)
  }, [])
  const startScroll = (): void => {
    if (!selection || busy) return
    if (selection.width < 60 || selection.height < 60) { setError(t('滚动截图区域太小或超出屏幕')); return }
    setError(''); setPanel(null); setText(null); setScrolling(true); setScrollProgress(null)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const controls = scrollControls.current!.getBoundingClientRect()
      void window.api.screenshot.startScroll(selection, { x: controls.x, y: controls.y, width: controls.width, height: controls.height }).catch(err => { setScrolling(false); reportError(err) })
    }))
  }
  const finishScroll = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const frame = await window.api.screenshot.finishScroll()
      const source = document.createElement('canvas'); source.width = frame.width; source.height = frame.height
      source.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(frame.pixels), frame.width, frame.height), 0, 0)
      setLongCapture(source); setScrolling(false); setError('')
    } catch (err) { reportError(err) } finally { setBusy(false) }
  }
  const ready = selection && selection.width >= 4 && selection.height >= 4
  const dimensions = ready && image.current ? screenshotCrop(selection, view, { width: image.current.width, height: image.current.height }) : null
  const toolbarWidth = Math.min(610, view.width - 16)
  const toolbarHeight = panel ? 150 : 48
  const toolbarTop = ready ? Math.max(8, selection.y + selection.height + toolbarHeight + 12 < view.height ? selection.y + selection.height + 12 : selection.y - toolbarHeight - 12) : view.height - 60
  return <ThemeProvider theme={theme}><CssBaseline />
    <style>{'html, body, #root { background: transparent; overflow: hidden; }'}</style>
    <canvas ref={canvas} width={view.width} height={view.height} data-screenshot-canvas data-screenshot-loaded={loaded || undefined}
      data-screenshot-snap={!selection && hover ? JSON.stringify(hover) : undefined} data-screenshot-selection={selection ? JSON.stringify(selection) : undefined} data-screenshot-layer-count={marks.length}
      data-screenshot-layer-bounds={tool === 'select' && selectedMark !== null && marks[selectedMark] ? JSON.stringify(markBounds(marks[selectedMark], canvas.current?.getContext('2d') ?? null)) : undefined}
      style={{ position: 'fixed', inset: 0, cursor, touchAction: 'none', pointerEvents: scrolling || longCapture ? 'none' : 'auto' }}
      onPointerDown={begin} onPointerMove={move} onPointerUp={end} onPointerCancel={() => {
        const g = gesture.current
        if (g) { setSelection(g.rect); setMarks(g.marks) }
        gesture.current = null; setDraft(null)
      }}
      onDoubleClick={() => { if (!translated && !scrolling && !longCapture && ready) void run('copy') }}
      onContextMenu={event => { event.preventDefault(); if (busy) return; if (selection) reset(); else void window.api.screenshot.close() }} />
    {!scrolling&&!longCapture&&!allScreens&&<Button variant="contained" size="small" data-screenshot-action="all-screens" sx={{position:'fixed',top:10,right:10}} onClick={()=>void window.api.screenshot.allScreens().catch(reportError)}>{t('跨屏截图')}</Button>}
    {text && <input autoFocus data-screenshot-text value={text.value} maxLength={160} onChange={event => setText({ ...text, value: event.target.value })}
      onBlur={commitText} onDoubleClick={() => { if (!text.value.trim()) void run('copy') }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitText() } }}
      style={{ position: 'fixed', left: Math.min(text.point.x, view.width - 240), top: Math.min(text.point.y, view.height - 40), width: 240, color, background: 'rgba(0,0,0,.7)', border: '1px solid #4c8dff', fontSize }} />}
    {!ready && <Paper sx={{ position: 'fixed', top: 24, left: '50%', transform: 'translateX(-50%)', p: 1.5 }}>
      <Stack direction="row" alignItems="center" spacing={2}><Typography>{t('拖动框选 · 双击完成 · Esc 退出')}</Typography>
        <Button onClick={() => window.api.screenshot.close()}>{t('取消')}</Button></Stack>
    </Paper>}
    {ready && !translated && !scrolling && !longCapture && <>
      <Typography variant="caption" sx={{ position: 'fixed', left: selection.x, top: Math.max(0, selection.y - 23), color: 'white', background: '#202020aa', px: .75, borderRadius: 1 }}>{dimensions?.width} × {dimensions?.height}</Typography>
      <Paper data-screenshot-toolbar elevation={4} sx={{ position: 'fixed', top: toolbarTop, left: Math.max(8, Math.min(view.width - toolbarWidth - 8, selection.x)), width: toolbarWidth, p: .5, borderRadius: 2 }}>
        <Stack direction="row" spacing={.25} alignItems="center" sx={{ whiteSpace: 'nowrap', '& .MuiButton-root': { minWidth: 32, px: .5, flexShrink: 0 }, '& > span': { display: 'inline-flex' } }}>
          <Box sx={{ display: 'flex', alignItems: 'center', flex: 1, minWidth: 0, overflowX: 'auto' }}>
          {TOOLS.map(([id, label]) => { const Icon = TOOL_ICONS[id]; return <Tooltip key={id} title={t(label)}><span><Button size="small" variant={tool === id ? 'contained' : 'text'} disabled={busy} data-screenshot-tool={id}
            aria-label={t(label)} onClick={() => { commitText(); setSelectedMark(null); setTool(id); setPanel(id === 'select' ? null : panel === id ? null : id) }}><Icon fontSize="small" /></Button></span></Tooltip> })}
          <Box sx={{ width: '1px', height: 22, bgcolor: 'divider', flexShrink: 0, mx: '.5rem !important' }} />
          {([['ocr', '识别文字', TextSnippet], ['translate', '翻译', Translate], ['ask', '截图问答', SmartToy]] as const).map(([id, label, Icon]) =>
            <Tooltip key={id} title={t(label) + ' · ' + t(id === 'ocr' ? '在本机识别' : id === 'translate' ? '仅向模型发送识别文字' : '向视觉模型发送所选截图')}><span><Button size="small" disabled={busy} data-screenshot-action={id} aria-label={t(label)} variant={panel === id ? 'contained' : 'text'}
              onClick={() => { commitText(); setPanel(panel === id ? null : id); if (id === 'ocr') void run('ocr') }}><Icon fontSize="small" /></Button></span></Tooltip>)}
          <Tooltip title={t('扫描二维码 · 在本机识别')}><span><Button size="small" aria-label={t('扫描二维码')} data-screenshot-action="qr" disabled={busy} variant={panel === 'qr' ? 'contained' : 'text'} onClick={() => { commitText(); void scanQr() }}><QrCodeScanner fontSize="small" /></Button></span></Tooltip>
          <Tooltip title={t('撤销')}><span><Button size="small" aria-label={t('撤销')} disabled={busy || !marks.length} onClick={undo}><Undo fontSize="small" /></Button></span></Tooltip>
          <Tooltip title={t('滚动截图')}><span><Button size="small" aria-label={t('滚动截图')} data-screenshot-action="scroll" disabled={busy} onClick={startScroll}><UnfoldMore fontSize="small" /></Button></span></Tooltip>
          <Tooltip title={t('重新框选')}><span><Button size="small" aria-label={t('重新框选')} disabled={busy} onClick={reset}><RestartAlt fontSize="small" /></Button></span></Tooltip>
          <Tooltip title={t('另存为')}><span><Button size="small" aria-label={t('另存为')} disabled={busy} data-screenshot-action="save" onClick={() => run('save')}><SaveAlt fontSize="small" /></Button></span></Tooltip>
          <Tooltip title={t('贴图')}><span><Button size="small" aria-label={t('贴图')} disabled={busy} data-screenshot-action="pin" onClick={()=>run('pin')}>▣</Button></span></Tooltip>
          </Box>
          <Tooltip title={t('取消')}><Button size="small" aria-label={t('取消')} onClick={() => window.api.screenshot.close()}><Close fontSize="small" /></Button></Tooltip>
          <Tooltip title={t('完成')}><span><Button size="small" aria-label={t('完成')} disabled={busy} color="success" data-screenshot-action="copy" onClick={() => run('copy')}><Check fontSize="small" /></Button></span></Tooltip>
        </Stack>
        {panel && <Paper data-screenshot-options elevation={3} sx={{ position: 'absolute', top: 'calc(100% + 8px)', left: 0, right: 0, p: 1.25, borderRadius: 2 }}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ minHeight: 32 }}>
            {['rect', 'ellipse', 'arrow', 'pen', 'text'].includes(panel) && COLORS.map(value => <button key={value} aria-label={value} disabled={busy} onClick={() => setColor(value)}
              style={{ width: 22, height: 22, background: value, border: value === color ? '2px solid #8caeff' : '1px solid #888', borderRadius: 4, cursor: 'pointer' }} />)}
            {['rect', 'ellipse', 'arrow', 'pen', 'mosaic', 'text'].includes(panel) && <TextField select size="small" sx={{ width: 112 }} value={panel === 'text' ? fontSize : panel === 'mosaic' ? mosaicSize : stroke} label={t(panel === 'text' ? '字号' : panel === 'mosaic' ? '马赛克大小' : '线条粗细')}
              onChange={event => { const value = Number(event.target.value); if (panel === 'text') setFontSize(value); else if (panel === 'mosaic') setMosaicSize(value); else setStroke(value) }}>
              {(panel === 'text' ? [16, 20, 28, 36] : panel === 'mosaic' ? [6, 12, 20, 32] : [2, 3, 5, 8]).map(value => <MenuItem key={value} value={value}>{value}</MenuItem>)}
            </TextField>}
            {(panel === 'ocr' || panel === 'translate') && <TextField select size="small" sx={{ width: 140 }} label={t('识别语言')} value={ocrLanguage} onChange={event => setOcrLanguage(event.target.value)}>
              <MenuItem value="auto">{t('中英文自动')}</MenuItem><MenuItem value="zh">中文</MenuItem><MenuItem value="en">English</MenuItem>
            </TextField>}
            {panel === 'ocr' && <Button size="small" disabled={busy} onClick={() => run('ocr')}>{t('识别文字')}</Button>}
            {panel === 'qr' && <><Typography variant="caption">{t('框选完整二维码，在本机识别；不会自动打开链接。')}</Typography><Button size="small" disabled={busy} onClick={() => { void scanQr() }}>{t('重新扫描')}</Button></>}
            {panel === 'translate' && <><TextField select size="small" sx={{ width: 140 }} label={t('翻译目标')} value={target} onChange={event => setTarget(event.target.value)}>
              <MenuItem value="auto">{t('智能翻译')}</MenuItem>
              {[...new Set(['en', 'zh', 'ja', 'ko', 'de', 'fr', 'es', ...resolveTranslateTargets(settings ?? {})])].map(code => <MenuItem key={code} value={code}>{({ en: 'English', zh: '中文', ja: '日本語', ko: '한국어', de: 'Deutsch', fr: 'Français', es: 'Español' } as Record<string, string>)[code] || code}</MenuItem>)}
            </TextField><Button size="small" disabled={busy} onClick={() => run('translate')}>{t('开始翻译')}</Button></>}
            {panel === 'ask' && <><TextField size="small" value={question} onChange={event => setQuestion(event.target.value)} placeholder={t('截图问题（可选）')} sx={{ flex: 1 }} inputProps={{ maxLength: 4000 }} />
              <Button size="small" disabled={busy} onClick={() => run('ask')}>{t('提问')}</Button></>}
            <Box sx={{ flexGrow: 1 }} /><Button size="small" aria-label={t('收起参数')} sx={{ minWidth: 28 }} onClick={() => setPanel(null)}><Close fontSize="small" /></Button>
          </Stack>
          {['ocr', 'translate', 'ask'].includes(panel) && <Typography variant="caption" color="text.secondary">{busy ? t('处理中…') : t('OCR 在本机运行；翻译发送识别文字，Ask 发送所选截图给配置的模型。')}</Typography>}
        </Paper>}
      </Paper>
    </>}
    {error && <Alert severity="error" sx={{ position: 'fixed', top: 8, left: 8, right: 8 }} onClose={() => setError('')}>{error}</Alert>}
    {scrolling && <Paper ref={scrollControls} data-scroll-controls elevation={5}
      sx={{ position: 'fixed', left: Math.max(8, Math.min(view.width - 420, selection!.x)), top: Math.max(8, Math.min(view.height - 160, selection!.y + selection!.height + 160 < view.height ? selection!.y + selection!.height + 12 : selection!.y - 160)), width: Math.min(410, view.width - 16), height: 148, p: 1.25, borderRadius: 2 }}>
      <Typography fontWeight={600}>{t('滚动截图')} · {scrollProgress ? `${scrollProgress.width} × ${scrollProgress.height}` : t('准备中…')}</Typography>
      {scrollProgress?.preview && <Box component="img" src={scrollProgress.preview} alt={t('滚动截图')} sx={{ position: 'absolute', right: 0, bottom: '100%', mb: 1, maxWidth: 100, maxHeight: 240, objectFit: 'contain', border: '1px solid', borderColor: 'divider', bgcolor: 'background.paper', pointerEvents: 'none' }} />}
      <Typography variant="body2" color="text.secondary" sx={{ height: 52, overflow: 'auto' }}>{scrollProgress?.message || t('在选区内连续向下滚动，无需停稳；实时预览已拼接内容。')}</Typography>
      <Stack direction="row" justifyContent="flex-end" spacing={1} sx={{ mt: .5 }}>
        <Button onClick={() => window.api.screenshot.close()}>{t('取消')}</Button>
        <Button variant="contained" disabled={busy || !scrollProgress?.frames} onClick={() => { void finishScroll() }}>{t('完成')}</Button>
      </Stack>
    </Paper>}
    {longCapture && <Box data-screenshot-long-preview sx={{ position: 'fixed', inset: 0, bgcolor: '#181818', overflow: 'auto', p: '24px 24px 100px' }}>
      <Box component="img" src={longPreview} alt={t('滚动截图')} sx={{ display: 'block', width: longCapture.width, maxWidth: '100%', height: 'auto', mx: 'auto' }} />
      <Paper sx={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', p: 1, borderRadius: 2 }}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography sx={{ px: 1, whiteSpace: 'nowrap' }}>{longCapture.width} × {longCapture.height}</Typography>
          <Button disabled={busy} onClick={() => run('save')}>{t('另存为')}</Button>
          <Button disabled={busy} onClick={()=>run('pin')}>{t('贴图')}</Button>
          <Button disabled={busy} onClick={() => run('copy')}>{t('复制图片')}</Button>
          <Button onClick={() => window.api.screenshot.close()}>{t('关闭')}</Button>
        </Stack>
      </Paper>
    </Box>}
    {translated && <Typography variant="caption" sx={{ position: 'fixed', left: translated.rect.x, top: Math.max(0, translated.rect.y - 23), color: 'white', background: '#202020aa', px: .75, borderRadius: 1 }}>{translated.canvas.width} × {translated.canvas.height}</Typography>}
    {translated && <Paper data-screenshot-translation elevation={5} sx={{ position: 'fixed', top: Math.max(8, translated.rect.y + translated.rect.height + 70 < view.height ? translated.rect.y + translated.rect.height + 12 : translated.rect.y - 60), left: Math.max(8, Math.min(view.width - Math.min(700, view.width - 16) - 8, translated.rect.x)), maxWidth: 'calc(100vw - 16px)', p: 1, borderRadius: 2 }}>
      <Stack direction="row" spacing={1} sx={{ overflowX: 'auto', whiteSpace: 'nowrap' }}>
        <Button onClick={() => setShowOriginal(value => !value)}>{t(showOriginal ? '查看译图' : '查看原图')}</Button>
        <Button onClick={() => window.api.screenshot.copyText(translated.text).catch(reportError)}>{t('复制文字')}</Button>
        <Button disabled={busy} onClick={() => run('save')}>{t('保存译图')}</Button>
        <Button disabled={busy} onClick={()=>run('pin')}>{t('贴图')}</Button>
        <Button disabled={busy} onClick={() => run('copy')}>{t('复制译图')}</Button>
        <Button disabled={busy} onClick={() => setTranslated(null)}>{t('返回编辑')}</Button>
        <Button onClick={() => window.api.screenshot.close()}>{t('关闭')}</Button>
      </Stack>
    </Paper>}
    {result && <Paper data-screenshot-result elevation={5} sx={{ position: 'fixed', top: '8%', left: '50%', transform: 'translateX(-50%)', width: Math.min(700, view.width - 32), p: 2 }}>
      <Stack direction="row" justifyContent="space-between"><Typography fontWeight={600}>{t(resultKind === 'qr' ? '二维码内容' : '处理结果')}</Typography><Button onClick={() => setResult('')}>{t('关闭')}</Button></Stack>
      <TextField multiline minRows={5} maxRows={14} fullWidth value={result} onChange={event => setResult(event.target.value)} sx={{ my: 1 }} />
      <Button variant="contained" onClick={() => window.api.screenshot.copyText(result).catch(reportError)}>{t('复制文字')}</Button>
      {resultKind === 'qr' && qrWebUrl(result) && <Button sx={{ ml: 1 }} onClick={() => window.api.screenshot.openQrUrl(result).catch(reportError)}>{t('打开链接')}</Button>}
    </Paper>}
  </ThemeProvider>
}

createRoot(document.getElementById('root')!).render(<ScreenshotEditor />)
