import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setMainLanguage } from '@shared/mainI18n'
import type { Reminder } from '@shared/reminders'
import {
  RemindersSync,
  type ReminderPage,
  type ReminderPushResult,
  type ReminderRemote,
  type ReminderSyncStore
} from './reminders-sync'

/**
 * The task half of the cloud feature.
 *
 * The reminder store cannot write a row verbatim (`save` refuses a time that has
 * already passed), so the merge goes through `put`; several of these tests exist to
 * pin that down, because the alternative silently drops exactly the overdue tasks
 * a waking machine has to show.
 */
const NOW = 1_760_000_000_000
const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yu-'))
  dirs.push(dir)
  return dir
}

function makeReminder(over: Partial<Reminder> = {}): Reminder {
  return {
    id: 'rem-1',
    title: '交周报',
    dueAt: NOW + 3_600_000,
    level: 'normal',
    priority: 'normal',
    deadlineAt: null,
    recurrence: null,
    source: 'manual',
    status: 'pending',
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
    deliveredAt: null,
    ...over
  }
}

interface MemoryStore extends ReminderSyncStore {
  rows: Map<string, Reminder>
}

function memoryStore(initial: Reminder[] = []): MemoryStore {
  const rows = new Map(initial.map((row) => [row.id, row]))
  return {
    rows,
    list: () => [...rows.values()],
    remove: (id: string) => {
      rows.delete(id)
    },
    put: (row: Reminder) => {
      rows.set(row.id, row)
    }
  }
}

/** A server row as `GET /api/v1/reminders` returns it. */
function remoteRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'rem-9',
    title: '远程任务',
    dueAt: NOW + 60_000,
    level: 'normal',
    priority: 'normal',
    deadlineAt: null,
    recurrence: null,
    status: 'pending',
    data: null,
    updatedAt: NOW,
    deleted: false,
    ...over
  }
}

class FakeRemote implements ReminderRemote {
  readonly pushes: Array<Array<Record<string, unknown>>> = []
  readonly pulls: Array<{ since: number; limit: number }> = []
  duplicate = false
  /** False when the server answers 200 but takes nothing, keeping rows dirty. */
  accept = true
  error: unknown = null
  page: (since: number) => ReminderPage = () => ({ cursor: 0, reminders: [], hasMore: false })

  async pushReminders(changes: unknown[]): Promise<{ status: number; payload: ReminderPushResult }> {
    const rows = changes as Array<Record<string, unknown>>
    this.pushes.push(rows)
    if (this.error) throw this.error
    const ids = rows.map((row) => String(row.id))
    const payload: ReminderPushResult = !this.accept
      ? { applied: [], duplicates: [], conflicts: [], cursor: 0 }
      : this.duplicate
        ? { applied: [], duplicates: ids, conflicts: [], cursor: ids.length }
        : { applied: ids, duplicates: [], conflicts: [], cursor: ids.length }
    return { status: 200, payload }
  }

  async pullReminders(since: number, limit: number): Promise<ReminderPage> {
    this.pulls.push({ since, limit })
    if (this.error) throw this.error
    return this.page(since)
  }
}

function sync(store: ReminderSyncStore, file: string, log: (line: string) => void = () => {}): RemindersSync {
  return new RemindersSync({ store, file, log, now: () => NOW })
}

