import { app } from 'electron'
import { createHash } from 'node:crypto'
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
  private readonly cloudPath: string
  private stats: StatsFile = emptyStats()
  private cloudStats: Record<string, StatsFile[]> = {}
  private timer: NodeJS.Timeout | null = null
  private writing: Promise<void> = Promise.resolve()
  private dirty = false

  constructor(filePath = join(app.getPath('userData'), 'stats.json')) {
    this.path = filePath
    this.cloudPath = `${filePath}.cloud.json`
  }

  get file(): string {
    return this.path
  }

  get(accountKey = ''): StatsFile {
    return this.aggregate([this.stats, ...(this.cloudStats[accountKey] ?? [])])
  }

  /** The snapshot belonging to this installation; never includes pulled devices. */
  localSnapshot(): StatsFile {
    return this.stats
  }

  /** Replaces the cached contributions from other installations. */
  async setCloudContributions(devices: Array<{ deviceId: string; stats: unknown }>, ownDeviceId: string, accountKey: string): Promise<void> {
    this.cloudStats[accountKey] = devices
      .filter((device) => device.deviceId !== ownDeviceId)
      .map((device) => sanitizeStats(device.stats))
    const body = JSON.stringify(this.cloudStats)
    const temp = `${this.cloudPath}.${process.pid}.tmp`
    await mkdir(dirname(this.cloudPath), { recursive: true })
    await writeFile(temp, body, 'utf8')
    await rename(temp, this.cloudPath)
  }

  private aggregate(sources: StatsFile[]): StatsFile {
    const result = emptyStats()
    for (const source of sources) {
      result.records += source.records
      result.lastAt = Math.max(result.lastAt, source.lastAt)
      for (const [day, totals] of Object.entries(source.days)) {
        const target = result.days[day] ?? (result.days[day] = {
          entries: 0, len: 0, ms: 0, used: 0, records: 0, usedMs: 0,
          chars: 0, units: 0, measured: 0, measuredUnits: 0, measuredMs: 0, savedMs: 0
        })
        for (const key of Object.keys(target) as Array<keyof typeof target>) target[key] += totals[key]
      }
      for (const [name, count] of Object.entries(source.apps)) result.apps[name] = (result.apps[name] ?? 0) + count
    }
    return result
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
    try {
      const raw = await readFile(this.cloudPath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      this.cloudStats = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, Array.isArray(value) ? value.map(sanitizeStats) : []]))
        : {}
    } catch {
      this.cloudStats = {}
    }
    return this.get()
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

/** Stable local namespace for cloud data belonging to one self-hosted account. */
export function statsAccountKey(serverUrl: string, userId: string): string {
  return createHash('sha256').update(`${serverUrl}\0${userId}`).digest('hex')
}
