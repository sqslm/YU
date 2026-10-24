import type { CapturePoint, CaptureRect } from '@shared/screenshot'

export type DrawTool = 'rect' | 'ellipse' | 'arrow' | 'pen' | 'text' | 'mosaic'
export type Mark = { tool: DrawTool; color: string; points: CapturePoint[]; text?: string; width?: number; fontSize?: number; scaleX?: number; scaleY?: number }

/** Scale the original gesture snapshot so pointer moves do not accumulate drift. */
export function resizeMark(mark: Mark, from: CaptureRect, to: CaptureRect): Mark {
  const sx = to.width / from.width, sy = to.height / from.height
  return { ...mark, points: mark.points.map(p => ({ x: to.x + (p.x - from.x) * sx, y: to.y + (p.y - from.y) * sy })),
    ...(mark.tool === 'text' ? { scaleX: (mark.scaleX ?? 1) * sx, scaleY: (mark.scaleY ?? 1) * sy } : {}) }
}
