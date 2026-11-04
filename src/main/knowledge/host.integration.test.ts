import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, describe, expect, it } from 'vitest'

import { KNOWLEDGE_LIMITS } from '@shared/knowledge'

import { KnowledgeHost } from './host'

/**
 * The production helper, not a stub: the compiled `yu-knowledge.exe` on real
 * pipes with isolated temporary data roots. Build it first with
 * `pnpm build:native` (or `pnpm test`, which builds before it runs).
 */
const ENTRY = join(process.cwd(), 'native', 'bin', 'yu-knowledge.exe')

function root(): string {
  return mkdtempSync(join(tmpdir(), 'yu-knowledge-it-'))
}

const cleanup: string[] = []
const instances: KnowledgeHost[] = []

afterEach(async () => {
  // A live helper holds its database open, so stop everything before the
  // directories are removed.
  for (const instance of instances.splice(0)) await instance.stop()
})

afterAll(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function host(dir = root(), idleMs = 60_000): KnowledgeHost {
  cleanup.push(dir)
  const instance = new KnowledgeHost({ entry: ENTRY, root: dir, requestMs: 30_000, idleMs })
  instances.push(instance)
  return instance
}

function requireHelper(): void {
  if (!existsSync(ENTRY)) {
    throw new Error(`the knowledge helper is missing: ${ENTRY}. Run pnpm build:native first.`)
  }
}

describe('compiled helper over the production host', () => {
  it('has a built helper to exercise', () => {
    requireHelper()
    expect(existsSync(ENTRY)).toBe(true)
  })

  it('answers an unused status query without starting anything', async () => {
    const instance = host()
    await expect(instance.status()).resolves.toEqual({
      version: 1,
      running: false,
      schema: null,
      opened: false,
      fts5: null,
      trigram: null
    })
    expect(instance.running).toBe(false)
    expect(instance.pid).toBeUndefined()
  })

  it('reports its capabilities once it is running and stores nothing until the first write', async () => {
    const instance = host()
    const source = await instance.saveSource({
      kind: 'web',
      originRef: 'https://example.com/a?q=1',
      locator: 'https://example.com/a?q=1',
      title: '例子',
      version: '1',
      scope: 'whole page',
      text: '知识图谱的基础'
    })
    expect(source.fingerprint).toHaveLength(64)
    await expect(instance.status()).resolves.toMatchObject({
      running: true,
      opened: true,
      fts5: true,
      trigram: true,
      schema: { knowledge: 1, profile: 1 }
    })
    const card = await instance.saveCard({
      kind: 'concept',
      title: '检索粒度',
      body: '知识图谱检索先命中标题，再落到正文。',
      topics: ['检索'],
      sourceIds: [source.id]
    })
    expect(card.sourceIds).toEqual([source.id])
    // Two Chinese characters take the literal branch; four take FTS.
    await expect(instance.searchCards({ query: '检索' })).resolves.toMatchObject({ total: 1 })
    await expect(instance.searchCards({ query: '知识图谱' })).resolves.toMatchObject({ total: 1 })
    await instance.stop()
  })

  it('refuses a source body over the shared limit and keeps the exact limit', async () => {
    const instance = host()
    const base = {
      kind: 'note' as const,
      originRef: 'note:limit',
      locator: 'note:limit',
      title: '上限',
      version: '1',
      scope: 'body'
    }
    const exact = '知'.repeat(KNOWLEDGE_LIMITS.body)
    const stored = await instance.saveSource({ ...base, text: exact })
    expect(stored.size).toBe(KNOWLEDGE_LIMITS.body)
    await expect(
      instance.saveSource({ ...base, version: '2', text: `${exact}🌸` })
    ).rejects.toMatchObject({ code: 'too_large' })
    await expect(instance.getSource(stored.id)).resolves.toMatchObject({
      size: KNOWLEDGE_LIMITS.body
    })
  }, 60_000)

  it('lists summaries and walks every card once through nextOffset', async () => {
    const instance = host()
    const ids: string[] = []
    for (let index = 1; index <= 5; index += 1) {
      const card = await instance.saveCard({
        kind: 'method',
        title: `翻页 ${index}`,
        body: `第 ${index} 张卡片的正文，含中文与 emoji 🙂`,
        topics: ['翻页']
      })
      ids.push(card.id)
    }
    const seen: string[] = []
    let offset: number | null = 0
    let pages = 0
    while (offset !== null) {
      const page = await instance.listCards({ offset, limit: 2 })
      pages += 1
      expect(page.total).toBe(5)
      for (const item of page.items) {
        expect(item).not.toHaveProperty('body')
        expect(item.bodyChars).toBeGreaterThan(0)
        seen.push(item.id)
      }
      offset = page.hasMore ? (page.nextOffset ?? null) : null
      if (offset === null) expect(page.hasMore).toBe(false)
      if (pages > 10) throw new Error('paging did not terminate')
    }
    expect(pages).toBe(3)
    expect(new Set(seen).size).toBe(5)
    expect([...seen].sort()).toEqual([...ids].sort())
    // The body is only fetched through the detail call.
    await expect(instance.getCard(ids[0])).resolves.toMatchObject({
      body: '第 1 张卡片的正文，含中文与 emoji 🙂'
    })
  }, 60_000)

  it('answers parallel requests and keeps data across a restart', async () => {
    const dir = root()
    const first = host(dir)
    const card = await first.saveCard({ kind: 'method', title: '重启后仍在', body: '正文' })
    const parallel = await Promise.all([first.status(), first.status(), first.listCards({})])
    expect(parallel[0].opened).toBe(true)
    await first.stop()

    const second = host(dir)
    const found = await second.getCard(card.id)
    expect(found.title).toBe('重启后仍在')
    await second.stop()
  })

  it('crosses the idle window and respawns on the next request', async () => {
    const instance = host(root(), 200)
    await instance.saveCard({ kind: 'review', title: '空闲前', body: '正文' })
    expect(instance.running).toBe(true)
    const deadline = Date.now() + 10_000
    while (instance.running && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 50))
    }
    expect(instance.running).toBe(false)
    // The stopped status is local: nothing is probed, nothing is started.
    await expect(instance.status()).resolves.toMatchObject({
      running: false,
      opened: false,
      fts5: null
    })
    expect(instance.running).toBe(false)
    await expect(instance.listCards({})).resolves.toMatchObject({ total: 1 })
    await instance.stop()
  })

  it('stops the process it started', async () => {
    const instance = host()
    await instance.saveCard({ kind: 'review', title: '停止', body: '正文' })
    const pid = instance.pid
    expect(pid).toBeGreaterThan(0)
    await instance.stop()
    expect(instance.running).toBe(false)
    const listing = await new Promise<string>((resolve) => {
      execFile('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], (_error, stdout) => resolve(String(stdout ?? '')))
    })
    // A live process would be listed by its image name; the pid alone also
    // appears in tasklist's own error text, so the name is the reliable check.
    expect(listing.trim().length).toBeGreaterThan(0)
    expect(listing).not.toContain('yu-knowledge.exe')
  })
})
