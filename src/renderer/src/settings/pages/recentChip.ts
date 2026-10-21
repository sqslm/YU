/**
 * The one-line provenance caption of a 最近识别 row.
 *
 * A take is produced by a prompt card (`promptKind` + `promptName`) answered by a
 * saved provider profile (`providerName`), both written by `pipeline.record`.
 * Entries written before those fields existed carry neither, and a row that
 * invented "未记录" for them would put noise on every old line — so the caption
 * is `null` and the page renders nothing.
 *
 * Kept out of `Home.tsx` because the string is the part worth testing: the
 * component must not grow a second text line (the page fits one window with no
 * scrolling), so the caption hangs off the existing meta line and has to be
 * right the first time.
 */
import type { HistoryEntry } from '@shared/types'
import { PROMPT_KIND_LABEL } from '@shared/promptLibrary'
import i18n from '../../i18n'

export type RecentChipSource = Pick<HistoryEntry, 'promptKind' | 'promptName' | 'providerName'>

function trimmed(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * `润色 · 默认提示词 · cn.deepseek-v4.1-flash`, or `null` for a legacy take.
 *
 * The kind label is only a prefix: without a card name and a provider there is
 * nothing to identify, and `润色` alone would describe the routing rather than
 * the take. The provider is dropped when it repeats the card name, which happens
 * for a builtin card whose name the user renamed to match the profile.
 */
export function recentChipText(entry: RecentChipSource): string | null {
  const name = trimmed(entry.promptName)
  const provider = trimmed(entry.providerName)
  if (name.length === 0 && provider.length === 0) return null

  const parts: string[] = []
  const kind = entry.promptKind
  // `history.json` is user-editable, so the kind is checked against the label
  // table instead of being trusted: an unknown value is simply skipped.
  if (kind && Object.prototype.hasOwnProperty.call(PROMPT_KIND_LABEL, kind)) {
    parts.push(i18n.t(PROMPT_KIND_LABEL[kind]))
  }
  if (name.length > 0) parts.push(name)
  if (provider.length > 0 && provider !== name) parts.push(provider)
  return parts.join(' · ')
}