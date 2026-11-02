/**
 * Turning a failed search into something worth reading.
 *
 * Two layers of noise sit between the real reason and the dialog: Electron wraps
 * every rejected `invoke` in `Error invoking remote method 'channel': Error: …`,
 * and the raw Electron text for a channel the main process does not know is
 * `No handler registered for 'workspace:search'` — true, but it tells the user
 * nothing they can act on. That case only happens when the renderer is newer than
 * the running main process (a hot-reloaded window over a stale process), so the
 * one useful instruction is "restart".
 */

/** Electron's wrapper: `Error invoking remote method 'x': Error: <message>`. */
const INVOKE_PREFIX = /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/

/** `No handler registered for 'channel'` — main is older than this window. */
const MISSING_HANDLER = /^No handler registered for '[^']*'\s*$/

export function searchErrorText(error: unknown, translate: (key: string) => string): string {
  const raw = (error instanceof Error ? error.message : String(error ?? '')).replace(INVOKE_PREFIX, '').trim()
  if (!raw) return translate('搜索失败，请重试')
  if (MISSING_HANDLER.test(raw)) return translate('搜索需要重启 YU 后才能使用')
  return translate(raw)
}
