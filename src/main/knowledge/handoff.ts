/**
 * Handing one document or one note to the knowledge queue, as the model-facing
 * tools do it.
 *
 * Two callers share this code: the saved-workflow executor (a page this run really
 * read) and the explicit note tool. Neither may invent a body — one publishes the
 * material it already holds, the other reads the note back through its own store.
 *
 * Every refusal here is a real state of the app (switch off, channel off, paused,
 * game mode, switched off turn, tool disabled in the permission settings), so the
 * caller reports it instead of queueing something the helper will never take.
 *
 * The turn's own signal travels with the hand-over: a source written after the
 * user cancelled would be a write nobody asked for. Rust keeps whatever it
 * committed, so a cancel that lands during the write is reported as cancelled and
 * nothing further is queued — the source that already exists stays as it is.
 */
import type { ExtractSourceResult } from '@shared/knowledge'
import { mt } from '@shared/mainI18n'

/** The same material shape the summary path projects. */
export interface HandoffMaterial {
  origin: string
  title: string
  text?: string
  url?: string
  locator?: string
}

export interface HandoffPublishOptions {
  signal?: AbortSignal
  /** The helper's own words when it refused the source. */
  reject?: (reason: string) => void
  /** Asked once the switch hand-over is done, before the source is written. */
  allow?: () => Promise<string>
}

export interface HandoffDeps {
  /** Master switch for the knowledge base. */
  enabled(): boolean
  /** Per-channel switch, i.e. the same one the collector checks before publishing. */
  channelOn(channel: 'reading' | 'notes'): boolean
  /** Game mode holds back every collection channel. */
  gameActive(): boolean
  /** Tools the user switched off in the permission settings; a saved workflow
   * grant never overrides them. */
  disabled(): readonly string[]
  /** The pause flags live in the helper, so they are asked for, never guessed. */
  paused(): Promise<{ manual: boolean; game: boolean }>
  /** Publishes through the collector and answers the source id it minted or found. */
  publishReading(material: HandoffMaterial, options: HandoffPublishOptions): Promise<string | null>
  /** Reads the note through its own store, publishes it, and answers the source id. */
  publishNote(noteId: string, options: HandoffPublishOptions): Promise<string | null>
  /** Queues one published source and wakes the engine only when it was accepted. */
  extract(sourceId: string, options: { signal?: AbortSignal; admit?: () => Promise<string> }): Promise<ExtractSourceResult>
  log?(line: string): void
}

/** The tool this hand-over writes with, i.e. the one the permission settings own. */
const TOOL = 'extract_knowledge'

function channelReason(channel: 'reading' | 'notes'): string {
  return channel === 'reading' ? mt('知识库没有开启阅读采集') : mt('知识库没有开启随记采集')
}

/**
 * The admission check, as a function that can be asked more than once.
 *
 * The switches, the pause and the permission list all live outside this call, so
 * they are read before and after the helper answers with its pause state. The
 * same function is handed to the publish call as well: waiting for a switch
 * hand-over can last long enough for the user to cancel, pause or switch the tool
 * off, and the write that follows has to honour that rather than the state this
 * run started with.
 */
function admission(
  deps: HandoffDeps,
  channel: 'reading' | 'notes',
  signal?: AbortSignal
): () => Promise<string> {
  const check = (): string => {
    if (signal?.aborted) return mt('本轮已取消')
    if (deps.disabled().includes(TOOL)) return mt('此工具已在权限设置中关闭：{{name}}', { name: TOOL })
    if (!deps.enabled()) return mt('知识采集未开启')
    if (!deps.channelOn(channel)) return channelReason(channel)
    if (deps.gameActive()) return mt('游戏模式已开启')
    return ''
  }
  return async () => {
    const before = check()
    if (before) return before
    let paused: { manual: boolean; game: boolean } | null = null
    try {
      paused = await deps.paused()
    } catch (error) {
      // The helper may be down; publishing reports that with its own reason.
      deps.log?.(`[knowledge] 读取暂停状态失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const after = check()
    if (after) return after
    if (!paused) return ''
    if (paused.game) return mt('游戏模式已开启')
    if (paused.manual) return mt('采集已暂停')
    return ''
  }
}

/** Why this run cannot hand anything over right now, or '' when it can. */
export async function handoffBlocker(
  deps: HandoffDeps,
  channel: 'reading' | 'notes',
  signal?: AbortSignal
): Promise<string> {
  return admission(deps, channel, signal)()
}

/** A page this run already read, handed to the queue through the real source chain. */
export async function handoffReading(
  deps: HandoffDeps,
  material: HandoffMaterial,
  options: { signal?: AbortSignal } = {}
): Promise<ExtractSourceResult> {
  const admit = admission(deps, 'reading', options.signal)
  const blocked = await admit()
  if (blocked) return { queued: 0, reason: blocked }
  let refused = ''
  let denied = ''
  const publish: HandoffPublishOptions = {
    reject: reason => (refused = reason),
    // The publish waits for a switch hand-over; whatever changed during that wait
    // is decided here, in the same words the first check used.
    allow: async () => {
      const reason = await admit()
      if (reason) denied = reason
      return reason
    }
  }
  if (options.signal) publish.signal = options.signal
  const sourceId = await deps.publishReading(material, publish)
  if (denied) return { queued: 0, reason: denied }
  if (refused) return { queued: 0, reason: mt('知识库拒绝了这次读取：{{reason}}', { reason: refused }) }
  if (!sourceId) {
    return { queued: 0, reason: options.signal?.aborted ? mt('本轮已取消') : mt('这条读取还没有进入知识库') }
  }
  // The source may already be committed when the cancel lands here. That is the
  // truth, so it is not rolled back — but nothing more is written or queued.
  if (options.signal?.aborted) return { queued: 0, reason: mt('本轮已取消') }
  // The queueing path reads the source back before it writes; the same admission
  // travels with it, because that read is another moment the user can change.
  return deps.extract(sourceId, { admit, ...(options.signal ? { signal: options.signal } : {}) })
}

/** One real note, re-read through its own store and handed over. */
export async function handoffNote(
  deps: HandoffDeps,
  noteId: string,
  options: { signal?: AbortSignal } = {}
): Promise<ExtractSourceResult> {
  const admit = admission(deps, 'notes', options.signal)
  const blocked = await admit()
  if (blocked) return { queued: 0, reason: blocked }
  let refused = ''
  let denied = ''
  const publish: HandoffPublishOptions = {
    reject: reason => (refused = reason),
    allow: async () => {
      const reason = await admit()
      if (reason) denied = reason
      return reason
    }
  }
  if (options.signal) publish.signal = options.signal
  const sourceId = await deps.publishNote(noteId, publish)
  if (denied) return { queued: 0, reason: denied }
  if (refused) return { queued: 0, reason: mt('知识库拒绝了这条随记：{{reason}}', { reason: refused }) }
  if (!sourceId) {
    return { queued: 0, reason: options.signal?.aborted ? mt('本轮已取消') : mt('这条随记还不能提炼') }
  }
  if (options.signal?.aborted) return { queued: 0, reason: mt('本轮已取消') }
  return deps.extract(sourceId, { admit, ...(options.signal ? { signal: options.signal } : {}) })
}
