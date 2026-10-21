/**
 * `get_selection`: read whatever the user has selected in the foreground app.
 *
 * Windows has no public "give me the selection" API that works across apps, so
 * the only reliable route is the universal one: put the current clipboard
 * aside, send Ctrl+C, read the new clipboard, then put the old clipboard back.
 * That is intrusive by nature, hence three guards:
 *
 * - the original clipboard is always restored (even when nothing was selected);
 * - the whole probe is bounded by a short timeout;
 * - an unchanged clipboard is reported as "no selection", never as the old
 *   clipboard content.
 *
 * `electron` and `koffi` are imported lazily: this module is pulled in by the
 * tool registry, which is unit-tested in plain Node where neither exists.
 */
import { mt } from '@shared/mainI18n'


export interface SelectionDeps {
  readClipboard: () => string
  writeClipboard: (text: string) => void
  /** Sends Ctrl+C to the focused window. */
  sendCopy: () => Promise<void>
  wait: (ms: number) => Promise<void>
}

export interface SelectionResult {
  ok: boolean
  text?: string
  error?: string
}

export interface SelectionOptions {
  deps?: Partial<SelectionDeps>
  /** Total budget for the clipboard to change. */
  timeoutMs?: number
  pollMs?: number
}

const VK_CONTROL = 0x11
const VK_C = 0x43
const KEYEVENTF_KEYUP = 0x0002

type KeybdEvent = (virtualKey: number, scan: number, flags: number, extra: number) => void

let keybdEvent: KeybdEvent | null = null

/**
 * Minimal `keybd_event` copy: Ctrl down, C down, C up, Ctrl up. `insert.ts`
 * owns paste-through-SendInput; this is the read-only sibling used by
 * `get_selection`.
 */
async function sendCopyKey(): Promise<void> {
  if (!keybdEvent) {
    const koffi = (await import('koffi')).default
    const user32 = koffi.load('user32.dll')
    keybdEvent = user32.func(
      'void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)'
    ) as KeybdEvent
  }
  keybdEvent(VK_CONTROL, 0, 0, 0)
  keybdEvent(VK_C, 0, 0, 0)
  keybdEvent(VK_C, 0, KEYEVENTF_KEYUP, 0)
  keybdEvent(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0)
}

async function defaultDeps(): Promise<SelectionDeps> {
  const { clipboard } = await import('electron')
  return {
    readClipboard: () => clipboard.readText(),
    writeClipboard: (text: string) => {
      clipboard.writeText(text)
    },
    sendCopy: sendCopyKey,
    wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  }
}

async function withDefaults(overrides: Partial<SelectionDeps>): Promise<SelectionDeps | null> {
  if (overrides.readClipboard && overrides.writeClipboard && overrides.sendCopy && overrides.wait) {
    return overrides as SelectionDeps
  }
  try {
    const base = await defaultDeps()
    return { ...base, ...overrides }
  } catch {
    return null
  }
}

/** Reads the current selection, restoring the clipboard on the way out. */
export async function getSelection(options: SelectionOptions = {}): Promise<SelectionResult> {
  const deps = await withDefaults(options.deps ?? {})
  if (!deps) return { ok: false, error: '无法访问剪贴板' }

  const timeoutMs = options.timeoutMs ?? 300
  const pollMs = options.pollMs ?? 30

  let previous = ''
  try {
    previous = deps.readClipboard()
  } catch {
    return { ok: false, error: '无法读取剪贴板' }
  }

  try {
    await deps.sendCopy()
  } catch (err) {
    return {
      ok: false,
      error: mt('无法发送复制快捷键：{{message}}', {
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }

  let captured = ''
  let elapsed = 0
  while (elapsed < timeoutMs) {
    await deps.wait(pollMs)
    elapsed += pollMs
    let current = ''
    try {
      current = deps.readClipboard()
    } catch {
      break
    }
    if (current !== previous) {
      captured = current
      break
    }
  }

  // Restore before reporting: the user must never lose their clipboard because
  // an assistant asked a question.
  try {
    if (deps.readClipboard() !== previous) deps.writeClipboard(previous)
  } catch {
    // A failed restore is not worth failing the tool over.
  }

  const text = captured.trim()
  if (!text) return { ok: false, error: '没有选中文字' }
  return { ok: true, text: captured }
}
