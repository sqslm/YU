import { shell } from 'electron'
import { isSafeLink } from '@shared/links'

/**
 * Opens a link from untrusted content, refusing anything that is not a plain web
 * or mail address.
 *
 * The answer card renders Markdown straight from a page the model read, and
 * `setWindowOpenHandler` / `will-navigate` are the last gate before the operating
 * system: without this check a single click on `[x](file:///C:/…/calc.exe)` runs a
 * program. Every `shell.openExternal` in the app goes through here.
 */
export function openExternalSafely(raw: string): void {
  if (!isSafeLink(raw)) {
    console.warn('[link] refused to open', raw.slice(0, 160))
    return
  }
  void shell.openExternal(raw)
}
