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
  /** Woken only after the switch and the game state have been confirmed. */
  engine?: { wake: () => void; abort?: (reason?: string) => void }
}

/**
 * Mirrors the switch and the game state into the helper, then — only once that
 * configuration is confirmed and only when the feature is on outside a game —
 * lets a still-authorized history job continue. A manually paused job is not
 * touched: `resume()` accepts `running` jobs only.
 */
export async function syncKnowledge(wiring: KnowledgeWiring, game: boolean): Promise<void> {
  await wiring.collector.sync({ game })
  if (!wiring.collector.enabled || game) {
    // A batch already waiting for a provider must not finish after the switch
    // closed. Telling the helper to cancel is the fast path; Rust re-checks the
    // configuration before it writes anything either way.
    wiring.engine?.abort?.(game ? '游戏模式已开启' : '采集已关闭')
    return
  }
  await wiring.history.resume().catch(() => undefined)
  // Extraction looks for one runnable batch; Rust decides whether anything is due.
  wiring.engine?.wake()
}
