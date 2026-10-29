import { readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, parse } from 'node:path'

function folderKey(value: string): string {
  const normalized = value.normalize('NFKC').trim().toLowerCase()
  return /^[a-z0-9][a-z0-9 _-]*$/.test(normalized) ? normalized.replace(/[ _-]/g, '') : normalized
}

/** One missing/extra/wrong letter or adjacent transposition, never a changed number or short acronym. */
function nearbyWord(a: string, b: string): boolean {
  if (/^[a-z]{4,}$/.test(a) && /^[a-z]{4,}$/.test(b) && (b === a + 's' || a.endsWith('s') && b === a.slice(0, -1))) return true
  if (!/^[a-z]{5,64}$/.test(a) || !/^[a-z]{5,64}$/.test(b) || Math.abs(a.length - b.length) > 1) return false
  if (a.length === b.length) {
    const different = [...a].flatMap((letter, i) => letter === b[i] ? [] : [i])
    return different.length === 1 || different.length === 2 && different[1] === different[0] + 1 && a[different[0]] === b[different[1]] && a[different[1]] === b[different[0]]
  }
  const shorter = a.length < b.length ? a : b, longer = a.length < b.length ? b : a
  let i = 0
  while (i < shorter.length && shorter[i] === longer[i]) i++
  return shorter.slice(i) === longer.slice(i + 1)
}

/** Prefer the complete literal path, then repair each missing component using real sibling directories only. */
export async function resolveSpokenFolder(input: string, signal?: AbortSignal): Promise<{ path: string; corrected: boolean; candidates?: string[] }> {
  signal?.throwIfAborted()
  try { return { path: await realpath(input), corrected: false } }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  // Find the nearest existing ancestor, rather than requiring the spoken parent to exist.
  let parent = dirname(input), path: string
  const remaining = [basename(input)]
  for (;;) {
    signal?.throwIfAborted()
    try { path = await realpath(parent); break }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === dirname(parent)) throw error
      remaining.unshift(basename(parent)); parent = dirname(parent)
    }
  }
  for (const name of remaining) {
    signal?.throwIfAborted()
    try {
      const literal = await realpath(join(path, name))
      if (!(await stat(literal)).isDirectory()) return { path: '', corrected: false }
      path = literal; continue
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const drive = parse(path).root[0]
    const key = folderKey(name.replace(new RegExp(`^(?:${drive}\\s*盘(?:里|中|下面|下)?的?\\s*)+`, 'i'), ''))
    const entries = (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory())
    const exact = entries.filter(entry => entry.name.normalize('NFKC').toLowerCase() === name.normalize('NFKC').toLowerCase())
    const normalized = exact.length ? exact : entries.filter(entry => folderKey(entry.name) === key)
    const matches = normalized.length ? normalized : entries.filter(entry => nearbyWord(folderKey(entry.name), key))
    signal?.throwIfAborted()
    if (matches.length !== 1) return { path: '', corrected: false, candidates: await Promise.all(matches.slice(0, 10).map(entry => realpath(join(path, entry.name)))) }
    path = await realpath(join(path, matches[0].name))
  }
  return { path, corrected: true }
}
