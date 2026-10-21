import { app } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  addToStats,
  emptyStats,
  sanitizeStats,
  statsFromEntries,
  type StatsFile
} from '@shared/stats'
import type { HistoryEntry } from '@shared/types'

/**
 * How long a burst of takes shares one write. A dictation is one write every
 * few seconds at most, but a retry storm or a test run should not turn into a
 * file write per row.
 */
const FLUSH_DELAY_MS = 800

/**
 * The lifetime usage rollup (`<userData>/stats.json`).
 *
 * Deliberately separate from `HistoryStore`: clearing the history, dropping
 * rows past the cap or trimming by retention must not reset the 概览 figures.
 * Nothing here is free text — only per-day counters and app names — so the file
 * survives "不保存历史" as well, which is what makes the charts stable across an
 * intentional wipe.
 */
export class StatsStore {
  private readonly path: string
  private stats: StatsFile = emptyStats()
  private timer: NodeJS.Timeout | null = null
  private writing: Promise<void> = Promise.resolve()
  private dirty = false

  constructor(filePath = join(app.getPath('userData'), 'stats.json')) {
    this.path = filePath
  }

  get file(): string {
    return this.path
  }

  get(): StatsFile {
    return this.stats
  }

  /**
   * Reads the file. When it is missing — the first launch after this feature
   * shipped, or a user who deleted it — the rollup is rebuilt from the history
   * rows that are still on disk, so the charts do not start at zero.
   */
  async load(seedFrom?: () => HistoryEntry[]): Promise<StatsFile> {
    try {
      const raw = await readFile(this.path, 'utf8')
      this.stats = sanitizeStats(JSON.parse(raw))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[stats] cannot read, rebuilding from history:', err)
      }
      this.stats = statsFromEntries(seedFrom ? seedFrom() : [])
      // Persist the seed now, so the rebuild happens once and not on every launch.
      this.dirty = true
      await this.flush()
    }
    return this.stats
  }

  /** Records one freshly stored take. Never rejects into the pipeline. */
  add(entry: HistoryEntry): void {
    addToStats(this.stats, entry)
    this.dirty = true
    this.schedule()
  }

  /** Writes immediately — used by `load()` and by tests. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.dirty) return
    this.dirty = false
    const body = JSON.stringify(this.stats, null, 2)
    this.writing = this.writing
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true })
        // Same temp-then-rename rule as history/settings: a truncated counter
        // file is not fatal (it is rebuilt from history), but it does lose the
        // streak the user has been building, so the write should be atomic too.
        const temp = `${this.path}.${process.pid}.tmp`
        await writeFile(temp, body, 'utf8')
        await rename(temp, this.path)
      })
      .catch((err: unknown) => {
        // A failed counter write must not cost the take; the next one retries.
        console.error('[stats] cannot write:', err)
      })
    await this.writing
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, FLUSH_DELAY_MS)
    // A pending counter write must never keep the app alive.
    this.timer.unref()
  }
}
