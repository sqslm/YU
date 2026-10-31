import type { PromptKind } from '@shared/types'
import type { PromptContext } from '@shared/prompts'
import { appLabel } from './foreground'

export interface SelectionTarget {
  text: string
  context: PromptContext
  apply(text: string, append: boolean, signal: AbortSignal): Promise<void>
}

/**
 * One finished selection edit, ready to be filed under 历史记录 (需求5).
 *
 * The editor owns no store: it hands the row's content to the app, which is the
 * only layer that knows how a history entry is written.
 */
export interface SelectionRecordInput {
  operation: 'polish' | 'translate'
  original: string
  result: string
  /** Display label of the window the text went back into; '' when unknown. */
  app: string
  promptName?: string
  promptId?: string
  promptKind?: PromptKind
  providerId?: string
  providerName?: string
  /** From the shortcut to the applied text, matching what history shows. */
  processingMs?: number
}

interface SelectionDeps {
  capture(): Promise<SelectionTarget>
  transform(text: string, operation: 'polish' | 'translate', context: PromptContext): Promise<{ text: string; promptName: string; promptId?: string; promptKind?: PromptKind; providerId?: string; providerName?: string } | null>
  busy(): boolean
  cancel(): void
  status(text: string, error?: boolean): void
  /** Optional: a selection edit that landed is a 润色 / 翻译 history row. */
  record?(input: SelectionRecordInput): void | Promise<void>
}

/** A shortcut owns one selection and one operation; never opens the Ask card. */
export class SelectionEditor {
  private session: { controller: AbortController; transforming: boolean } | null = null
  constructor(private readonly deps: SelectionDeps) {}
  get isBusy(): boolean { return this.session !== null }
  cancel(): void {
    this.session?.controller.abort()
    if (this.session?.transforming) this.deps.cancel()
    this.session = null
  }
  async run(operation: 'polish' | 'translate', append: boolean): Promise<void> {
    if (this.session || this.deps.busy()) { this.deps.status('正在处理上一条，稍后再试'); return }
    const startedAt = Date.now()
    const session = { controller: new AbortController(), transforming: false }
    this.session = session
    try {
      const target = await this.deps.capture()
      session.controller.signal.throwIfAborted()
      session.transforming = true
      const result = await this.deps.transform(target.text, operation, target.context)
      session.transforming = false
      if (!result || session.controller.signal.aborted) return
      await target.apply(result.text, append, session.controller.signal)
      if (!session.controller.signal.aborted) this.deps.status(append ? '已追加到选区末尾' : '已替换选中文字')
      // Only a text that actually replaced/appended the selection is a record:
      // a cancelled or refused edit is not something the user wants in history.
      if (!session.controller.signal.aborted) this.file(operation, target, result, startedAt)
    } catch (error) {
      if (!session.controller.signal.aborted) this.deps.status(error instanceof Error ? error.message : String(error), true)
    } finally {
      if (this.session === session) this.session = null
    }
  }

  /**
   * Best effort, and never in the way: the text is already in the user's
   * document, so a history write that fails (or a host that wired none) must not
   * turn a successful edit into an error notice.
   */
  private file(
    operation: 'polish' | 'translate',
    target: SelectionTarget,
    result: { text: string; promptName: string; promptId?: string; promptKind?: PromptKind; providerId?: string; providerName?: string },
    startedAt: number
  ): void {
    const record = this.deps.record
    if (!record) return
    const context = target.context ?? {}
    const entry: SelectionRecordInput = {
      operation,
      original: target.text,
      result: result.text,
      app: appLabel(context.appName ?? '', context.windowTitle ?? ''),
      processingMs: Math.max(0, Date.now() - startedAt),
      ...(result.promptName ? { promptName: result.promptName } : {}),
      ...(result.promptId ? { promptId: result.promptId } : {}),
      ...(result.promptKind ? { promptKind: result.promptKind } : {}),
      ...(result.providerId ? { providerId: result.providerId } : {}),
      ...(result.providerName ? { providerName: result.providerName } : {})
    }
    try {
      void Promise.resolve(record(entry)).catch(() => {})
    } catch {
      // A host that throws synchronously is a host without history: ignore it.
    }
  }
}
