/**
 * Ask Anything — the compatibility surface for the tool-using agent.
 *
 * The routing, the tool loop and the answer construction all live in
 * `agent.ts`. This module keeps the shape the pipeline and the existing tests
 * were written against: `answerWithSearch` returns exactly
 * `{text, sources, searched, query?}` and nothing else, even though the agent
 * knows about tools and card actions.
 */

import type { SearchResult, Settings } from '@shared/types'
import type { PromptContext } from '@shared/prompts'
import { askAgent, type AgentOptions } from './agent'

export interface AskOutcome {
  text: string
  sources: SearchResult[]
  /** True when a web search actually ran (not just when it was requested). */
  searched: boolean
  query?: string
}

// Query-shaping helpers moved to `agent.ts` when the tool loop landed; they are
// re-exported here because the pipeline and the tests import them from answer.
export {
  appendSources,
  isColloquialQuery,
  looksTimeSensitive,
  parseIntent,
  parseSearchDecision,
  prepareSearchQuery,
  resetThread,
  sanitizeSearchQuery
} from './agent'
export type { AgentIntent, AgentResult } from './agent'

/**
 * Answers one spoken question.
 *
 * Each call starts a fresh conversation: a take is a standalone question, while
 * multi-turn follow-ups go through `askFollowUp` in `agent.ts`. Every failure in
 * the tool leg degrades to a plain answer — a take must never be lost because a
 * provider was down.
 *
 * `options` is optional and new: a caller that can render partial text passes
 * `onDelta` here to get the answer while it is still being generated. Callers
 * that omit it keep the exact previous behaviour.
 */
export async function answerWithSearch(
  settings: Settings,
  transcript: string,
  context: PromptContext,
  signal: AbortSignal,
  log: (line: string) => void = () => {},
  options: AgentOptions = {}
): Promise<AskOutcome> {
  const result = await askAgent(settings, transcript, context, signal, log, {
    ...options,
    reset: true
  })
  const outcome: AskOutcome = {
    text: result.text,
    sources: result.sources,
    searched: result.searched
  }
  if (result.searched && result.query) outcome.query = result.query
  return outcome
}
