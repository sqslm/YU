import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { applyPendingRestore, createBackup, inspectBackup, stageRestore, SUPPORTED_SCHEMA, type BackupRoots } from './backup'
const real = vi.hoisted(() => ({ copy: undefined as undefined | typeof import('node:fs').copyFileSync }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  real.copy = actual.copyFileSync
  return { ...actual, copyFileSync: vi.fn(actual.copyFileSync) }
})

// The copy mock is a module-level stand-in, so each test starts from the real one.
beforeEach(() => { vi.mocked(fs.copyFileSync).mockImplementation((from, to) => real.copy!(from, to)) })
const rootsToRemove: string[] = [], databases: DatabaseSync[] = []
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) if (db.isOpen) db.close(); for (const root of rootsToRemove.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function setup(): { root: string; roots: BackupRoots; destination: string } {
  const root = fs.mkdtempSync(join(tmpdir(), 'yu-backup-test-')); rootsToRemove.push(root)
  const roots = { user: join(root, 'user'), notes: join(root, 'custom-notes'), chat: join(root, 'install', 'chat'), knowledge: join(root, 'install'), profile: join(root, 'install') }
  for (const dir of Object.values(roots)) fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(join(roots.user, 'memory', 'model'), { recursive: true })
  fs.writeFileSync(join(roots.user, 'memory', 'model', 'weights.onnx'), 'model remains local')
  fs.writeFileSync(join(roots.user, 'account.json'), 'current login')
  fs.writeFileSync(join(roots.user, 'settings.json'), JSON.stringify({ notesDir: 'old-machine-path', syncEnabled: true }))
  fs.mkdirSync(join(roots.notes, 'notes', 'attachments', 'id'), { recursive: true })
  fs.writeFileSync(join(roots.notes, 'notes.json'), JSON.stringify({ notes: [{ id: 'one', transcript: '原始内容' }] }))
  fs.writeFileSync(join(roots.notes, 'notes', 'attachments', 'id', 'source.json'), 'arbitrary attachment bytes')
  return { root, roots, destination: join(root, 'backup') }
}
/**
 * A stand-in for the helper: it writes a real SQLite file so every later check —
 * quick_check on preview, copy on restore — sees one. The genuine snapshot is
 * covered by the integration test against the release helper.
 */
// The snapshots have to look like the libraries they claim to be: a restore
// checks the tables and the schema version before it replaces anything.
const helperSnapshot = async (database: 'knowledge' | 'profile', target: string): Promise<number> => {
  const file = new DatabaseSync(target)
  try {
    if (database === 'knowledge') file.exec('PRAGMA journal_mode=DELETE; PRAGMA user_version=10; CREATE TABLE sources(id TEXT PRIMARY KEY); CREATE TABLE cards(id TEXT PRIMARY KEY)')
    else file.exec('PRAGMA journal_mode=DELETE; PRAGMA user_version=3; CREATE TABLE profile_items(id TEXT PRIMARY KEY); CREATE TABLE profile_pending(id TEXT PRIMARY KEY)')
    return fs.statSync(target).size
  } finally { file.close() }
}

it('backs up committed WAL contents and restores user data while retaining models, login and a recovery copy', async () => {
  const { roots, destination } = setup()
  const db = new DatabaseSync(join(roots.chat, 'chats.db')); databases.push(db)
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE data(value TEXT); INSERT INTO data VALUES('最新已提交内容')")
  const result = await createBackup(destination, roots, { 聊天: 1, 随记: 1 }, helperSnapshot)
  expect(result.files).toBe(4)
  expect(fs.existsSync(join(destination, 'user', 'memory'))).toBe(false)
  expect(fs.existsSync(join(destination, 'user', 'account.json'))).toBe(false)
  const snapshot = new DatabaseSync(join(destination, 'chat', 'chats.db')); databases.push(snapshot)
  expect(snapshot.prepare('SELECT value FROM data').get()?.value).toBe('最新已提交内容'); snapshot.close()
  db.exec("UPDATE data SET value='恢复前的新内容'"); db.close()
  fs.writeFileSync(join(roots.notes, 'notes.json'), '{"notes":[{"id":"new"}]}')
  await stageRestore(destination, roots)
  const recovery = applyPendingRestore(roots)!
  expect(recovery.length).toBeGreaterThan(0)
  const restored = new DatabaseSync(join(roots.chat, 'chats.db')); databases.push(restored)
  expect(restored.prepare('SELECT value FROM data').get()?.value).toBe('最新已提交内容')
  expect(fs.readFileSync(join(roots.notes, 'notes.json'), 'utf8')).toContain('原始内容')
  expect(fs.readFileSync(join(roots.notes, 'notes', 'attachments', 'id', 'source.json'), 'utf8')).toBe('arbitrary attachment bytes')
  expect(JSON.parse(fs.readFileSync(join(roots.user, 'settings.json'), 'utf8'))).toMatchObject({ notesDir: roots.notes, syncEnabled: false })
  expect(fs.readFileSync(join(roots.user, 'memory', 'model', 'weights.onnx'), 'utf8')).toBe('model remains local')
  expect(fs.readFileSync(join(roots.user, 'account.json'), 'utf8')).toBe('current login')
  expect(recovery.some(dir => fs.existsSync(join(dir, 'notes.json')) && fs.readFileSync(join(dir, 'notes.json'), 'utf8').includes('new'))).toBe(true)
  expect(fs.existsSync(join(roots.user, '.yu-restore-stage'))).toBe(false)
  expect(applyPendingRestore(roots)).toBeNull()
})
it('rejects changed files and path traversal before touching current data', async () => {
  const { roots, destination } = setup()
  await createBackup(destination, roots, {}, helperSnapshot)
  fs.appendFileSync(join(destination, 'notes', 'notes.json'), 'bad')
  await expect(inspectBackup(destination)).rejects.toThrow('校验失败')
  expect(fs.existsSync(join(roots.user, '.yu-restore-stage'))).toBe(false)
  const manifest = JSON.parse(fs.readFileSync(join(destination, 'manifest.json'), 'utf8'))
  manifest.entries[0].path = '../account.json'
  fs.writeFileSync(join(destination, 'manifest.json'), JSON.stringify(manifest))
  await expect(stageRestore(destination, roots)).rejects.toThrow('无效')
  expect(fs.readFileSync(join(roots.user, 'account.json'), 'utf8')).toBe('current login')
})
it('rolls back all moved data when installing a restored file fails', async () => {
  const { roots, destination } = setup()
  await createBackup(destination, roots, {}, helperSnapshot)
  fs.writeFileSync(join(roots.notes, 'notes.json'), '{"notes":[{"id":"new"}]}')
  await stageRestore(destination, roots)
  vi.mocked(fs.copyFileSync).mockImplementationOnce(() => { throw Error('simulated locked destination') })
  expect(() => applyPendingRestore(roots)).toThrow('locked')
  expect(fs.readFileSync(join(roots.notes, 'notes.json'), 'utf8')).toContain('new')
  expect(JSON.parse(fs.readFileSync(join(roots.user, 'settings.json'), 'utf8')).syncEnabled).toBe(true)
  expect(fs.existsSync(join(roots.user, 'restore-pending.json'))).toBe(false)
})

it.each(['renameSync', 'copyFileSync'])('recovers after a process interruption during %s', async method => {
  const { roots, destination } = setup()
  await createBackup(destination, roots, {}, helperSnapshot)
  fs.writeFileSync(join(roots.notes, 'notes.json'), '{"notes":[{"id":"before-crash"}]}')
  await stageRestore(destination, roots)
  const script = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const roots=${JSON.stringify(roots)}, method=${JSON.stringify(method)}, original=fs[method];
    fs[method]=(...args)=>{ original(...args); if((method==='renameSync'?args[0]:args[1])===${JSON.stringify(join(roots.user, 'settings.json'))}) process.exit(44); };
    syncBuiltinESMExports(); const {applyPendingRestore}=await import(${JSON.stringify(pathToFileURL(resolve('src/main/backup.ts')).href)}); applyPendingRestore(roots);`
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { encoding: 'utf8', windowsHide: true })
  expect(child.status, child.stderr).toBe(44)
  const pending = JSON.parse(fs.readFileSync(join(roots.user, 'restore-pending.json'), 'utf8'))
  expect(pending.notesDir).toBe(roots.notes)
  const recovery = applyPendingRestore(roots)!
  expect(fs.readFileSync(join(roots.notes, 'notes.json'), 'utf8')).toContain('原始内容')
  expect(recovery.some(dir => fs.existsSync(join(dir, 'notes.json')) && fs.readFileSync(join(dir, 'notes.json'), 'utf8').includes('before-crash'))).toBe(true)
})

/** A library file with one row, standing in for one the helper would write. */
function library(roots: BackupRoots, area: 'knowledge' | 'profile', value: string): string {
  const path = join(roots[area]!, 'data', area, `${area}.db`)
  fs.mkdirSync(join(path, '..'), { recursive: true })
  const file = new DatabaseSync(path)
  file.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS marker(value TEXT); DELETE FROM marker")
  file.prepare('INSERT INTO marker VALUES(?)').run(value)
  file.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  file.close()
  return path
}
function marker(path: string): string | undefined {
  const file = new DatabaseSync(path, { readOnly: true })
  try { return file.prepare('SELECT value FROM marker').get()?.value as string | undefined } finally { file.close() }
}
it('refuses a library whose structure the helper reports as incomplete', async () => {
  const { roots, destination } = setup()
  makeLibrary(roots, 'knowledge', 10, '在用')
  makeLibrary(roots, 'profile', 3, '在用')
  await createBackup(destination, roots, {}, helperSnapshot)
  // Right kind, right version, missing the table the recovery path opens first:
  // installing it would only fail on the next start.
  const inspect = async (file: string) => ({ kind: file.includes('profile') ? 'profile' as const : 'knowledge' as const, version: 3, missing: file.includes('profile') ? ['profile_pending'] : [] })
  await expect(inspectBackup(destination, inspect)).rejects.toThrow('缺少必需的表')
  await expect(stageRestore(destination, roots, inspect)).rejects.toThrow('缺少必需的表')
  expect(fs.existsSync(join(roots.user, '.yu-restore-stage'))).toBe(false)
})

it('refuses a restore log that does not name the range the marker promised', async () => {
  const { roots, destination } = setup()
  const knowledge = library(roots, 'knowledge', '恢复前的知识库')
  library(roots, 'profile', '恢复前的画像')
  await createBackup(destination, roots, {}, helperSnapshot)
  await stageRestore(destination, roots)
  const stage = join(roots.user, '.yu-restore-stage')
  const journal = join(stage, 'restore-state.json')
  const pending = JSON.parse(fs.readFileSync(join(roots.user, 'restore-pending.json'), 'utf8'))
  const id = '11111111-2222-3333-4444-555555555555'
  const items = pending.items.map((item: { area: string; path: string }) => ({ ...item, present: true }))
  // A log naming one file more than the marker announced is not this restore.
  fs.writeFileSync(journal, JSON.stringify({ id, items: [...items, { area: 'user', path: 'account.json', present: true }] }))
  expect(() => applyPendingRestore(roots)).toThrow('恢复日志无效')
  expect(marker(knowledge)).toBe('恢复前的知识库')
  // Nor is one that repeats an entry, or drops one the marker promised.
  fs.writeFileSync(journal, JSON.stringify({ id, items: [...items, items.at(-1)] }))
  expect(() => applyPendingRestore(roots)).toThrow('恢复日志无效')
  fs.writeFileSync(journal, JSON.stringify({ id, items: items.slice(1) }))
  expect(() => applyPendingRestore(roots)).toThrow('恢复日志无效')
  expect(marker(knowledge)).toBe('恢复前的知识库')
  // The range the marker did promise still applies.
  fs.writeFileSync(journal, JSON.stringify({ id, items }))
  expect(applyPendingRestore(roots)!.length).toBeGreaterThan(0)
})


it('keeps the live libraries when a version one backup carries none', async () => {
  const { roots, destination } = setup()
  const knowledge = library(roots, 'knowledge', '在用的知识库')
  const profile = library(roots, 'profile', '在用的画像')
  await createBackup(destination, roots, {}, helperSnapshot)
  // The same directory declared as a version 1 backup: the libraries are not part
  // of that format, so a restore must leave both of them, logs included, alone.
  const manifest = JSON.parse(fs.readFileSync(join(destination, 'manifest.json'), 'utf8'))
  manifest.version = 1
  manifest.entries = manifest.entries.filter((entry: { area: string }) => entry.area !== 'knowledge' && entry.area !== 'profile')
  fs.writeFileSync(join(destination, 'manifest.json'), JSON.stringify(manifest))
  fs.rmSync(join(destination, 'knowledge'), { recursive: true, force: true })
  fs.rmSync(join(destination, 'profile'), { recursive: true, force: true })
  fs.writeFileSync(`${profile}-wal`, 'stale profile log')
  expect((await inspectBackup(destination)).libraries).toEqual([])
  await stageRestore(destination, roots)
  applyPendingRestore(roots)
  expect(marker(knowledge)).toBe('在用的知识库')
  expect(marker(profile)).toBe('在用的画像')
  expect(fs.readFileSync(`${profile}-wal`, 'utf8')).toBe('stale profile log')
})
it('replaces both libraries and rolls them back together when the second one cannot be copied', async () => {
  const { roots, destination } = setup()
  const knowledge = library(roots, 'knowledge', '备份里的知识库')
  const profile = library(roots, 'profile', '备份里的画像')
  await createBackup(destination, roots, {}, helperSnapshot)
  const live = new DatabaseSync(knowledge); databases.push(live)
  live.exec("UPDATE marker SET value='恢复前的知识库'"); live.close()
  const liveProfile = new DatabaseSync(profile); databases.push(liveProfile)
  liveProfile.exec("UPDATE marker SET value='恢复前的画像'"); liveProfile.close()
  await stageRestore(destination, roots)
  vi.mocked(fs.copyFileSync).mockImplementation((from, to) => {
    if (String(to).endsWith('profile.db')) throw Error('simulated locked profile')
    return real.copy!(from, to)
  })
  expect(() => applyPendingRestore(roots)).toThrow('locked profile')
  expect(marker(knowledge)).toBe('恢复前的知识库')
  expect(marker(profile)).toBe('恢复前的画像')
  expect(fs.existsSync(join(roots.user, 'restore-pending.json'))).toBe(false)
})
it('removes the whole backup when the second library cannot be snapshotted', async () => {
  const { roots, destination } = setup()
  library(roots, 'knowledge', '能快照的知识库')
  library(roots, 'profile', '快照失败的画像')
  const snapshot = async (database: 'knowledge' | 'profile', target: string): Promise<number> => {
    if (database === 'profile') throw Error('the profile database is locked')
    return helperSnapshot(database, target)
  }
  await expect(createBackup(destination, roots, {}, snapshot)).rejects.toThrow('locked')
  expect(fs.existsSync(destination)).toBe(false)
})

/** A live library of the shape and schema the helper would have written. */
function makeLibrary(roots: BackupRoots, area: 'knowledge' | 'profile', version: number, value: string): string {
  const path = join(roots[area], 'data', area, `${area}.db`)
  fs.mkdirSync(join(path, '..'), { recursive: true })
  const file = new DatabaseSync(path); databases.push(file)
  if (area === 'knowledge') file.exec(`PRAGMA user_version=${version}; CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS cards(id TEXT PRIMARY KEY); DELETE FROM sources`)
  else file.exec(`PRAGMA user_version=${version}; CREATE TABLE IF NOT EXISTS profile_items(id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS profile_pending(id TEXT PRIMARY KEY); DELETE FROM profile_items`)
  file.prepare(`INSERT INTO ${area === 'knowledge' ? 'sources' : 'profile_items'} VALUES(?)`).run(value)
  file.close()
  return path
}

/** Rewrites one library entry so the manifest still matches the bytes on disk. */
function swap(destination: string, area: 'knowledge' | 'profile', source: string): void {
  const entry = join(destination, area, 'data', area, `${area}.db`)
  fs.mkdirSync(join(entry, '..'), { recursive: true })
  fs.copyFileSync(source, entry)
  const manifest = JSON.parse(fs.readFileSync(join(destination, 'manifest.json'), 'utf8'))
  const row = manifest.entries.find((item: { area: string }) => item.area === area)
  const bytes = fs.statSync(entry).size
  const hash = createHash('sha256').update(fs.readFileSync(entry)).digest('hex')
  row.bytes = bytes; row.sha256 = hash
  fs.writeFileSync(join(destination, 'manifest.json'), JSON.stringify(manifest))
}

it('refuses a snapshot whose file is the other library', async () => {
  const { roots, destination } = setup()
  makeLibrary(roots, 'knowledge', 10, 'before'); makeLibrary(roots, 'profile', 3, 'before')
  await createBackup(destination, roots, {}, helperSnapshot)
  // The genuine knowledge snapshot is put where the profile belongs. A restore
  // that only checked the file name would install it and break the profile.
  swap(destination, 'profile', join(destination, 'knowledge', 'data', 'knowledge', 'knowledge.db'))
  await expect(inspectBackup(destination)).rejects.toThrow('不是该数据库')
  await expect(stageRestore(destination, roots)).rejects.toThrow('不是该数据库')
})

it('refuses a library whose schema the helper cannot open', async () => {
  const { roots, destination } = setup()
  makeLibrary(roots, 'knowledge', 10, 'before'); makeLibrary(roots, 'profile', 3, 'before')
  await createBackup(destination, roots, {}, async (database, target) => {
    await helperSnapshot(database, target)
    const file = new DatabaseSync(target)
    try { file.exec(`PRAGMA user_version=${SUPPORTED_SCHEMA[database] + 996}`) } finally { file.close() }
    return fs.statSync(target).size
  })
  await expect(inspectBackup(destination)).rejects.toThrow('版本不受支持')
  await expect(stageRestore(destination, roots)).rejects.toThrow('版本不受支持')
})

it('recovers a version one marker that never listed what it replaced', async () => {
  const { roots, destination } = setup()
  const knowledge = library(roots, 'knowledge', '恢复前')
  await createBackup(destination, roots, {}, helperSnapshot)
  await stageRestore(destination, roots)
  // A marker written by the version that predates the item list: version and notes
  // directory only. Requiring `items` here would report a valid old log as invalid
  // and leave the moved originals in the recovery directory.
  const declared = JSON.parse(fs.readFileSync(join(roots.user, 'restore-pending.json'), 'utf8')) as { items: Array<{ area: string; path: string }> }
  // A version 1 stage never carried a library: the manifest is the legacy one.
  const stage = join(roots.user, '.yu-restore-stage')
  const full = JSON.parse(fs.readFileSync(join(stage, 'manifest.json'), 'utf8')) as { version: number; entries: Array<{ area: string; path: string }> }
  fs.writeFileSync(join(stage, 'manifest.json'), JSON.stringify({ ...full, version: 1, entries: full.entries.filter(entry => entry.path.startsWith('data/') === false) }))
  fs.rmSync(join(stage, 'knowledge'), { recursive: true, force: true })
  fs.writeFileSync(join(roots.user, 'restore-pending.json'), JSON.stringify({ version: 1, notesDir: roots.notes }))
  const id = '22222222-3333-4444-8555-666666666666'
  const at = (area: string) => (roots as unknown as Record<string, string>)[area]
  // The legacy list, in the order a version 1 marker always used.
  const legacyList = declared.items.filter(item => !item.path.startsWith('data/'))
  const items = legacyList.map(item => ({ ...item, present: fs.existsSync(join(at(item.area), item.path)) }))
  fs.writeFileSync(join(roots.user, '.yu-restore-stage', 'restore-state.json'), JSON.stringify({ id, items }))
  const moved = items.filter(item => item.present)
  for (const item of moved) {
    const target = join(at(item.area), item.path), original = join(at(item.area), `.yu-before-restore-${id}`, item.path)
    fs.mkdirSync(join(original, '..'), { recursive: true }); fs.renameSync(target, original)
  }
  // A v1 restore replaces the legacy list only: the libraries stay as they are.
  expect(() => applyPendingRestore(roots)).not.toThrow()
  for (const item of moved) expect(fs.existsSync(join(at(item.area), item.path))).toBe(true)
  expect(fs.existsSync(join(roots.user, 'restore-pending.json'))).toBe(false)
  // The library the v1 list never mentioned is still the live one.
  expect(fs.existsSync(knowledge)).toBe(true)
})

it('rolls the libraries back from the log when the staged files were destroyed', async () => {
  const { roots, destination } = setup()
  const ids = { knowledge: 'before', profile: 'before' }
  for (const area of ['knowledge', 'profile'] as const) makeLibrary(roots, area, area === 'knowledge' ? 10 : 3, ids[area])
  await createBackup(destination, roots, {}, helperSnapshot)
  await stageRestore(destination, roots)
  // A process killed after moving the originals leaves exactly this state: a log,
  // a recovery directory, and a stage that is no longer trustworthy.
  const marker = JSON.parse(fs.readFileSync(join(roots.user, 'restore-pending.json'), 'utf8'))
  const id = '11111111-2222-4333-8444-555555555555'
  const items = marker.items as Array<{ area: string; path: string }>
  const at = (area: string) => (roots as unknown as Record<string, string>)[area]
  const state = { id, items: items.map(item => ({ ...item, present: fs.existsSync(join(at(item.area), item.path)) })) }
  fs.writeFileSync(join(roots.user, '.yu-restore-stage', 'restore-state.json'), JSON.stringify(state))
  for (const item of state.items) if (item.present) {
    const target = join(at(item.area), item.path)
    const original = join(at(item.area), `.yu-before-restore-${id}`, item.path)
    fs.mkdirSync(join(original, '..'), { recursive: true }); fs.renameSync(target, original)
  }
  fs.appendFileSync(join(roots.user, '.yu-restore-stage', 'knowledge', 'data', 'knowledge', 'knowledge.db'), 'broken')
  expect(() => applyPendingRestore(roots)).toThrow('校验失败')
  for (const area of ['knowledge', 'profile'] as const) {
    const file = new DatabaseSync(join(roots[area], 'data', area, `${area}.db`), { readOnly: true })
    try { expect(file.prepare(`SELECT id FROM ${area === 'knowledge' ? 'sources' : 'profile_items'}`).get()?.id).toBe(ids[area]) } finally { file.close() }
  }
  expect(fs.existsSync(join(roots.user, 'restore-pending.json'))).toBe(false)
  expect(fs.readdirSync(roots.user).some(name => name.startsWith('restore-failed-'))).toBe(true)
})
