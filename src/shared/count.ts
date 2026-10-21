/**
 * Text counters shared by the pipeline, history and the insights page.
 *
 * Chinese is counted per character (that is what a user means by "字数"),
 * latin text per whitespace-separated word, and the two are simply added —
 * mixed sentences like "AI 很好用" become 1 + 3 = 4 units, which matches how
 * the vendor's own usage stats read.
 */

/** Matches one CJK ideograph, kana or hangul syllable. */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g
/** Tokens that are not pure punctuation or symbols. */
const WORD = /[A-Za-z0-9][A-Za-z0-9'’_-]*/g

export interface TextCount {
  /** Characters of CJK script. */
  cjk: number
  /** Latin/numeric words. */
  words: number
  /** `cjk + words` — the number shown to the user. */
  units: number
  /** Code points in the text, for the raw "字符" figure. */
  chars: number
}

export function countText(text: string): TextCount {
  if (!text) return { cjk: 0, words: 0, units: 0, chars: 0 }
  const cjk = text.match(CJK)?.length ?? 0
  const withoutCjk = text.replace(CJK, ' ')
  const words = withoutCjk.match(WORD)?.length ?? 0
  return { cjk, words, units: cjk + words, chars: [...text].length }
}

/** The single number stored on a history entry (REQ-07). */
export function countUnits(text: string): number {
  return countText(text).units
}

/**
 * Speaking rate in words per minute. Returns 0 for takes shorter than a
 * second, where the ratio is meaningless noise.
 */
export function speakingWpm(units: number, durationMs: number): number {
  if (durationMs < 1000 || units <= 0) return 0
  return Math.round((units / durationMs) * 60_000)
}

/** Assumed typing rate for the "time saved" figure. */
export const TYPING_WPM = 40

/**
 * Time saved versus typing the same text at `TYPING_WPM`, clamped at zero.
 * Subtracts the time spent speaking, which is what the user actually paid.
 */
export function timeSavedMs(units: number, durationMs: number, typingWpm = TYPING_WPM): number {
  if (units <= 0) return 0
  const typingMs = (units / typingWpm) * 60_000
  return Math.max(0, Math.round(typingMs - durationMs))
}

/**
 * Compact form of a hit counter.
 *
 * Digits up to 999, then `1k` / `1.1k` / `11k` / `999k`, then `1M`. One decimal
 * only below ten (1.1k reads as "a thousand and a bit"); above that the fraction
 * is noise next to the digit it would replace. The exact number stays available
 * in the tooltip, so nothing is actually lost by rounding here.
 */
export function formatHitCount(count: number): string {
  const value = Math.max(0, Math.floor(count))
  if (value < 1000) return String(value)
  const units = ['', 'k', 'M', 'B']
  let scaled = value
  let unit = 0
  while (scaled >= 1000 && unit < units.length - 1) {
    scaled /= 1000
    unit += 1
  }
  let rounded = scaled < 10 ? Math.round(scaled * 10) / 10 : Math.round(scaled)
  // 999_999 would round to "1000k": a four-digit mantissa defeats the point.
  if (rounded >= 1000 && unit < units.length - 1) {
    rounded = Math.round((rounded / 1000) * 10) / 10
    unit += 1
  }
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}${units[unit]}`
}
