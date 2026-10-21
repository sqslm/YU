import koffi from 'koffi'
import { clipboard } from 'electron'
import type { MultilineMode } from '@shared/types'
import { KEYEVENTF_KEYUP, buildKeyEvents, danglingKeyUps, type KeyEvent } from './keyevents'

/**
 * Text insertion.
 *
 * Primary path is SendInput with KEYEVENTF_UNICODE, which reaches almost every
 * Win32/UWP/Electron control without touching the clipboard. Some targets
 * (elevated windows, some remote-desktop clients and a few Chromium canvases)
 * drop synthetic Unicode input, so the caller can fall back to
 * clipboard + Ctrl+V, restoring the previous clipboard afterwards.
 */

const user32 = koffi.load('user32.dll')

const INPUT_KEYBOARD = 1
const INPUT_SIZE = 40 // x64 layout: type(4)+pad(4)+KEYBDINPUT(wVk,wScan,flags,time)+pad+extraInfo

const SendInput = user32.func('uint32_t SendInput(uint32_t cInputs, void *pInputs, int cbSize)')
const GetAsyncKeyState = user32.func('int16_t GetAsyncKeyState(int vKey)')

/**
 * Modifier keys worth probing when the keyboard is stuck.
 *
 * The generic codes plus both sides of each modifier: Windows reports physical
 * presses on the side-specific codes, and a stolen/aborted injection shows up
 * there.
 */
const MODIFIER_VKS = [0x10, 0x11, 0x12, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0x5b, 0x5c]

const VK_CONTROL = 0x11
const VK_V = 0x56

function buildInput(events: KeyEvent[]): Buffer {
  const buffer = Buffer.alloc(INPUT_SIZE * events.length)
  events.forEach((event, index) => {
    const base = index * INPUT_SIZE
    buffer.writeUInt32LE(INPUT_KEYBOARD, base)
    buffer.writeUInt16LE(event.vk ?? 0, base + 8)
    buffer.writeUInt16LE(event.scan ?? 0, base + 10)
    buffer.writeUInt32LE(event.flags ?? 0, base + 12)
    buffer.writeUInt32LE(0, base + 16)
    buffer.writeBigUInt64LE(0n, base + 24)
  })
  return buffer
}

function send(events: KeyEvent[]): number {
  if (events.length === 0) return 0
  return Number(SendInput(events.length, buildInput(events), INPUT_SIZE))
}

/** Types text with SendInput Unicode events. Returns false if the OS refused. */
export function typeUnicode(text: string, multiline: MultilineMode = 'space'): boolean {
  if (!text) return true
  const events = buildKeyEvents(text, multiline)
  // Chunk to keep a single SendInput call reasonable.
  const CHUNK = 64
  const sent: KeyEvent[] = []
  let ok = true
  for (let i = 0; i < events.length; i += CHUNK) {
    const slice = events.slice(i, i + CHUNK)
    const delivered = send(slice)
    sent.push(...slice.slice(0, Math.max(0, delivered)))
    if (delivered !== slice.length) {
      ok = false
      break
    }
  }
  if (!ok) {
    // The abort may have landed between a modifier press and its release; put
    // the keyboard back the way we found it before returning.
    const stragglers = danglingKeyUps(sent)
    if (stragglers.length > 0) send(stragglers)
  }
  return ok
}

/**
 * Releases modifiers the OS still believes are held, and reports which ones.
 *
 * Injection is not transactional: a press can be delivered while its release is
 * dropped (focus change, UIPI, a locked session). The desktop then behaves as if
 * Shift is held everywhere — every keystroke becomes a shortcut — and there is
 * no way back except pressing and releasing the key by hand. Our own inserts
 * clean up after themselves; this exists for the cases we did not run, and is
 * exposed as an explicit "reset keyboard" action.
 */
export function releaseStuckModifiers(): number[] {
  const stuck = MODIFIER_VKS.filter((vk) => (GetAsyncKeyState(vk) & 0x8000) !== 0)
  if (stuck.length === 0) return []
  send(stuck.map((vk) => ({ vk, scan: 0, flags: KEYEVENTF_KEYUP })))
  return stuck
}

