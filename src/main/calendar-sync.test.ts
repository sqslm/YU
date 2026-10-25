import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setMainLanguage } from '@shared/mainI18n'
import type { CalendarEvent } from '@shared/calendar'
import { CalendarStore } from './calendar'
import {
  CalendarSync,
  DEFAULT_ICS_TIMEOUT_MS,
  FeedTooLargeError,
  checkFeedUrl,
  readCappedText,
  refreshExternalCalendars,
  resolveFeedUrl,
  type CalendarPage,
  type CalendarPushResult,
  type CalendarRemote,
  type CalendarSyncStore,
  type ExternalCalendar,
  type IcsFetch,
  type IcsResponse
} from './calendar-sync'

/**
 * The calendar half of the cloud feature: subscription feeds in, and the two-way
 * `seq` sync with the self-hosted server.
 *
 * Everything here is driven by fakes — a fake `fetch`, a fake store — because the
 * point of these tests is the merge policy, not the network or the file format
 * (both of which have their own suites).
 */
const NOW = 1_760_000_000_000
const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yu-'))
  dirs.push(dir)
  return dir
}

function ics(uid: string, summary: string, start = '20261101T100000Z', end = '20261101T110000Z'): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Yu//Calendar//CN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `SUMMARY:${summary}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n')
}

function feed(over: Partial<ExternalCalendar> = {}): ExternalCalendar {
  return { id: 'feed-1', name: '工作', url: 'https://feeds.example.com/work.ics', enabled: true, ...over }
}

function okFeed(body: string): IcsFetch {
  return async () => ({ ok: true, status: 200, text: async () => body })
}

/**
 * A body that arrives in pieces, like a real socket, and reports what was asked
 * of it: `pulls` counts reads, `onCancel` fires when the reader gives up early.
 */
function chunkStream(
  chunks: Uint8Array[],
  onCancel?: () => void
): { stream: ReadableStream<Uint8Array>; pulls: () => number } {
  let pulls = 0
  let index = 0
  // `highWaterMark: 0` so the stream does not fill its internal queue on its own:
  // then `pulls` counts what a reader actually asked for, not eager prefetching.
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls += 1
        const chunk = chunks[index]
        index += 1
        if (!chunk) {
          controller.close()
          return
        }
        controller.enqueue(chunk)
      },
      cancel() {
        onCancel?.()
      }
    },
    { highWaterMark: 0 }
  )
  return { stream, pulls: () => pulls }
}

function makeEvent(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'evt-1',
    title: '周会',
    start: NOW + 3_600_000,
    end: NOW + 7_200_000,
    allDay: false,
    source: 'manual',
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
    status: 'confirmed',
    ...over
  }
}

interface MemoryStore extends CalendarSyncStore {
  rows: Map<string, CalendarEvent>
}

function memoryStore(initial: CalendarEvent[] = []): MemoryStore {
  const rows = new Map(initial.map((event) => [event.id, event]))
  return {
    rows,
    list: () => [...rows.values()],
    remove: (id: string) => {
      rows.delete(id)
    },
    put: (row: CalendarEvent) => {
      rows.set(row.id, row)
    }
  }
}

/** A `CalendarRemote` whose answers each test scripts. */
class FakeRemote implements CalendarRemote {
  readonly pushes: Array<Array<Record<string, unknown>>> = []
  readonly pulls: Array<{ since: number; limit: number }> = []
  /** The server answering every push with "already have it", like a retry does. */
  duplicate = false
  /** False when the server answers 200 but takes nothing, keeping the rows dirty. */
  accept = true
  /** Ids the server rejects because its own copy is newer, like a late push. */
  stale: string[] = []
  error: unknown = null
  page: (since: number) => CalendarPage = () => ({ cursor: 0, events: [], hasMore: false })

  async pushCalendar(changes: unknown[]): Promise<{ status: number; payload: CalendarPushResult }> {
    const rows = changes as Array<Record<string, unknown>>
    this.pushes.push(rows)
    if (this.error) throw this.error
    const ids = rows.map((row) => String(row.id))
    const stale = ids.filter((id) => this.stale.includes(id))
    const fresh = ids.filter((id) => !this.stale.includes(id))
    const payload: CalendarPushResult = !this.accept
      ? { applied: [], duplicates: [], conflicts: [], stale, cursor: 0 }
      : this.duplicate
        ? { applied: [], duplicates: fresh, conflicts: [], stale, cursor: ids.length }
        : { applied: fresh, duplicates: [], conflicts: [], stale, cursor: ids.length }
    return { status: 200, payload }
  }

