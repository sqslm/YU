/**
 * Game mode and the history scan, through the real wiring.
 *
 * A scan suspended by game mode is not a user pause: the job keeps its `running`
 * state, so leaving the game lets the same authorized job continue from its
 * checkpoint. A manual pause stays a manual pause.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_SETTINGS, mergeSettings } from '@shared/defaults'
import type { Settings } from '@shared/types'

import { ChatStore } from '../chat-store'
import { KnowledgeCollector } from './collector'
import { HistoryDriver } from './history'
import { KnowledgeHost } from './host'
import { createHistoryPages } from './pages'
import { syncKnowledge } from './session'

const ENTRY = join(process.cwd(), 'native', 'bin', 'yu-knowledge.exe')
const roots: string[] = []
const instances: KnowledgeHost[] = []
const stores: ChatStore[] = []

vi.mock('electron', () => ({ app: { getPath: () => roots[0] ?? tmpdir() } }))

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yu-knowledge-session-'))
  roots.push(dir)
  return dir
}

function settings(dir: string, enabled: boolean): Settings {
  return mergeSettings({
    ...DEFAULT_SETTINGS,
    notesDir: join(dir, 'notes'),
    knowledge: { enabled, notes: true, chat: true, reading: true }
  })
}

async function until(check: () => Promise<boolean> | boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
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

describe('game mode and the scan', () => {
  it('continues a game-suspended job after the game ends', async () => {
    if (!existsSync(ENTRY)) throw new Error(`the knowledge helper is missing: ${ENTRY}`)
    const dir = root()
    const handler = new KnowledgeHost({ entry: ENTRY, root: dir, requestMs: 30_000, idleMs: 60_000 })
    instances.push(handler)
    const chats = new ChatStore(join(dir, 'chats.db'))
    stores.push(chats)
    const threadId = chats.create().id
    for (let index = 0; index < 25; index += 1) {
      const pair = chats.begin(threadId, `问题${index}`)
      chats.finish(pair.answerId, `答案${index}`, 'done')
    }

    let game = false
    const config = settings(dir, true)
    const collector = new KnowledgeCollector({ settings: () => config, host: () => handler })
    await syncKnowledge({ collector, history: { resume: async () => null } }, game)

    const driver = new HistoryDriver({
      host: () => handler,
      pages: createHistoryPages({ notes: () => ({ list: () => ({ notes: [] }) }), chats: () => chats, limit: 4 }),
      // The real predicate: a game suspends the walk, it does not pause the job.
      allowed: () => collector.enabled && !game,
      bounds: () => ({ noteBound: null, chatBound: chats.historyBound() })
    })

    const job = await driver.start({ notes: false, chat: true })
    expect(job).not.toBeNull()

    // Suspend mid-scan, before the scan can finish.
    game = true
    await until(async () => (await handler.historyStatus(job!.id)).job!.chatCursor !== null, 'a committed batch')
    await new Promise(resolve => setTimeout(resolve, 150))
    const parked = (await handler.historyStatus(job!.id)).job!
    expect(parked.state).toBe('running')
    expect(parked.chatDone).toBe(false)

    // Leaving the game is the real wiring's job, not the test's.
    game = false
    await syncKnowledge({ collector, history: driver }, game)
    await until(async () => (await handler.historyStatus(job!.id)).job!.state === 'completed', 'the scan to finish')
    const done = (await handler.historyStatus(job!.id)).job!
    expect(done.scanned).toBe(25)
  }, 60_000)

  it('leaves a manually paused job paused across a game', async () => {
    if (!existsSync(ENTRY)) throw new Error(`the knowledge helper is missing: ${ENTRY}`)
    const dir = root()
    const handler = new KnowledgeHost({ entry: ENTRY, root: dir, requestMs: 30_000, idleMs: 60_000 })
    instances.push(handler)
    const chats = new ChatStore(join(dir, 'chats.db'))
    stores.push(chats)
    const threadId = chats.create().id
    for (let index = 0; index < 12; index += 1) {
      const pair = chats.begin(threadId, `问题${index}`)
      chats.finish(pair.answerId, `答案${index}`, 'done')
    }
    const config = settings(dir, true)
    const collector = new KnowledgeCollector({ settings: () => config, host: () => handler })
    await syncKnowledge({ collector, history: { resume: async () => null } }, false)

    let game = false
    const driver = new HistoryDriver({
      host: () => handler,
      pages: createHistoryPages({ notes: () => ({ list: () => ({ notes: [] }) }), chats: () => chats, limit: 4 }),
      allowed: () => collector.enabled && !game,
      bounds: () => ({ noteBound: null, chatBound: chats.historyBound() })
    })
    // A job the user paused on purpose, before any walk could finish it.
    const begun = await handler.beginHistory(
      { notes: false, chat: true },
      { noteBound: null, chatBound: chats.historyBound() }
    )
    const job = begun.job
    await driver.control(job.id, 'pause')
    game = true
    await syncKnowledge({ collector, history: { resume: async () => null } }, game)
    game = false
    await syncKnowledge({ collector, history: driver }, game)
    await new Promise(resolve => setTimeout(resolve, 150))
    const state = (await handler.historyStatus(job.id)).job!
    expect(state.state).toBe('paused')
    expect(state.chatDone).toBe(false)
  }, 60_000)

  it('spawns nothing while the feature is off', async () => {
    const dir = root()
    const handler = new KnowledgeHost({ entry: ENTRY, root: dir, requestMs: 30_000, idleMs: 60_000 })
    instances.push(handler)
    const config = settings(dir, false)
    const collector = new KnowledgeCollector({ settings: () => config, host: () => handler })
    const reached: string[] = []
    await syncKnowledge({ collector, history: { resume: async () => { reached.push('resume'); return null } } }, false)
    await syncKnowledge({ collector, history: { resume: async () => { reached.push('resume'); return null } } }, true)
    expect(handler.running).toBe(false)
    expect(reached).toEqual([])
  })
})
