export function dragged(start: { x: number; y: number }, end: { x: number; y: number }): boolean {
  return Math.hypot(end.x - start.x, end.y - start.y) >= 4
}
