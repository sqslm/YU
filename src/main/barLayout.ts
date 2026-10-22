import type { Rect } from './cardLayout'
import type { BarWindowLayout } from '@shared/types'

export const BAR_WIDTH = 340
export const BAR_HEIGHT = 60
const CAPTION_HEIGHT = 128

/** Keep the actual recording strip anchored while giving its bubble room. */
export function barCaptionRect(bar: Rect, work: Rect, visible: boolean): { bounds: Rect; layout: BarWindowLayout } {
  if (!visible) return { bounds: { ...bar, width: BAR_WIDTH, height: BAR_HEIGHT },
    layout: { barTop: 0, captionSide: 'above' } }
  const width = BAR_WIDTH
  const height = CAPTION_HEIGHT
  const above = bar.y - work.y >= height - BAR_HEIGHT
  const x = Math.max(work.x, Math.min(bar.x, work.x + work.width - width))
  const y = above ? bar.y - height + BAR_HEIGHT : bar.y
  return { bounds: { x, y, width, height }, layout: {
    barTop: bar.y - y, captionSide: above ? 'above' : 'below'
  } }
}
