/**
 * Keyboard-hook child process.
 *
 * Runs inside an Electron utilityProcess so that a native message pump and a
 * pass-through hook never share a thread with the UI. It installs a
 * WH_KEYBOARD_LL hook through koffi, resolves push-to-talk chords, swallows the
 * keys it owns and reports start/mode/stop events to the host over
 * process.parentPort.
 *
 * Design notes learned from the probes in scripts/spike-hook.mjs:
 *  - A blocking GetMessage loop starves the JS thread, so callbacks would never
 *    run. We pump with PeekMessageW on a short interval instead.
 *  - The hook callback must declare `const KBDLLHOOKSTRUCT *` so koffi decodes
 *    the struct; declaring it as intptr_t yields a raw JS number.
 */
import koffi from 'koffi'
import { tokenToVk } from './keys'
import {
  createSwallowState,
  forgetAll,
  isRepeat,
  markDown,
  markEaten,
  markUp,
  shouldSwallow
} from './swallow'

type VkSet = Set<number>

interface Binding {
  mode: 'dictation' | 'translate' | 'ask'
  keys: number[]
  primary: number
}

const WH_KEYBOARD_LL = 13
const WM_KEYDOWN = 0x0100
const WM_KEYUP = 0x0101
const WM_SYSKEYDOWN = 0x0104
const WM_SYSKEYUP = 0x0105
const PM_REMOVE = 0x0001
const LLKHF_INJECTED = 0x10
/** Virtual-key code of Escape, used to abandon an in-flight take. */
const VK_ESCAPE = 0x1b

const user32 = koffi.load('user32.dll')
const kernel32 = koffi.load('kernel32.dll')

const KBDLLHOOKSTRUCT = koffi.struct('KBDLLHOOKSTRUCT', {
  vkCode: 'uint32',
  scanCode: 'uint32',
  flags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr_t'
})

const HOOKPROC = koffi.proto(
  'intptr_t HOOKPROC(int nCode, uintptr_t wParam, const KBDLLHOOKSTRUCT *lParam)'
)

const SetWindowsHookExW = user32.func(
  'void *SetWindowsHookExW(int idHook, void *lpfn, void *hmod, uint32_t dwThreadId)'
)
const CallNextHookEx = user32.func(
  'intptr_t CallNextHookEx(void *hhk, int nCode, uintptr_t wParam, intptr_t lParam)'
)
const UnhookWindowsHookEx = user32.func('int UnhookWindowsHookEx(void *hhk)')
const PeekMessageW = user32.func(
  'int PeekMessageW(void *lpMsg, void *hWnd, uint32_t min, uint32_t max, uint32_t remove)'
)
const TranslateMessage = user32.func('int TranslateMessage(void *lpMsg)')
const DispatchMessageW = user32.func('intptr_t DispatchMessageW(void *lpMsg)')
const GetModuleHandleW = kernel32.func('void *GetModuleHandleW(const char16_t *name)')
const GetAsyncKeyState = user32.func('int16_t GetAsyncKeyState(int vKey)')
const SendInput = user32.func('uint32_t SendInput(uint32_t nInputs, void *pInputs, int cbSize)')
const OpenInputDesktop = user32.func(
  'void *OpenInputDesktop(uint32_t dwFlags, int fInherit, uint32_t dwDesiredAccess)'
)
const CloseDesktop = user32.func('int CloseDesktop(void *hDesktop)')
/** Minimal right that proves *this* process can read the active desktop. */
const DESKTOP_READOBJECTS = 0x0001

const port = process.parentPort

function post(message: unknown): void {
  port.postMessage(message)
}

let enabled = true
let bindings: Binding[] = []
let pasteLast: Binding | null = null
/**
 * Ctrl+Alt+N (or whatever the user bound) toggles a 随记 take. Kept apart from
 * `bindings` because a note is not a `Mode`: nothing is inserted, no history
 * entry is written, so the host routes it to the notes page instead of the
 * dictation pipeline.
 */
