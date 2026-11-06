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
export function inspectBackup(directory: string): BackupSummary {
  return summary(directory, readManifest(directory))
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
export async function stageRestore(source: string, roots: BackupRoots): Promise<void> {
  const manifest = readManifest(source), stage = join(roots.user, STAGE)
  if (existsSync(stage) || existsSync(join(roots.user, PENDING))) throw Error(`已有恢复暂存数据，请先重启；若恢复曾失败，请检查 ${stage}`)
  for (const root of Object.values(roots)) if (inside(source, root)) throw Error('恢复来源不能包含当前数据目录')
  await mkdir(stage)
  try {
    for (const entry of manifest.entries) {
      const target = join(stage, entry.area, entry.path)
      await mkdir(dirname(target), { recursive: true }); await copyFile(owned(source, `${entry.area}/${entry.path}`), target)
    }
    await writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest))
    readManifest(stage)
    await writeFile(join(roots.user, PENDING), JSON.stringify({ version: manifest.version, notesDir: resolve(roots.notes) }))
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error }
}

interface RestoreState { id: string; items: Array<{ area: Area; path: string; present: boolean }> }
const sidecars = (items: Array<{ area: Area; path: string }>) => items.flatMap(item => [item, ...(sqlite(item.path) ? [{ ...item, path: item.path + '-wal' }, { ...item, path: item.path + '-shm' }] : [])])
const RESTORE_ITEMS = sidecars(SELECTIONS)
/**
 * What one restore replaces. A version 1 backup always replaced every legacy
 * item, so that list stays as it was; a library is only replaced when this
 * backup actually carries it. A backup with one library — or with none, as every
 * version 1 is — therefore leaves the other library and its sidecars alone.
 */
function restoreItems(manifest: Manifest): Array<{ area: Area; path: string }> {
  return [...RESTORE_ITEMS, ...sidecars(LIBRARIES.filter(item => manifest.entries.some(entry => entry.area === item.area)))]
}
function recoverPrevious(roots: BackupRoots, state: RestoreState): void {
  for (const item of [...state.items].reverse()) {
    const target = owned(roots[item.area], item.path), original = owned(roots[item.area], `.yu-before-restore-${state.id}/${item.path}`)
    if (existsSync(original)) {
      rmSync(target, { recursive: true, force: true }); mkdirSync(dirname(target), { recursive: true }); renameSync(original, target)
    } else if (!item.present) rmSync(target, { recursive: true, force: true })
  }
}
/** Run after taking the single-instance lock, before opening any store or worker. */
export function applyPendingRestore(roots: BackupRoots): string[] | null {
  const marker = join(roots.user, PENDING), stage = join(roots.user, STAGE), journal = join(stage, 'restore-state.json'), complete = join(stage, 'restore-complete')
  if (!existsSync(marker)) return null
  let state: RestoreState | undefined
  if (existsSync(journal)) {
    state = JSON.parse(readFileSync(journal, 'utf8')) as RestoreState
    const expected = state.items
    const same = (items: Array<{ area: Area; path: string }>) => expected.length === items.length && expected.every((item, i) => item.area === items[i].area && item.path === items[i].path)
    // An interrupted restore from before the libraries existed has the legacy
    // list, which is exactly what it moved; recover it rather than refuse it.
    if (!/^[a-f0-9-]{36}$/.test(state.id) || !(same(RESTORE_ITEMS) || same(restoreItems(readManifest(stage))))) throw Error('恢复日志无效，未修改用户数据')
    if (!existsSync(complete)) { recoverPrevious(roots, state); rmSync(journal); state = undefined }
  }
  if (!state) {
    try {
      const manifest = readManifest(stage)
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
