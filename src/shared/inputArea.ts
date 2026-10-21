/**
 * Coarse "what kind of field is the caret in" hint (REQ-02 / ACC-03 step 5).
 *
 * The prompt builder uses it to pick a register: a terminal wants the spoken
 * words verbatim, a document wants punctuation and paragraphing, a chat box wants
 * neither. It is a heuristic over the UI Automation snapshot plus the foreground
 * app name, and it refuses to guess: a wrong `chat` label silently rewrites the
 * user's email opener, while `unknown` merely skips one prompt line.
 */
import type { InputAreaType } from './types'

export interface InputAreaHint {
  /** UIA control type name from `UiaSnapshot.controlType` (`edit`, `document`, …). */
  controlType?: string
  /** UIA class name, e.g. `Chrome_RenderWidgetHostHWND`, `ConsoleWindowClass`. */
  className?: string
  /** Foreground application name or window title, used for the chat heuristic. */
  appName?: string
  /** Read-only controls are never an insertion target. */
  readOnly?: boolean
}

/** Terminals echo keystrokes literally, so the model must not add punctuation. */
const TERMINAL = [/consolewindowclass/i, /mintty/i, /windowsterminal/i, /cascadia/i]

/** Rich surfaces that behave like documents even when UIA calls them panes. */
const DOCUMENT = [
  /chrome_renderwidgethosthwnd/i,
  /mozilla/i,
  /internet explorer_server/i,
  /scintilla/i,
  /^word/i
]

/** Plain single-line / multi-line edit boxes (`Edit`, `TEdit`, `RichEdit20W`, …). */
const EDIT = [/edit$/i, /richedit/i, /^textbox$/i, /^wpftextbox$/i, /^javax\.swing/i]

/** Apps whose primary input is a chat composer. */
const CHAT_APP = /wechat|slack|discord|telegram|whatsapp|feishu|lark|dingtalk|qq|messenger/i

/**
 * `unknown` means "say nothing to the model", which is also what happens for
 * read-only controls: dictation into a read-only field is a bug, not a register.
 */
export function inferInputAreaType(hint: InputAreaHint | null | undefined): InputAreaType {
  if (!hint || hint.readOnly) return 'unknown'
  const control = (hint.controlType ?? '').trim().toLowerCase()
  const className = hint.className ?? ''
  const appName = hint.appName ?? ''

  if (TERMINAL.some((pattern) => pattern.test(className))) return 'terminal'
  if (CHAT_APP.test(appName)) return 'chat'
  if (control === 'document') return 'document'
  if (control === 'edit') {
    // UIA reports every browser text field as an edit inside a render widget;
    // the class is what distinguishes "somewhere in a page" from a real edit box.
    if (DOCUMENT.some((pattern) => pattern.test(className))) return 'document'
    return 'edit'
  }
  if (EDIT.some((pattern) => pattern.test(className))) return 'edit'
  if (DOCUMENT.some((pattern) => pattern.test(className))) return 'document'
  return 'unknown'
}