let notesBinding: Binding | null = null
/**
 * True while the answer card is on screen. ESC then belongs to the card — the
 * window is shown inactive, so the card's own keydown handler never fires and
 * the hook is the only place that can see the key.
 */
let cardOpen = false
/**
 * How the hotkey gesture is interpreted.
 *
 * - `toggle` (default): press to start, press the same key again to stop.
 * - `hold`: keep the keys down while talking, release to stop.
 *
 * Both are implemented here because the difference is a single branch: where the
 * take opens. `hold` used to be accepted by the settings page and then ignored,
 * so choosing it recorded only the silence after the key was released.
 */
let activation: 'hold' | 'toggle' = 'toggle'

// Synthetic keystrokes are ignored by default: our own SendInput traffic must
// never re-enter the hook. Tests can opt in explicitly.
const allowInjected = process.env.TYPELESS_ALLOW_INJECTED === '1'

/**
 * Keys the OS reports as down, which presses we swallowed, and the timestamps
 * used to recognise auto-repeat. The invariants that make "stuck modifier" and
 * "holding the hotkey kills the take" impossible live in ./swallow; this file
 * only wires them to the hook.
 */
const state = createSwallowState()
const pressed: VkSet = state.pressed

/**
 * Posts a KEYUP for one key.
 *
 * Only ever used to answer a press this hook swallowed when the real release
 * never arrived (focus stolen by a menu, another desktop, an elevation prompt,
 * the child restarting). The foreground app then receives a release it never
 * saw a press for, which is harmless — the opposite order is what strands a
 * modifier as "held down".
 */
function sendKeyUp(vk: number): void {
  const input = Buffer.alloc(40)
  input.writeUInt32LE(1, 0) // INPUT_KEYBOARD
  input.writeUInt16LE(vk, 8) // KEYBDINPUT.wVk
  input.writeUInt32LE(0x0002, 12) // KEYEVENTF_KEYUP
  SendInput(1, input, 40)
}


/**
 * False while another desktop owns the input queue: a UAC consent prompt, the
 * lock screen, or any secure-desktop switch.
 *
 * `GetAsyncKeyState` reports every key as up on a desktop we cannot open, so a
 * take that merely *looked* released there would start a recording nobody asked
 * for. Only the "may I start?" decision consults this; a stop is never
 * suppressed, because a take that keeps running is the louder failure.
 */
function inputDesktopAvailable(): boolean {
  const handle = OpenInputDesktop(0, 0, DESKTOP_READOBJECTS)
  if (!handle) return false
  CloseDesktop(handle)
  return true
}

/**
 * Gestures are **tap-friendly**, not strictly click-based.
 *
 * - Press: the take starts immediately, so holding the key already records.
 *   That is what lets a qualifier pressed mid-hold switch the mode.
 * - Release before TAP_MS: the take stays open ("locked"), and the next press
 *   ends it — the vendor's press-again-to-finish.
 * - Release after TAP_MS: the take ends right there, like a walkie-talkie.
 * - A qualifier (Shift/Space) held together with the primary picks the mode,
 *   in either press order.
 *
 * Holding the key can never produce a stream of "结束听写" toggles: auto-repeat
 * never reaches here (see ./swallow), so a held key is one press, one take.
 */
interface Recording {
  mode: Binding['mode']
  primary: number
  keys: number[]
  startedAt: number
}

/** A press whose mode is settled when the primary comes back up. */
interface Pending {
  mode: Binding['mode']
  primary: number
  keys: number[]
  chord: Binding | null
}

let recording: Recording | null = null
let pending: Pending | null = null
function bindingFrom(mode: Binding['mode'], keys: string[]): Binding {
  const vks = keys.map(tokenToVk)
  return { mode, keys: vks, primary: vks[0] }
}

function allDown(keys: number[]): boolean {
  return keys.every((k) => pressed.has(k))
}


