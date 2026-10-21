/**
 * Multi-language translation helpers (REQ-10).
 *
 * Translation mode can deliver up to {@link MAX_TRANSLATE_TARGETS} languages in
 * one take. Everything here is pure so the pipeline stays a thin caller and the
 * request/response shaping is unit-testable without Electron.
 *
 * The wire format is the one the prompt asks for:
 *
 * ```text
 * [en] Hello world
 * [ja] こんにちは世界
 * ```
 *
 * A single target keeps the pre-REQ-10 shape: bare translated text, no label.
 */
import { MAX_TRANSLATE_TARGETS } from './defaults'

/** One translated block, in configuration order. */
export interface TranslateBlock {
  /** Language code exactly as configured, e.g. `en`. */
  target: string
  /** Translated text; empty means the model dropped that target. */
  text: string
}

/** The slice of `Settings` the target resolution needs. */
export interface TranslateTargetSource {
  translateTargets?: readonly string[]
  /** Legacy single-value field, still written by older builds. */
  translateTarget?: string
}

/** Chinese labels for the alerts; unknown codes fall back to the code itself. */
const LANGUAGE_LABELS: Record<string, string> = {
  zh: '中文',
  'zh-cn': '中文',
  'zh-tw': '繁体中文',
  en: '英语',
  ja: '日语',
  ko: '韩语',
  ru: '俄语',
  de: '德语',
  fr: '法语',
  es: '西班牙语',
  it: '意大利语',
  pt: '葡萄牙语',
  ar: '阿拉伯语'
}

/**
 * Resolve the requested targets: `translateTargets` wins, the legacy
 * `translateTarget` is honoured when the array is empty, and the result is
 * trimmed, de-duplicated (case-insensitively) and capped at
 * {@link MAX_TRANSLATE_TARGETS}. A source with nothing usable means `['en']`.
 */
export function resolveTranslateTargets(settings: TranslateTargetSource): string[] {
  const configured = settings.translateTargets
  const raw =
    configured && configured.length > 0 ? configured : [settings.translateTarget ?? '']
  const seen = new Set<string>()
  const targets: string[] = []
  for (const item of raw) {
    const code = (item ?? '').trim()
    if (!code) continue
    if (seen.has(code.toLowerCase())) continue
    seen.add(code.toLowerCase())
    targets.push(code)
    if (targets.length >= MAX_TRANSLATE_TARGETS) break
  }
  return targets.length > 0 ? targets : ['en']
}

/** Display label for a language code (`ja` -> `日语`). */
export function languageLabel(code: string): string {
  return LANGUAGE_LABELS[code.trim().toLowerCase()] ?? code
}

/** True when `code` is one of the requested targets, subtags included. */
export function hasLanguage(targets: readonly string[], code: string): boolean {
  const wanted = code.trim().toLowerCase()
  if (!wanted) return false
  const primary = wanted.split('-')[0]!
  return targets.some((target) => {
    const known = target.trim().toLowerCase()
    return known === wanted || known.split('-')[0] === primary
  })
}

/**
 * The format block appended to the translate card when more than one target is
 * requested: one request, one labelled line per target, in the given order.
 */
export function multiTargetInstruction(targets: readonly string[]): string {
  const order = targets.join(', ')
  const samples = targets.map((code) => `[${code}] …`).join('\n')
  return [
    '',
    `这次要同时给出 ${targets.length} 个目标语言的译文，顺序固定：${order}。`,
    'Return one line per target in the order given, each line prefixed with [<code>].',
    '示例：',
    samples,
    '- 行首标签必须是方括号加语言码，标签之间不要有空行、不要合并也不要遗漏目标。',
    '- 不要输出原文、语言名称、解释或任何额外说明。'
  ].join('\n')
}

/**
 * One `[code] text` (or `【code】text`) label.
 *
 * `null` means the line is a plain continuation line, `'foreign'` means it is
 * labelled with a language nobody asked for — that has to close the current
 * block instead of being appended to it, or one stray `[fr]` line would end up
 * inside the previous target's translation.
 */
