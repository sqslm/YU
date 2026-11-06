import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import { applyPendingRestore, createBackup, describe as describeDatabase, inspectBackup, stageRestore, SUPPORTED_SCHEMA, type BackupRoots } from './backup'
import { KnowledgeHost } from './knowledge/host'

/**
 * The two helper databases join the existing backup only as consistent snapshots:
 * what a restart would see, not the live files. These run against the compiled
 * helper over its real pipes, with the cards, sources and relations it minted.
 */
const ENTRY = join(process.cwd(), 'native', 'bin', 'yu-knowledge.exe')

const cleanup: string[] = []
const hosts: KnowledgeHost[] = []

afterEach(async () => {
  for (const instance of hosts.splice(0)) await instance.stop()
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Rig { base: string; roots: BackupRoots; destination: string }

function rig(): Rig {
  const base = mkdtempSync(join(tmpdir(), 'yu-backup-lib-'))
  cleanup.push(base)
  const roots: BackupRoots = {
    user: join(base, 'user'),
    notes: join(base, 'notes'),
    chat: join(base, 'install', 'chat'),
    knowledge: join(base, 'install'),
    profile: join(base, 'install')
  }
  for (const dir of new Set(Object.values(roots))) mkdirSync(dir, { recursive: true })
  mkdirSync(join(roots.notes, 'notes'), { recursive: true })
  mkdirSync(join(base, 'backups'), { recursive: true })
  require('node:fs').writeFileSync(join(roots.notes, 'notes.json'), JSON.stringify({ notes: [{ id: 'carried' }] }))
  return { base, roots, destination: join(base, 'backup') }
}

function helper(root: string): KnowledgeHost {
  if (!existsSync(ENTRY)) throw new Error(`the knowledge helper is missing: ${ENTRY}`)
  const instance = new KnowledgeHost({ entry: ENTRY, root, requestMs: 30_000, idleMs: 60_000 })
  hosts.push(instance)
  return instance
}

/** Rows of one table in a database file, read without opening the helper. */
function rows(path: string, table: string): number {
  const file = new DatabaseSync(path, { readOnly: true })
  try { return Number(file.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? 0) } finally { file.close() }
}

describe('the two libraries in the backup', () => {
  it('snapshots them, restores them on the next start and leaves the other data alone', async () => {
    const { roots, base } = rig()
    const install = roots.knowledge
    const knowledgeDb = join(install, 'data', 'knowledge', 'knowledge.db')
    const profileDb = join(install, 'data', 'profile', 'profile.db')
    const instance = helper(install)
    const source = await instance.saveSource({
      kind: 'note', originRef: 'n1', locator: '', title: '随记一', version: '1', scope: '随记', readAt: 1,
      text: '这条随记讲的是幂等键的用途。'
    })
    const card = await instance.saveCard({ kind: 'concept', title: '幂等键', summary: '重复请求只生效一次', body: '幂等键让重复请求只生效一次。', topics: ['幂等'], sourceIds: [source.id] })
    await instance.profileStatus()
    expect(existsSync(knowledgeDb)).toBe(true)

    const snapshot = (database: 'knowledge' | 'profile', target: string): Promise<number> => instance.backupDatabase(database, target)
    const result = await createBackup(join(base, 'backup'), roots, { 随记: 1 }, snapshot)
    expect(result.libraries).toEqual(['knowledge', 'profile'])
    const manifest = JSON.parse(readFileSync(join(base, 'backup', 'manifest.json'), 'utf8'))
    expect(manifest.version).toBe(2)
    const areas = manifest.entries.map((entry: { area: string }) => entry.area)
    expect(areas).toContain('knowledge')
    expect(areas).toContain('profile')
    // The snapshot is a file of its own: no log was carried along beside it.
    expect(existsSync(join(base, 'backup', 'knowledge', 'data', 'knowledge', 'knowledge.db'))).toBe(true)
    expect(existsSync(join(base, 'backup', 'knowledge', 'data', 'knowledge', 'knowledge.db-wal'))).toBe(false)
    expect(rows(join(base, 'backup', 'knowledge', 'data', 'knowledge', 'knowledge.db'), 'cards')).toBe(1)

    // Change the live libraries after the backup, so a restore has to undo it.
    const second = await instance.saveSource({
      kind: 'web', originRef: 'https://example.test/later', locator: 'https://example.test/later', title: '后来的网页', version: 'v1', scope: '', readAt: 2,
      text: '这是备份之后才出现的材料。'
    })
    await instance.saveCard({ kind: 'concept', title: '后来的卡片', summary: '', body: '备份之后才写下的卡片。', topics: [], sourceIds: [second.id] })
    expect(rows(knowledgeDb, 'cards')).toBe(2)
    await instance.stop()
    hosts.length = 0

    const notes = join(roots.notes, 'notes.json')
    require('node:fs').writeFileSync(notes, JSON.stringify({ notes: [{ id: 'newer' }] }))
    expect(JSON.parse(readFileSync(notes, 'utf8')).notes[0].id).toBe('newer')
    await stageRestore(join(base, 'backup'), roots)
    const recovery = applyPendingRestore(roots)!
    expect(recovery.length).toBeGreaterThan(0)

    // The old log left with the database it belonged to, so it cannot be
    // replayed onto the snapshot that replaced it.
    expect(existsSync(`${knowledgeDb}-wal`)).toBe(false)
    expect(existsSync(profileDb)).toBe(true)
    expect(recovery.length).toBeGreaterThan(0)

    // Cold start on the restored files: the card the backup carried is there,
    // the one written afterwards is gone, and the source came back with it.
    const reopened = helper(install)
    const restored = await reopened.getCard(card.id)
    expect(restored.title).toBe('幂等键')
    expect(restored.sourceIds).toEqual([source.id])
    expect((await reopened.listCards()).total).toBe(1)
    const sourceRow = await reopened.findSources({ channel: 'note', originRef: 'n1' })
    expect(sourceRow.sources.length).toBe(1)
    const profile = await reopened.profileStatus()
    expect(profile.enabled).toBeTypeOf('boolean')
    expect(JSON.parse(readFileSync(notes, 'utf8')).notes[0].id).toBe('carried')
    expect(recovery.some(dir => existsSync(join(dir, 'data', 'knowledge', 'knowledge.db')))).toBe(true)
  }, 120_000)

  it('keeps the library a backup does not carry, sidecars included', async () => {
    const { roots, base } = rig()
    const install = roots.knowledge
    const profileDb = join(install, 'data', 'profile', 'profile.db')
    const instance = helper(install)
    await instance.saveSource({ kind: 'note', originRef: 'n1', locator: '', title: '随记一', version: '1', scope: '随记', readAt: 1, text: '只备份知识库的那一次。' })
    await instance.profileStatus()
    const snapshot = (database: 'knowledge' | 'profile', target: string): Promise<number> => instance.backupDatabase(database, target)
    const destination = join(base, 'backups', 'one-library')
    await createBackup(destination, roots, {}, snapshot)
    await instance.stop()
    hosts.length = 0

    // The backup now carries only the knowledge library, the way one written
    // while the profile could not be reached would.
    const manifestPath = join(destination, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.entries = manifest.entries.filter((entry: { area: string }) => entry.area !== 'profile')
    rmSync(join(destination, 'profile'), { recursive: true, force: true })
    require('node:fs').writeFileSync(manifestPath, JSON.stringify(manifest))
    const profileBytes = readFileSync(profileDb)
    // A stale log beside the untouched library must survive too: it belongs to
    // the database that stayed, not to the one being replaced.
    require('node:fs').writeFileSync(`${profileDb}-wal`, 'stale profile log')

    await stageRestore(destination, roots)
    applyPendingRestore(roots)
    expect(readFileSync(profileDb)).toEqual(profileBytes)
    expect(readFileSync(`${profileDb}-wal`, 'utf8')).toBe('stale profile log')
    expect(existsSync(join(install, 'data', 'knowledge', 'knowledge.db'))).toBe(true)
  }, 120_000)

  it('still restores a version 1 backup and refuses one that claims a library', async () => {
    const { roots, base } = rig()
    const install = roots.knowledge
    const knowledgeDb = join(install, 'data', 'knowledge', 'knowledge.db')
    const instance = helper(install)
    const source = await instance.saveSource({ kind: 'note', originRef: 'n1', locator: '', title: '随记一', version: '1', scope: '随记', readAt: 1, text: '版本一备份里的材料。' })
    const card = await instance.saveCard({ kind: 'concept', title: '随记一的卡', summary: '', body: '版本一备份里的卡片。', topics: [], sourceIds: [source.id] })
    const snapshot = (database: 'knowledge' | 'profile', target: string): Promise<number> => instance.backupDatabase(database, target)
    const destination = join(base, 'backups', 'v2')
    await createBackup(destination, roots, {}, snapshot)
    await instance.stop()
    hosts.length = 0
    const claim = join(base, 'backups', 'claim')
    require('node:fs').cpSync(destination, claim, { recursive: true })

    // The same directory declared as a version 1 backup: the libraries are no
    // longer part of it, so a restore must leave the live ones exactly as they are.
    const manifestPath = join(destination, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.version = 1
    manifest.entries = manifest.entries.filter((entry: { area: string }) => entry.area !== 'knowledge' && entry.area !== 'profile')
    rmSync(join(destination, 'knowledge'), { recursive: true, force: true })
    rmSync(join(destination, 'profile'), { recursive: true, force: true })
    require('node:fs').writeFileSync(manifestPath, JSON.stringify(manifest))
    expect((await inspectBackup(destination)).libraries).toEqual([])

    await expect(stageRestore(destination, roots)).resolves.toBeUndefined()
    applyPendingRestore(roots)
    const reopened = helper(install)
    expect((await reopened.getCard(card.id)).title).toBe('随记一的卡')
    expect(rows(knowledgeDb, 'cards')).toBe(1)
    await reopened.stop()
    hosts.length = 0

    // A version 1 manifest that lists a library is not that backup's file, even
    // when its entries would otherwise pass every check.
    const claimManifest = JSON.parse(readFileSync(join(claim, 'manifest.json'), 'utf8'))
    claimManifest.version = 1
    require('node:fs').writeFileSync(join(claim, 'manifest.json'), JSON.stringify(claimManifest))
    await expect(inspectBackup(claim)).rejects.toThrow('无效')
    await expect(stageRestore(claim, roots)).rejects.toThrow('无效')
  }, 120_000)

  it('skips a library that is not there and cleans up when a snapshot fails', async () => {
    const { roots, base } = rig()
    // No helper has run, so neither database exists: the backup must not create one.
    const empty = await createBackup(join(base, 'empty'), roots, {}, async () => { throw Error('must not be called') })
    expect(empty.libraries).toEqual([])
    expect(existsSync(join(base, 'empty', 'knowledge'))).toBe(false)
    expect(existsSync(join(roots.knowledge, 'data'))).toBe(false)

    const instance = helper(roots.knowledge)
    await instance.saveSource({ kind: 'note', originRef: 'n1', locator: '', title: '随记一', version: '1', scope: '随记', readAt: 1, text: '有材料的一次。' })
    const locked = join(base, 'locked')
    await expect(createBackup(locked, roots, {}, async () => { throw Error('the database is locked') })).rejects.toThrow('locked')
    expect(existsSync(locked)).toBe(false)
  }, 60_000)
})

describe('what a backup refuses to invent', () => {
  const TEXT = '冷备份时只应看到已经存在的那个库，缺失的那个不该被备份创建出来。'
  it('creates neither library when the app never opened one', async () => {
    const { roots } = rig()
    const instance = helper(roots.knowledge)
    const knowledge = join(roots.knowledge, 'data', 'knowledge', 'knowledge.db')
    const profile = join(roots.profile, 'data', 'profile', 'profile.db')
    expect(existsSync(knowledge) || existsSync(profile)).toBe(false)
    const result = await createBackup(join(roots.knowledge, '..', 'backup-cold'), roots, {}, (database, target) => instance.backupDatabase(database, target))
    // Nothing to copy, nothing invented: a backup is not a reason to start a library.
    expect(result.libraries).toEqual([])
    expect(existsSync(knowledge), 'the backup created the knowledge library').toBe(false)
    expect(existsSync(profile), 'the backup created the profile library').toBe(false)
  })

  it('mirrors the schema the helper writes', async () => {
    const { roots } = rig()
    const instance = helper(roots.knowledge)
    await instance.saveSource({ kind: 'note', originRef: 'n1', locator: 'n1', title: '冷备份', version: 'v1', scope: '测试', text: TEXT })
    expect(describeDatabase(join(roots.knowledge, 'data', 'knowledge', 'knowledge.db')).version).toBe(SUPPORTED_SCHEMA.knowledge)
    await instance.profileStatus()
    expect(describeDatabase(join(roots.profile, 'data', 'profile', 'profile.db')).version).toBe(SUPPORTED_SCHEMA.profile)
  })
})