/** Longest binding whose keys are all currently pressed. */
function matchBinding(): Binding | null {
  let best: Binding | null = null
  for (const b of bindings) {
    if (!allDown(b.keys)) continue
    if (!best || b.keys.length > best.keys.length) best = b
  }
  return best
}


/**
 * The gesture state machine is driven by the **hook's own key events**, never by
 * polling `GetAsyncKeyState`.
 *
 * Both designs were tried, and each one broke a real keyboard:
 *
 *  - Ledger only (events in, no reconciliation): a release the hook never saw —
 *    desktop switch, UAC prompt, this child restarting — left the key "held"
 *    forever, so every later press read as auto-repeat and the hotkey died.
 *  - Sampling only (0.9.16: the ledger was recomputed from `GetAsyncKeyState`
 *    every 4 ms): a press this hook *swallows* is not guaranteed to reach the
 *    asynchronous key state, so the hotkey itself could read as never pressed —
 *    "right Alt does nothing" while the tray still showed 启用快捷键.
 *
 * So the ledger is fed by hook events, and `GetAsyncKeyState` is only ever
 * allowed to *remove* what the ledger still believes: the self-heal, never the
 * source of truth. A key the OS never showed as down cannot be judged (a
 * swallowed key may never appear there), and a key it did show as down must read
 * up for LOST_RELEASE_MS before a release is synthesised — so holding the hotkey
 * still counts as one continuous press.
 */
const LOST_RELEASE_MS = 250
/**
 * How long a press is trusted before `GetAsyncKeyState` may overrule it.
 *
 * The async key state is updated by the input thread, so for the first tick or two
 * after a keydown it can still read "up" — and a chord that is not swallowed (every
 * Ctrl/Alt qualifier of the notes chord) was then reaped as a stale release before
 * the chord could complete. Measured on the packaged build: the press was dropped
 * 1 ms after it arrived, so Ctrl+Alt+N never fired. A real lost release is still
 * reported after this window, which is all the self-heal is for.
 */
const RECONCILE_GRACE_MS = 150
/**
 * Longest gap between two keydowns of the *same* held key that can still be
 * Windows auto-repeat. The typematic repeat rate tops out at one char per 400 ms
 * and is never slower than ~1 s, so a "repeat" arriving later than this is a
 * release we never saw followed by a fresh press.
 */
const REPEAT_GAP_MS = 1200
/** Keys `GetAsyncKeyState` has already shown as down while the ledger held them. */
const osSawDown = new Set<number>()
/** When such a key started reading as up. */
const osUpSince = new Map<number, number>()

/** Every virtual key any gesture can use, so tracing stays one line per press. */
function boundKey(vk: number): boolean {
  if (vk === VK_ESCAPE) return true
  for (const b of bindings) if (b.keys.includes(vk)) return true
  if (notesBinding && notesBinding.keys.includes(vk)) return true
  return pasteLast ? pasteLast.keys.includes(vk) : false
}

/**
 * Drops keys whose release never reached the hook, and returns them.
 *
 * Runs on the 4 ms tick *before* the ledger is diffed, so a dropped key is
 * reported exactly like a real keyup — which is what ends the take and what
 * spares the rest of the system a stranded modifier.
 */
function reconcile(now: number): number[] {
  const dropped: number[] = []
  for (const vk of [...pressed]) {
    if ((GetAsyncKeyState(vk) & 0x8000) !== 0) {
      osSawDown.add(vk)
      osUpSince.delete(vk)
      continue
    }
    // Not eaten: the OS is the better witness here, the hook simply missed it —
    // but only after the async state has had time to see the press at all.
    if (now - (state.downAt.get(vk) ?? now) < RECONCILE_GRACE_MS) continue
    if (!state.eaten.has(vk)) {
      dropped.push(vk)
      continue
    }
    // Eaten: this hook is the reason the key is invisible, so the async state may
    // never have seen the press at all. Only judge a key it did show as down.
    if (!osSawDown.has(vk)) continue
    const since = osUpSince.get(vk) ?? now
    osUpSince.set(vk, since)
    if (now - since < LOST_RELEASE_MS) continue
    // A swallowed press whose release never arrived looks like a stuck modifier
    // to every other app; answer for it. Harmless when nobody saw the press.
    sendKeyUp(vk)
    dropped.push(vk)
  }
  for (const vk of dropped) {
    pressed.delete(vk)
    state.eaten.delete(vk)
    state.downAt.delete(vk)
    osSawDown.delete(vk)
    osUpSince.delete(vk)
  }
  return dropped
}

