import { describe, expect, it } from 'vitest'
import {
  REPEAT_MS,
  createSwallowState,
  forgetAll,
  isRepeat,
  markDown,
  markEaten,
  markUp,
  prune,
  shouldSwallow
} from './swallow'

const VK_SHIFT = 0x10
const VK_RALT = 0xa5

describe('swallow pairing', () => {
  it('swallows the release of a press it swallowed', () => {
    const state = createSwallowState()
    markDown(state, VK_RALT, 0)
    markEaten(state, VK_RALT, true)
    expect(markUp(state, VK_RALT)).toBe(true)
  })

  it('lets through the release of a press it did not swallow', () => {
    const state = createSwallowState()
    markDown(state, VK_SHIFT, 0)
    markEaten(state, VK_SHIFT, false)
    expect(markUp(state, VK_SHIFT)).toBe(false)
  })

  it('does not let a swallowed press leak into the next release', () => {
    // The stuck-modifier regression: press swallowed, release never seen, then a
    // normal press whose release must still reach the app.
    const state = createSwallowState()
    markDown(state, VK_SHIFT, 0)
    markEaten(state, VK_SHIFT, true)
    // Release lost (hook missed it); our state still says the key is held.
    markDown(state, VK_SHIFT, 1000)
    markEaten(state, VK_SHIFT, false)
    expect(markUp(state, VK_SHIFT)).toBe(false)
    expect(state.eaten.size).toBe(0)
  })
})

describe('auto-repeat', () => {
  it('flags a second keydown without a release inside the window', () => {
    const state = createSwallowState()
    markDown(state, VK_RALT, 0)
    expect(isRepeat(state, VK_RALT, 40)).toBe(true)
  })

  it('flags a late repeat too, past the typematic delay', () => {
    // The first auto-repeat lands after 250–1000 ms, so a time window that is
    // short enough not to eat a deliberate re-press lets it through. Holding
    // RightAlt for a second must not read as "the same chord again".
    const state = createSwallowState()
    markDown(state, VK_RALT, 0)
    expect(isRepeat(state, VK_RALT, 1500)).toBe(true)
  })

  it('treats a press after a release as new', () => {
    const state = createSwallowState()
    markDown(state, VK_RALT, 0)
    markUp(state, VK_RALT)
    // Released: nothing is held, so the next keydown is a real press.
    expect(isRepeat(state, VK_RALT, REPEAT_MS + 1)).toBe(false)
  })

  it('never flags a key that was not held', () => {
    const state = createSwallowState()
    expect(isRepeat(state, VK_RALT, 10)).toBe(false)
  })

  it('does not flag the second press of a double tap', () => {
    const state = createSwallowState()
    markDown(state, VK_RALT, 0)
    markUp(state, VK_RALT)
    expect(isRepeat(state, VK_RALT, 150)).toBe(false)
  })
})

describe('prune', () => {
  it('drops keys the OS says are up, and their stale pairings', () => {
    const state = createSwallowState()
    markDown(state, VK_SHIFT, 0)
    markEaten(state, VK_SHIFT, true)
    const dropped = prune(state, () => false)
    expect(dropped).toEqual([VK_SHIFT])
    expect(state.pressed.size).toBe(0)
    expect(state.eaten.size).toBe(0)
    expect(state.downAt.size).toBe(0)
  })

  it('keeps keys the OS still reports as held', () => {
    const state = createSwallowState()
    markDown(state, VK_RALT, 0)
    expect(prune(state, (vk) => vk === VK_RALT)).toEqual([])
    expect(state.pressed.has(VK_RALT)).toBe(true)
  })
})

describe('forgetAll', () => {
  it('clears every map, including the repeat timestamps', () => {
    const state = createSwallowState()
    markDown(state, VK_RALT, 0)
    markEaten(state, VK_RALT, true)
    forgetAll(state)
    expect([state.pressed.size, state.eaten.size, state.downAt.size]).toEqual([0, 0, 0])
  })
})

describe('qualifier gate', () => {
  const VK_SPACE = 0x20
  const VK_CTRL = 0x11
  const HOLD_RALT = (primary: number): boolean => primary === VK_RALT
  const bindings = [
    { keys: [VK_RALT], primary: VK_RALT },
    { keys: [VK_RALT, VK_SHIFT], primary: VK_RALT },
    { keys: [VK_RALT, VK_SPACE], primary: VK_RALT }
  ]

  it('always swallows a primary', () => {
    expect(shouldSwallow(bindings, VK_RALT, () => false)).toBe(true)
  })

  it('swallows a qualifier only while its primary is held', () => {
    expect(shouldSwallow(bindings, VK_SHIFT, HOLD_RALT)).toBe(true)
    expect(shouldSwallow(bindings, VK_SPACE, HOLD_RALT)).toBe(true)
  })

  it('lets a lone Shift or Space through to the foreground app', () => {
    // Eating these on their own denies every app its capitals and its spaces.
    expect(shouldSwallow(bindings, VK_SHIFT, () => false)).toBe(false)
    expect(shouldSwallow(bindings, VK_SPACE, () => false)).toBe(false)
  })

  it('ignores keys that belong to no chord', () => {
    expect(shouldSwallow(bindings, 0x41, HOLD_RALT)).toBe(false)
  })

  it('does not let one chord primary vouch for another', () => {
    const split = [
      { keys: [VK_RALT, VK_SHIFT], primary: VK_RALT },
      { keys: [VK_CTRL, VK_SPACE], primary: VK_CTRL }
    ]
    // Ctrl is held: Space is its qualifier, Shift is not.
    expect(shouldSwallow(split, VK_SPACE, (vk) => vk === VK_CTRL)).toBe(true)
    expect(shouldSwallow(split, VK_SHIFT, (vk) => vk === VK_CTRL)).toBe(false)
  })
})
