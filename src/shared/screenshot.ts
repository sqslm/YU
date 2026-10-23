export interface ScreenshotFrame { dataUrl: string; width: number; height: number }
export type ScreenshotAction = 'copy' | 'save' | 'ocr' | 'translate' | 'ask'
export interface ScreenshotResult { text?: string; saved?: boolean }
export interface CaptureRect { x: number; y: number; width: number; height: number }

/** CSS coordinates to real captured pixels, including mixed DPI displays. */
export function screenshotCrop(rect: CaptureRect, view: { width: number; height: number }, image: { width: number; height: number }): CaptureRect {
  const x = Math.max(0, Math.min(image.width - 1, Math.round(rect.x * image.width / view.width)))
  const y = Math.max(0, Math.min(image.height - 1, Math.round(rect.y * image.height / view.height)))
  return { x, y, width: Math.max(1, Math.min(image.width - x, Math.round(rect.width * image.width / view.width))),
    height: Math.max(1, Math.min(image.height - y, Math.round(rect.height * image.height / view.height))) }
}
