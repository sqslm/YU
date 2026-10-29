import type { PromptContext } from '@shared/prompts'

export interface SelectionTarget {
  text: string
  context: PromptContext
  apply(text: string, append: boolean, signal: AbortSignal): Promise<void>
}
interface SelectionDeps {
  capture(): Promise<SelectionTarget>
  transform(text: string, operation: 'polish' | 'translate', context: PromptContext): Promise<{ text: string; promptName: string } | null>
  busy(): boolean
  cancel(): void
  status(text: string, error?: boolean): void
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
    } catch (error) {
      if (!session.controller.signal.aborted) this.deps.status(error instanceof Error ? error.message : String(error), true)
    } finally {
      if (this.session === session) this.session = null
    }
  }
}
