/**
 * The main-process half of the user-profile loop.
 *
 * It has exactly two jobs: report facts that really happened (a finished
 * conversation, a finished Ask, a created note, an edited card) and carry the one
 * model call the helper asks for. Everything else — what counts as evidence, when
 * a batch is due, what may be written, what the context says — is decided in Rust.
 *
 * One wake drains the whole runnable backlog, exactly like the extraction engine:
 * a switch that was just turned on should not need a second user action before the
 * second batch runs. Only one batch is ever in flight.
 */

import type { Settings } from '@shared/types'
import type { ProfileContext, ProfileFeature, ProfileStatus } from '@shared/knowledge'
import { KnowledgeError } from '@shared/knowledge'
import type { KnowledgeHost } from './host'

/** Learning that waits for a provider is slow; never busy-poll for it. */
const MAX_IDLE_WAIT_MS = 60_000

export interface ProfileTurn {
  threadId: string
  userId: string
  answerId: string
  question: string
  at: number
}

export interface ProfileAsk {
  taskId: string
  question: string
  at: number
}

export interface ProfileDeps {
  settings: () => Settings
  host: () => KnowledgeHost | null
  /** False while the profile is off, paused or in game mode. */
  allowed: () => boolean
  log?: (line: string) => void
  now?: () => number
  schedule?: (run: () => void, delayMs: number) => { cancel: () => void }
}

