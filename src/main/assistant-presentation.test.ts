import { expect, it } from 'vitest'
import type { AssistantTurn } from '@shared/assistant'
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