let prevHeld: VkSet = new Set<number>()

/** The key that completes a chord: the last one in the binding. */
function chordKey(b: Binding): number {
  return b.keys[b.keys.length - 1] ?? b.primary
}

/**
 * Hook-side decision only: may this press be swallowed?
 *
 * A qualifier that belongs to a chord is swallowed so the foreground app never
 * sees a half-pressed shortcut; the paste-last qualifiers are left alone (a
 * leaked Ctrl with no V is harmless, a swallowed Ctrl breaks every other Ctrl
 * shortcut the user types).
 */
function swallowDown(vk: number, injected: boolean): boolean {
  if (!enabled || (injected && !allowInjected)) return false
  // The card is the only owner of ESC while it is up: swallowing it here is what
  // makes "ESC closes the answer" work from the app the user is actually typing in.
  if (cardOpen && vk === VK_ESCAPE) return true
  if (pasteLast && vk === chordKey(pasteLast) && allDown(pasteLast.keys)) return true
  if (notesBinding && vk === chordKey(notesBinding) && allDown(notesBinding.keys)) return true
  // A qualifier only belongs to us once its primary is held: a lone Shift or
  // Space must reach the foreground app, or typing breaks everywhere. The ledger
  // answers that question — the async key state does not necessarily see a key
  // this hook has already swallowed.
  return shouldSwallow(bindings, vk, (primary) => pressed.has(primary))
}

