import { mkdtempSync, rmSync } from 'node:fs'
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
}

function harness(options: {
  enabled?: boolean
  answer?: (prompt: string) => string
  root?: string
} = {}): Harness {
  const root = options.root ?? makeRoot()
  const prompts: string[] = []
  const host = new KnowledgeHost({
    entry,
    root,
    requestMs: 15_000,
    completer: async call => {
      const prompt = call.messages.map(message => message.content).join('\n')
      prompts.push(prompt)
      return (options.answer ?? (() => '{"items":[]}'))(prompt)
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
    allowed: (): boolean => profile.enabled
  })
  return { host, profile, settings, prompts }
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
    await profile.completedChat(turn)
    await until(async () => ((await host.profileStatus()).usageTotal === 1 ? true : undefined), 'the first count')
    const status = await host.profileStatus()
    expect(status.usageTotal).toBe(1)
    expect(prompts).toHaveLength(0)
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
    await until(async () => ((await host.profileStatus()).pending === 1 ? true : undefined), 'the queued evidence')
    profile.wake()
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
    // A callback assigned inside an executor is widened to `never` by TS, so the
    // handle lives on an object the compiler cannot narrow away.
    const gate: { release?: () => void } = {}
    const waiting = new Promise<void>(resolve => {
      gate.release = resolve
    })
    const { host, profile } = harness({
      answer: () => '{"items":[]}'
    })
    await profile.sync()
    await profile.completedChat({
      threadId: 't2',
      userId: 'm1',
      answerId: 'm2',
      question: '我更希望回答先给结论',
      at: Date.now()
    })
    await until(async () => ((await host.profileStatus()).pending === 1 ? true : undefined), 'the queued evidence')
    await host.saveProfile({ dimension: 'expression', value: '先给结论', category: 'explicit', origin: 'manual', pinned: true, slot: 'expression:conclusion-first' })
    const cleared = await profile.clear()
    expect(cleared).toBe(true)
    const context = await profile.context()
    expect(context?.text ?? '').toBe('')
    gate.release?.()
    await waiting
    expect((await host.profileStatus()).items).toBe(0)
  })

  it('parks a running batch on game mode and resumes the same evidence afterwards', { timeout: 60_000 }, async () => {
    const { host, profile } = harness({ answer: () => '{"items":[]}' })
    await profile.sync()
    await profile.completedChat({ threadId: 't3', userId: 'm1', answerId: 'm2', question: '最近在看 SQLite 的 FTS5', at: Date.now() })
    await until(async () => ((await host.profileStatus()).pending === 1 ? true : undefined), 'the queued evidence')
    await profile.sync({ game: true })
    const parked = await host.profileStatus()
    expect(parked.pausedGame).toBe(true)
    expect((await host.profileStatus()).pending).toBe(1)
    await profile.sync({ game: false })
    expect((await host.profileStatus()).pausedGame).toBe(false)
    // Leaving the game resumes the loop, so the queued sentence is consumed
    // instead of waiting for the next unrelated event.
    await until(async () => ((await host.profileStatus()).pending === 0 ? true : undefined), 'the resumed batch')
  })

  it('does not run a paused module and keeps the evidence for later', { timeout: 60_000 }, async () => {
    const { host, profile } = harness({ answer: () => '{"items":[]}' })
    await profile.sync()
    await profile.completedChat({ threadId: 't4', userId: 'm1', answerId: 'm2', question: '我想把项目拆成多个阶段', at: Date.now() })
    await until(async () => ((await host.profileStatus()).pending === 1 ? true : undefined), 'the queued evidence')
    await profile.pause(true)
    expect((await host.profileStatus()).pausedManual).toBe(true)
    // A paused module neither learns nor loses the queued sentence.
    expect((await host.profileStatus()).pending).toBe(1)
    await profile.pause(false)
    const status = await host.profileStatus()
    expect(status.pausedManual).toBe(false)
    // Resuming drains it: the batch ran instead of the evidence piling up forever.
    await until(async () => ((await host.profileStatus()).pending === 0 ? true : undefined), 'the resumed batch')
    expect((await host.profileStatus()).items).toBe(0)
  })
})
