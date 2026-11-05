import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, describe, expect, it } from 'vitest'

import { KnowledgeHost } from './host'

/**
 * Stage 6 joins records to the knowledge they produced. These run against the
 * compiled helper on real pipes: the note→card list, the delete preview and the
 * purge all go through the same RPCs the app uses, with the versions the helper
 * minted itself.
 */
const ENTRY = join(process.cwd(), 'native', 'bin', 'yu-knowledge.exe')

function root(): string {
  return mkdtempSync(join(tmpdir(), 'yu-knowledge-link-'))
}

const cleanup: string[] = []
const instances: KnowledgeHost[] = []

afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.stop()
})

afterAll(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function host(dir = root()): KnowledgeHost {
  cleanup.push(dir)
  const instance = new KnowledgeHost({ entry: ENTRY, root: dir, requestMs: 30_000, idleMs: 60_000 })
  instances.push(instance)
  return instance
}

function requireHelper(): void {
  if (!existsSync(ENTRY)) throw new Error(`the knowledge helper is missing: ${ENTRY}`)
}

describe('records and the knowledge they produced', () => {
  it('finds the source of a note and of a chat thread', async () => {
    requireHelper()
    const instance = host()
    const note = await instance.saveSource({
      kind: 'note',
      originRef: 'n1',
      locator: '',
      title: '随记一',
      version: '1',
      scope: '随记',
      readAt: 1,
      text: '这条随记讲的是幂等键的用途。'
    })
    const turn = await instance.saveSource({
      kind: 'chat',
      originRef: 't1:u1:a1',
      locator: '',
      title: '对话一',
      version: '1',
      scope: '主界面问答',
      readAt: 2,
      text: '问：幂等键有什么用？答：避免重复写入。'
    })

    await expect(instance.findSources({ channel: 'note', originRef: 'n1' })).resolves.toEqual({
      sources: [expect.objectContaining({ id: note.id, version: '1', state: 'active' })]
    })
    const thread = await instance.findSources({ channel: 'chat', originRef: 't1:u1:a1' })
    expect(thread.sources.map(source => source.id)).toEqual([turn.id])
    await expect(instance.findSources({ channel: 'note', originRef: 'missing' })).resolves.toEqual({ sources: [] })
  }, 60_000)

  it('lists only the cards a record produced, filtered before paging', async () => {
    requireHelper()
    const instance = host()
    const first = await instance.saveSource({
      kind: 'note',
      originRef: 'n-a',
      locator: '',
      title: '甲',
      version: '1',
      scope: '随记',
      readAt: 1,
      text: '甲的正文，讲的是锁的粒度。'
    })
    const second = await instance.saveSource({
      kind: 'note',
      originRef: 'n-b',
      locator: '',
      title: '乙',
      version: '1',
      scope: '随记',
      readAt: 2,
      text: '乙的正文，讲的是缓存的失效。'
    })
    const a = await instance.saveCard({ kind: 'concept', title: '锁粒度', body: '锁的粒度决定竞争范围。', sourceIds: [first.id] })
    const b = await instance.saveCard({ kind: 'concept', title: '缓存失效', body: '缓存失效要成批处理。', sourceIds: [second.id] })

    const page = await instance.cardsBySource({ sourceId: first.id, offset: 0, limit: 5 })
    expect(page.items.map(card => card.id)).toEqual([a.id])
    expect(page.total).toBe(1)
    expect(page.items[0]).not.toHaveProperty('body')

    const none = await instance.cardsBySource({ noteId: 'n-nope', offset: 0, limit: 5 })
    expect(none.items).toEqual([])
    expect(b.id).not.toBe(a.id)
  }, 60_000)

  it('previews and purges: only the single-source card goes', async () => {
    requireHelper()
    const instance = host()
    const only = await instance.saveSource({
      kind: 'note',
      originRef: 'n-only',
      locator: '',
      title: '独占',
      version: '1',
      scope: '随记',
      readAt: 1,
      text: '这条随记是唯一来源。'
    })
    const shared = await instance.saveSource({
      kind: 'note',
      originRef: 'n-shared',
      locator: '',
      title: '共享',
      version: '1',
      scope: '随记',
      readAt: 2,
      text: '这条随记还有别的来源。'
    })
    const lonely = await instance.saveCard({ kind: 'concept', title: '独占知识', body: '只有一条来源的结论。', sourceIds: [only.id] })
    const both = await instance.saveCard({ kind: 'concept', title: '共享知识', body: '两条来源支持的结论。', sourceIds: [only.id, shared.id] })

    const impact = await instance.cardImpact(only.id)
    expect(impact).toMatchObject({ cards: 2, single: 1, multi: 1 })
    expect(impact.items.map(item => item.id).sort()).toEqual([lonely.id, both.id].sort())

    const purged = await instance.purgeCards({ sources: [{ id: only.id, version: only.version }], cards: true })
    expect(purged.removed).toEqual([lonely.id])
    expect(purged.kept).toEqual([both.id])

    expect((await instance.cardsBySource({ sourceId: only.id, offset: 0, limit: 5 })).items).toEqual([])
    const survivor = await instance.getCard(both.id)
    expect(survivor.sourceIds).toEqual([shared.id])

    // Idempotent: purging an already invalid source skips it and touches nothing.
    const again = await instance.purgeCards({ sources: [{ id: only.id, version: only.version }], cards: true })
    expect(again.removed).toEqual([])
    expect(again.skipped).toEqual([only.id])
  }, 60_000)

  it('unlinks without deleting when the user did not tick the option', async () => {
    requireHelper()
    const instance = host()
    const source = await instance.saveSource({
      kind: 'note',
      originRef: 'n-keep',
      locator: '',
      title: '保留',
      version: '1',
      scope: '随记',
      readAt: 1,
      text: '这条随记的正文，删记录但留知识。'
    })
    const card = await instance.saveCard({ kind: 'concept', title: '留下的知识', body: '这条知识应当保留下来。', sourceIds: [source.id] })

    const result = await instance.purgeCards({ sources: [{ id: source.id, version: source.version }], cards: false })
    expect(result.removed).toEqual([])
    expect((await instance.getCard(card.id)).sourceIds).toEqual([])
    expect((await instance.cardsBySource({ sourceId: source.id, offset: 0, limit: 5 })).items).toEqual([])
  }, 60_000)

  it('refuses a stale preview instead of deleting a newer source', async () => {
    requireHelper()
    const instance = host()
    const source = await instance.saveSource({
      kind: 'note',
      originRef: 'n-stale',
      locator: '',
      title: '旧版',
      version: '1',
      scope: '随记',
      readAt: 1,
      text: '第一版正文。'
    })
    const card = await instance.saveCard({ kind: 'concept', title: '旧知识', body: '第一版正文里提炼出的结论。', sourceIds: [source.id] })
    await instance.saveSource({
      kind: 'note',
      originRef: 'n-stale',
      locator: '',
      title: '新版',
      version: '2',
      scope: '随记',
      readAt: 3,
      text: '第二版正文，已经改过。'
    })

    // A preview taken before the note changed carries the old version number.
    const result = await instance.purgeCards({ sources: [{ id: source.id, version: '9' }], cards: true })
    expect(result.removed).toEqual([])
    expect(result.skipped).toEqual([source.id])
    await expect(instance.getCard(card.id)).resolves.toMatchObject({ id: card.id })
  }, 60_000)
})