beforeEach(() => {
  setMainLanguage('zh')
})

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('提醒推送', () => {
  it('整行放进 data，连同截止时间、优先级与重复规则', async () => {
    const row = makeReminder({
      title: '交周报',
      priority: 'high',
      level: 'strong',
      deadlineAt: NOW + 7_200_000,
      recurrence: { frequency: 'weekly', hour: 18, minute: 30, weekdays: [1, 5] },
      source: 'voice',
      timeExpression: '每周一和周五下班前'
    })
    const store = memoryStore([row])
    const remote = new FakeRemote()
    const result = await sync(store, join(tempDir(), 'sync.json')).run(remote, 'http://server.test:8787')

    expect(result).toEqual({ pushed: 1, pulled: 0 })
    const change = remote.pushes[0][0]
    expect(change).toMatchObject({
      id: 'rem-1',
      title: '交周报',
      dueAt: NOW + 3_600_000,
      level: 'strong',
      priority: 'high',
      deadlineAt: NOW + 7_200_000,
      status: 'pending'
    })
    expect(change.recurrence).toEqual({ frequency: 'weekly', hour: 18, minute: 30, weekdays: [1, 5] })
    expect(change.data).toMatchObject({ source: 'voice', timeExpression: '每周一和周五下班前' })
  })

  it('超长标题截到服务器上限，整批不会被拒', async () => {
    const store = memoryStore([makeReminder({ title: '长'.repeat(320) })])
    const remote = new FakeRemote()
    await sync(store, join(tempDir(), 'sync.json')).run(remote, 'http://server.test:8787')
    expect(String(remote.pushes[0][0].title)).toHaveLength(300)
  })

  it('服务器把推送当重复也视为已送达', async () => {
    const store = memoryStore([makeReminder()])
    const remote = new FakeRemote()
    remote.duplicate = true
    const engine = sync(store, join(tempDir(), 'sync.json'))
    await engine.run(remote, 'http://server.test:8787')
    expect(engine.pendingCount()).toBe(0)
  })

  it('本地删除变成 tombstone，服务器确认后不再推', async () => {
    const store = memoryStore([makeReminder()])
    const remote = new FakeRemote()
    const engine = sync(store, join(tempDir(), 'sync.json'))
    await engine.run(remote, 'http://server.test:8787')

    store.remove('rem-1')
    expect(engine.pendingCount()).toBe(1)
    await engine.run(remote, 'http://server.test:8787')
    expect(remote.pushes[1][0]).toMatchObject({
      id: 'rem-1',
      title: '',
      dueAt: null,
      deadlineAt: null,
      recurrence: null,
      status: 'cancelled',
      data: null,
      deletedAt: NOW
    })
    expect(engine.pendingCount()).toBe(0)
  })

  it('服务器拒绝的 id 只记一行日志，不会每轮重试', async () => {
    const store = memoryStore([makeReminder()])
    const remote = new FakeRemote()
    const lines: string[] = []
    remote.pushReminders = async (changes: unknown[]) => {
      const ids = (changes as Array<Record<string, unknown>>).map((row) => String(row.id))
      remote.pushes.push(changes as Array<Record<string, unknown>>)
      return { status: 409, payload: { applied: [], duplicates: [], conflicts: ids.map((id) => ({ id, error: 'reminder_id_taken' })) } }
    }
    const engine = sync(store, join(tempDir(), 'sync.json'), (line) => lines.push(line))
    await engine.run(remote, 'http://server.test:8787')
    expect(engine.pendingCount()).toBe(0)
    expect(lines.join('\n')).toContain('被服务器拒绝')
  })
})

