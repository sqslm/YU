import { mt } from '@shared/mainI18n'
import type { ToolContext, ToolDefinition, ToolOutcome } from './registry'

type Execute = (name: string, args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutcome>
const string = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
const clarify = (summary: string): ToolOutcome => ({ ok: false, status: 'awaiting_confirmation', summary, data: { needsClarification: true } })

export function readAloudDefinition(execute: Execute): ToolDefinition {
  return {
    name: 'read_aloud',
    description: 'On an explicit request, read a real source aloud through the configured TTS provider. Resolve a uniquely titled/id note, latest completed polish/translation/history result, previous answer, daily briefing, current page/document, selection, clipboard or supplied text. Do not copy an excerpt into speak_text or invent unavailable content. Missing/ambiguous sources require clarification.',
    parameters: { type: 'object', properties: {
      source: { type: 'string', enum: ['note', 'result', 'answer', 'briefing', 'calendar', 'reminders', 'current_content', 'webpage', 'selection', 'clipboard', 'text', 'unspecified'] },
      title: { type: 'string' }, id: { type: 'string' }, latest: { type: 'boolean' },
      url: { type: 'string' }, day: { type: 'string', enum: ['today', 'tomorrow'] },
      mode: { type: 'string', enum: ['dictation', 'translate', 'ask'] }, text: { type: 'string' }
    }, required: ['source'], additionalProperties: false },
    available: ctx => Boolean(ctx.life),
    run: async (args, ctx) => {
      let text = '', label = '', truncated = false
      const permitted = (name: string): boolean => Boolean(ctx.allowedTools?.includes(name) && !(ctx.access?.() ?? ctx.settings.assistantAccess).disabledTools.includes(name))
      const unavailable = (name: string): ToolOutcome => ({ ok: false, summary: mt('本次任务未授权此工具：{{name}}', { name }), data: {} })
      if (!permitted('speak_text')) return unavailable('speak_text')
      if (args.source === 'note') {
        if (!ctx.personal || !permitted('search_notes')) return unavailable('search_notes')
        const title = string(args.title), id = string(args.id)
        if (!title && !id && args.latest !== true) return clarify(mt('请说明要朗读哪条随记的标题，或说“朗读最新随记”。'))
        ctx.onStatus?.(mt('正在查找随记：{{title}}', { title: title || mt('最新随记') }))
        const rows = ctx.personal.notes().filter(row => id ? row.id === id : title ? (row.title ?? '').trim().toLocaleLowerCase() === title.toLocaleLowerCase() : true)
          .sort((a, b) => b.createdAt - a.createdAt)
        if (!rows.length) return clarify(mt('没有找到指定内容：{{title}}', { title: title || id || mt('最新随记') }))
        if (rows.length > 1 && args.latest !== true) return clarify(mt('找到多条同名随记，请先在随记中选择要朗读的那一条。'))
        const row = rows[0]
        text = row.polished?.trim() || row.transcript; label = row.title || mt('随记')
      } else if (args.source === 'result') {
        if (!ctx.personal || !permitted('search_history')) return unavailable('search_history')
        const rows = ctx.personal.history('').filter(row => (!args.id || row.id === args.id) && (!args.mode || row.mode === args.mode) &&
          (!row.status || row.status === 'completed') && !row.error && row.final?.trim()).sort((a, b) => b.createdAt - a.createdAt)
        if (!rows.length) return clarify(mt('没有找到可朗读的已完成结果。'))
        text = rows[0].final; label = mt('最近的处理结果')
      } else if (args.source === 'answer') {
        text = ctx.taskContext?.task?.recentExchange?.answer ?? ''; label = mt('上一条回答')
      } else if (args.source === 'briefing') {
        const result = await execute('daily_briefing', {}, ctx)
        if (!result.ok) return result
        text = string(result.data.body); label = string(result.data.title) || mt('今日简报')
      } else if (args.source === 'calendar' || args.source === 'reminders') {
        const result = await execute(args.source === 'calendar' ? 'list_events' : 'list_reminders', args.day ? { ...(args.source === 'calendar' ? { range: args.day } : { day: args.day }) } : {}, ctx)
        if (!result.ok) return result
        const items = Array.isArray(result.data.items) ? result.data.items as Record<string, unknown>[] : []
        text = items.map(row => [row.title, row.when || row.triggerTime, row.description || row.notes, row.location].filter(Boolean).join('，')).join('。\n')
        label = mt(args.source === 'calendar' ? '日程' : '提醒与待办'); truncated = result.data.truncated === true
      } else if (args.source === 'webpage') {
        const result = await execute('read_webpage', { url: string(args.url) }, ctx)
        if (!result.ok) return result
        text = string(result.data.text); label = string(result.data.title) || string(args.url); truncated = result.data.truncated === true
      } else if (['current_content', 'selection', 'clipboard'].includes(String(args.source))) {
        const name = args.source === 'current_content' ? 'read_current_content' : args.source === 'selection' ? 'get_selection' : 'read_clipboard'
        ctx.onStatus?.(mt('正在读取要朗读的内容…'))
        const result = await execute(name, {}, ctx)
        if (!result.ok) return result
        text = string(result.data.text); label = string(result.data.title) || mt('所选内容'); truncated = result.data.truncated === true
      } else if (args.source === 'text') { text = string(args.text); label = mt('指定文本') }
      else return clarify(mt('请说明要朗读的内容，例如“朗读随记里标题为优化点的内容”或“朗读刚才的润色结果”。'))
      if (!text.trim()) return clarify(mt('没有找到可朗读的文字，请选择具体内容后重试。'))
      ctx.onStatus?.(mt('正在生成语音：{{title}}', { title: label }))
      const outcome = await execute('speak_text', { text }, ctx)
      if (!outcome.ok || outcome.data.skipped) return outcome
      return { ...outcome, summary: `${mt('已开始朗读：{{title}}', { title: label })}${truncated ? `\n${mt('当前来源仅读取了部分，朗读仅覆盖已读取的文字。')}` : ''}`,
        data: { ...outcome.data, source: args.source, title: label, truncated } }
    }
  }
}
