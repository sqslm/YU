import { describe, expect, it } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { PROBE_STAGING_RELATIVE, discardProbeOutput, resolveProbeOutput, stagingRoot } from './probe-output'

const repo = process.cwd()
const created: string[] = []

function allocate(): { dir: string; temporary: boolean } {
  const output = resolveProbeOutput({ repo })
  created.push(output.dir)
  return output
}

function cleanup(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
}

describe('probe output directory', () => {
  it('gives every run without PROBE_OUT its own directory inside the staging area', () => {
    try {
      const first = allocate()
      const second = allocate()
      expect(first.temporary).toBe(true)
      expect(second.temporary).toBe(true)
      expect(first.dir).not.toBe(second.dir)
      expect(existsSync(first.dir)).toBe(true)
      expect(existsSync(second.dir)).toBe(true)
      for (const dir of [first.dir, second.dir]) {
        expect(dir.startsWith(stagingRoot(repo) + sep)).toBe(true)
        // The recorded stage-19/20/21 results live outside the repository; a run
        // must never be able to land there.
        expect(dir).not.toContain(`${sep}work${sep}`)
      }
    } finally {
      cleanup()
    }
  })

  it('resolves an explicit directory without creating it', () => {
    const explicit = resolve(repo, 'somewhere/else/probe-run')
    const output = resolveProbeOutput({ repo, explicit: 'somewhere/else/probe-run' })
    expect(output).toEqual({ dir: explicit, temporary: false })
    expect(existsSync(explicit)).toBe(false)
    expect(stagingRoot(repo)).toBe(join(repo, PROBE_STAGING_RELATIVE))
  })

  it('removes only a directory it created', () => {
    const output = allocate()
    expect(existsSync(output.dir)).toBe(true)
    expect(discardProbeOutput(output.dir, repo)).toBe(true)
    expect(existsSync(output.dir)).toBe(false)
  })

  it('refuses a path outside the staging area, including a sibling with the same prefix', () => {
    const outside = join(repo, 'src')
    expect(discardProbeOutput(outside, repo)).toBe(false)
    expect(existsSync(outside)).toBe(true)
    const sibling = `${stagingRoot(repo)}-evidence`
    expect(discardProbeOutput(sibling, repo)).toBe(false)
    // Recorded evidence directories are never candidates for removal.
    const history = join(repo, '..', '..', 'work', 't19-probe')
    expect(discardProbeOutput(history, repo)).toBe(false)
    expect(existsSync(join(repo, 'src'))).toBe(true)
  })
})