/** Turns one ledger diff into start / mode / stop / cancel / paste-last events. */
function drive(): void {
  const now = Date.now()
  // Releases the hook never saw leave the ledger here, so the diff below reports
  // them exactly like real keyups.
  const dropped = reconcile(now)
  if (dropped.length) post({ type: 'stale', keys: dropped })
  const held = new Set(pressed)
  const entered = [...held].filter((vk) => !prevHeld.has(vk))
  const left = [...prevHeld].filter((vk) => !held.has(vk))
  prevHeld = held
  if (!enabled) return

  // A swallowed press whose release never arrived is answered inside
  // `reconcile` (synthetic keyup, same idea as the vendor's
  // resetPressingKeycodes but automatic and per key). By the time the diff runs,
  // every key that leaves the ledger is already balanced, so what follows is
  // pure gesture translation.

  for (const vk of left) {
    if (recording) {
      // Toggle keeps the take when a qualifier is lifted: the mode was already
      // settled and users let go of the modifier long before they stop talking.
      // Hold is the opposite — the gesture is "keep the keys down while you
      // talk", so releasing any of them ends the take.
      const ends =
        activation === 'hold' ? recording.keys.includes(vk) : vk === recording.primary
      if (ends) {
        const mode = recording.mode
        recording = null
        post({ type: 'stop', mode, at: now })
      }
      continue
    }
    if (pending && vk === pending.primary) {
      // On a secure desktop every key reads as up. Treating that as "the user
      // finished the gesture" is how a take starts behind a UAC prompt, so the
      // gesture is dropped instead of honoured.
      if (!inputDesktopAvailable()) {
        pending = null
        continue
      }
      const mode = pending.chord?.mode ?? pending.mode
      const keys = pending.chord?.keys ?? pending.keys
      pending = null
      recording = { mode, primary: vk, keys, startedAt: now }
      post({ type: 'start', mode, at: now })
    }
  }

  for (const vk of entered) {
    if (vk === VK_ESCAPE) {
      if (recording) {
        recording = null
        post({ type: 'cancel', at: now, reason: 'esc' })
      } else {
        if (pending) pending = null
        // The stage lives in the main process, not here: a previous take may
        // still be transcribing while this one records nothing, and that is
        // exactly the moment the user presses ESC. Offer it every time and let
        // `pipeline.cancel()` ignore it when nothing is in flight.
        if (cardOpen) post({ type: 'esc', at: now })
        post({ type: 'cancel', at: now, reason: 'esc' })
      }
      continue
    }
    if (recording) {
      const next = matchBinding()
      if (next && next.keys.length > recording.keys.length) {
        recording = { ...recording, mode: next.mode, keys: next.keys }
        post({ type: 'mode', mode: next.mode, at: now })
      } else if (vk === recording.primary) {
        const mode = recording.mode
        recording = null
        post({ type: 'stop', mode, at: now })
      }
      continue
    }
    if (pending) {
      // The chord is read while the keys are still down, so "hold Shift, then
      // tap the hotkey" and "hold the hotkey, then tap Shift" both mean the
      // longer gesture.
      const next = matchBinding()
      if (next && next.keys.length > pending.keys.length) pending.chord = next
      continue
    }
    if (pasteLast && allDown(pasteLast.keys)) {
      post({ type: 'paste-last', at: now })
      continue
    }
    if (notesBinding && allDown(notesBinding.keys)) {
      // A note take never coexists with a dictation take: reaching here means no
      // `pending` and no `recording`, so the host can treat this as a pure toggle.
      post({ type: 'notes-toggle', at: now })
      continue
    }
    const match = matchBinding()
    if (!match) continue
    if (activation === 'hold') {
      // Hold means what the settings page promises: the take opens on the press
      // and the release ends it. Starting on the release (the toggle gesture)
      // made a held hotkey record only the silence after the user let go, which
      // is why every word of a held take was missing from the transcript.
      if (!inputDesktopAvailable()) continue
      recording = { mode: match.mode, primary: match.primary, keys: match.keys, startedAt: now }
      post({ type: 'start', mode: match.mode, at: now })
      continue
    }
    // The take starts on the release: a held key is one press, never a stream.
    pending = { mode: match.mode, primary: match.primary, keys: match.keys, chord: null }
  }
}

const handler = koffi.register(
  (nCode: number, wParam: number, lParam: unknown) => {
    if (nCode < 0) return CallNextHookEx(null, nCode, wParam, koffi.address(lParam))
    const kb = koffi.decode(lParam, KBDLLHOOKSTRUCT)
    const injected = (kb.flags & LLKHF_INJECTED) !== 0
    const isDown = wParam === WM_KEYDOWN || wParam === WM_SYSKEYDOWN
    const isUp = wParam === WM_KEYUP || wParam === WM_SYSKEYUP
    if (!isDown && !isUp) return CallNextHookEx(null, nCode, wParam, koffi.address(lParam))
    // Our own SendInput traffic (inserted text, the synthetic release above) must
    // never enter the ledger: a keyup we generate would otherwise consume the
    // `eaten` flag of a press the user is still holding. Tests opt in.
    if (injected && !allowInjected) {
      return CallNextHookEx(null, nCode, wParam, koffi.address(lParam))
    }

    const vk = kb.vkCode
    // Auto-repeat repeats the press that is already in the ledger, so `drive`
    // never sees a second "entered" for it: holding the hotkey is one gesture.
    let repeat = isDown && isRepeat(state, vk, Date.now())
    if (isDown && repeat && Date.now() - (state.downAt.get(vk) ?? 0) > REPEAT_GAP_MS) {
      // Nothing auto-repeats this slowly, so this is not a repeat: the ledger
      // still says "down" because the release was lost while we swallowed the
      // press. Answer for that press, then read this keydown as the fresh one it
      // is — without this, a lost keyup used to kill the hotkey until restart.
      if (state.eaten.has(vk)) sendKeyUp(vk)
      pressed.delete(vk)
      state.eaten.delete(vk)
      state.downAt.delete(vk)
      osSawDown.delete(vk)
      osUpSince.delete(vk)
      repeat = false
    }
    if (isDown) markDown(state, vk, Date.now())

    // A release is only ever swallowed to balance a press we swallowed. That
    // pairing — plus reconcile()'s synthetic keyup when the real release never
    // arrives — is what lets the hotkey stay invisible to the foreground app
    // without ever leaving a modifier stranded.
    const eaten = isDown ? swallowDown(vk, injected) : markUp(state, vk)
    if (isDown) markEaten(state, vk, eaten)
    if (boundKey(vk) && !repeat) {
      post({
        type: 'log',
        line: `[hook] ${isDown ? 'down' : 'up'} 0x${vk.toString(16)}${eaten ? ' eaten' : ''}`
      })
    }
    if (eaten) return 1
    return CallNextHookEx(null, nCode, wParam, koffi.address(lParam))
  },
  koffi.pointer(HOOKPROC)
)

