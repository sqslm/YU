/**
 * Drives the one-off history scan.
 *
 * The helper owns the job, its cursor and every decision about what to keep; this
 * driver only reads bounded pages out of the stores that already exist and hands
 * them over. It never re-reads a page, so a batch that is cancelled or fails
 * resumes from the checkpoint the helper actually committed.
 */

import type { HistoryJob, PublishInput } from '@shared/knowledge'
import type { KnowledgeHost } from './host'

/** One bounded batch of already-stored content, plus where to continue. */
export interface HistoryPage {
  rows: PublishInput[]
  cursor: string | null
  done: boolean
}

/** The two stores a history scan is allowed to read, in bounded pages. */
export interface HistoryPages {
  /** `bound` is the note id the job fixed when it started; nothing newer enters. */
  notes(after: string | null, bound: string | null): HistoryPage
  /** `bound` is the message sequence the job fixed when it started. */
  chat(after: string | null, bound: number | null): HistoryPage
}

export interface HistoryDeps {
  host: () => KnowledgeHost | null
  pages: HistoryPages
  /** False once the feature is switched off: the walk then parks the job. */
  allowed?: () => boolean
  /**
   * Called after a batch really committed sources. Extraction must look for the new
   * work without waiting for the next publish event: a scan is the only producer
   * that can queue dozens of groups without any other traffic.
   */
  onBatch?: () => void
  /**
   * The scan bounds read from the stores right before a job starts. They are
   * persisted by the helper, so resuming a job after a restart keeps its own set.
   */
  bounds?: () => { noteBound: string | null; chatBound: number | null }
  log?: (line: string) => void
}

export const HISTORY_PAGE = 20

export class HistoryDriver {
  /** Jobs this process is currently walking, so two starts never interleave. */
  private readonly walking = new Set<string>()
  /** Walks this process is running, so a backup can wait for the current step. */
  private readonly pending = new Set<Promise<void>>()

  constructor(private readonly deps: HistoryDeps) {}

  private error(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  /** Starts (or joins) a job and walks it to the end. */
  async start(scopes: { notes: boolean; chat: boolean }): Promise<HistoryJob | null> {
    const host = this.deps.host()
    if (!host) return null
    const bound = this.deps.bounds?.()
    const begun = await host.beginHistory(scopes, bound)
    void this.walk(begun.job.id, scopes)
    return begun.job
  }

  /**
   * Continues a job that was interrupted by a restart. A paused job stays paused:
   * only a resumed job is walked again.
   */
  async resume(): Promise<HistoryJob | null> {
    const host = this.deps.host()
    if (!host) return null
    const job = (await host.latestHistory()).job
    if (!job || job.state !== 'running') return job
    void this.walk(job.id, job.scopes)
    return job
  }

  /** Pause/resume/cancel from the renderer; resume also restarts the walk. */
  async control(jobId: string, action: 'pause' | 'resume' | 'cancel'): Promise<HistoryJob | null> {
    const host = this.deps.host()
    if (!host) return null
    const call = action === 'pause' ? host.pauseHistory : action === 'resume' ? host.resumeHistory : host.cancelHistory
    const job = (await call.call(host, jobId)).job
    if (action === 'resume' && job) void this.walk(job.id, job.scopes)
    return job
  }

  async walk(jobId: string, scopes: { notes: boolean; chat: boolean }): Promise<void> {
    if (this.walking.has(jobId)) return
    const task = this.walkJob(jobId, scopes)
    this.pending.add(task)
    try { await task } finally { this.pending.delete(task) }
  }

  /** Stops here, and waits until a step already in flight has landed. */
  async park(): Promise<void> {
    await Promise.allSettled([...this.pending])
  }

  private async walkJob(jobId: string, scopes: { notes: boolean; chat: boolean }): Promise<void> {
    this.walking.add(jobId)
    try {
      while (true) {
        const host = this.deps.host()
        if (!host) return
        if (this.deps.allowed && !this.deps.allowed()) {
          // Automatic suspension (game mode, or the feature switched off) only
          // stops this walk. The job keeps its `running` state in the helper, so an
          // authorized resume continues from the checkpoint the helper committed.
          // A manual pause is the user's own decision and stays `paused`.
          return
        }
        const job = (await host.historyStatus(jobId)).job
        // The gate can close while the status call is in flight; a closed window
        // must not start a page it would then write into the snapshot.
        if (this.deps.allowed && !this.deps.allowed()) return
        if (!job || job.state !== 'running') return
        if (scopes.notes && !job.noteDone) {
          const page = this.deps.pages.notes(job.noteCursor, job.noteBound ?? null)
          if (this.deps.allowed && !this.deps.allowed()) return
          const step = await host.stepHistory({
            jobId,
            kind: 'note',
            cursor: page.cursor,
            rows: page.rows,
            done: page.done
          })
          this.notify(step.job.scanned, job.scanned)
          await tick()
          continue
        }
        if (scopes.chat && !job.chatDone) {
          const page = this.deps.pages.chat(job.chatCursor, job.chatBound ?? null)
          if (this.deps.allowed && !this.deps.allowed()) return
          const step = await host.stepHistory({
            jobId,
            kind: 'chat',
            cursor: page.cursor,
            rows: page.rows,
            done: page.done
          })
          this.notify(step.job.scanned, job.scanned)
          await tick()
          continue
        }
        // Every selected scope reported itself finished; the helper decides whether
        // that completes the job, this driver never marks it complete itself.
        return
      }
    } catch (error) {
      this.deps.log?.(`[knowledge] 历史整理中断：${this.error(error)}`)
    } finally {
      this.walking.delete(jobId)
    }
  }

  /** Wakes extraction only when this batch actually added sources. */
  private notify(scanned: number, before: number): void {
    if (scanned <= before) return
    try {
      this.deps.onBatch?.()
    } catch (error) {
      this.deps.log?.(`[knowledge] 扫描通知失败：${this.error(error)}`)
    }
  }
}

/** Lets the event loop run between batches so the UI stays responsive. */
function tick(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}
