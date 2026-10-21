/**
 * Which link schemes the app is willing to open or render as clickable.
 *
 * Every `href` in this app either comes from a model answer or from a web page
 * the model read, so it is attacker-controlled. Handing
 * `file:///C:/Windows/System32/calc.exe` to `shell.openExternal` is ShellExecute —
 * one click runs a program — and `javascript:`/`data:` are script execution in a
 * privileged renderer. Shared between the main process (the only place that can
 * really open anything) and the card renderer (so no unsafe link is ever drawn as
 * clickable).
 */
export const SAFE_LINK_SCHEMES: readonly string[] = ['http:', 'https:', 'mailto:']

export function isSafeLink(raw: string): boolean {
  let url: URL
  try {
    // Parsing, not prefix matching: `HTTP://`, `https:\\host` and
    // `file:/C:/x` all normalise here, which a `startsWith` check would miss.
    url = new URL(raw.trim())
  } catch {
    return false
  }
  return SAFE_LINK_SCHEMES.includes(url.protocol)
}
