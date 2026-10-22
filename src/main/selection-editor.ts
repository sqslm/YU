import type { AnswerCardPayload, CardActionId } from '@shared/types'
import type { PromptContext } from '@shared/prompts'
import { mt } from '@shared/mainI18n'

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
  show(payload: AnswerCardPayload): void
  hide(): void
}

/** One captured selection, one preview. Late work can never edit a newer selection. */
export class SelectionEditor {
  private revision = 0
  private session: { target?: SelectionTarget; result: string; promptName: string; busy: boolean; controller: AbortController } | null = null
  constructor(private readonly deps: SelectionDeps) {}

  cancel(): void {
    this.revision++
    this.session?.controller.abort()
    if (this.session?.busy) this.deps.cancel()
    this.session = null
  }

  async open(): Promise<void> {
    this.cancel()
    const session = { result: '', promptName: '', busy: false, controller: new AbortController() } as NonNullable<typeof this.session>
    this.session = session
    try {
      if (this.deps.busy()) throw new Error(mt('正在处理上一条，稍后再试'))
      session.target = await this.deps.capture()
      if (this.session === session) this.render()
    } catch (error) {
      if (this.session === session) this.render(String(error instanceof Error ? error.message : error))
    }
  }

  private render(status = ''): void {
    const session = this.session
    if (!session) return
    const actions: NonNullable<AnswerCardPayload['actions']> = session.target ? [
      { id: 'selection-polish', label: mt('润色选区') },
      { id: 'selection-translate', label: mt('翻译选区') },
      ...(session.result ? [
        { id: 'selection-replace' as const, label: mt('替换选区') },
        { id: 'selection-append' as const, label: mt('追加到末尾') }
      ] : [])
    ] : []
    this.deps.show({ selection: true, answer: session.result, question: session.target?.text ?? '',
      sources: [], tools: session.promptName ? [session.promptName] : [], streaming: session.busy,
      status: status || (session.busy ? mt('正在处理选中文字…') : session.result ? '' : mt('选择润色或翻译，预览后再应用。')),
      actions })
  }

  async action(id: CardActionId): Promise<void> {
    const session = this.session
    if (!session?.target) return
    if (id === 'stop') {
      this.revision++
      if (session.busy) this.deps.cancel()
      session.busy = false
      this.render(mt('已停止'))
      return
    }
    if (session.busy) return
    if (id === 'selection-polish' || id === 'selection-translate') {
      const revision = ++this.revision
      session.busy = true
      session.result = ''
      session.promptName = ''
      this.render()
      try {
        const result = await this.deps.transform(session.target.text, id === 'selection-polish' ? 'polish' : 'translate', session.target.context)
        if (this.session !== session || revision !== this.revision || !session.busy) return
        session.busy = false
        if (result) { session.result = result.text; session.promptName = result.promptName }
        this.render(result ? '' : mt('已停止'))
      } catch (error) {
        if (this.session !== session || revision !== this.revision) return
        session.busy = false
        this.render(error instanceof Error ? error.message : String(error))
      }
    } else if ((id === 'selection-replace' || id === 'selection-append') && session.result) {
      session.busy = true
      this.deps.hide()
      try {
        await session.target.apply(session.result, id === 'selection-append', session.controller.signal)
        if (this.session === session) this.session = null
      } catch (error) {
        if (this.session !== session) return
        session.busy = false
        this.render(error instanceof Error ? error.message : String(error))
      }
    }
  }
}
