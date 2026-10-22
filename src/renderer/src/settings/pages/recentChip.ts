/** The recorded card name for a compact 最近识别 tag; no provider/model details. */
import type { HistoryEntry } from '@shared/types'

export type RecentChipSource = Pick<HistoryEntry, 'promptName'>

/**
 * Use provenance saved with the take, not the current library selection.
 * Legacy or card-free takes have no card tag.
 */
export function recentChipText(entry: RecentChipSource): string | null {
  return typeof entry.promptName === 'string' ? entry.promptName.trim() || null : null
}
