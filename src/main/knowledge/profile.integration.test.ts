import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { Settings } from '@shared/types'

import { KnowledgeHost } from './host'
import { ProfileCollector } from './profile'

/** The compiled helper this suite drives; the debug build is not the product. */
const entry = join(process.cwd(), 'native', 'bin', 'yu-knowledge.exe')

const roots: string[] = []
const hosts: KnowledgeHost[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'yu-profile-loop-'))
  roots.push(root)
  return root
}

interface Harness {
  host: KnowledgeHost
  profile: ProfileCollector
  settings: Settings
  prompts: string[]
  logs: string[]
}

function harness(options: {
  enabled?: boolean
  answer?: (prompt: string) => string | Promise<string>
  root?: string
} = {}): Harness {
  const root = options.root ?? makeRoot()
  const prompts: string[] = []
  const logs: string[] = []
  const host = new KnowledgeHost({
    entry,
    root,
    requestMs: 15_000,
    completer: async call => {
      const prompt = call.messages.map(message => message.content).join('\n')
      prompts.push(prompt)
      return await (options.answer ?? (() => '{"items":[]}'))(prompt)
    }
  })
  hosts.push(host)
  const settings = {
    ...DEFAULT_SETTINGS,
    userProfile: {
      ...DEFAULT_SETTINGS.userProfile,
      enabled: options.enabled ?? true
    }
  } as Settings
  const profile: ProfileCollector = new ProfileCollector({
    settings: () => settings,
    host: () => host,
    allowed: (): boolean => profile.enabled,
    log: line => logs.push(line)
  })
  return { host, profile, settings, prompts, logs }
}

async function until<T>(check: () => Promise<T | undefined>, what: string, timeoutMs = 20_000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = await check()
    if (value !== undefined) return value
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

beforeAll(() => {
  // The 30 s window is a product default; a test cannot wait for it.
  process.env.YU_PROFILE_LEARN_MS = '0'
})

afterAll(() => {
  delete process.env.YU_PROFILE_LEARN_MS
})

afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.stop()))
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // A store may still be closing on Windows; the temp root is disposable.
    }
  }
})

