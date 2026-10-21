import { describe, expect, it } from 'vitest'
import { isSameOrder, reorderIds } from './providerProfilesView'

const base = ['a', 'b', 'c', 'd']

describe('reorderIds', () => {
  it('drops a row above the row it was dragged onto', () => {
    expect(reorderIds(base, 'c', 'a', false)).toEqual(['c', 'a', 'b', 'd'])
  })

  it('drops a row below the row it was dragged onto', () => {
    expect(reorderIds(base, 'a', 'c', true)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('moves downwards by one slot without double counting its own slot', () => {
    // 'a' onto the lower half of 'b': remove 'a' first, then insert after 'b'.
    expect(reorderIds(base, 'a', 'b', true)).toEqual(['b', 'a', 'c', 'd'])
  })

  it('treats a drop on the upper half of the next row as a no-op', () => {
    expect(reorderIds(base, 'a', 'b', false)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('can move a row to the very end and to the very front', () => {
    expect(reorderIds(base, 'b', 'd', true)).toEqual(['a', 'c', 'd', 'b'])
    expect(reorderIds(base, 'd', 'a', false)).toEqual(['d', 'a', 'b', 'c'])
  })

  it('keeps the order when the row is dropped on itself', () => {
    expect(reorderIds(base, 'b', 'b', true)).toEqual(base)
    expect(reorderIds(base, 'b', 'b', false)).toEqual(base)
  })

  it('keeps the order when an id is not in the list', () => {
    expect(reorderIds(base, 'nope', 'a', false)).toEqual(base)
    expect(reorderIds(base, 'a', 'nope', false)).toEqual(base)
  })

  it('never mutates the caller list', () => {
    const input = [...base]
    reorderIds(input, 'd', 'a', false)
    expect(input).toEqual(base)
  })
})

describe('isSameOrder', () => {
  it('compares positionally', () => {
    expect(isSameOrder(base, ['a', 'b', 'c', 'd'])).toBe(true)
    expect(isSameOrder(base, ['b', 'a', 'c', 'd'])).toBe(false)
    expect(isSameOrder(base, ['a', 'b', 'c'])).toBe(false)
  })
})