describe('提醒拉取', () => {
  it('从 data 还原整行，包括重复规则与稍后提醒', async () => {
    const store = memoryStore()
    const remote = new FakeRemote()
    remote.page = () => ({
      cursor: 3,
      hasMore: false,
      reminders: [remoteRow({
        id: 'rem-9',
        title: '远程任务',
        dueAt: NOW + 120_000,
        level: 'strong',
        priority: 'high',
        deadlineAt: NOW + 900_000,
        recurrence: { frequency: 'daily', hour: 9, minute: 0 },
        status: 'pending',
        updatedAt: NOW + 5,
        data: {
          title: '远程任务',
          description: '带上合同',
          source: 'voice',
          priority: 'high',
          level: 'strong',
          status: 'pending',
          dueAt: NOW + 120_000,
          deadlineAt: NOW + 900_000,
          recurrence: { frequency: 'daily', hour: 9, minute: 0 },
          snoozedUntil: NOW + 600_000,
          createdAt: NOW - 50_000,
          updatedAt: NOW + 5,
          deliveredAt: null
        }
      })]
    })
    const result = await sync(store, join(tempDir(), 'sync.json')).run(remote, 'http://server.test:8787')

    expect(result.pulled).toBe(1)
    const row = store.rows.get('rem-9')
    expect(row).toMatchObject({
      id: 'rem-9',
      title: '远程任务',
      description: '带上合同',
      source: 'voice',
      priority: 'high',
      level: 'strong',
      dueAt: NOW + 120_000,
      deadlineAt: NOW + 900_000,
      snoozedUntil: NOW + 600_000,
      createdAt: NOW - 50_000,
      updatedAt: NOW + 5,
      deliveredAt: null
    })
    expect(row?.recurrence).toEqual({ frequency: 'daily', hour: 9, minute: 0 })
  })

  it('没有 data 时按列值兜底', async () => {
    const store = memoryStore()
    const remote = new FakeRemote()
    remote.page = () => ({
      cursor: 1,
      hasMore: false,
      reminders: [remoteRow({ id: 'rem-2', title: '只带列', data: null, status: 'completed' })]
    })
    await sync(store, join(tempDir(), 'sync.json')).run(remote, 'http://server.test:8787')
    expect(store.rows.get('rem-2')).toMatchObject({
      title: '只带列',
      status: 'completed',
      level: 'normal',
      priority: 'normal',
      source: 'manual',
      recurrence: null,
      deliveredAt: null
    })
  })

  it('已经过期的提醒照样落地（save 会拒绝，put 不会）', async () => {
    const store = memoryStore()
    const remote = new FakeRemote()
    remote.page = () => ({
      cursor: 1,
      hasMore: false,
      reminders: [remoteRow({
        id: 'rem-3',
        title: '昨天的电话',
        dueAt: NOW - 86_400_000,
        status: 'due',
        data: { title: '昨天的电话', dueAt: NOW - 86_400_000, status: 'due', missedAt: NOW - 86_400_000 }
      })]
    })
    const result = await sync(store, join(tempDir(), 'sync.json')).run(remote, 'http://server.test:8787')
    expect(result.pulled).toBe(1)
    expect(store.rows.get('rem-3')).toMatchObject({
      dueAt: NOW - 86_400_000,
      status: 'due',
      missedAt: NOW - 86_400_000
    })
  })

  it('标题为空的服务器行被跳过', async () => {
    const store = memoryStore()
    const remote = new FakeRemote()
    const lines: string[] = []
    remote.page = () => ({
      cursor: 1,
      hasMore: false,
      reminders: [remoteRow({ id: 'rem-4', title: '', data: null })]
    })
    const result = await sync(store, join(tempDir(), 'sync.json'), (line) => lines.push(line))
      .run(remote, 'http://server.test:8787')
    expect(result.pulled).toBe(0)
    expect(store.rows.size).toBe(0)
    expect(lines.join('\n')).toContain('无法解析')
  })

  it('服务器说删了，本地就删掉', async () => {
    const store = memoryStore([makeReminder()])
    const remote = new FakeRemote()
    remote.page = () => ({
      cursor: 2,
      hasMore: false,
      reminders: [remoteRow({ id: 'rem-1', deleted: true, deletedAt: NOW, title: '', data: null })]
    })
    const result = await sync(store, join(tempDir(), 'sync.json')).run(remote, 'http://server.test:8787')
    expect(result.pulled).toBe(1)
    expect(store.rows.has('rem-1')).toBe(false)
  })

  it('游标只前进，并写进状态文件', async () => {
    const file = join(tempDir(), 'sync.json')
    const store = memoryStore()
    const remote = new FakeRemote()
    remote.page = () => ({ cursor: 11, reminders: [], hasMore: false })
    await sync(store, file).run(remote, 'http://server.test:8787')

    remote.page = () => ({ cursor: 4, reminders: [], hasMore: false })
    await sync(store, file).run(remote, 'http://server.test:8787')
    expect(remote.pulls.map((call) => call.since)).toEqual([0, 11])

    const next = new FakeRemote()
    await sync(store, file).run(next, 'http://server.test:8787')
    expect(next.pulls[0].since).toBe(11)
  })

  it('翻页直到 hasMore 为假', async () => {
    const store = memoryStore()
    const remote = new FakeRemote()
    remote.page = (since) => since === 0
      ? { cursor: 1, hasMore: true, reminders: [remoteRow({ id: 'rem-a', title: 'A', data: null })] }
      : { cursor: 2, hasMore: false, reminders: [remoteRow({ id: 'rem-b', title: 'B', data: null })] }
    const result = await sync(store, join(tempDir(), 'sync.json')).run(remote, 'http://server.test:8787')
    expect(result.pulled).toBe(2)
    expect([...store.rows.keys()]).toEqual(['rem-a', 'rem-b'])
    expect(remote.pulls.map((call) => call.since)).toEqual([0, 1])
  })

  it('未确认的本地改动在冲突时另存，且允许副本保留已过的时间', async () => {
    const store = memoryStore([makeReminder({ title: '交周报（本机）', dueAt: NOW - 1000 })])
    const remote = new FakeRemote()
    remote.accept = false
    remote.page = () => ({
      cursor: 7,
      hasMore: false,
      reminders: [remoteRow({ id: 'rem-1', title: '交周报（服务器）', dueAt: NOW + 600_000, data: null })]
    })
    const lines: string[] = []
    const result = await sync(store, join(tempDir(), 'sync.json'), (line) => lines.push(line))
      .run(remote, 'http://server.test:8787')

    expect(result.pulled).toBe(1)
    expect(store.rows.get('rem-1')?.title).toBe('交周报（服务器）')
    const copy = [...store.rows.values()].find((row) => row.id !== 'rem-1')
    expect(copy?.title).toBe('交周报（本机）（冲突副本）')
    // The copy keeps a time that has already passed: `put` had to be the writer.
    expect(copy?.dueAt).toBe(NOW - 1000)
    expect(lines.join('\n')).toContain('已另存')
  })
})