  async pullCalendar(since: number, limit: number): Promise<CalendarPage> {
    this.pulls.push({ since, limit })
    if (this.error) throw this.error
    return this.page(since)
  }
}

function unsupported(): Error {
  return Object.assign(new Error('没有这个接口'), { status: 404 })
}

function sync(store: CalendarSyncStore, file: string, log: (line: string) => void = () => {}): CalendarSync {
  return new CalendarSync({ store, file, log, now: () => NOW })
}

beforeEach(() => {
  setMainLanguage('zh')
})

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('订阅地址校验', () => {
  it('webcal 改写成 https', () => {
    expect(resolveFeedUrl('webcal://example.com/a.ics')).toBe('https://example.com/a.ics')
    expect(resolveFeedUrl('  webcals://example.com/a.ics  ')).toBe('https://example.com/a.ics')
    expect(resolveFeedUrl('https://example.com/a.ics')).toBe('https://example.com/a.ics')
  })

  it('接受 https 与 webcal，拒绝明文 http', () => {
    expect(checkFeedUrl('https://example.com/a.ics')).toEqual({ ok: true, url: 'https://example.com/a.ics' })
    expect(checkFeedUrl('webcal://example.com/a.ics')).toEqual({ ok: true, url: 'https://example.com/a.ics' })
    const plain = checkFeedUrl('http://example.com/a.ics')
    expect(plain.ok).toBe(false)
  })

  it('拒绝内网与回环地址', () => {
    for (const url of [
      'http://127.0.0.1:8080/cal.ics',
      'https://localhost/cal.ics',
      'https://192.168.1.12/cal.ics',
      'https://10.0.0.5/cal.ics',
      'https://169.254.169.254/latest/meta-data.ics',
      'https://172.20.3.4/cal.ics',
      'https://nas.local/cal.ics',
      'https://[::1]/cal.ics'
    ]) {
      expect(checkFeedUrl(url).ok).toBe(false)
    }
  })

  it('拒绝非 http(s) 协议', () => {
    expect(checkFeedUrl('file:///etc/passwd').ok).toBe(false)
    expect(checkFeedUrl('ftp://example.com/a.ics').ok).toBe(false)
  })

  it('默认超时是 15 秒', () => {
    expect(DEFAULT_ICS_TIMEOUT_MS).toBe(15_000)
  })
})

describe('响应体读取上限', () => {
  it('content-length 超过上限时直接拒绝，响应体一次也不读', async () => {
    let textCalls = 0
    let cancels = 0
    const { stream, pulls } = chunkStream([new Uint8Array([0x61])], () => {
      cancels += 1
    })
    const response: IcsResponse = {
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === 'content-length' ? '900000000' : null) },
      body: stream,
      text: async () => {
        textCalls += 1
        return 'a'
      }
    }

    await expect(readCappedText(response, 1024)).rejects.toBeInstanceOf(FeedTooLargeError)
    // The whole point: the ceiling is checked before a single byte is buffered.
    expect(pulls()).toBe(0)
    expect(cancels).toBe(0)
    expect(textCalls).toBe(0)
  })

  it('流式读取越过上限时取消读取器，不再继续累积', async () => {
    let cancels = 0
    const chunks = Array.from({ length: 5 }, () => new Uint8Array(8).fill(0x61))
    const { stream, pulls } = chunkStream(chunks, () => {
      cancels += 1
    })
    const response: IcsResponse = { ok: true, status: 200, text: async () => '', body: stream }

    const error = await readCappedText(response, 10).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(FeedTooLargeError)
    expect((error as FeedTooLargeError).name).toBe('FeedTooLargeError')
    expect(cancels).toBe(1)
    // Stopped at the chunk that crossed the line instead of draining the feed.
    expect(pulls()).toBeLessThan(chunks.length)
  })

  it('正常的小响应体逐块解码', async () => {
    let textCalls = 0
    const { stream } = chunkStream([Buffer.from('BEGIN:VCALENDAR\r\n'), Buffer.from('END:VCALENDAR')])
    const response: IcsResponse = {
      ok: true,
      status: 200,
      text: async () => {
        textCalls += 1
        return 'unused'
      },
      body: stream
    }

    expect(await readCappedText(response, 1024)).toBe('BEGIN:VCALENDAR\r\nEND:VCALENDAR')
    expect(textCalls).toBe(0)
  })

  it('多字节字符被切在两个块之间也能正确解码', async () => {
    const bytes = Buffer.from('会议日程确认', 'utf8')
    // 会 is three bytes, so a cut at 4 lands inside 议: exactly the boundary the
    // streaming decoder has to survive.
    const { stream } = chunkStream([bytes.subarray(0, 4), bytes.subarray(4)])
    const response: IcsResponse = { ok: true, status: 200, text: async () => '', body: stream }

    expect(await readCappedText(response, 1024)).toBe('会议日程确认')
  })

  it('没有可读流时退回 text()，大小照样检查', async () => {
    const small: IcsResponse = { ok: true, status: 200, text: async () => 'BEGIN:VCALENDAR' }
    expect(await readCappedText(small, 1024)).toBe('BEGIN:VCALENDAR')

    const big: IcsResponse = { ok: true, status: 200, body: null, text: async () => 'a'.repeat(64) }
    await expect(readCappedText(big, 10)).rejects.toBeInstanceOf(FeedTooLargeError)
  })
})

