/** Windows virtual-key codes used by the low-level keyboard hook. */
export const VK = {
  LeftCtrl: 0xa2,
  RightCtrl: 0xa3,
  LeftAlt: 0xa4,
  RightAlt: 0xa5,
  LeftShift: 0xa0,
  RightShift: 0xa1,
  LeftWin: 0x5b,
  RightWin: 0x5c,
  Space: 0x20,
  Tab: 0x09,
  Enter: 0x0d,
  Escape: 0x1b,
  Backspace: 0x08,
  CapsLock: 0x14,
  Insert: 0x2d,
  Delete: 0x2e,
  Home: 0x24,
  End: 0x23,
  PageUp: 0x21,
  PageDown: 0x22
} as const

/** Tokens that map 1:1 to a virtual-key code (modifiers, named keys, F-keys). */
const NAMED: Record<string, number> = {
  ...VK,
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, 0x70 + i] as const)
  )
}

export const KEY_TOKENS = Object.keys(NAMED)

/**
 * Turns a binding token such as "RightAlt", "A", "1" or "F5" into a virtual-key
 * code. Unknown tokens throw so a bad settings file fails loudly at startup.
 */
export function tokenToVk(token: string): number {
  const named = NAMED[token]
  if (named !== undefined) return named
  if (/^[A-Z]$/.test(token)) return token.charCodeAt(0)
  if (/^[0-9]$/.test(token)) return token.charCodeAt(0)
  throw new Error(`unknown key token: ${token}`)
}

/** True for keys that are only meaningful as chord modifiers. */
export function isModifierVk(vk: number): boolean {
  return vk >= 0xa0 && vk <= 0xa5
}

export function vkToToken(vk: number): string | undefined {
  for (const [token, code] of Object.entries(NAMED)) if (code === vk) return token
  if (vk >= 0x30 && vk <= 0x5a) return String.fromCharCode(vk)
  return undefined
}