function sendCtrlV(): void {
  // One call, so a refusal cannot leave Ctrl down between the three sends.
  const events: KeyEvent[] = [
    { vk: VK_CONTROL, scan: 0x1d },
    { vk: VK_V, scan: 0x2f },
    { vk: VK_V, scan: 0x2f, flags: KEYEVENTF_KEYUP },
    { vk: VK_CONTROL, scan: 0x1d, flags: KEYEVENTF_KEYUP }
  ]
  const delivered = send(events)
  if (delivered !== events.length) send(danglingKeyUps(events.slice(0, Math.max(0, delivered))))
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * True when the clipboard holds a file list.
 *
 * A file list cannot be rebuilt from any buffer Electron exposes, so overwriting
 * it means the user's copied files are simply gone. Typing the text out is slower
 * but never destroys anything.
 */
function clipboardHasFiles(): boolean {
  return clipboard.availableFormats().some((format) => /files|filename|uri-list/i.test(format))
}

/**
 * Pastes text through the clipboard and puts the previous clipboard back.
 * `restoreAfterMs` gives the target app time to consume the paste first.
 *
 * The clipboard is restored as whatever it was: a copied picture used to be
 * replaced by the empty string `readText()` returns for it.
 */
export async function pasteViaClipboard(
  text: string,
  options: { restore: boolean; restoreAfterMs?: number } = { restore: true }
): Promise<void> {
  const previousText = clipboard.readText()
  const previousImage = clipboard.readImage()
  clipboard.writeText(text)
  await sleep(30)
  sendCtrlV()
  if (!options.restore) return
  await sleep(options.restoreAfterMs ?? 220)
  // The user copied something else in the meantime: their clipboard wins.
  if (clipboard.readText() !== text) return
  if (!previousImage.isEmpty()) {
    clipboard.writeImage(previousImage)
    return
  }
  clipboard.writeText(previousText)
}

export interface InsertOptions {
  method: 'auto' | 'sendinput' | 'clipboard'
  restoreClipboard: boolean
  multiline?: MultilineMode
}

/**
 * Pastes rich text: the plain text plus an HTML flavour of the same content.
 *
 * The clipboard is the only channel that carries a format — SendInput types
 * code points, so a rich paste sent that way would land the tags themselves.
 * The target picks what it understands: Word and Outlook use the HTML, a plain
 * edit control uses `text`, and neither ever sees something it cannot render.
 */
export async function insertRich(
  text: string,
  html: string,
  options: { restore: boolean; restoreAfterMs?: number } = { restore: true }
): Promise<void> {
  const previousText = clipboard.readText()
  const previousHtml = clipboard.readHTML()
  const previousImage = clipboard.readImage()
  clipboard.write({ text, html })
  await sleep(30)
  sendCtrlV()
  if (!options.restore) return
  await sleep(options.restoreAfterMs ?? 220)
  // The user copied something else in the meantime: their clipboard wins.
  if (clipboard.readText() !== text) return
  if (!previousImage.isEmpty()) {
    clipboard.writeImage(previousImage)
    return
  }
  if (previousHtml && previousHtml.trim()) {
    clipboard.write({ text: previousText, html: previousHtml })
    return
  }
  clipboard.writeText(previousText)
}

/**
 * Inserts text at the current caret using the configured strategy.
 *
 * `auto` (the default) pastes through the clipboard: one atomic paste lands the
 * whole block at once, and a paste can never be mistaken for Enter — which is
 * what used to submit half-finished messages in chat inputs.
 */
export async function insertText(
  text: string,
  options: InsertOptions
): Promise<'sendinput' | 'clipboard'> {
  if (!text) return 'clipboard'
  const multiline = options.multiline ?? 'space'

  if (options.method === 'sendinput') {
    if (!typeUnicode(text, multiline)) throw new Error('SendInput refused the key events')
    return 'sendinput'
  }

  if (options.method === 'auto' && clipboardHasFiles()) {
    // A copied file list cannot be put back after we overwrite the clipboard, and
    // silently losing someone's files is worse than a slower insert. This is the
    // documented trade-off of `auto`.
    if (typeUnicode(text, multiline)) return 'sendinput'
  }

  await pasteViaClipboard(text, { restore: options.restoreClipboard })
  return 'clipboard'
}

/* ------------------------------------------------------------------------- *
 * ACC-08 / REQ-08 insertion verification
 *
 * Typing into another application is fire-and-forget unless we look at the
 * control afterwards: a focused window can drop a paste, and the user then
 * believes their dictation vanished. `verifyInsertion` reads the focused control
 * back a few times and says what it saw. It performs no IO itself — the read is
 * injected, because the only honest reader is UI Automation running in its own
 * utility process — which keeps every branch unit-testable.
 * ------------------------------------------------------------------------- */

/** How many characters of the inserted text must be visible to call it landed. */
const VERIFY_TAIL_CHARS = 24

/** First wait before reading back; later attempts double it. */
const VERIFY_INITIAL_DELAY_MS = 150

const VERIFY_DEFAULT_TIMEOUT_MS = 1200

const VERIFY_DEFAULT_ATTEMPTS = 3

/**
 * `mismatch` means the control was readable and did not hold our text: real
 * evidence of a failed insert. `no-target` (UIA cannot read the control) and
 * `timeout` (never became readable in time) are only logged — plenty of apps
 * expose no automation value at all, and that is not an error.
 */
export interface VerifyInsertionResult {
  ok: boolean
  reason?: 'no-target' | 'mismatch' | 'timeout'
  observed?: string
}

/**
 * The part of `expected` that has to appear in the control: its last characters,
 * ignoring whitespace, so a re-wrapped or scrolled-to-end control still matches.
 */
export function insertionTail(expected: string, maxChars = VERIFY_TAIL_CHARS): string {
  const compacted = (expected ?? '').replace(/\s+/g, '')
  return compacted.length <= maxChars ? compacted : compacted.slice(-maxChars)
}

/**
 * Reads the focused control back until the inserted tail shows up.
 *
 * Waits 150 ms, then 300 ms, … (exponential), for at most `attempts` reads and
 * `timeoutMs` of wall clock. `readBack` returns the control's full text, or
 * `null` when nothing readable is focused.
 */
export async function verifyInsertion(
  readBack: () => Promise<string | null>,
  expected: string,
  opts: { timeoutMs?: number; attempts?: number } = {}
): Promise<VerifyInsertionResult> {
  const tail = insertionTail(expected)
  if (!tail) return { ok: true }

  const timeoutMs = Math.max(0, opts.timeoutMs ?? VERIFY_DEFAULT_TIMEOUT_MS)
  const attempts = Math.max(1, Math.floor(opts.attempts ?? VERIFY_DEFAULT_ATTEMPTS))
  const deadline = Date.now() + timeoutMs

  let observed: string | null = null
  let lastText: string | null = null
  let delay = VERIFY_INITIAL_DELAY_MS

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      const wait = Math.min(delay, deadline - Date.now())
      if (wait <= 0) break
      await sleep(wait)
      delay *= 2
    }
    try {
      observed = await readBack()
    } catch {
      observed = null
    }
    if (observed) {
      lastText = observed
      if (observed.replace(/\s+/g, '').includes(tail)) return { ok: true, observed }
    }
  }

  if (lastText) return { ok: false, reason: 'mismatch', observed: lastText }
  if (Date.now() >= deadline) return { ok: false, reason: 'timeout' }
  return { ok: false, reason: 'no-target' }
}

/** One-line log form for an insertion verdict, used by the pipeline. */
export function insertOk(ok: boolean, reason?: string): string {
  return ok ? 'insert verified' : `insert unverified${reason ? `: ${reason}` : ''}`
}

