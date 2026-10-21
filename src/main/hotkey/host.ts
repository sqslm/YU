import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import type { HotkeyEvent, Mode, Settings } from '@shared/types'
import { mt } from '@shared/mainI18n'

const here = __dirname

/**
 * Events the hook child reports. `cancel` (ESC while recording, or a discarded
 * tap that armed the double-press window) is not part of the shared
 * `HotkeyEvent` union yet, so it is declared here next to it.
 */
export type HotkeyCancelEvent = {
  type: 'cancel'
  at: number
  /** `esc` = user abandoned the take, `tap` = press too short to be speech. */
  reason?: 'esc' | 'tap'
  mode?: Mode
}
export type HotkeyLockEvent = { type: 'lock'; at: number; mode: Mode }
/** The notes chord (Ctrl+Alt+N by default): open 随记 and toggle its recorder. */
export type HotkeyNotesEvent = { type: 'notes-toggle'; at: number }
/**
 * ESC pressed while the answer card was up. The card window is shown inactive, so
 * its own keydown handler never runs; the hook is the only thing that sees the key.
 */
export type HotkeyEscapeEvent = { type: 'esc'; at: number }
export type HotkeyHostEvent =
  | HotkeyEvent
  | HotkeyCancelEvent
  | HotkeyLockEvent
  | HotkeyNotesEvent
  | HotkeyEscapeEvent

export type HotkeyMessage =
  | HotkeyHostEvent
  | { type: 'ready' }
  | { type: 'error'; message: string }
  /** Keys the child dropped because the OS said they were no longer held. */
  | { type: 'stale'; keys: number[] }
  /** Free-form trace line, forwarded verbatim to the diagnostics log. */
  | { type: 'log'; line: string }

/**
 * Owns the native keyboard hook, which lives in a utilityProcess so a stuck
 * message pump or a native fault can never freeze the UI. Restarts the child if
 * it dies: an uninstalled hook means the user loses dictation entirely.
 */
export class HotkeyHost {
  private proc: UtilityProcess | null = null
  private settings: Settings | null = null
  private restarts = 0
  /** Set by `stop()` so a deliberate teardown is not mistaken for a crash. */
  private stopping = false
  /** Mirrors the answer card's visibility in the hook; see `setCardOpen`. */
  private cardOpen = false

  constructor(
    private readonly onEvent: (event: HotkeyHostEvent) => void,
    private readonly onLog: (line: string) => void = () => {}
  ) {}

  start(settings: Settings): void {
    this.settings = settings
    this.stopping = false
    this.restarts = 0
    this.spawn()
  }

  private spawn(): void {
    const entry = join(here, 'hotkey.js')
    this.onLog(`[hotkey] spawning ${entry}`)
    const child = utilityProcess.fork(entry, [], {
      serviceName: 'typeless-hotkey',
      stdio: 'inherit'
    })
    this.proc = child

    child.on('message', (message: unknown) => {
      const msg = message as HotkeyMessage
      if (msg.type === 'ready') {
        this.onLog('[hotkey] ready')
        this.pushConfig()
        return
      }
      if (msg.type === 'error') {
        this.onLog(`[hotkey] error: ${msg.message}`)
        return
      }
      if (msg.type === 'stale') {
        // Proof that the self-heal ran; without this line a stuck-key recovery
        // would be invisible in the diagnostics log.
        const names = msg.keys.map((vk) => `0x${vk.toString(16)}`)
        this.onLog(`[hotkey] released stale keys: ${names.join(',')}`)
        return
      }
      if (msg.type === 'log') {
        // The hook's own trace. Without it, "pressing right Alt does nothing"
        // is indistinguishable from "the hook never saw the key".
        this.onLog(msg.line)
        return
      }
      this.onEvent(msg)
    })

    child.on('exit', (code) => {
      this.onLog(`[hotkey] exited with ${code}`)
      this.proc = null
      // A teardown we asked for is not a crash. Restarting here is how quitting
      // the app used to leave an orphan hook process still swallowing keys.
      if (this.stopping) return
      this.restarts += 1
      // The hook is the only way to dictate, so it must keep coming back. Fast
      // retries cover a transient crash; past five, back off to half a minute so
      // a systematic failure (locked-down session, antivirus quarantine) does not
      // spin forever while the tray still claims the shortcut works.
      const delay = this.restarts <= 5 ? 800 : 30_000
      if (this.restarts === 6) {
        this.onLog('[hotkey] restarts are not sticking, backing off')
        this.onEvent({
          type: 'error',
          message: mt('键盘钩子反复退出，快捷键可能暂时失效（已在后台重试）')
        })
      }
      setTimeout(() => {
        if (!this.stopping) this.spawn()
      }, delay)
    })
  }

  /** Pushes the current shortcuts (and enabled flag) to the hook process. */
  apply(settings: Settings): void {
    this.settings = settings
    this.pushConfig()
  }

  private pushConfig(): void {
    const settings = this.settings
    if (!settings || !this.proc) return
    const bindings: Record<string, string[]> = {}
    for (const [mode, binding] of Object.entries(settings.hotkeys.bindings)) {
      bindings[mode] = binding.keys
    }
    this.proc.postMessage({
      type: 'config',
      bindings,
      pasteLast: settings.hotkeys.pasteLastKeys.keys,
      notes: settings.hotkeys.notesKeys?.keys ?? [],
      activation: settings.activationMode
    })
    this.proc.postMessage({ type: 'enabled', value: settings.hotkeys.enabled })
    // A re-spawned child starts with the card flag cleared; restore it so ESC
    // keeps working on a card that was already up when the hook restarted.
    this.proc.postMessage({ type: 'card', open: this.cardOpen })
    this.onLog(`[hotkey] config activation=${settings.activationMode} enabled=${settings.hotkeys.enabled}`)
    this.onLog(`[hotkey] notes chord ${(settings.hotkeys.notesKeys?.keys ?? []).join('+') || '(none)'}`)
  }

  /**
   * Tells the hook whether the answer card is on screen.
   *
   * While it is, ESC belongs to the card: the hook swallows it and reports
   * `esc`, which is the only way to close a window that never takes focus.
   */
  setCardOpen(open: boolean): void {
    this.cardOpen = open
    this.proc?.postMessage({ type: 'card', open })
  }

  /**
   * Forgets every key the child still believes is held.
   *
   * Used by the "reset keyboard" action: after releasing modifiers at the OS
   * level, the hook must not keep a chord half-pressed, or the next press looks
   * like a completion instead of a start.
   */
  reset(): void {
    this.proc?.postMessage({ type: 'reset' })
    this.onLog('[hotkey] state reset')
  }

  stop(): void {
    this.stopping = true
    this.proc?.kill()
    this.proc = null
  }
}