function readLabel(
  line: string,
  targets: readonly string[]
): { target: string; rest: string } | 'foreign' | null {
  const match = /^\s*(?:[-*•>]\s*)?(?:\[([^\]]{1,16})\]|【([^】]{1,16})】)\s*[:：]?\s*(.*)$/.exec(
    line
  )
  if (!match) return null
  const rawCode = (match[1] ?? match[2] ?? '').trim()
  if (!rawCode) return 'foreign'
  const wanted = rawCode.toLowerCase()
  const primary = wanted.split('-')[0]!
  const exact = targets.find((target) => target.toLowerCase() === wanted)
  // A region-tagged reply (`zh-CN` for `zh`) is accepted only when one target
  // claims that language, so `[en]` can never be filed under `zh`.
  const fuzzy = exact ?? targets.find((target) => target.toLowerCase().split('-')[0] === primary)
  if (!fuzzy) return 'foreign'
  return { target: fuzzy, rest: match[3] ?? '' }
}

/**
 * Split a multi-target reply into per-target blocks, in the order of `targets`.
 * Targets the model skipped are absent from the result — the caller decides
 * whether that is a partial success or a hard failure.
 */
export function parseTargetBlocks(raw: string, targets: readonly string[]): TranslateBlock[] {
  const collected = new Map<string, string[]>()
  let current: string | null = null

  for (const line of raw.split(/\r?\n/)) {
    const labelled = readLabel(line, targets)
    if (labelled === 'foreign') {
      // A label for a language that was not requested: drop it and stop
      // collecting, so the text never leaks into the previous target.
      current = null
      continue
    }
    if (labelled) {
      current = labelled.target
      if (!collected.has(current)) collected.set(current, [])
      if (labelled.rest.trim()) collected.get(current)!.push(labelled.rest.trimEnd())
      continue
    }
    if (current) collected.get(current)!.push(line)
  }

  const blocks = targets
    .map((target) => ({ target, text: (collected.get(target) ?? []).join('\n').trim() }))
    .filter((block) => block.text.length > 0)

  if (blocks.length === 0 && targets.length > 1) {
    // A model that ignored the labels but still answered per paragraph: adopt a
    // positional reading instead of throwing the whole take away.
    const paragraphs = raw
      .split(/\r?\n\s*\r?\n/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean)
    if (paragraphs.length === targets.length) {
      return targets.map((target, index) => ({ target, text: paragraphs[index]! }))
    }
  }

  return blocks
}

/** Targets that produced no text at all. */
export function missingTargets(
  blocks: readonly TranslateBlock[],
  targets: readonly string[]
): string[] {
  return targets.filter((target) => !blocks.some((block) => block.target === target))
}

/**
 * The text that gets inserted. With one requested target the output stays bare
 * (backwards compatible); with several, every block is labelled and ordered.
 */
export function formatTranslateOutput(
  blocks: readonly TranslateBlock[],
  targets: readonly string[]
): string {
  const requested = targets.length > 0 ? targets : blocks.map((block) => block.target)
  const ordered = requested
    .map((target) => blocks.find((block) => block.target === target))
    .filter((block): block is TranslateBlock => Boolean(block && block.text.trim()))
  if (requested.length <= 1) return ordered.map((block) => block.text).join('\n\n')
  // A labelled block per target, separated by a rule. The label carries the human
  // language name: the output is pasted into documents, where `[en]` reads like
  // leftover tooling noise.
  return ordered
    .map((block) => `${languageLabel(block.target)}\n${block.text}`)
    .join('\n\n---\n\n')
}

/**
 * Best-effort language of a transcript, read from its writing system.
 *
 * Only scripts that identify a single language are reported (`ja`, `ko`, `ru`,
 * `zh`); Latin text stays `null` because `en`/`es`/`fr` are indistinguishable
 * here. Callers must treat `null` as "unknown", never as a guess.
 */
export function detectTranscriptLanguage(text: string): string | null {
  const body = text.replace(/\s+/g, '')
  if (!body) return null
  // Japanese mixes kana with Han characters, so kana has to win over Han.
  if (/[\u3040-\u30ff]/.test(body)) return 'ja'
  if (/[\uac00-\ud7af\u1100-\u11ff]/.test(body)) return 'ko'
  if (/[\u0400-\u04ff]/.test(body)) return 'ru'
  if (/[\u4e00-\u9fff]/.test(body)) return 'zh'
  return null
}
