import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

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

afterAll(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

function host(dir = root()): KnowledgeHost {
  cleanup.push(dir)
  return new KnowledgeHost({ entry: ENTRY, root: dir, requestMs: 15_000, idleMs: 60_000 })
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

  it('reports its capabilities and stores nothing until the first write', async () => {
    const dir = root()
    cleanup.push(dir)
    const instance = new KnowledgeHost({ entry: ENTRY, root: dir, idleMs: 60_000 })
    const status = await instance.status()
    cleanup.push(dir)
    expect(status.fts5).toBe(true)
    expect(status.trigram).toBe(true)
    expect(status.opened).toBe(false)
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

  it('answers parallel requests and keeps data across a restart', async () => {
    const dir = root()
    cleanup.push(dir)
    const first = new KnowledgeHost({ entry: ENTRY, root: dir, idleMs: 60_000 })
    const card = await first.saveCard({ kind: 'method', title: '重启后仍在', body: '正文' })
    const parallel = await Promise.all([first.status(), first.status(), first.listCards({})])
    expect(parallel[0].opened).toBe(true)
    await first.stop()

    const second = new KnowledgeHost({ entry: ENTRY, root: dir, idleMs: 60_000 })
    const found = await second.getCard(card.id)
    expect(found.title).toBe('重启后仍在')
    await second.stop()
  })

  it('crosses the idle window and respawns on the next request', async () => {
    const dir = root()
    cleanup.push(dir)
    const instance = new KnowledgeHost({ entry: ENTRY, root: dir, idleMs: 200 })
    await instance.status()
    expect(instance.running).toBe(true)
    const deadline = Date.now() + 10_000
    while (instance.running && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50))
    expect(instance.running).toBe(false)
    // A fresh process has opened nothing yet: the idle exit and the lazy start
    // both hold.
    await expect(instance.status()).resolves.toMatchObject({ opened: false, fts5: true })
    await instance.stop()
  })

  it('stops the process it started', async () => {
    const instance = host()
    await instance.status()
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
