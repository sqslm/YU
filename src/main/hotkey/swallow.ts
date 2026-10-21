/**
 * What the keyboard hook believes about keys, kept pure so it can be tested.
 *
 * Two invariants live here, and both exist because of a real failure seen in the
 * wild:
 *
 *  1. A release is swallowed only when *that press* was swallowed. A stale flag
 *     denies the foreground app a keyup it is waiting for, and Windows then
 *     behaves as if Shift is held down everywhere — every keystroke becomes a
 *     shortcut until the user presses and releases the key by hand.
 *
 *  2. Keyboard auto-repeat must never read as a fresh press. Holding the hotkey
 *     in toggle mode used to end the take milliseconds after starting it,
 *     because the repeat keydown matched "the same chord pressed again".
 */

/** Repeat window. Faster than any deliberate second press (300 ms), slower than a repeat. */
export const REPEAT_MS = 60

export interface SwallowState {
  /** Keys the keyboard reports as down right now. */
  pressed: Set<number>
  /** Keys whose current press was swallowed, awaiting a paired release. */
  eaten: Set<number>
  /** Last keydown timestamp per key, for auto-repeat detection. */
  downAt: Map<number, number>
}

export function createSwallowState(): SwallowState {
  return { pressed: new Set(), eaten: new Set(), downAt: new Map() }
}

/**
 * True when this keydown is Windows auto-repeat rather than a fresh press.
 *
 * Being in `pressed` is the whole signal: a genuine second press always has a
 * release in between, and `markUp` clears the entry. A time window alone is not
 * enough — the *first* repeat arrives after the typematic delay (250–1000 ms,
 * user-configurable), which is far longer than any window that would not also
 * swallow a deliberate re-press. Holding RightAlt for a second therefore still
 * read as "the same chord pressed again" and toggled the take off and on. The
 * clock arguments stay so the hook and its callers need no churn.
 */
export function isRepeat(
  state: SwallowState,
  vk: number,
  now: number,
  repeatMs = REPEAT_MS
): boolean {
  void now
  void repeatMs
  return state.pressed.has(vk)
}

export function markDown(state: SwallowState, vk: number, now: number): void {
  state.pressed.add(vk)
  state.downAt.set(vk, now)
}

/** Records whether this press was swallowed. Consumed by the matching release. */
export function markEaten(state: SwallowState, vk: number, eaten: boolean): void {
  if (eaten) state.eaten.add(vk)
  else state.eaten.delete(vk)
}

/**
 * True when the release must also be swallowed.
 *
 * Consuming the pairing here is the fix for the stuck-modifier bug: the flag
 * describes one press, not "this key was ever swallowed".
 */
export function markUp(state: SwallowState, vk: number): boolean {
  state.pressed.delete(vk)
  state.downAt.delete(vk)
  return state.eaten.delete(vk)
}

export function forgetAll(state: SwallowState): void {
  state.pressed.clear()
  state.eaten.clear()
  state.downAt.clear()
}

/** One chord as the hook needs to see it: every key, plus the one that starts it. */
export interface SwallowBinding {
  keys: number[]
  primary: number
}

/**
 * May this keydown be withheld from the foreground app?
 *
 * A primary is always ours — that is the hotkey. A qualifier is ours **only
 * while the primary of that chord is already held**: swallowing Space or
 * RightShift on its own denies every application its spaces and capitals,
 * which is a far worse defect than the half-pressed shortcut this hook hides.
 * Holding the primary first is exactly the gesture that makes the qualifier
 * part of a chord, in either press order.
 */
export function shouldSwallow(
  bindings: readonly SwallowBinding[],
  vk: number,
  primaryHeld: (vk: number) => boolean
): boolean {
  for (const binding of bindings) {
    if (!binding.keys.includes(vk)) continue
    if (vk === binding.primary) return true
    if (primaryHeld(binding.primary)) return true
  }
  return false
}

/**
 * Drops entries the OS says are no longer held, and returns the keys dropped.
 *
 * A hook can miss a release (desktop switch, UAC prompt, session lock, a
 * restarted utility process). The entries left behind are exactly the stale ones
 * that break the invariants above, so reconciling against `GetAsyncKeyState`
 * every second is what makes "stuck keyboard" self-healing.
 */
export function prune(state: SwallowState, isHeld: (vk: number) => boolean): number[] {
  const dropped: number[] = []
  for (const vk of [...state.pressed]) {
    if (isHeld(vk)) continue
    state.pressed.delete(vk)
    dropped.push(vk)
  }
  for (const vk of [...state.eaten]) {
    if (!state.pressed.has(vk)) state.eaten.delete(vk)
  }
  for (const vk of [...state.downAt.keys()]) {
    if (!state.pressed.has(vk)) state.downAt.delete(vk)
  }
  return dropped
}
