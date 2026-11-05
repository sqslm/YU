/**
 * Drives the Rust extraction pipeline.
 *
 * Rust decides which task may run, in what order, and when it is due again; this
 * engine only performs the I/O it is told to perform: read the exact character
 * ranges the helper asked for out of the real stores, hand them back, and let the
 * helper call the configured model. It owns nothing else — no scoring, no
 * segmentation, no merge policy.
 *
 * One wake drains the whole runnable backlog: the loop keeps asking for the next
 * task until Rust reports nothing left, so a scan that queued ten groups does not
 * need ten user actions. Only one batch is ever in flight.
 */

import { createHash } from 'node:crypto'

import type { Settings } from '@shared/types'
import type { CollectChannel, ExtractGroup, ExtractSourceInput } from '@shared/knowledge'
import { KnowledgeError } from '@shared/knowledge'
import type { KnowledgeHost } from './host'
import type { RecoveredBody } from './collector'

/** Extraction that waits for a provider is slow; never busy-poll for it. */
const MAX_IDLE_WAIT_MS = 60_000

/** A source that cannot be read for a reason Rust has to know about. */
class MissingSource extends Error {
  constructor(
    message: string,
    readonly code: string = 'source_changed'
  ) {
    super(message)
  }
}

export interface ExtractDeps {
  host: () => KnowledgeHost | null
  /**
   * Reads one source body out of the store that owns it. Reading sources come
   * from the in-memory stash, which holds exactly the text that was published.
   */
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

/** The whole-body hash the helper compares with the version it stored. */
const fingerprintOf = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex')

export class ExtractEngine {
  private readonly deps: ExtractDeps
  private readonly schedule: (run: () => void, delayMs: number) => { cancel: () => void }
  private timer: { cancel: () => void } | null = null
  private busy = false
  private stopped = false
  private again = false
  private runningChannel: CollectChannel | null = null
  private inflight: Promise<void> | null = null

  constructor(deps: ExtractDeps) {
    this.deps = deps
    this.schedule = deps.schedule ?? defaultSchedule
  }

  /** Asks for a tick as soon as the call stack unwinds. */
  wake(): void {
    if (this.stopped) return
    if (this.busy) {
      // A wake that lands mid-batch must survive it: the loop ends when Rust says
      // there is nothing left, which may already be past whatever was queued here.
      this.again = true
      return
    }
    this.at(0)
  }

  /**
   * Stops the batch that is waiting for a provider. Rust re-checks the switch and
   * the pause state before it writes, so this is only the fast path: the claim is
   * always released by `extract.run` or `extract.fail`.
   */
  abort(reason = '采集已暂停'): void {
    this.deps.host()?.cancelInFlight(reason)
  }

  /**
   * Stops the in-flight batch and waits until its claim was really released.
   *
   * The caller stops the helper right after a control operation, so the `extract.fail`
   * that parks the task has to reach Rust before the process goes away; otherwise the
   * next start repairs the task as failed and a pause looks like a crash.
   */
  async park(reason = '采集已暂停'): Promise<void> {
    this.abort(reason)
    const inflight = this.inflight
    if (inflight) await inflight
  }

