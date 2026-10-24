import type { AssistantTurn } from '@shared/assistant'
import type { AnswerCardPayload } from '@shared/types'

const ACTIONS = new Set(['open_application', 'open_folder', 'open_file', 'open_url', 'open_page', 'create_reminder', 'manage_reminder', 'create_note', 'update_note_tags', 'update_note', 'extract_note_tasks', 'copy_to_clipboard'])
/** Successful read-only answers use Ask; actual actions and failures stay on the voice bar. */
export function assistantAnswer(turn: AssistantTurn): AnswerCardPayload | undefined {
  if (turn.state !== 'done' || turn.localResults?.some(result => !result.ok || ACTIONS.has(result.tool))) return undefined
  return { question: turn.question, answer: turn.answer, sources: turn.sources, localResults: turn.localResults, assistant: true, streaming: false }
}