const msg = Buffer.alloc(64)
let hook: unknown = null

function install(): void {
  hook = SetWindowsHookExW(WH_KEYBOARD_LL, handler, GetModuleHandleW(null), 0)
  if (!hook) {
    post({ type: 'error', message: 'SetWindowsHookExW failed' })
    process.exit(1)
  }
  setInterval(() => {
    while (PeekMessageW(msg, null, 0, 0, PM_REMOVE)) {
      TranslateMessage(msg)
      DispatchMessageW(msg)
    }
    // 4ms sampling is the whole state machine: no press can be missed, no
    // release can be lost. The timer also keeps the hook's message pump warm.
    drive()
  }, 4)
  post({ type: 'ready' })
}

port.on('message', (event: { data: unknown }) => {
  const data = event.data as
    | {
        type: 'config'
        bindings: Record<string, string[]>
        pasteLast: string[]
        notes?: string[]
        activation?: 'hold' | 'toggle'
      }
    | { type: 'enabled'; value: boolean }
    | { type: 'card'; open: boolean }
    | { type: 'reset' }
  if (data.type === 'config') {
    bindings = []
    for (const [mode, keys] of Object.entries(data.bindings)) {
      bindings.push(bindingFrom(mode as Binding['mode'], keys))
    }
    bindings.sort((a, b) => b.keys.length - a.keys.length)
    pasteLast = bindingFrom('dictation', data.pasteLast)
    notesBinding = data.notes && data.notes.length > 0 ? bindingFrom('dictation', data.notes) : null
    if (data.activation === 'hold' || data.activation === 'toggle') {
      activation = data.activation
    }
    // Re-binding changes which keys we watch. A leftover `eaten` flag for a key
    // that is no longer in any binding would never be reconciled again, and the
    // next real press of that key would be a down the app never sees released —
    // a stuck modifier. Forget the old snapshot wholesale.
    pending = null
    prevHeld = new Set<number>()
    forgetAll(state)
  } else if (data.type === 'card') {
    cardOpen = data.open
  } else if (data.type === 'enabled') {
    enabled = data.value
    if (!enabled) {
      if (recording) {
        post({ type: 'stop', mode: recording.mode, at: Date.now() })
        recording = null
      }
      // A half-finished gesture must not survive a suspend: it would start a
      // take on a release the user never meant as one.
      pending = null
      // Anything still held now belongs to the foreground app again; forgetting
      // it is what keeps a suspended hotkey from holding a modifier down.
      forgetAll(state)
      prevHeld = new Set<number>()
    }
  } else if (data.type === 'reset') {
    // Explicit "the user says the keyboard looks stuck" path: forget everything
    // rather than waiting for the next physical keyup to prove us wrong.
    recording = null
    pending = null
    forgetAll(state)
    prevHeld = new Set<number>()
  }
})

process.on('exit', () => {
  if (hook) UnhookWindowsHookEx(hook)
  koffi.unregister(handler)
})

install()
