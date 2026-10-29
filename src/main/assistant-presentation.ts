import { unresolvedToolFailure, type AssistantTurn } from '@shared/assistant'
import type { AnswerCardPayload } from '@shared/types'
import { dedupeSources, stripAppendedSources } from './agent'

const ACTIONS = new Set(['open_application', 'open_folder', 'open_file', 'open_url', 'open_page', 'create_reminder', 'manage_reminder', 'create_note', 'update_note_tags', 'update_note', 'extract_note_tasks', 'copy_to_clipboard', 'create_event', 'manage_event', 'configure_briefing', 'stop_speaking', 'sync_control', 'control_note_audio', 'set_system_volume', 'apply_selection_edit', 'configure_speech', 'control_speech', 'send_briefing', 'configure_briefing_delivery'])
/** Successful read-only answers use Ask; actual actions and failures stay on the voice bar. */
export function assistantAnswer(turn: AssistantTurn, fromCard = false): AnswerCardPayload | undefined {
  if (fromCard) {
    if (turn.state !== 'done' && turn.state !== 'error' || turn.taskState === 'cancelled') return undefined
  } else if (turn.state !== 'done' || turn.taskState === 'failed' || turn.taskState === 'cancelled' || turn.taskState !== 'awaiting_confirmation' && (unresolvedToolFailure(turn.localResults) || turn.localResults?.some(result => ACTIONS.has(result.tool)))) return undefined
  // The card draws `sources` as its own clickable section, so the markdown list the agent
  // appended to the text would show up twice. Strip it only when there are cards to render;
  // without sources the text is the only place the links appear, so it is left alone.
  const sources = turn.sources ? dedupeSources(turn.sources) : turn.sources
  return { taskId: turn.taskId, taskState: turn.taskState, question: turn.question, answer: sources?.length ? stripAppendedSources(turn.answer) : turn.answer, sources, localResults: turn.localResults, assistant: true, streaming: false }
}
