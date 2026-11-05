/**
 * Drives the Rust extraction pipeline.
 *
 * Rust decides which task may run, in what order, and when it is due again; this
 * engine only performs the I/O it is told to perform: read the material out of the
 * real stores, hand it back, and let the helper call the configured model. It owns
 * nothing else — no scoring, no segmentation, no merge policy — and it never holds
 * more than one batch in flight, so a burst of new sources cannot turn into a
 * model storm.
 */

import type { Settings } from '@shared/types'
import type { CollectChannel } from '@shared/knowledge'
import type { KnowledgeHost } from './host'
import type { RecoveredBody } from './collector'

/** Extraction that waits for a provider is slow; never busy-poll for it. */
const MAX_IDLE_WAIT_MS = 60_000

export interface ExtractDeps {
  host: () => KnowledgeHost | null
  /** Reads one source body out of the store that owns it. */
  readBody: (channel: CollectChannel, originRef: string) => RecoveredBody
  settings: () => Settings
  /** False while the feature is off, paused or in game mode. */
  allowed: () => boolean
  log?: (line: string) => void
  now?: () => number
  schedule?: (run: () => void, delayMs: number) => { cancel: () => void }
}

const defaultSchedule = (run: () => void, delayMs: number): { cancel: () => void } => {
  const timer = setTimeout(run, delayMs)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

/** A body that is gone turns into a task state, never into a silent retry. */
const missingCode = (missing: 'deleted' | 'temporary' | 'empty' | 'unknown'): string =>
  missing === 'unknown' ? 'internal' : 'source_changed'

const missingReason = (missing: 'deleted' | 'temporary' | 'empty' | 'unknown'): string => {
  switch (missing) {
    case 'deleted':
      return '来源已删除'
    case 'temporary':
      return '来源已转为临时对话'
    case 'empty':
      return '来源正文为空'
    default:
      return '来源暂时无法读取'
  }
}

export class ExtractEngine {
  private readonly deps: ExtractDeps
  private readonly schedule: (run: () => void, delayMs: number) => { cancel: () => void }
  private timer: { cancel: () => void } | null = null
  private busy = false
  private stopped = false

  constructor(deps: ExtractDeps) {
    this.deps = deps
    this.schedule = deps.schedule ?? defaultSchedule
  }

  /** Asks for a tick as soon as the call stack unwinds. */
  wake(): void {
    if (this.stopped) return
    this.at(0)
  }

  stop(): void {
    this.stopped = true
    this.timer?.cancel()
    this.timer = null
  }

  private at(delayMs: number): void {
    if (this.stopped) return
    this.timer?.cancel()
    this.timer = this.schedule(() => {
      this.timer = null
      void this.tick()
    }, Math.max(0, Math.min(delayMs, MAX_IDLE_WAIT_MS)))
  }

  private log(line: string): void {
    this.deps.log?.(line)
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /**
   * Runs at most one batch. Anything that cannot run right now is left in the
   * database exactly as Rust left it: a claim is only ever released by
   * `extract.run` or `extract.fail`.
   */
  async tick(): Promise<void> {
    if (this.busy || this.stopped) return
    const host = this.deps.host()
    if (!host?.running || !this.deps.allowed()) return
    this.busy = true
    try {
      const next = await host.extractNext()
      if (!next.enabled || next.paused) return
      if (!next.group) {
        if (next.nextDueAt !== null) this.at(next.nextDueAt - this.now())
        return
      }
      const group = next.group
      const sources: { sourceId: string; version: string; text: string }[] = []
      for (const ref of group.sources) {
        const body = this.deps.readBody(group.channel, ref.originRef)
        if ('missing' in body) {
          await host.extractFail({
            groupId: group.groupId,
            claim: group.claim,
            code: missingCode(body.missing),
            reason: missingReason(body.missing)
          })
          this.wake()
          return
        }
        sources.push({ sourceId: ref.sourceId, version: ref.version, text: body.text })
      }
      const knowledge = this.deps.settings().knowledge
      const outcome = await host.extractRun({
        groupId: group.groupId,
        claim: group.claim,
        sources,
        profileId: knowledge?.profileId ?? null,
        effort: knowledge?.effort ?? 'high'
      })
      this.log(
        `[knowledge] 提炼 ${group.groupId}：${outcome.state}，卡片 ${outcome.cards.length}，建议 ${outcome.proposals.length}`
      )
      if (outcome.remaining) this.wake()
    } catch (error) {
      // A failed batch must not spin: Rust already moved the task to failed or is
      // still holding the claim, and the next tick retries only what is runnable.
      this.log(`[knowledge] 提炼失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.busy = false
    }
  }
}