describe('外部日历订阅', () => {
  it('拉取后按 uid 合并，重复拉取只更新不新增', async () => {
    const store = new CalendarStore(join(tempDir(), 'calendar.json'))
    const urls: string[] = []
    const fetched: Array<{ id: string; at: number }> = []
    const fetchImpl: IcsFetch = async (url) => {
      urls.push(url)
      return { ok: true, status: 200, text: async () => ics('work-1@example.com', '产品评审') }
    }
    const options = {
      getCalendars: () => [feed({ url: 'webcal://feeds.example.com/work.ics' })],
      fetchImpl,
      store,
      log: () => {},
      now: () => NOW,
      onFetched: (id: string, at: number) => fetched.push({ id, at })
    }

    const first = await refreshExternalCalendars(options)
    expect(first).toEqual({ feeds: 1, added: 1, updated: 0, failed: 0 })
    expect(urls).toEqual(['https://feeds.example.com/work.ics'])
    expect(fetched).toEqual([{ id: 'feed-1', at: NOW }])

    const second = await refreshExternalCalendars(options)
    expect(second).toEqual({ feeds: 1, added: 0, updated: 1, failed: 0 })
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0].title).toBe('产品评审')
    expect(store.list()[0].source).toBe('import')
  })

  it('本地已取消的日程在订阅刷新后仍是已取消', async () => {
    const store = new CalendarStore(join(tempDir(), 'calendar.json'))
    const options = {
      getCalendars: () => [feed()],
      fetchImpl: okFeed(ics('work-1@example.com', '产品评审')),
      store,
      log: () => {}
    }
    await refreshExternalCalendars(options)
    const id = store.list()[0].id
    store.action(id, 'cancel')

    await refreshExternalCalendars(options)
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0].status).toBe('cancelled')
  })

  it('未启用的订阅不出网', async () => {
    const store = new CalendarStore(join(tempDir(), 'calendar.json'))
    let calls = 0
    const result = await refreshExternalCalendars({
      getCalendars: () => [feed({ enabled: false })],
      fetchImpl: async () => {
        calls += 1
        return { ok: true, status: 200, text: async () => ics('a@b', 'x') }
      },
      store,
      log: () => {}
    })
    expect(result).toEqual({ feeds: 0, added: 0, updated: 0, failed: 0 })
    expect(calls).toBe(0)
  })

  it('内网地址一次也不请求，只记一行日志', async () => {
    const store = new CalendarStore(join(tempDir(), 'calendar.json'))
    const lines: string[] = []
    let calls = 0
    const result = await refreshExternalCalendars({
      getCalendars: () => [feed({ url: 'http://127.0.0.1:9000/cal.ics' })],
      fetchImpl: async () => {
        calls += 1
        return { ok: true, status: 200, text: async () => '' }
      },
      store,
      log: (line) => lines.push(line)
    })
    expect(result).toEqual({ feeds: 1, added: 0, updated: 0, failed: 1 })
    expect(calls).toBe(0)
    expect(lines.join('\n')).toContain('跳过')
  })

  it('超时的订阅降级成一次失败，不抛异常', async () => {
    const store = new CalendarStore(join(tempDir(), 'calendar.json'))
    const lines: string[] = []
    let aborted = false
    const result = await refreshExternalCalendars({
      getCalendars: () => [feed()],
      fetchImpl: async () => {
        // A feed that never answers: the module has to stop waiting by itself.
        await new Promise((resolve) => setTimeout(resolve, 500))
        aborted = true
        return { ok: true, status: 200, text: async () => '' }
      },
      store,
      log: (line) => lines.push(line),
      timeoutMs: 20
    })
    expect(result).toEqual({ feeds: 1, added: 0, updated: 0, failed: 1 })
    expect(lines.join('\n')).toContain('超时')
    expect(aborted).toBe(false)
  })

  it('HTTP 错误只算一次失败', async () => {
    const store = new CalendarStore(join(tempDir(), 'calendar.json'))
    const lines: string[] = []
    const result = await refreshExternalCalendars({
      getCalendars: () => [feed()],
      fetchImpl: async () => ({ ok: false, status: 500, text: async () => '' }),
      store,
      log: (line) => lines.push(line)
    })
    expect(result.failed).toBe(1)
    expect(lines.join('\n')).toContain('500')
  })

  it('订阅体超过上限时记「文件过大」并算一次失败', async () => {
    const store = new CalendarStore(join(tempDir(), 'calendar.json'))
    const lines: string[] = []
    const result = await refreshExternalCalendars({
      getCalendars: () => [feed()],
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        // Over 5 MB announced: the body must never be read at all.
        headers: { get: () => '6291456' },
        text: async () => {
          throw new Error('不该读响应体')
        }
      }),
      store,
      log: (line) => lines.push(line)
    })
    expect(result).toEqual({ feeds: 1, added: 0, updated: 0, failed: 1 })
    expect(lines.join('\n')).toContain('文件过大')
    expect(store.list()).toHaveLength(0)
  })

  it('一个订阅坏掉不影响另一个', async () => {
    const store = new CalendarStore(join(tempDir(), 'calendar.json'))
    const result = await refreshExternalCalendars({
      getCalendars: () => [
        feed({ id: 'bad', url: 'http://10.0.0.9/x.ics' }),
        feed({ id: 'good', url: 'https://feeds.example.com/work.ics' })
      ],
      fetchImpl: okFeed(ics('work-1@example.com', '产品评审')),
      store,
      log: () => {}
    })
    expect(result).toEqual({ feeds: 2, added: 1, updated: 0, failed: 1 })
    expect(store.list()).toHaveLength(1)
  })
})

