import { createHash, randomUUID } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import type { BackupSummary } from '@shared/backup'

/**
 * `knowledge` and `profile` are the two databases the Rust helper owns. They live
 * under the application data root rather than inside `userData`, and they are the
 * only files there a backup may touch.
 */
export interface BackupRoots { user: string; notes: string; chat: string; knowledge: string; profile: string }
type Area = keyof BackupRoots
type Library = 'knowledge' | 'profile'
interface BackupEntry { area: Area; path: string; bytes: number; sha256: string }
interface Manifest { format: 'YU-backup'; version: 1 | 2; createdAt: string; entries: BackupEntry[]; counts: Record<string, number> }
const USER_FILES = ['settings.json', 'history.sqlite', 'reminders.sqlite', 'entities.sqlite', 'stats.json', 'calendar.json', 'workflows.json', 'briefing-state.json', 'briefing-delivery.json', 'audio', 'memory/assistant.db', 'memory/style.db', 'memory/sdk']
const SELECTIONS: Array<{ area: Area; path: string }> = [
  ...USER_FILES.map(path => ({ area: 'user' as const, path })),
  { area: 'notes', path: 'notes.json' }, { area: 'notes', path: 'notes' }, { area: 'chat', path: 'chats.db' }
]
/**
 * Version 2 backs these up as well. A library is only written through a snapshot
 * the helper takes of its live database — never by copying the file, which would
 * carry a half-applied log along with it.
 */
const LIBRARIES: Array<{ area: Library; path: string }> = [
  { area: 'knowledge', path: 'data/knowledge/knowledge.db' },
  { area: 'profile', path: 'data/profile/profile.db' }
]
const STAGE = '.yu-restore-stage', PENDING = 'restore-pending.json'
const inside = (root: string, file: string): boolean => { const rel = relative(resolve(root), resolve(file)); return !rel || !rel.startsWith('..') && !isAbsolute(rel) }
const sqlite = (path: string) => /\.(?:db|sqlite)$/i.test(path)
const database = (area: Area, path: string) => area === 'chat' || area === 'knowledge' || area === 'profile' || area === 'user' && !path.startsWith('audio/') && sqlite(path)
const library = (area: unknown): area is Library => LIBRARIES.some(item => item.area === area)
/**
 * The newest schema each library may hold, mirrored from `KNOWLEDGE_SCHEMA` and
 * `PROFILE_SCHEMA` in native/knowledge/src/store.rs. A restore refuses a library
 * whose schema is newer than the helper that will open it; `backup.test.ts`
 * compares these against what the helper reports so they cannot drift silently.
 */
export const SUPPORTED_SCHEMA: Record<Library, number> = { knowledge: 10, profile: 3 }
/** What a SQLite file claims to be: which library, and how new its schema is. */
export interface DatabaseKind { kind: Library | 'unknown'; version: number }
/** What the helper reports about a file: which library, how new, and — from the
 *  same migrations it applies — which tables that version still owes. */
export interface DatabaseReport extends DatabaseKind { missing?: string[] }
export type Inspector = (file: string) => Promise<DatabaseReport>
/**
 * Reads the label a restore has to check before it moves anything: the kind comes
 * from the tables a library is built on, the version from `user_version`. Opened
 * read-only, so nothing is migrated, created or unlocked by looking.
 */
export function describe(file: string): DatabaseReport {
  const connection = new DatabaseSync(file, { readOnly: true })
  try {
    const tables = connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => String((row as { name: unknown }).name))
    const version = Number((connection.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined)?.user_version ?? 0)
    // The helper's own tables decide the kind, not the file name: a knowledge
    // snapshot dropped into the profile slot is still a knowledge database.
    const kind = tables.includes('cards') && tables.includes('sources') ? 'knowledge' : tables.includes('profile_items') ? 'profile' : 'unknown'
    return { kind, version, missing: [] }
  } finally { connection.close() }
}
/**
 * What the helper verified at stage time, bound to the marker.
 *
 * The staged manifest already hashes every file, and `checkLibraries` asked the
 * running helper whether each library is one it can open. Hashing the library
 * entries together turns that verdict into something a cold start can check
 * without opening anything: same entries, same bytes, same promise. A list of
 * table names here would be a weaker second opinion that drifts with the schema.
 */