const defaultSchedule = (run: () => void, delayMs: number): { cancel: () => void } => {
  const timer = setTimeout(run, delayMs)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

export class ProfileCollector {
  private timer: { cancel: () => void } | null = null
  private working = false
  private again = false
  private parked = false

  constructor(private readonly deps: ProfileDeps) {}

  private get settings() {
    return this.deps.settings().userProfile
  }

  /** The master switch alone; pauses and game mode are separate facts. */
  get enabled(): boolean {
    return this.settings?.enabled === true
  }

  /**
   * Mirrors this module's own switches into the helper. It never spawns a helper
   * for an off feature: with the switch closed there is nothing to report, and a
   * spawn would create the database the user asked to leave alone.
   */
  async sync(options: { game?: boolean } = {}): Promise<void> {
    const settings = this.settings
    const host = this.deps.host()
    if (!settings || !host) return
    if (!settings.enabled && !host.running) {
      // Nothing is running: there is no batch to release and a switch that was never
      // on must not create the database it was meant to leave alone.
      await this.park('画像学习已关闭')
      return
    }
    const reason = !settings.enabled
      ? '画像学习已关闭'
      : options.game === true
        ? '游戏模式已暂停画像学习'
        : !settings.chat
          ? '画像学习已停止收集对话'
          : null
    if (reason !== null) {
      // The helper answers one frame at a time: while it waits for the model, a control
      // frame sent behind that run is not read yet, so the release inside its transaction
      // cannot happen. Cancel first — the run unwinds and puts its claim back before the
      // control frame is processed — then let the reply prove the settled state.
      this.stop()
      host.cancelInFlight(reason, 'profile.learn.run')
    }
    try {
      await host.configureProfile({
        enabled: settings.enabled,
        usage: settings.usage,
        chat: settings.chat,
        pausedGame: options.game === true,
      })
    } catch (error) {
      this.deps.log?.(`画像设置同步失败：${describe(error)}`)
      return
    }
    if (!settings.enabled) {
      // A closed switch parks the loop and frees the timer; the stored profile stays
      // in the database for explicit management.
      await this.park('画像学习已关闭')
      return
    }
    if (options.game) {
      // Game mode parks before the helper is stopped, so the release is recorded as
      // a pause instead of looking like a crashed batch.
      await this.park('游戏模式已暂停画像学习')
      return
    }
    if (!settings.chat) {
      // Only chat and Ask questions are evidence; with the channel closed nothing new
      // can arrive, so an in-flight batch is released as a pause.
      await this.park('画像学习已停止收集对话')
      return
    }
    if (this.deps.allowed()) this.wake()
  }

  /** One finished conversation: a usage count and, when allowed, its question. */
  async completedChat(turn: ProfileTurn): Promise<void> {
    await this.report('chat', `chat:${turn.threadId}:${turn.answerId}`, turn.at)
    if (!this.settings?.chat) return
    await this.evidence({
      sourceKind: 'chat',
      sourceId: turn.threadId,
      version: `${turn.userId}:${turn.answerId}`,
      originRef: `${turn.threadId}:${turn.userId}:${turn.answerId}`,
      locator: '主界面问答',
      at: turn.at,
      text: turn.question,
    })
  }

  /** One finished floating Ask. Its question is the user's own sentence. */
  async completedAsk(ask: ProfileAsk): Promise<void> {
    await this.report('ask', `ask:${ask.taskId}`, ask.at)
    if (!this.settings?.chat) return
    await this.evidence({
      sourceKind: 'ask',
      sourceId: ask.taskId,
      version: 'v1',
      originRef: `ask:${ask.taskId}`,
      locator: '浮动提问',
      at: ask.at,
      text: ask.question,
    })
  }

  /** A note was really created; the note body itself is not profile evidence. */
  async completedNote(noteId: string, at = this.deps.now?.() ?? Date.now()): Promise<void> {
    await this.report('note', `note:${noteId}`, at)
  }

  /**
   * The user edited a card by hand: a real, completed, in-app action. The card's own
   * revision is the operation identity, so editing the same revision twice counts
   * once and an edit never mints a fresh id out of the clock.
   */
  async editedCard(cardId: string, revision: number, at = this.deps.now?.() ?? Date.now()): Promise<void> {
    await this.report('card-edit', `card:${cardId}:${revision}`, at)
  }

  /** The numbers the page may show; an off switch answers locally. */
  async status(): Promise<ProfileStatus | null> {
    const host = this.deps.host()
    if (!host) return null
    if (!this.enabled) {
      return {
        enabled: false,
        usage: this.settings?.usage === true,
        chat: this.settings?.chat === true,
        pausedManual: false,
        pausedGame: false,
        epoch: 0,
        pending: 0,
        items: 0,
        usageTotal: 0,
        failed: 0,
        failedItems: [],
        nextDueAt: null
      }
    }
    try {
      return await host.profileStatus()
    } catch (error) {
      this.deps.log?.(`画像状态读取失败：${describe(error)}`)
      return null
    }
  }

  /** The explicit retry path for a batch that failed for a real reason. */
  async retry(): Promise<number | null> {
    const host = this.deps.host()
    if (!host) return null
    try {
      const result = await host.retryProfile()
      if (result.retried > 0) this.wake()
      return result.retried
    } catch (error) {
      this.deps.log?.(`画像重试失败：${describe(error)}`)
      return null
    }
  }

  /** A deleted or temporary thread can no longer be evidence. */
  async retractThread(threadId: string, reason: string): Promise<void> {
    const host = this.deps.host()
    if (!host) return
    // A withdrawal concerns data that already exists, so it must run even while the
    // switch is closed: otherwise the queued source would be learned the moment the
    // switch reopens. A profile that was never created has nothing to withdraw.
    if (!this.enabled && !host.running && !host.hasProfileData()) return
    try {
      await host.retractProfileSource('chat', threadId, reason)
    } catch (error) {
      this.deps.log?.(`画像证据撤回失败：${describe(error)}`)
    }
  }

  /** The readable context; stage 6 will feed it to answers. */
  async context(): Promise<ProfileContext | null> {
    const host = this.deps.host()
    if (!host) return null
    if (!this.enabled) return { enabled: false, text: '', items: [], bytes: 0 }
    try {
      return await host.profileContext()
    } catch (error) {
      this.deps.log?.(`画像上下文读取失败：${describe(error)}`)
      return null
    }
  }

  /** Manual pause keeps the stored profile and every manual maintenance path. */
  async pause(paused: boolean): Promise<boolean> {
    const host = this.deps.host()
    if (!host) return false
    try {
      await host.pauseProfile('manual', paused)
    } catch (error) {
      this.deps.log?.(`画像暂停失败：${describe(error)}`)
      return false
    }
    if (paused) await this.park('手动暂停画像学习')
    else this.wake()
    return true
  }

  async clear(): Promise<boolean> {
    const host = this.deps.host()
    if (!host) return false
    try {
      await host.clearProfile()
      return true
    } catch (error) {
      this.deps.log?.(`画像清空失败：${describe(error)}`)
      return false
    }
  }

  /** Releases an in-flight batch so a normal pause is not a failure. */
  /**
   * Stops the loop and aborts the batch this module owns. Only `profile.learn.run`
   * is touched: a concurrent extraction batch belongs to the other module and is
   * never cancelled from here.
   */
  async park(reason = '画像学习已暂停'): Promise<void> {
    const first = !this.parked
    this.parked = true
    this.stop()
    this.deps.host()?.cancelInFlight(reason, 'profile.learn.run')
    if (first) this.deps.log?.(reason)
  }

  /** Waits until a batch that was already claimed has been handed back. */
  async settled(): Promise<void> {
    const loop = this.loop
    if (loop) await loop
  }

  wake(): void {
    if (!this.enabled || !this.deps.allowed()) return
    if (this.working) {
      // A wake that arrives mid-batch is remembered, not dropped.
      this.again = true
      return
    }
    this.parked = false
    void this.tick()
  }

  stop(): void {
    this.timer?.cancel()
    this.timer = null
  }

  private loop: Promise<void> | null = null

  private async tick(): Promise<void> {
    if (this.working) return
    this.working = true
    const done = (async () => {
    try {
      do {
        this.again = false
        await this.drain()
      } while (this.again && this.enabled && this.deps.allowed())
    } finally {
      this.working = false
    }
    })()
    this.loop = done
    try { await done } finally { if (this.loop === done) this.loop = null }
  }

  /** Runs every batch the helper is willing to hand out right now. */
  private async drain(): Promise<void> {
    const host = this.deps.host()
    if (!host) return
    for (;;) {
      if (!this.enabled || !this.deps.allowed() || this.parked) return
      let next
      try {
        next = await host.learnNext()
      } catch (error) {
        this.deps.log?.(`画像批次读取失败：${describe(error)}`)
        return
      }
      if (!next.batch) {
        this.arm(next.nextDueAt)
        return
      }
      if (!this.enabled || !this.deps.allowed() || this.parked) {
        // The batch was handed out before the gate closed; handing it back keeps
        // the claim out of a snapshot instead of letting it sit in `working`.
        await host.learnFail({ claim: next.batch.claim, code: 'cancelled', reason: '正在备份或准备恢复' }).catch(() => undefined)
        return
      }
      const claim = next.batch.claim
      try {
        await host.learnRun({
          claim,
          profileId: this.settings?.profileId ?? null,
          effort: this.settings?.effort ?? 'high',
        })
      } catch (error) {
        const code = error instanceof KnowledgeError ? error.code : 'internal'
        if (code === 'cancelled') return
        await host
          .learnFail({ claim, code, reason: describe(error).slice(0, 300) })
          .catch(() => undefined)
        this.deps.log?.(`画像归纳失败：${describe(error)}`)
        return
      }
    }
  }

  private arm(dueAt: number | null): void {
    this.stop()
    if (dueAt === null) return
    const delay = Math.min(Math.max(dueAt - (this.deps.now?.() ?? Date.now()), 0), MAX_IDLE_WAIT_MS)
    this.timer = (this.deps.schedule ?? defaultSchedule)(() => {
      this.timer = null
      this.wake()
    }, Math.max(delay, 0))
  }

  private async report(feature: ProfileFeature, opId: string, at: number): Promise<void> {
    const host = this.deps.host()
    if (!host || !this.enabled || !this.settings?.usage) return
    try {
      await host.recordProfileEvent({ opId, feature, at })
    } catch (error) {
      this.deps.log?.(`画像功能统计失败：${describe(error)}`)
    }
  }

  private async evidence(input: {
    sourceKind: 'chat' | 'ask'
    sourceId: string
    version: string
    originRef: string
    locator: string
    at: number
    text: string
  }): Promise<void> {
    const host = this.deps.host()
    if (!host || !this.enabled || !this.deps.allowed()) return
    try {
      const result = await host.queueProfileEvidence([input])
      // New evidence the helper really accepted is what wakes the loop. A duplicate
      // settles as `queued: 0` and must not spend a model call, while a full queue is
      // worth saying out loud: nothing was stored, so the sentence is not learned yet.
      if (result.queued > 0) this.wake()
      else if (result.reason === 'capacity') this.deps.log?.('画像证据已满，等这一批学完再排队')
    } catch (error) {
      // Collection never breaks the answer it was observing, but the failure is
      // reported instead of swallowed.
      this.deps.log?.(`画像证据入队失败：${describe(error)}`)
    }
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
