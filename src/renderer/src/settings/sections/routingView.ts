/**
 * Pure list math for the "窗口归类" page.
 *
 * The page used to be one flat table with a per-row 归类 select. It now renders
 * one self-contained block per prompt kind, so two questions got a single right
 * answer each: "which rules belong to this block, in what order" and "is this
 * block open by default". Both live here instead of inline in the component,
 * the same way `providerProfilesView.ts` keeps its drag math out of the drag
 * handlers — it makes them testable without a browser or a DOM.
 */
import type { AppRule, PromptKind } from '@shared/types'

/**
 * Block order on the page: AI → 润色 → 翻译 → 文档 → 邮件.
 *
 * Declared here rather than reusing `PROMPT_KINDS`: that constant belongs to the
 * pipeline (the order prompt kinds are registered and iterated in), while this
 * is a presentation decision. Keeping them separate means reordering the blocks
 * cannot accidentally reorder anything the pipeline does.
 */
export const RULE_GROUP_ORDER: readonly PromptKind[] = [
  'ai',
  'polish',
  'translate',
  'document',
  'email'
]

/** One block of the page: a kind plus the rules the user filed under it. */
export interface RuleGroup {
  kind: PromptKind
  rules: AppRule[]
}

/**
 * Runtime guard for `kind`. Settings arrive from disk and from older app
 * versions, so a value that types as `PromptKind` is still worth checking
 * before it is used to pick a label out of a record.
 */
export function isPromptKind(value: unknown): value is PromptKind {
  return typeof value === 'string' && (RULE_GROUP_ORDER as readonly string[]).includes(value)
}

/**
 * Split `rules` into one group per kind.
 *
 * Always five groups, always in `RULE_GROUP_ORDER`, including the empty ones:
 * the block is also where the user adds the *first* rule of a kind, so hiding an
 * empty block would hide the only way to create that kind of rule.
 *
 * Within a group the stored order of `appRules` is preserved. That order is the
 * routing priority (`matchAppRule` takes the first hit), so the page has to read
 * as "the list I saved" rather than as a re-sorted view.
 *
 * Rules whose `kind` is not one of the five are dropped: no block could ever
 * show them, and quietly bucketing them into 润色 would move a rule the user
 * wrote somewhere they never put it.
 */
export function groupRules(rules: readonly AppRule[]): RuleGroup[] {
  const groups: RuleGroup[] = RULE_GROUP_ORDER.map((kind) => ({ kind, rules: [] }))
  const buckets = new Map<PromptKind, RuleGroup>(groups.map((group) => [group.kind, group]))
  // Defensive: hand-edited settings can carry a non-array here, and this page
  // must still render an (empty) five-block layout instead of throwing.
  const source = Array.isArray(rules) ? rules : []
  for (const rule of source) {
    const bucket = buckets.get(rule.kind)
    if (!bucket) continue
    bucket.rules.push(rule)
  }
  return groups
}

/** The rules of one kind, in stored order. An unknown kind has no rules. */
export function rulesOfKind(rules: readonly AppRule[], kind: PromptKind): AppRule[] {
  if (!isPromptKind(kind)) return []
  return (Array.isArray(rules) ? rules : []).filter((rule) => rule.kind === kind)
}

/** How many rules are filed under `kind`; the "N 条" next to a block title. */
export function countOf(rules: readonly AppRule[], kind: PromptKind): number {
  return rulesOfKind(rules, kind).length
}

/**
 * Stamp `kind` onto a rule body.
 *
 * A block decides the kind, so the row no longer carries a select: the kind is
 * assigned once, at creation, by whoever asked for the rule (a block's "+ 新增
 * 规则", or the window picker). Spreading instead of mutating keeps the caller's
 * draft object reusable and lets a test assert the input was left alone.
 */
export function withKind<T extends object>(rule: T, kind: PromptKind): T & { kind: PromptKind } {
  return { ...rule, kind }
}

/**
 * Default expanded state of a block: open when it has rules, collapsed when it
 * is empty.
 *
 * Only the *default* — the page keeps the user's manual toggles separately, so
 * this must stay a pure function of the group (`0 条` blocks are the ones that
 * would otherwise waste a screenful of empty panes).
 */
export function groupDefaultOpen(group: RuleGroup): boolean {
  return group.rules.length > 0
}