function verifiedKey(manifest: Manifest): string {
  const libraries = manifest.entries.filter(entry => library(entry.area)).map(entry => [entry.area, entry.path, entry.bytes, entry.sha256])
  return JSON.stringify([scopeKey(restoreItems(manifest)), libraries])
}
/**
 * Refuses a manifest whose library entries do not hold that library, or hold a
 * schema the running helper cannot open. Called before anything is overwritten.
 */
export async function checkLibraries(manifest: Manifest, directory: string, inspect?: Inspector): Promise<void> {
  for (const item of LIBRARIES) {
    const entry = manifest.entries.find(file => file.area === item.area && file.path === item.path)
    if (!entry) continue
    const file = owned(directory, `${entry.area}/${entry.path}`)
    const label = inspect ? await inspect(file) : describe(file)
    const said = item.area === 'knowledge' ? '知识库' : '画像'
    if (label.kind !== item.area) throw Error(`备份里的${said}不是该数据库`)
    if (label.version < 1 || label.version > SUPPORTED_SCHEMA[item.area]) throw Error(`备份里的${said}版本不受支持`)
    // Right kind and version is not the same as openable: a file at a version that
    // promised a table it no longer holds fails the moment the helper recovers its
    // own interrupted work, so it is refused before anything is moved.
    if (label.missing?.length) throw Error(`备份里的${said}缺少必需的表：${label.missing.join('、')}`)
    // A version 2 entry describes one self-contained file. A sidecar next to it holds
    // pages the manifest never hashed, so it is neither copied nor allowed: restoring
    // the database alone would silently lose whatever was committed into the log.
    if (existsSync(`${file}-wal`) || existsSync(`${file}-shm`)) throw Error(`备份里的${said}带着清单之外的数据：${item.path}-wal`)
  }
}
function allowed(area: unknown, path: unknown): path is string {
  return typeof path === 'string' && !path.includes('\\') && !path.split('/').some(part => !part || part === '.' || part === '..') &&
    (SELECTIONS.some(item => item.area === area && (path === item.path || ['audio', 'memory/sdk', 'notes'].includes(item.path) && path.startsWith(item.path + '/')))
      || LIBRARIES.some(item => item.area === area && path === item.path)) && !/-(?:wal|shm)$/.test(path)
}
function owned(root: string, path: string): string {
  const file = join(root, path)
  if (!inside(root, file)) throw Error('备份路径超出数据目录')
  let cursor = file
  while (!existsSync(cursor)) cursor = dirname(cursor)
  if (!inside(realpathSync(root), realpathSync(cursor))) throw Error('备份路径包含指向目录外的链接')
  return file
}
/** Hash in fixed-size chunks, including startup validation of large recordings. */
function digest(file: string): string {
  const hash = createHash('sha256'), fd = openSync(file, 'r'), buffer = Buffer.allocUnsafe(1024 * 1024)
  try { let size: number; while ((size = readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, size)); return hash.digest('hex') }
  finally { closeSync(fd) }
}
function summary(path: string, manifest: Manifest): BackupSummary {
  return {
    path, createdAt: manifest.createdAt, files: manifest.entries.length, bytes: manifest.entries.reduce((sum, file) => sum + file.bytes, 0), counts: manifest.counts,
    libraries: LIBRARIES.filter(item => manifest.entries.some(entry => entry.area === item.area)).map(item => item.area)
  }
}
function scan(root: string, path: string): string[] {
  const file = owned(root, path)
  if (!existsSync(file)) return []
  const stat = lstatSync(file)
  if (stat.isSymbolicLink()) throw Error('备份不包含符号链接，请使用实际数据目录')
  if (stat.isDirectory()) return readdirSync(file).flatMap(name => scan(root, `${path}/${name}`))
  if (!stat.isFile() || /-(?:wal|shm)$/.test(file)) return []
  return [path]
}
function validateFile(file: string, entry: BackupEntry): void {
  if (database(entry.area, entry.path)) {
    const db = new DatabaseSync(file, { readOnly: true })
    try { if (Object.values(db.prepare('PRAGMA quick_check').get() ?? {})[0] !== 'ok') throw Error('备份数据库损坏') }
    finally { db.close() }
  } else if (entry.path.endsWith('.json') && !entry.path.includes('/')) JSON.parse(readFileSync(file, 'utf8'))
}
/** Copies one of the two helper databases through its own online backup. */
export type Snapshot = (database: Library, target: string) => Promise<number>
export async function createBackup(destination: string, roots: BackupRoots, counts: Record<string, number>, snapshot: Snapshot): Promise<BackupSummary> {
  for (const root of Object.values(roots)) if (inside(root, destination)) throw Error('备份位置必须在用户数据目录之外')
  await mkdir(destination, { recursive: false })
  const manifest: Manifest = { format: 'YU-backup', version: 2, createdAt: new Date().toISOString(), entries: [], counts }
  try {
    for (const selection of SELECTIONS) {
      if (!existsSync(roots[selection.area])) continue
      for (const path of scan(roots[selection.area], selection.path)) {
        const source = owned(roots[selection.area], path), target = join(destination, selection.area, path)
        await mkdir(dirname(target), { recursive: true })
        if (database(selection.area, path)) {
          const db = new DatabaseSync(source, { readOnly: true })
          try { await backup(db, target) } finally { db.close() }
        } else await copyFile(source, target)
        manifest.entries.push({ area: selection.area, path, bytes: lstatSync(target).size, sha256: digest(target) })
      }
    }
    for (const item of LIBRARIES) {
      const source = owned(roots[item.area], item.path)
      // A missing library is skipped on its own: nothing is created, and the
      // feature that would own it stays off after a restore.
      if (!existsSync(source)) continue
      const target = join(destination, item.area, item.path)
      await mkdir(dirname(target), { recursive: true })
      await snapshot(item.area, target)
      manifest.entries.push({ area: item.area, path: item.path, bytes: lstatSync(target).size, sha256: digest(target) })
    }
    await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2))
    return summary(destination, manifest)
  } catch (error) { await rm(destination, { recursive: true, force: true }); throw error }
}
export async function inspectBackup(directory: string, inspect?: Inspector): Promise<BackupSummary> {
  const manifest = readManifest(directory)
  // Preview is a promise about what a restore would install, so it checks the
  // libraries now rather than letting the next start discover a mismatch.
  await checkLibraries(manifest, directory, inspect)
  return summary(directory, manifest)
}
function readManifest(directory: string): Manifest {
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as Manifest
  const version = manifest?.version
  if (manifest.format !== 'YU-backup' || !(version === 1 || version === 2) || !Array.isArray(manifest.entries) || !manifest.entries.length || manifest.entries.length > 100000 || !manifest.counts || typeof manifest.counts !== 'object') throw Error('不是有效的 YU 备份')
  const seen = new Set<string>()
  for (const entry of manifest.entries) {
    const key = `${entry.area}/${entry.path}`.toLowerCase()
    // Version 1 predates the two libraries, so a file claiming to be one is not
    // that backup's file no matter what it is named.
    if (!allowed(entry.area, entry.path) || version === 1 && library(entry.area) || seen.has(key)) throw Error('备份清单包含无效或重复的路径')
    seen.add(key)
    const file = owned(directory, `${entry.area}/${entry.path}`), stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.bytes || digest(file) !== entry.sha256) throw Error('备份文件校验失败')
    validateFile(file, entry)
  }
  return manifest
}
export async function stageRestore(source: string, roots: BackupRoots, inspect?: Inspector): Promise<void> {
  const manifest = readManifest(source), stage = join(roots.user, STAGE)
  if (existsSync(stage) || existsSync(join(roots.user, PENDING))) throw Error(`已有恢复暂存数据，请先重启；若恢复曾失败，请检查 ${stage}`)
  for (const root of Object.values(roots)) if (inside(source, root)) throw Error('恢复来源不能包含当前数据目录')
  await checkLibraries(manifest, source, inspect)
  await mkdir(stage)
  try {
    for (const entry of manifest.entries) {
      const target = join(stage, entry.area, entry.path)
      await mkdir(dirname(target), { recursive: true }); await copyFile(owned(source, `${entry.area}/${entry.path}`), target)
    }
    await writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest))
    readManifest(stage)
    // The staged copies are read back too: the backup may be fine while the copy
    // that landed on disk is not, and a broken stage must not replace anything.
    await checkLibraries(readManifest(stage), stage, inspect)
    // The marker carries what this restore will replace, so a later start can
    // reason about an interrupted restore without reading the stage again.
    await writeFile(join(roots.user, PENDING), JSON.stringify({ version: manifest.version, notesDir: resolve(roots.notes), items: restoreItems(manifest), verified: verifiedKey(manifest) }))
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error }
}