describe('日程双向同步', () => {
  it('推送变化的日程并记住服务器已确认的内容', async () => {
    const store = memoryStore([makeEvent()])
    const remote = new FakeRemote()
    const engine = sync(store, join(tempDir(), 'sync.json'))

    expect(engine.pendingCount()).toBe(1)
    const result = await engine.run(remote, 'http://server.test:8787')
    expect(result).toEqual({ pushed: 1, pulled: 0 })
    expect(remote.pushes).toHaveLength(1)
    expect(remote.pushes[0][0]).toMatchObject({
      id: 'evt-1',
      title: '周会',
      start: NOW + 3_600_000,
      end: NOW + 7_200_000,
      allDay: false,
      location: null,
      notes: null,
      leadMinutes: null,
      source: 'manual',
      uid: null,
      status: 'confirmed',
      updatedAt: NOW - 1000
    })
    expect(engine.pendingCount()).toBe(0)

    // Nothing changed since: the next pass sends nothing.
    await engine.run(remote, 'http://server.test:8787')
    expect(remote.pushes).toHaveLength(1)
  })

  it('服务器把推送当成重复也视为已送达', async () => {
    const store = memoryStore([makeEvent()])
    const remote = new FakeRemote()
    remote.duplicate = true
    const engine = sync(store, join(tempDir(), 'sync.json'))
    const result = await engine.run(remote, 'http://server.test:8787')
    expect(result.pushed).toBe(1)
    expect(engine.pendingCount()).toBe(0)
  })

  it('拉取新日程并把游标写进状态文件', async () => {
    const file = join(tempDir(), 'sync.json')
    const store = memoryStore()
    const remote = new FakeRemote()
    remote.page = () => ({
      cursor: 7,
      hasMore: false,
      events: [{
        id: 'remote-1',
        title: '远程会议',
        start: NOW + 1_000_000,
        end: NOW + 1_800_000,
        allDay: false,
        location: '3 楼',
        notes: null,
        leadMinutes: 15,
        source: 'manual',
        uid: null,
        status: 'confirmed',
        updatedAt: NOW,
        deleted: false
      }]
    })
    const engine = sync(store, file)
    const result = await engine.run(remote, 'http://server.test:8787')
    expect(result.pulled).toBe(1)
    expect(store.rows.get('remote-1')?.title).toBe('远程会议')
    expect(engine.pendingCount()).toBe(0)

    // A fresh instance reads the cursor back and does not re-read the page.
    const next = new FakeRemote()
    await sync(store, file).run(next, 'http://server.test:8787')
    expect(next.pulls[0].since).toBe(7)
  })

  it('游标只前进，不因服务器返回旧游标而倒退', async () => {
    const file = join(tempDir(), 'sync.json')
    const store = memoryStore()
    const remote = new FakeRemote()
    remote.page = () => ({ cursor: 9, events: [], hasMore: false })
    const engine = sync(store, file)
    await engine.run(remote, 'http://server.test:8787')

    remote.page = () => ({ cursor: 3, events: [], hasMore: false })
    await engine.run(remote, 'http://server.test:8787')
    expect(remote.pulls.map((call) => call.since)).toEqual([0, 9])

    const next = new FakeRemote()
    await sync(store, file).run(next, 'http://server.test:8787')
    expect(next.pulls[0].since).toBe(9)
  })

  it('本地删除变成 tombstone，服务器确认后收尾', async () => {
    const store = memoryStore([makeEvent()])
    const remote = new FakeRemote()
    const engine = sync(store, join(tempDir(), 'sync.json'))
    await engine.run(remote, 'http://server.test:8787')

    store.remove('evt-1')
    expect(engine.pendingCount()).toBe(1)
    await engine.run(remote, 'http://server.test:8787')
    expect(remote.pushes[1][0]).toMatchObject({ id: 'evt-1', deletedAt: NOW })
    expect(remote.pushes[1][0].title).toBe('')
    expect(engine.pendingCount()).toBe(0)

    await engine.run(remote, 'http://server.test:8787')
    expect(remote.pushes).toHaveLength(2)
  })

  it('服务器说删了，本地就删掉', async () => {
    const store = memoryStore([makeEvent()])
    const remote = new FakeRemote()
    remote.page = () => ({
      cursor: 4,
      hasMore: false,
      events: [{ id: 'evt-1', deleted: true, deletedAt: NOW, title: '', start: 0, end: 0, updatedAt: NOW }]
    })
    const engine = sync(store, join(tempDir(), 'sync.json'))
    const result = await engine.run(remote, 'http://server.test:8787')
    expect(result.pulled).toBe(1)
    expect(store.rows.has('evt-1')).toBe(false)
    expect(engine.pendingCount()).toBe(0)
  })

  it('服务器没接收的本地改动，在拉到同 id 的副本时另存', async () => {
    const store = memoryStore([makeEvent({ title: '周会（本机）' })])
    const remote = new FakeRemote()
    // A server that answers 200 but does not take the row: the local content is
    // still unconfirmed, which is the only case where a copy is owed.
    remote.accept = false
    remote.page = () => ({
      cursor: 5,
      hasMore: false,
      events: [{
        id: 'evt-1',
        title: '周会（服务器）',
        start: NOW + 3_600_000,
        end: NOW + 7_200_000,
        allDay: false,
        source: 'manual',
        status: 'confirmed',
        updatedAt: NOW + 1,
        deleted: false
      }]
    })
    const lines: string[] = []
    const engine = sync(store, join(tempDir(), 'sync.json'), (line) => lines.push(line))
    const result = await engine.run(remote, 'http://server.test:8787')
    expect(result.pulled).toBe(1)
    expect(store.rows.get('evt-1')?.title).toBe('周会（服务器）')
    const copy = [...store.rows.values()].find((event) => event.id !== 'evt-1')
    expect(copy?.title).toBe('周会（本机）（冲突副本）')
    expect(copy?.uid).toBeUndefined()
    expect(lines.join('\n')).toContain('已另存')
  })

  it('服务器版本更新时把本机改动另存为副本，而不是静默丢掉', async () => {
    const store = memoryStore([makeEvent({ title: '周会（本机）' })])
    const remote = new FakeRemote()
    // A server that holds a newer version of this id: our push loses.
    remote.stale = ['evt-1']
    const lines: string[] = []
    const engine = sync(store, join(tempDir(), 'sync.json'), (line) => lines.push(line))
    expect(await engine.run(remote, 'http://server.test:8787')).toEqual({ pushed: 1, pulled: 0 })

    // Losing must not be silent: the local edit survives under a new id.
    const copy = [...store.rows.values()].find((event) => event.id !== 'evt-1')
    expect(copy?.title).toBe('周会（本机）（冲突副本）')
    expect(lines.join('\n')).toContain('服务端版本更新')

    // Recorded as delivered, so the older content never overwrites the newer copy.
    await engine.run(remote, 'http://server.test:8787')
    expect(remote.pushes).toHaveLength(2)
    expect(remote.pushes[1].map((row) => String(row.id))).not.toContain('evt-1')
  })

  it('删除输给服务端更新的版本时放弃这个删除，不反复重试', async () => {
    const store = memoryStore([makeEvent()])
    const lines: string[] = []
    const engine = sync(store, join(tempDir(), 'sync.json'), (line) => lines.push(line))
    const remote = new FakeRemote()
    await engine.run(remote, 'http://server.test:8787')
    expect(engine.pendingCount()).toBe(0)

    // Deleted here, changed elsewhere: the server refuses the tombstone.
    store.rows.delete('evt-1')
    remote.stale = ['evt-1']
    await engine.run(remote, 'http://server.test:8787')
    expect(lines.join('\n')).toContain('删除未生效')

    // The tombstone is dropped, so the deletion is neither retried forever nor
    // replayed over the newer server row.
    expect(engine.pendingCount()).toBe(0)
    const pushes = remote.pushes.length
    await engine.run(remote, 'http://server.test:8787')
    expect(remote.pushes).toHaveLength(pushes)
  })

  it('已确认的本地日程被其他设备修改时直接采纳服务器版本，不产生副本', async () => {
    const store = memoryStore([makeEvent({ title: '周会' })])
    const remote = new FakeRemote()
    const engine = sync(store, join(tempDir(), 'sync.json'))
    await engine.run(remote, 'http://server.test:8787')

    remote.page = () => ({
      cursor: 6,
      hasMore: false,
      events: [{
        id: 'evt-1',
        title: '周会（改到周五）',
        start: NOW + 3_600_000,
        end: NOW + 7_200_000,
        allDay: false,
        source: 'manual',
        status: 'confirmed',
        updatedAt: NOW + 2,
        deleted: false
      }]
    })
    await engine.run(remote, 'http://server.test:8787')
    expect(store.rows.get('evt-1')?.title).toBe('周会（改到周五）')
    expect(store.rows.size).toBe(1)
  })

  it('服务器不支持日历接口时记住并跳过', async () => {
    const store = memoryStore([makeEvent()])
    const remote = new FakeRemote()
    remote.error = unsupported()
    const lines: string[] = []
    const engine = sync(store, join(tempDir(), 'sync.json'), (line) => lines.push(line))

    const result = await engine.run(remote, 'http://old.test:8787')
    expect(result).toEqual({ pushed: 0, pulled: 0 })
    expect(lines.join('\n')).toContain('不支持')

    remote.error = null
    await engine.run(remote, 'http://old.test:8787')
    expect(remote.pushes).toHaveLength(1)
    expect(remote.pulls).toHaveLength(0)

    // A different server is asked again: the 404 was that server's, not the feature's.
    await engine.run(new FakeRemote(), 'http://new.test:8787')
    expect(remote.pushes).toHaveLength(1)
  })

  it('其他错误照常抛出，交给引擎记 lastError', async () => {
    const store = memoryStore([makeEvent()])
    const remote = new FakeRemote()
    remote.error = Object.assign(new Error('服务器睡着了'), { status: 503 })
    const engine = sync(store, join(tempDir(), 'sync.json'))
    await expect(engine.run(remote, 'http://server.test:8787')).rejects.toThrow('服务器睡着了')
  })
})
