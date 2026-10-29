/** Slightly reduce pointer gain without compounding it on every drag event. */
export function dampenNodeDrag(node: { x?: number; y?: number; fx?: number; fy?: number }, origin: { x: number; y: number }): void {
  node.fx = node.x = origin.x + ((node.x ?? origin.x) - origin.x) * .85
  node.fy = node.y = origin.y + ((node.y ?? origin.y) - origin.y) * .85
}