describe('the profile loop over the compiled helper', () => {
  it('starts nothing while the switch is off', { timeout: 60_000 }, async () => {
    const { host, profile } = harness({ enabled: false })
    await profile.sync()
    await profile.completedChat({ threadId: 't1', userId: 'm1', answerId: 'm2', question: '我在做什么项目', at: Date.now() })
    const context = await profile.context()
    expect(host.running).toBe(false)
    expect(context).toEqual({ enabled: false, text: '', items: [], bytes: 0 })
  })

  it('counts a repeated completion once and never calls the model for usage', { timeout: 60_000 }, async () => {
    const { host, profile, prompts } = harness()
    await profile.sync()
    const turn = { threadId: 't1', userId: 'm1', answerId: 'm2', question: '帮我把这段话改得更简洁', at: Date.now() }
    await profile.completedChat(turn)
    await until(async () => (prompts.length === 1 ? true : undefined), 'the evidence batch')
    await profile.completedChat(turn)
    await new Promise(resolve => setTimeout(resolve, 300))
    const status = await host.profileStatus()
    expect(status.usageTotal).toBe(1)
    // A replayed turn is neither counted again nor queued again, so the loop keeps
    // the one call it already made.
    expect(prompts).toHaveLength(1)
  })

  it('turns the user sentence into a quoted item and a readable context', { timeout: 90_000 }, async () => {
    const question = '我在做 typeless 的语音输入，喜欢结论先说的回答方式。'
    const { host, profile, prompts } = harness({
      answer: () =>
        JSON.stringify({
          items: [
            {
              dimension: 'expression',
              category: 'explicit',
              value: '喜欢结论先说的回答',
              evidence: [{ quote: '喜欢结论先说的回答方式' }]
            }
          ]
        })
    })
    await profile.sync()
    await profile.completedChat({ threadId: 't1', userId: 'm1', answerId: 'm2', question, at: Date.now() })
    // No explicit wake: real evidence is what starts the loop, exactly like a
    // finished conversation does in the running app.
    await until(async () => ((await host.profileStatus()).items === 1 ? true : undefined), 'the written item')
    expect(prompts.length).toBeGreaterThan(0)
    const context = await profile.context()
    expect(context?.enabled).toBe(true)
    expect(context?.text).toContain('结论先说')
    expect(context?.bytes).toBeLessThanOrEqual(2_000)
    const status = await host.profileStatus()
    expect(status.pending).toBe(0)
    // The two modules are independent: the knowledge collector was never asked to
    // run, so turning the profile on did not silently switch collection on too.
    expect((await host.queueStatus()).channels.enabled).toBe(false)
  })

  it('keeps the manual correction when the model answers after a clear', { timeout: 90_000 }, async () => {
    // The completer really waits, so the batch is provably in flight when the user
    // clears: a gate that nothing awaits would prove nothing.
    const gate: { release?: () => void } = {}
    const waiting = new Promise<void>(resolve => {
      gate.release = resolve
    })
    const { host, profile, prompts } = harness({
      answer: async () => {
        await waiting
        return JSON.stringify({
          items: [
            {
              dimension: 'expression',
              category: 'explicit',
              value: '回答要先给结论',
              evidence: [{ quote: '回答先给结论' }]
            }
          ]
        })
      }
    })
    await profile.sync()
    await profile.completedChat({
      threadId: 't2',
      userId: 'm1',
      answerId: 'm2',
      question: '我更希望回答先给结论',
      at: Date.now()
    })
    await until(async () => (prompts.length === 1 ? true : undefined), 'the provider call')
    await host.saveProfile({ dimension: 'expression', value: '先给结论', category: 'explicit', origin: 'manual', pinned: true, slot: 'expression:conclusion-first' })
    const cleared = await profile.clear()
    expect(cleared).toBe(true)
    gate.release?.()
    await waiting
    // The late answer is refused by the epoch barrier: nothing was written back.
    await until(async () => ((await host.profileStatus()).pending === 0 ? true : undefined), 'the released batch')
    const context = await profile.context()
    expect(context?.text ?? '').toBe('')
    expect((await host.profileStatus()).items).toBe(0)
  })

  it('does not cancel the profile batch when only the knowledge switch closes', { timeout: 90_000 }, async () => {
    const gate: { release?: () => void } = {}
    const waiting = new Promise<void>(resolve => {
      gate.release = resolve
    })
    const { host, profile, prompts } = harness({
      answer: async () => {
        await waiting
        return JSON.stringify({
          items: [
            {
              dimension: 'goal',
              category: 'inferred',
              value: '把知识库做成可检索的卡片',
              evidence: [{ quote: '做成可检索的卡片' }]
            }
          ]
        })
      }
    })
    await profile.sync()
    await profile.completedChat({ threadId: 't5', userId: 'm1', answerId: 'm2', question: '我想把知识库做成可检索的卡片', at: Date.now() })
    await until(async () => (prompts.length === 1 ? true : undefined), 'the provider call')
    // The extraction module's only cancel entry must not reach this batch.
    host.cancelInFlight('采集已暂停', 'extract.run')
    gate.release?.()
    await waiting
    await until(async () => ((await host.profileStatus()).items === 1 ? true : undefined), 'the finished profile batch')
    expect((await host.profileStatus()).pending).toBe(0)
  })

  it('retries a real failure only through the explicit entry', { timeout: 90_000 }, async () => {
    let attempt = 0
    const { host, profile, logs } = harness({
      answer: () => {
        attempt += 1
        if (attempt === 1) throw new Error('合成的模型失败')
        return JSON.stringify({
          items: [
            {
              dimension: 'background',
              category: 'inferred',
              value: '主要用 Windows 开发',
              evidence: [{ quote: 'Windows 开发' }]
            }
          ]
        })
      }
    })
    await profile.sync()
    await profile.completedChat({ threadId: 't6', userId: 'm1', answerId: 'm2', question: '我主要用 Windows 开发', at: Date.now() })
    await until(async () => (logs.some(line => line.includes('画像归纳失败')) ? true : undefined), 'the failed batch')
    expect((await host.profileStatus()).items).toBe(0)
    const retried = await profile.retry()
    expect(retried).toBe(1)
    await until(async () => ((await host.profileStatus()).items === 1 ? true : undefined), 'the retried item')
  })

  it('parks a running batch on game mode and resumes the same evidence afterwards', { timeout: 90_000 }, async () => {
    const gate: { release?: () => void } = {}
    const waiting = new Promise<void>(resolve => {
      gate.release = resolve
    })
    const { host, profile, prompts } = harness({
      answer: async () => {
        await waiting
        return '{"items":[]}'
      }
    })
    await profile.sync()
    await profile.completedChat({ threadId: 't3', userId: 'm1', answerId: 'm2', question: '最近在看 SQLite 的 FTS5', at: Date.now() })
    await until(async () => (prompts.length === 1 ? true : undefined), 'the provider call')
    await profile.sync({ game: true })
    expect((await host.profileStatus()).pausedGame).toBe(true)
    // The cancelled answer is refused and its row comes back to the queue instead
    // of staying `working` until the helper restarts.
    await until(async () => ((await host.profileStatus()).pending === 1 ? true : undefined), 'the released batch')
    gate.release?.()
    await waiting
    await profile.sync({ game: false })
    expect((await host.profileStatus()).pausedGame).toBe(false)
    // Leaving the game resumes the loop, so the queued sentence is consumed
    // instead of waiting for the next unrelated event.
    await until(async () => ((await host.profileStatus()).pending === 0 ? true : undefined), 'the resumed batch')
  })

  it('does not run a paused module and keeps the evidence for later', { timeout: 90_000 }, async () => {
    const gate: { release?: () => void } = {}
    const waiting = new Promise<void>(resolve => {
      gate.release = resolve
    })
    const { host, profile, prompts } = harness({
      answer: async () => {
        await waiting
        return '{"items":[]}'
      }
    })
    await profile.sync()
    await profile.completedChat({ threadId: 't4', userId: 'm1', answerId: 'm2', question: '我想把项目拆成多个阶段', at: Date.now() })
    await until(async () => (prompts.length === 1 ? true : undefined), 'the provider call')
    await profile.pause(true)
    expect((await host.profileStatus()).pausedManual).toBe(true)
    // A paused module neither learns nor loses the queued sentence.
    await until(async () => ((await host.profileStatus()).pending === 1 ? true : undefined), 'the released batch')
    gate.release?.()
    await waiting
    const pausedCalls = prompts.length
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(prompts.length).toBe(pausedCalls)
    await profile.pause(false)
    expect((await host.profileStatus()).pausedManual).toBe(false)
    // Resuming drains it: the batch ran instead of the evidence piling up forever.
    await until(async () => ((await host.profileStatus()).pending === 0 ? true : undefined), 'the resumed batch')
    expect((await host.profileStatus()).items).toBe(0)
  })

  /** A gated answer keeps one batch genuinely in flight while the switches move. */
  function held(): { waiting: Promise<void>; release: () => void } {
    let release: () => void = () => {}
    const waiting = new Promise<void>(resolve => {
      release = () => resolve()
    })
    return { waiting, release }
  }

  it('learns the held batch when the master switch is flicked off and on', { timeout: 90_000 }, async () => {
    let calls = 0
    const gate = held()
    const { host, profile, prompts, settings } = harness({
      answer: async () => {
        calls += 1
        if (calls === 1) {
          await gate.waiting
          return '{"items":[]}'
        }
        return JSON.stringify({
          items: [
            {
              dimension: 'project',
              category: 'explicit',
              value: '先把阶段四收尾',
              evidence: [{ quote: '先把阶段四收尾' }]
            }
          ]
        })
      }
    })
    await profile.sync()
    await profile.completedChat({
      threadId: 't7',
      userId: 'm1',
      answerId: 'm2',
      question: '我先把阶段四收尾',
      at: Date.now()
    })
    await until(async () => (prompts.length === 1 ? true : undefined), 'the provider call')
    // Flick the switch without waiting for anything: the helper releases the claim
    // inside the control transaction, so the queue is already back to pending.
    settings.userProfile.enabled = false
    await profile.sync()
    settings.userProfile.enabled = true
    await profile.sync()
    await new Promise(resolve => setTimeout(resolve, 500))
    // The original batch runs again by itself; the refused answer writes nothing.
    await until(async () => ((await host.profileStatus()).items === 1 ? true : undefined), 'the resumed batch')
    gate.release()
    await gate.waiting
    const status = await host.profileStatus()
    expect(status.pending).toBe(0)
    expect(status.failed).toBe(0)
  })

  it('learns the held batch when the chat channel is flicked off and on', { timeout: 90_000 }, async () => {
    let calls = 0
    const gate = held()
    const { host, profile, prompts, settings } = harness({
      answer: async () => {
        calls += 1
        if (calls === 1) {
          await gate.waiting
          return '{"items":[]}'
        }
        return JSON.stringify({
          items: [
            {
              dimension: 'goal',
              category: 'inferred',
              value: '把画像循环做扎实',
              evidence: [{ quote: '把画像循环做扎实' }]
            }
          ]
        })
      }
    })
    await profile.sync()
    await profile.completedChat({
      threadId: 't8',
      userId: 'm1',
      answerId: 'm2',
      question: '我想把画像循环做扎实',
      at: Date.now()
    })
    await until(async () => (prompts.length === 1 ? true : undefined), 'the provider call')
    settings.userProfile.chat = false
    await profile.sync()
    settings.userProfile.chat = true
    await profile.sync()
    await until(async () => ((await host.profileStatus()).items === 1 ? true : undefined), 'the resumed batch')
    gate.release()
    await gate.waiting
    const status = await host.profileStatus()
    expect(status.pending).toBe(0)
    expect(status.failed).toBe(0)
  })

  it('learns the held batch when the manual pause is flicked off and on', { timeout: 90_000 }, async () => {
    let calls = 0
    const gate = held()
    const { host, profile, prompts } = harness({
      answer: async () => {
        calls += 1
        if (calls === 1) {
          await gate.waiting
          return '{"items":[]}'
        }
        return JSON.stringify({
          items: [
            {
              dimension: 'expression',
              category: 'inferred',
              value: '讲解时先给结论',
              evidence: [{ quote: '先给结论' }]
            }
          ]
        })
      }
    })
    await profile.sync()
    await profile.completedChat({
      threadId: 't10',
      userId: 'm1',
      answerId: 'm2',
      question: '讲解时先给结论再展开',
      at: Date.now()
    })
    await until(async () => (prompts.length === 1 ? true : undefined), 'the provider call')
    await profile.pause(true)
    await profile.pause(false)
    await until(async () => ((await host.profileStatus()).items === 1 ? true : undefined), 'the resumed batch')
    gate.release()
    await gate.waiting
    const status = await host.profileStatus()
    expect(status.pending).toBe(0)
    expect(status.failed).toBe(0)
  })

  it('retracts a held chat while the switch is off so it is never learned', { timeout: 90_000 }, async () => {
    const gate = held()
    const { host, profile, prompts, settings } = harness({
      answer: async () => {
        await gate.waiting
        return JSON.stringify({
          items: [
            {
              dimension: 'focus',
              category: 'inferred',
              value: '被删掉的对话',
              evidence: [{ quote: '被删掉的对话' }]
            }
          ]
        })
      }
    })
    await profile.sync()
    await profile.completedChat({
      threadId: 't9',
      userId: 'm1',
      answerId: 'm2',
      question: '这段对话稍后会被删掉',
      at: Date.now()
    })
    await until(async () => (prompts.length === 1 ? true : undefined), 'the provider call')
    settings.userProfile.enabled = false
    await profile.sync()
    // The deletion arrives while the switch is closed: it must still reach the helper,
    // because the queued sentence is the user's data, not the loop's state.
    await profile.retractThread('t9', '对话已删除')
    expect((await host.profileStatus()).pending).toBe(0)
    settings.userProfile.enabled = true
    await profile.sync()
    gate.release()
    await gate.waiting
    await new Promise(resolve => setTimeout(resolve, 300))
    const status = await host.profileStatus()
    expect(status.items).toBe(0)
    expect(status.pending).toBe(0)
    expect(prompts).toHaveLength(1)
  })

  it('holds maintenance until the helper has released a cancelled claim', { timeout: 90_000 }, async () => {
    const gate: { release?: () => void } = {}
    const waiting = new Promise<void>(resolve => {
      gate.release = resolve
    })
    const root = makeRoot()
    const { host, profile, prompts } = harness({
      root,
      answer: async () => {
        await waiting
        return JSON.stringify({ items: [] })
      }
    })
    await profile.sync()
    await profile.completedChat({
      threadId: 't3',
      userId: 'm1',
      answerId: 'm2',
      question: '我更喜欢先给结论',
      at: Date.now()
    })
    await until(async () => (prompts.length === 1 ? true : undefined), 'the provider call')
    // The live profile database, held so the helper cannot commit its release: the
    // claim really is still `working` while maintenance waits.
    const live = new DatabaseSync(join(root, 'data', 'profile', 'profile.db'))
    live.exec('BEGIN IMMEDIATE')
    await profile.park('正在备份')
    let settled = false
    const pending = profile.settled().then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(settled).toBe(false)
    const held = live.prepare('SELECT state FROM profile_pending').get() as { state: string } | undefined
    expect(held?.state).toBe('working')
    live.exec('ROLLBACK')
    live.close()
    gate.release?.()
    await pending
    // Only now may a snapshot be taken, and it must not carry the cancelled claim.
    const target = join(mkdtempSync(join(tmpdir(), 'yu-profile-snap-')), 'profile.db')
    expect(await host.backupDatabase('profile', target, 1500)).toBeGreaterThan(0)
    const snapshot = new DatabaseSync(target, { readOnly: true })
    try {
      const row = snapshot.prepare("SELECT count(*) AS n FROM profile_pending WHERE state = 'working'").get() as { n: number }
      expect(Number(row.n)).toBe(0)
    } finally {
      snapshot.close()
    }
  })
})