describe('提醒同步的降级', () => {
  it('服务器不支持提醒接口时记住并跳过', async () => {
    const store = memoryStore([makeReminder()])
    const remote = new FakeRemote()
    remote.error = Object.assign(new Error('没有这个接口'), { status: 404 })
    const lines: string[] = []
    const engine = sync(store, join(tempDir(), 'sync.json'), (line) => lines.push(line))

    expect(await engine.run(remote, 'http://old.test:8787')).toEqual({ pushed: 0, pulled: 0 })
    expect(lines.join('\n')).toContain('不支持')

    remote.error = null
    await engine.run(remote, 'http://old.test:8787')
    expect(remote.pushes).toHaveLength(1)
    expect(remote.pulls).toHaveLength(0)
  })

  it('其他错误照常抛出', async () => {
    const store = memoryStore([makeReminder()])
    const remote = new FakeRemote()
    remote.error = Object.assign(new Error('服务器睡着了'), { status: 503 })
    await expect(sync(store, join(tempDir(), 'sync.json')).run(remote, 'http://server.test:8787'))
      .rejects.toThrow('服务器睡着了')
  })

  it('状态文件损坏时从零开始，不丢本机数据', async () => {
    const dir = tempDir()
    const file = join(dir, 'sync.json')
    const store = memoryStore([makeReminder()])
    const remote = new FakeRemote()
    await sync(store, file).run(remote, 'http://server.test:8787')

    // A truncated file is what a crash mid-write leaves behind.
    writeFileSync(file, '{ not json', 'utf8')
    const lines: string[] = []
    const again = sync(store, file, (line) => lines.push(line))
    expect(again.pendingCount()).toBe(1)
    expect(lines.join('\n')).toContain('无法读取')
    expect(store.rows.size).toBe(1)
  })
})
