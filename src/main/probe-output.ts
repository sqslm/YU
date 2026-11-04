/**
 * Output directory for the real-renderer probe runs.
 *
 * The probe used to fall back to a fixed `work/t19-probe` directory, so a plain
 * `pnpm test` (which runs the probe test without `PROBE_OUT`) silently
 * overwrote the recorded stage-19 result. A run without an explicit directory
 * now gets its own freshly created directory inside the repository's staging
 * area, and only that directory is removed once the result has been read.
 *
 * An explicit directory is never created here and never removed: it exists so a
 * run can be kept as evidence.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

/** Staging area on the project disk; ignored by `.gitignore` (`/*`). */
export const PROBE_STAGING_RELATIVE = '.tmp/probe'

export interface ProbeOutput {
  dir: string
  /** True when this call created a per-run directory that must be discarded. */
  temporary: boolean
}

export function stagingRoot(repo: string): string {
  return join(resolve(repo), PROBE_STAGING_RELATIVE)
}

/**
 * `explicit` wins when set (and is only resolved, never created or removed).
 * Otherwise a unique directory is created atomically under the staging root, so
 * two runs — or two concurrent workers — cannot share a writable path.
 */
export function resolveProbeOutput(options: { repo: string; explicit?: string | undefined }): ProbeOutput {
  const explicit = options.explicit?.trim()
  if (explicit) return { dir: resolve(options.repo, explicit), temporary: false }
  const root = stagingRoot(options.repo)
  mkdirSync(root, { recursive: true })
  return { dir: mkdtempSync(join(root, 'run-')), temporary: true }
}

/**
 * Removes a directory this module created. Anything outside the staging root is
 * refused, so a mis-resolved path can never delete a recorded evidence folder.
 */
export function discardProbeOutput(dir: string, repo: string): boolean {
  const root = stagingRoot(repo)
  const target = resolve(dir)
  if (!target.startsWith(root + sep)) return false
  rmSync(target, { recursive: true, force: true })
  return true
}