  /** Stops only a batch that belongs to this channel. */
  abortChannel(channel: CollectChannel, reason = '来源渠道已关闭'): void {
    if (this.runningChannel === channel) this.abort(reason)
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
   * Drains every task that is runnable right now. A batch that cannot run leaves
   * its task exactly as Rust left it; every claimed task that fails after the
   * claim is settled through `extract.fail`, so nothing stays `working` forever.
   */
  async tick(): Promise<void> {
    if (this.stopped) return
    if (this.busy) {
      this.again = true
      return
    }
    const host = this.deps.host()
    if (!host?.running || !this.deps.allowed()) return
    this.busy = true
    try {
      for (;;) {
        if (this.stopped || !this.deps.allowed()) break
        const next = await host.extractNext()
        if (!next.enabled || next.paused) break
        if (!next.group) {
          if (next.nextDueAt !== null) this.at(next.nextDueAt - this.now())
          break
        }
        const settled = await this.runGroup(host, next.group)
        if (!settled) break
      }
    } catch (error) {
      // The helper itself failed: the claim is recovered when it restarts, and the
      // next explicit wake retries. Never spin here.
      this.log(`[knowledge] 提炼中断：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.busy = false
    }
    if (this.again && !this.stopped) {
      this.again = false
      this.at(0)
    }
  }

  /** Runs one claimed batch. Returns false when the loop should stop. */
  private async runGroup(host: KnowledgeHost, group: ExtractGroup): Promise<boolean> {
    this.runningChannel = group.channel
    const done = this.execute(host, group)
    this.inflight = done.then(
      () => undefined,
      () => undefined
    )
    try {
      return await done
    } finally {
      this.inflight = null
      this.runningChannel = null
    }
  }

  /**
   * Everything after the claim lives inside one settlement boundary: whatever throws
   * releases the claim with a real reason, so a source store that raises is not
   * mistaken for a deletion and no task stays `working` while the helper is alive.
   */
  private async execute(host: KnowledgeHost, group: ExtractGroup): Promise<boolean> {
    let items: ExtractSourceInput[]
    try {
      items = this.read(group)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (error instanceof MissingSource) {
        await this.settle(host, group, error.code, reason)
        return true
      }
      this.log(`[knowledge] 读取正文失败：${reason}`)
      await this.settle(host, group, 'internal', `读取正文失败：${reason}`)
      return true
    }
    return this.run(host, group, items)
  }

  /** Slices the planned ranges out of the stores; throws on a real read failure. */
  private read(group: ExtractGroup): ExtractSourceInput[] {
    const texts = new Map<string, string[]>()
    const hashes = new Map<string, string>()
    const items: ExtractSourceInput[] = []
    for (const item of group.items) {
      const ref = group.sources.find(source => source.sourceId === item.sourceId)
      if (!ref) throw new MissingSource('来源已不属于该任务')
      let chars = texts.get(item.sourceId)
      if (!chars) {
        const body = this.deps.readBody(group.channel, ref.originRef)
        if ('missing' in body) {
          // A reading body lives only in memory: once it is gone the task needs a
          // real re-read instead of being failed or silently retried.
          const gone = group.channel === 'reading' && body.missing === 'unknown'
          throw new MissingSource(
            gone ? '正文已不在内存' : missingReason(body.missing),
            gone ? 'needs_reread' : missingCode(body.missing)
          )
        }
        chars = Array.from(body.text)
        texts.set(item.sourceId, chars)
        hashes.set(item.sourceId, fingerprintOf(body.text))
      }
      const slice = chars.slice(item.start, item.end).join('')
      items.push({
        sourceId: item.sourceId,
        version: item.version,
        fingerprint: hashes.get(item.sourceId) ?? '',
        segment: item.segment,
        start: item.start,
        end: item.end,
        text: slice
      })
    }
    return items
  }

  private async run(host: KnowledgeHost, group: ExtractGroup, items: ExtractSourceInput[]): Promise<boolean> {
    const knowledge = this.deps.settings().knowledge
    try {
      const outcome = await host.extractRun({
        groupId: group.groupId,
        claim: group.claim,
        items,
        profileId: knowledge?.profileId ?? null,
        effort: knowledge?.effort ?? 'high'
      })
      this.log(
        `[knowledge] 提炼 ${group.groupId}：${outcome.state}，卡片 ${outcome.cards.length}，建议 ${outcome.proposals.length}`
      )
      return true
    } catch (error) {
      const code = error instanceof KnowledgeError ? error.code : 'internal'
      const reason = error instanceof Error ? error.message : String(error)
      // A pause or a closed switch parks the task instead of failing it.
      const settled = code === 'cancelled' && !this.deps.allowed() ? 'paused' : code
      this.log(`[knowledge] 提炼失败：${settled} ${reason}`)
      await this.settle(host, group, settled, reason)
      return this.deps.allowed()
    }
  }

  /** Releases a claim with an explicit code so the task never stays `working`. */
  private async settle(
    host: KnowledgeHost,
    group: ExtractGroup,
    code: string,
    reason: string
  ): Promise<void> {
    try {
      await host.extractFail({ groupId: group.groupId, claim: group.claim, code, reason })
    } catch (error) {
      this.log(
        `[knowledge] 释放任务 ${group.groupId} 失败：${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
}
