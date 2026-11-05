/**
 * Stage 6 B: a record owns what it really produced, and one material can be
 * owned by two conversations.
 *
 * These run on the compiled helper and a real `ChatStore`: the production
 * collector publishes the turns and the reading material, the production purge
 * RPCs do the deleting, and the rows come back through the same calls the app
 * uses. The only hand-made input is the tool payload a reading material is built
 * from, which is what the agent hands the collector.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_SETTINGS, mergeSettings } from '@shared/defaults'

import { ChatStore } from '../chat-store'
import { KnowledgeCollector, readingKey, readingMaterial } from './collector'
import { KnowledgeHost } from './host'
import { RecordReleaser } from './release'

const ENTRY = join(process.cwd(), 'native', 'bin', 'yu-knowledge.exe')
const roots: string[] = []
const instances: KnowledgeHost[] = []
const stores: ChatStore[] = []

vi.mock('electron', () => ({ app: { getPath: () => roots[0] ?? tmpdir() } }))

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yu-knowledge-owner-'))
  roots.push(dir)
  return dir
}

afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.stop()
  for (const store of stores.splice(0)) {
    try {
      store.close()
    } catch {
      // already closed
    }
  }
})

afterAll(() => {
  for (const dir of roots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // a leftover root is reported by the caller, never hidden
    }
  }
})

interface Rig {
  knowledge: KnowledgeHost
  chats: ChatStore
  collector: KnowledgeCollector
  turn: (question: string, answer: string) => Promise<string>
  read: (threadId: string, url: string, text: string) => Promise<{ sourceId: string } | null>
}

function rig(): Rig {
  if (!existsSync(ENTRY)) throw new Error(`the knowledge helper is missing: ${ENTRY}`)
  const dir = root()
  const knowledge = new KnowledgeHost({ entry: ENTRY, root: dir, requestMs: 30_000, idleMs: 60_000 })
  instances.push(knowledge)
  const chats = new ChatStore(join(dir, 'chats.db'))
  stores.push(chats)
  const settings = mergeSettings({
    ...DEFAULT_SETTINGS,
    notesDir: join(dir, 'notes'),
    knowledge: { enabled: true, notes: true, chat: true, reading: true }
  })
  const collector = new KnowledgeCollector({
    settings: () => settings,
    host: () => knowledge
  })
  const turn = async (question: string, answer: string): Promise<string> => {
    const { id: threadId } = chats.create()
    const pair = chats.begin(threadId, question)
    chats.finish(pair.answerId, answer, 'done')
    // The production entry point the chat page calls when a turn completes. It
    // publishes in the background, so the rows are waited for, not assumed.
    collector.threadFinished({
      threadId,
      threadTitle: question,
      userId: pair.userId,
      answerId: pair.answerId,
      question,
      answer,
      at: Date.now()
    })
    await until(
      async () => (await knowledge.findSources({ channel: 'chat', groupKey: threadId })).sources.length > 0,
      `thread ${threadId} was published`
    )
    return threadId
  }
  const read = async (
    threadId: string,
    url: string,
    text: string
  ): Promise<{ sourceId: string } | null> => {
    const material = readingMaterial('read_webpage', { url, title: '共享网页', text })
    expect(material).not.toBeNull()
    expect(readingKey(material!.origin).startsWith('reading:')).toBe(true)
    return collector.publishReading(material!, { threadId, at: Date.now(), scope: '主界面问答' })
  }
  return { knowledge, chats, collector, turn, read }
}

/** Waits for a background publish instead of guessing how long it takes. */
async function until(
  probe: () => Promise<boolean>,
  label: string,
  budgetMs = 20_000
): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < budgetMs) {
    if (await probe()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for: ${label}`)
}

describe('one material read by two conversations', () => {
  it('survives the deletion of one of them and goes with the last one', async () => {
    const { knowledge, collector, turn, read } = rig()
    await collector.sync()
    const url = 'https://example.test/shared-page'
    const first = await turn('问题甲', '回答甲。')
    const readA = await read(first, url, '同一篇网页正文，讲的是检索粒度。')
    const second = await turn('问题乙', '回答乙。')
    const readB = await read(second, url, '同一篇网页正文，讲的是检索粒度。')
    // The same page is one row, not two: both conversations read the one source.
    expect(readA?.sourceId).toBeTruthy()
    expect(readB?.sourceId).toBe(readA?.sourceId)

    const page = (await knowledge.findSources({ channel: 'chat', groupKey: first })).sources.find(
      source => source.kind === 'web'
    )
    expect(page).toBeDefined()

    // Deleting thread A cancels A's own turn and gives up A's claim on the page,
    // but the page and the reading task stay with thread B.
    const cancelled = await knowledge.invalidateThread(first, 'thread deleted')
    expect(cancelled.cancelled).toHaveLength(1)
    expect(cancelled.detached).toEqual([page!.id])
    expect((await knowledge.getSource(page!.id)).state).toBe('active')
    const kept = (await knowledge.findSources({ channel: 'chat', groupKey: second })).sources
    expect(kept.find(source => source.kind === 'web')?.state).toBe('active')
    const queue = await knowledge.listQueue({ offset: 0, limit: 100 })
    const reading = queue.items.find(item => item.groupKey === `reading:${page!.id}` || item.items.some(entry => entry.sourceId === page!.id))
    expect(reading?.state).not.toBe('cancelled')

    // The page is not a note and not a conversation: no record answers for it.
    await expect(knowledge.findSources({ channel: 'note', originRef: url })).resolves.toMatchObject({ sources: [] })

    // The last owner going away retires it.
    await knowledge.invalidateThread(second, 'thread deleted')
    expect((await knowledge.getSource(page!.id)).state).toBe('invalid')
  }, 60_000)

  it('keeps the shared card when only the sharing record is purged', async () => {
    const { knowledge, collector, turn, read } = rig()
    await collector.sync()
    const url = 'https://example.test/cited-page'
    const first = await turn('问题甲', '回答甲。')
    const readA = await read(first, url, '网页正文里写着检索粒度这件事。')
    const second = await turn('问题乙', '回答乙。')
    const readB = await read(second, url, '网页正文里写着检索粒度这件事。')
    expect(readB?.sourceId).toBe(readA?.sourceId)

    const page = (await knowledge.findSources({ channel: 'chat', groupKey: first })).sources.find(
      source => source.kind === 'web'
    )!
    const card = await knowledge.saveCard({
      kind: 'concept',
      title: '共享材料结论',
      summary: '从两边都读过的网页提炼',
      body: '检索粒度决定命中范围。',
      sourceIds: [page.id]
    })

    // The preview promises nothing it cannot keep: the card is not the record's to
    // delete, because the material stays valid for the other conversation.
    const impact = await knowledge.cardImpact({ channel: 'chat', groupKey: first })
    expect(impact.cards).toBe(0)
    expect(impact.single).toBe(0)
    expect(impact.shared).toEqual([page.id])
    expect(impact.sources.map(source => source.id)).toContain(page.id)

    const purged = await knowledge.purgeCards({
      record: { channel: 'chat', groupKey: first },
      confirm: { sources: impact.sources, ticket: impact.ticket },
      cards: true
    })
    expect(purged.removed).toEqual([])
    expect(purged.detached).toEqual([page.id])
    await expect(knowledge.getCard(card.id)).resolves.toMatchObject({ id: card.id, sourceIds: [page.id] })
    expect((await knowledge.getSource(page.id)).state).toBe('active')

    // Deleting the record twice destroys nothing the second time.
    await expect(
      knowledge.purgeCards({
        record: { channel: 'chat', groupKey: first },
        confirm: { sources: impact.sources, ticket: impact.ticket },
        cards: true
      })
    ).rejects.toThrow('预览已失效，请重新确认')
    await expect(knowledge.getCard(card.id)).resolves.toMatchObject({ id: card.id })

    // The last owner gone, the card loses its only valid source and goes with it.
    const last = await knowledge.cardImpact({ channel: 'chat', groupKey: second })
    expect(last.single).toBe(1)
    const gone = await knowledge.purgeCards({
      record: { channel: 'chat', groupKey: second },
      confirm: { sources: last.sources, ticket: last.ticket },
      cards: true
    })
    expect(gone.removed).toEqual([card.id])
  }, 60_000)
})

describe('deleting a record without touching cards', () => {
  it('gives up its own claim and keeps the page for the other reader', async () => {
    const { knowledge, collector, turn, read } = rig()
    await collector.sync()
    const url = 'https://example.test/default-delete'
    const first = await turn('问题甲', '回答甲。')
    await read(first, url, '默认删除时这段正文仍然有效。')
    const second = await turn('问题乙', '回答乙。')
    await read(second, url, '默认删除时这段正文仍然有效。')

    const page = (await knowledge.findSources({ channel: 'chat', groupKey: first })).sources.find(
      source => source.kind === 'web'
    )!
    const card = await knowledge.saveCard({
      kind: 'concept',
      title: '默认删除时保留的卡片',
      summary: '两边都读过的网页',
      body: '默认删除不碰卡片。',
      sourceIds: [page.id]
    })

    // The path the app takes when the user does not tick 「同时删除关联知识」.
    const released = await new RecordReleaser(() => knowledge).release(
      { channel: 'chat', groupKey: first },
      '记录已删除'
    )
    expect(released.failures).toEqual([])
    // Its own turn row is retired; the page is only given up, so it stays live.
    expect(released.retired).toBe(1)
    expect(released.detached).toBeGreaterThanOrEqual(1)
    expect((await knowledge.getSource(page.id)).state).toBe('active')
    await expect(knowledge.getCard(card.id)).resolves.toMatchObject({ id: card.id, sourceIds: [page.id] })

    // The other conversation keeps both the page and its queued reading task.
    const kept = (await knowledge.findSources({ channel: 'chat', groupKey: second })).sources
    expect(kept.find(source => source.kind === 'web')?.state).toBe('active')
    const queue = await knowledge.listQueue({ offset: 0, limit: 100 })
    expect(queue.items.find(item => item.items.some(entry => entry.sourceId === page.id))?.state).not.toBe(
      'cancelled'
    )

    // Deleting the same record again finds nothing left to release.
    const again = await new RecordReleaser(() => knowledge).release(
      { channel: 'chat', groupKey: first },
      '记录已删除'
    )
    expect(again.retired).toBe(0)
    expect(again.detached).toBe(0)

    // A note that published nothing settles nothing: the note branch stays a no-op.
    const note = await new RecordReleaser(() => knowledge).release(
      { channel: 'note', originRef: 'note_without_sources' },
      '记录已删除'
    )
    expect(note).toEqual({ retired: 0, detached: 0, cancelled: [], failures: [] })

    // The last reader going away retires the page; the default delete never takes
    // a card with it.
    const last = await new RecordReleaser(() => knowledge).release(
      { channel: 'chat', groupKey: second },
      '记录已删除'
    )
    expect(last.detached).toBe(0)
    expect((await knowledge.getSource(page.id)).state).toBe('invalid')
    await expect(knowledge.getCard(card.id)).resolves.toMatchObject({ id: card.id })
  }, 60_000)

  it('settles two deletes of one page at once without a half state', async () => {
    const { knowledge, collector, turn, read } = rig()
    await collector.sync()
    const url = 'https://example.test/parallel-delete'
    const first = await turn('问题甲', '回答甲。')
    await read(first, url, '并发删除时这段正文只该失效一次。')
    const second = await turn('问题乙', '回答乙。')
    await read(second, url, '并发删除时这段正文只该失效一次。')

    const page = (await knowledge.findSources({ channel: 'chat', groupKey: first })).sources.find(
      source => source.kind === 'web'
    )!
    const [left, right] = await Promise.all([
      new RecordReleaser(() => knowledge).release(
        { channel: 'chat', groupKey: first },
        '记录已删除'
      ),
      new RecordReleaser(() => knowledge).release(
        { channel: 'chat', groupKey: second },
        '记录已删除'
      )
    ])
    expect(left.failures).toEqual([])
    expect(right.failures).toEqual([])
    // Both turns and the page are retired exactly once between them: the row is
    // never retired while another reader still claims it.
    expect(left.retired + right.retired).toBe(3)
    expect((await knowledge.getSource(page.id)).state).toBe('invalid')
    for (const threadId of [first, second]) {
      const live = (await knowledge.findSources({ channel: 'chat', groupKey: threadId })).sources.filter(
        source => source.kind === 'web'
      )
      expect(live).toHaveLength(0)
    }
  }, 60_000)
})
