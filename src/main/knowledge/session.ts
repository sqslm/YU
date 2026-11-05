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

import type { CollectChannel } from '@shared/knowledge'
import type { KnowledgeCollector } from './collector'
import type { HistoryDriver } from './history'

export interface KnowledgeWiring {
  collector: Pick<KnowledgeCollector, 'sync' | 'enabled'>
  history: Pick<HistoryDriver, 'resume'>
  /** Woken only after the switch and the game state have been confirmed. */
  engine?: {
    wake: () => void
    park?: (reason?: string) => Promise<void>
    abortChannel?: (channel: CollectChannel, reason?: string) => void
  }
}

/**
 * Mirrors the switch and the game state into the helper, then — only once that
 * configuration is confirmed and only when the feature is on outside a game —
 * lets a still-authorized history job continue. A manually paused job is not
 * touched: `resume()` accepts `running` jobs only.
 */
export async function syncKnowledge(wiring: KnowledgeWiring, game: boolean): Promise<void> {
  // The collector knows which channels the helper was told about, so a channel
  // that was closed by this very call is reported instead of guessed.
  const { closed } = await wiring.collector.sync({ game })
  if (!wiring.collector.enabled || game) {
    // A batch already waiting for a provider must not finish after the switch
    // closed, and the caller stops the helper right after this: waiting for the
    // release keeps a normal pause from looking like a crash on the next start.
    await wiring.engine?.park?.(game ? '游戏模式已开启' : '采集已关闭')
    return
  }
  // A channel that was closed mid-batch cannot be written any more, so its batch is
  // stopped now instead of paying for an answer Rust would refuse.
  for (const name of closed) wiring.engine?.abortChannel?.(name)
  await wiring.history.resume().catch(() => undefined)
  // Extraction looks for one runnable batch; Rust decides whether anything is due.
  wiring.engine?.wake()
}
