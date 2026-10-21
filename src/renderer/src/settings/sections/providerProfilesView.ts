/**
 * Order math behind dragging a saved profile.
 *
 * The gesture lives in React, but "where does this row land" has exactly one
 * right answer, so it is a pure function here instead of inline drag handlers —
 * which also means it can be tested without a browser or a pointer.
 */

/**
 * Returns `ids` with `dragId` moved next to `targetId`.
 *
 * `after` drops it below the target, `after: false` above it. The dragged id is
 * removed *before* the target index is read, so dragging downwards does not
 * count the row's own old slot twice (which is the classic off-by-one here).
 *
 * Unknown ids and a drop on the row itself return the order unchanged, so the
 * caller can skip a settings patch that would rewrite the same chain.
 */
export function reorderIds(
  ids: readonly string[],
  dragId: string,
  targetId: string,
  after: boolean
): string[] {
  const order = [...ids]
  if (dragId === targetId) return order
  if (!order.includes(dragId)) return order
  const rest = order.filter((id) => id !== dragId)
  const target = rest.indexOf(targetId)
  if (target < 0) return order
  rest.splice(after ? target + 1 : target, 0, dragId)
  return rest
}

/** True when a drop would leave the cached order untouched. */
export function isSameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}