interface RestoreState { id: string; items: Array<{ area: Area; path: string; present: boolean }> }
/**
 * What `stageRestore` leaves behind: which backup version it came from, the notes
 * directory it will point at, and — for markers written from here on — the exact
 * list of items the restore replaces. Older markers only carry the first two, and
 * a restore from before the libraries existed replaced the legacy list alone.
 */
interface PendingMarker { version?: number; notesDir?: string; items?: Array<{ area: Area; path: string }>; verified?: string }
const sidecars = (items: Array<{ area: Area; path: string }>) => items.flatMap(item => [item, ...(sqlite(item.path) ? [{ ...item, path: item.path + '-wal' }, { ...item, path: item.path + '-shm' }] : [])])
const RESTORE_ITEMS = sidecars(SELECTIONS)
/**
 * What one restore replaces. A version 1 backup always replaced every legacy
 * item, so that list stays as it was; a library is only replaced when this
 * backup actually carries it. A backup with one library — or with none, as every
 * version 1 is — therefore leaves the other library and its sidecars alone.
 */
function restoreItems(manifest: Manifest): Array<{ area: Area; path: string }> {
  return scopeItems(LIBRARIES.filter(item => manifest.entries.some(entry => entry.area === item.area)))
}
/** The exact item list a restore of these libraries replaces, in one fixed order. */
function scopeItems(libraries: Array<{ area: Area; path: string }>): Array<{ area: Area; path: string }> {
  return [...RESTORE_ITEMS, ...sidecars(libraries)]
}
const scopeKey = (items: Array<{ area: Area; path: string }>): string => items.map(item => `${item.area}/${item.path}`).join('|')
function recoverPrevious(roots: BackupRoots, state: RestoreState): void {
  for (const item of [...state.items].reverse()) {
    const target = owned(roots[item.area], item.path), original = owned(roots[item.area], `.yu-before-restore-${state.id}/${item.path}`)
    if (existsSync(original)) {
      rmSync(target, { recursive: true, force: true }); mkdirSync(dirname(target), { recursive: true }); renameSync(original, target)
    } else if (!item.present) rmSync(target, { recursive: true, force: true })
  }
}
/** Run after taking the single-instance lock, before opening any store or worker. */
export function applyPendingRestore(roots: BackupRoots, inspect?: Inspector): string[] | null {
  const marker = join(roots.user, PENDING), stage = join(roots.user, STAGE), journal = join(stage, 'restore-state.json'), complete = join(stage, 'restore-complete')
  if (!existsSync(marker)) return null
  const pending = JSON.parse(readFileSync(marker, 'utf8')) as PendingMarker
  const declared = Array.isArray(pending.items) ? pending.items : RESTORE_ITEMS
  /**
   * The staged copy is checked again here: staging and the next start are separated
   * by a restart, and a sidecar that appeared in between is data the manifest never
   * vouched for. It runs only when a restore is about to be applied — an interrupted
   * one is first rolled back from its log, which never needs the stage.
   */
  const checkStaged = (): void => {
    for (const item of LIBRARIES) {
      if (!declared.some(held => held.area === item.area && held.path === item.path)) continue
      const staged = join(stage, item.area, item.path)
      for (const suffix of ['-wal', '-shm']) {
        if (existsSync(`${staged}${suffix}`)) throw Error(`恢复暂存与标记不符，未修改用户数据：${item.area}/${item.path}${suffix}`)
      }
    }
  }
  let state: RestoreState | undefined
  if (existsSync(journal)) {
    state = JSON.parse(readFileSync(journal, 'utf8')) as RestoreState
    const expected = state.items
    // A log lists the database files and their sidecars; `allowed` describes the
    // files themselves, so a sidecar is checked through the file it belongs to.
    const legal = (items: Array<{ area: Area; path: string }>) => Array.isArray(items) && items.every((item): boolean => {
      const path: string = item.path
      // A log also lists sidecars; `allowed` describes the files themselves, so a
      // sidecar is checked through the database file it belongs to.
      const base = path.replace(/-(?:wal|shm)$/, '')
      if (base === path) return allowed(item.area, path)
      return allowed(item.area, base)
    })
    // The log lists what it moved, and that list is checked against the marker —
    // never against the stage. An interrupted restore must be recoverable even
    // when the staged files are gone or damaged: the originals sit in the
    // recovery directory, waiting to be moved back.
    // The marker is the range this restore promised to replace; the log has to
    // name exactly that range — no extra file, no repeat, no reordering — and a
    // legacy marker still means the legacy list alone.
    const unique = (items: Array<{ area: Area; path: string }>) => new Set(items.map(item => `${item.area}/${item.path}`)).size === items.length
    // A version 1 marker predates both the item list and the libraries: it
    // promised the legacy list alone, and that is the only range its log may name.
    const legacy = !Array.isArray(pending.items) && (pending.version === 1 || pending.version === undefined)
    const declaredOk = Array.isArray(pending.items) ? unique(pending.items) : legacy
    const allowedRanges = legacy ? [scopeKey(RESTORE_ITEMS)] : [scopeKey(declared)]
    if (!/^[a-f0-9-]{36}$/.test(state?.id ?? '') || !legal(expected) || !declaredOk || !unique(expected) || !allowedRanges.includes(scopeKey(expected))) throw Error('恢复日志无效，未修改用户数据')
    if (!expected.every(item => typeof item.present === 'boolean')) throw Error('恢复日志无效，未修改用户数据')
    if (!existsSync(complete)) { recoverPrevious(roots, state); rmSync(journal); state = undefined }
  }
  if (!state) {
    try {
      // Before the stage is read, opened or copied: a file next to a staged library
      // is not part of what the user agreed to replace.
      checkStaged()
      const manifest = readManifest(stage)
      // The staged manifest has to describe the same replacement range the marker
      // announced: a stage that grew or lost a library since then is not the one
      // the user agreed to.
      if (Array.isArray(pending.items) && scopeKey(restoreItems(manifest)) !== scopeKey(declared)) throw Error('恢复暂存与标记不符，未修改用户数据')
      // The stage has to be the one the helper verified: a library that appeared,
      // vanished or changed after that verdict is a different restore. A marker
      // from before this binding existed cannot prove it, so it is refused rather
      // than checked against a weaker list.
      if (restoreItems(manifest).length > RESTORE_ITEMS.length) {
        if (!pending.verified) throw Error('恢复暂存来自更早的版本，请重新发起恢复')
        if (pending.verified !== verifiedKey(manifest)) throw Error('恢复暂存与标记不符，未修改用户数据')
      }
      for (const root of Object.values(roots)) mkdirSync(root, { recursive: true })
      state = { id: randomUUID(), items: restoreItems(manifest).map(item => {
        const target = owned(roots[item.area], item.path), present = existsSync(target)
        if (present && lstatSync(target).isSymbolicLink()) throw Error('恢复目标包含符号链接')
        return { ...item, present }
      }) }
      // Persist the original locations before the first move, so a process interruption is recoverable.
      writeFileSync(journal, JSON.stringify(state))
      for (const item of state.items) if (item.present) {
        const target = owned(roots[item.area], item.path), original = owned(roots[item.area], `.yu-before-restore-${state.id}/${item.path}`)
        mkdirSync(dirname(original), { recursive: true }); renameSync(target, original)
      }
      for (const entry of manifest.entries) {
        const target = owned(roots[entry.area], entry.path)
        mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(stage, entry.area, entry.path), target)
      }
      const settings = join(roots.user, 'settings.json')
      if (existsSync(settings)) {
        const data = JSON.parse(readFileSync(settings, 'utf8'))
        data.notesDir = resolve(roots.notes) === resolve(roots.user) ? '' : roots.notes; data.syncEnabled = false
        writeFileSync(settings, JSON.stringify(data, null, 2))
      }
      writeFileSync(complete, 'complete')
    } catch (error) {
      if (state) { recoverPrevious(roots, state); rmSync(journal, { force: true }) }
      if (existsSync(marker)) renameSync(marker, join(roots.user, `restore-failed-${Date.now()}.json`))
      throw error
    }
  }
  const recovery = [...new Set(Object.values(roots).map(root => join(root, `.yu-before-restore-${state!.id}`)))].filter(path => existsSync(path))
  rmSync(marker)
  try { rmSync(stage, { recursive: true }) } catch (error) { console.warn('[backup] restored data; staging cleanup failed:', stage, error) }
  return recovery
}
