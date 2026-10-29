import { expect, it } from 'vitest'
import type { AssistantTurn } from '@shared/assistant'
import { stripAppendedSources } from './agent'
import { assistantAnswer } from './assistant-presentation'

const turn = (tools: string[] = []): AssistantTurn => ({ id: 1, question: 'What is this window?', answer: 'Feishu', sources: [], state: 'done', localResults: tools.map(tool => ({ tool, ok: true, summary: 'Real result' })) })
it('keeps card follow-up actions and failures in the card that submitted them', () => {
  expect(assistantAnswer(turn(['create_note']), true)).toMatchObject({ answer: 'Feishu', streaming: false })
  expect(assistantAnswer({ ...turn(), state: 'error', taskState: 'failed', answer: 'Request failed' }, true)).toMatchObject({ answer: 'Request failed' })
})
it('keeps recovered file-search results in the answer card, but rejects an unrecovered index failure', () => {
  const failed = { tool: 'search_files_everything', ok: false, fallback: true, summary: 'Index unavailable' }
  expect(assistantAnswer({ ...turn(), localResults: [failed, { tool: 'search_files', ok: true, summary: 'Actual results' }] })).toBeDefined()
  expect(assistantAnswer({ ...turn(), localResults: [failed] })).toBeUndefined()
})
it('puts normal answers and actual read-only tool results in the existing Ask card', () => {
  for (const tools of [[], ['get_active_window'], ['search_files'], ['list_reminders'], ['search_notes'], ['analyze_screenshot']]) {
    expect(assistantAnswer(turn(tools))).toMatchObject({ answer: 'Feishu', assistant: true, streaming: false })
  }
})
it('keeps application opens, data changes and compound actions out of the answer window', () => {
  for (const tools of [['open_application'], ['open_url'], ['create_note'], ['manage_reminder'], ['search_files', 'open_file'], ['list_reminders', 'create_reminder']]) expect(assistantAnswer(turn(tools))).toBeUndefined()
})
it('never renders failed, cancelled or pending operations as successful answers', () => {
  expect(assistantAnswer({ ...turn(), state: 'error' })).toBeUndefined()
  expect(assistantAnswer({ ...turn(), state: 'cancelled' })).toBeUndefined()
  expect(assistantAnswer({ ...turn(), state: 'working' })).toBeUndefined()
  expect(assistantAnswer({ ...turn(['search_files']), localResults: [{ tool: 'search_files', ok: false, summary: 'Not found' }] })).toBeUndefined()
})
it('keeps real application candidates visible while waiting for the user to choose', () => {
  expect(assistantAnswer({ ...turn(['open_application']), taskId: 'task-1', taskState: 'awaiting_confirmation' }))
    .toMatchObject({ taskId: 'task-1', taskState: 'awaiting_confirmation', streaming: false })
})
it('leaves the markdown source list in the text only when the card has no sources to draw', () => {
  const answer = '窗口是飞书。\n\n## 来源\n- [飞书](https://feishu.example/doc)'
  const source = { title: '飞书', url: 'https://feishu.example/doc', snippet: '' }
  // With source cards present the text list would be a second, duplicated section.
  expect(assistantAnswer({ ...turn(), answer, sources: [source] })).toMatchObject({ answer: '窗口是飞书。', sources: [source] })
  // Without cards the list is the only place the links exist, so it stays.
  expect(assistantAnswer({ ...turn(), answer, sources: [] })).toMatchObject({ answer })
})
it('strips only the appended source block, never body text that resembles it', () => {
  expect(stripAppendedSources('第一段\n\n第二段')).toBe('第一段\n\n第二段')
  expect(stripAppendedSources('结论\n\n## 来源\n- [A](https://a.example/1)\n- [B](https://b.example/2)')).toBe('结论')
  // A `## 来源` heading the answer wrote itself, mid-text, is not the appended tail.
  expect(stripAppendedSources('## 来源对比\n正文')).toBe('## 来源对比\n正文')
})
