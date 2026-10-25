export interface ScreenshotFrame { pixels: Uint8Array; width: number; height: number; windows: CaptureRect[]; cursor: CapturePoint }
export type ScreenshotAction = 'copy' | 'save' | 'ocr' | 'translate' | 'ask'
export interface ScreenshotTextRegion extends CaptureRect { text: string; fontSize?: number }
export interface ScreenshotTranslation { width: number; height: number; regions: ScreenshotTextRegion[] }
export interface ScreenshotResult { text?: string; saved?: boolean; translation?: ScreenshotTranslation }
export interface ScrollCaptureProgress { width: number; height: number; frames: number; message?: string; stopped?: boolean }
export interface CaptureRect { x: number; y: number; width: number; height: number }
export type CapturePoint = { x: number; y: number }
/** Clip physical Windows bounds to this display, then map to editor coordinates. */
export function captureWindowRegions(windows: CaptureRect[], display: CaptureRect, view: { width: number; height: number }): CaptureRect[] {
  return windows.flatMap(rect => {
    const x = Math.max(rect.x, display.x), y = Math.max(rect.y, display.y)
    const width = Math.min(rect.x + rect.width, display.x + display.width) - x
    const height = Math.min(rect.y + rect.height, display.y + display.height) - y
    return width > 4 && height > 4 ? [{ x: (x - display.x) * view.width / display.width, y: (y - display.y) * view.height / display.height, width: width * view.width / display.width, height: height * view.height / display.height }] : []
  })
}
export function captureWindowAt(point: CapturePoint, windows: CaptureRect[]): CaptureRect | null {
  return windows.find(rect => point.x >= rect.x && point.y >= rect.y && point.x < rect.x + rect.width && point.y < rect.y + rect.height) ?? null
}
export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
export const CAPTURE_HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
export function captureHandle(rect: CaptureRect, handle: ResizeHandle): CapturePoint {
  return { x: rect.x + (handle.includes('w') ? 0 : handle.includes('e') ? rect.width : rect.width / 2),
    y: rect.y + (handle.includes('n') ? 0 : handle.includes('s') ? rect.height : rect.height / 2) }
}
export function captureHit(point: CapturePoint, rect: CaptureRect): ResizeHandle | 'move' | null {
  const handle = CAPTURE_HANDLES.find(id => { const p = captureHandle(rect, id); return Math.abs(point.x - p.x) <= 7 && Math.abs(point.y - p.y) <= 7 })
  if (handle) return handle
  if (point.x >= rect.x - 4 && point.x <= rect.x + rect.width + 4 && point.y >= rect.y - 4 && point.y <= rect.y + rect.height + 4 &&
      Math.min(Math.abs(point.x - rect.x), Math.abs(point.x - rect.x - rect.width), Math.abs(point.y - rect.y), Math.abs(point.y - rect.y - rect.height)) <= 4) return 'move'
  return null
}
export function resizeCapture(rect: CaptureRect, handle: ResizeHandle, point: CapturePoint, view: { width: number; height: number }): CaptureRect {
  let left = rect.x, right = rect.x + rect.width, top = rect.y, bottom = rect.y + rect.height
  if (handle.includes('w')) left = Math.max(0, Math.min(right - 4, point.x))
  if (handle.includes('e')) right = Math.min(view.width, Math.max(left + 4, point.x))
  if (handle.includes('n')) top = Math.max(0, Math.min(bottom - 4, point.y))
  if (handle.includes('s')) bottom = Math.min(view.height, Math.max(top + 4, point.y))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** CSS coordinates to real captured pixels, including mixed DPI displays. */
export function screenshotCrop(rect: CaptureRect, view: { width: number; height: number }, image: { width: number; height: number }): CaptureRect {
  const x = Math.max(0, Math.min(image.width - 1, Math.round(rect.x * image.width / view.width)))
  const y = Math.max(0, Math.min(image.height - 1, Math.round(rect.y * image.height / view.height)))
  return { x, y, width: Math.max(1, Math.min(image.width - x, Math.round(rect.width * image.width / view.width))),
    height: Math.max(1, Math.min(image.height - y, Math.round(rect.height * image.height / view.height))) }
}
