import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { applyPendingRestore, createBackup, inspectBackup, stageRestore, type BackupRoots } from './backup'
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, copyFileSync: vi.fn(actual.copyFileSync) }
})

const rootsToRemove: string[] = [], databases: DatabaseSync[] = []
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) if (db.isOpen) db.close(); for (const root of rootsToRemove.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function setup(): { root: string; roots: BackupRoots; destination: string } {
  const root = fs.mkdtempSync(join(tmpdir(), 'yu-backup-test-')); rootsToRemove.push(root)
  const roots = { user: join(root, 'user'), notes: join(root, 'custom-notes'), chat: join(root, 'install', 'chat') }
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
it('backs up committed WAL contents and restores user data while retaining models, login and a recovery copy', async () => {
  const { roots, destination } = setup()
  const db = new DatabaseSync(join(roots.chat, 'chats.db')); databases.push(db)
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE data(value TEXT); INSERT INTO data VALUES('最新已提交内容')")
  const result = await createBackup(destination, roots, { 聊天: 1, 随记: 1 })
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
  await createBackup(destination, roots, {})
  fs.appendFileSync(join(destination, 'notes', 'notes.json'), 'bad')
  expect(() => inspectBackup(destination)).toThrow('校验失败')
  expect(fs.existsSync(join(roots.user, '.yu-restore-stage'))).toBe(false)
  const manifest = JSON.parse(fs.readFileSync(join(destination, 'manifest.json'), 'utf8'))
  manifest.entries[0].path = '../account.json'
  fs.writeFileSync(join(destination, 'manifest.json'), JSON.stringify(manifest))
  await expect(stageRestore(destination, roots)).rejects.toThrow('无效')
  expect(fs.readFileSync(join(roots.user, 'account.json'), 'utf8')).toBe('current login')
})
it('rolls back all moved data when installing a restored file fails', async () => {
  const { roots, destination } = setup()
  await createBackup(destination, roots, {})
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
  await createBackup(destination, roots, {})
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
