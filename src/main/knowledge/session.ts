/**
 * One place that applies "is collection on, and are we in a game" to the helper
 * and then restarts an authorized history walk.
 *
 * The two facts have to travel together: an automatic suspension stops a walk but
 * leaves the job authorized, so once the reason lifts the walk resumes from its
 * checkpoint. Doing that only inside the Electron entry point would make the
 * behaviour untestable; doing it only in the driver would never be called by the
 * real game-mode flow.
 */

import type { KnowledgeCollector } from './collector'
import type { HistoryDriver } from './history'

export interface KnowledgeWiring {
  collector: Pick<KnowledgeCollector, 'sync' | 'enabled'>
  history: Pick<HistoryDriver, 'resume'>
}

/**
 * Mirrors the switch and the game state into the helper, then — only once that
 * configuration is confirmed and only when the feature is on outside a game —
 * lets a still-authorized history job continue. A manually paused job is not
 * touched: `resume()` accepts `running` jobs only.
 */
export async function syncKnowledge(wiring: KnowledgeWiring, game: boolean): Promise<void> {
  await wiring.collector.sync({ game })
  if (!wiring.collector.enabled || game) return
  await wiring.history.resume().catch(() => undefined)
}
