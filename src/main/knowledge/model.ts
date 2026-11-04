/**
 * Model callbacks for the knowledge helper.
 *
 * The helper cannot reach a provider itself: it sends a `model.request` frame
 * and this bridge answers using the same `complete` call and the same provider
 * chain the rest of the app uses. Phase 1 uses it only to prove the path holds
 * — no knowledge or profile prompt is written here, and the renderer cannot
 * reach it.
 */

import type { Settings } from '@shared/types'
import { KnowledgeError, type HelperChatMessage } from '@shared/knowledge'

import { chainFor, profileOverlay } from '../providers/chain'
import { complete } from '../providers/llm'

export interface ModelCall {
  /** Empty or unknown ids fall back to the first enabled profile. */
  profileId: string
  effort: string
  messages: HelperChatMessage[]
  maxTokens?: number
  signal: AbortSignal
}

export type KnowledgeCompleter = (call: ModelCall) => Promise<string>

export interface CompleterOptions {
  settings: () => Settings
  /** Test seam: replaces the provider call; production passes nothing. */
  complete?: typeof complete
}

/** The first enabled profile, or the one the helper pinned by id. */
export function selectProfile(settings: Settings, profileId: string) {
  const chain = chainFor(settings, 'llm')
  const pinned = profileId ? chain.find((profile) => profile.id === profileId) : undefined
  return pinned ?? chain[0]
}

export function createKnowledgeCompleter(options: CompleterOptions): KnowledgeCompleter {
  const send = options.complete ?? complete
  return async (call) => {
    const settings = options.settings()
    const profile = selectProfile(settings, call.profileId)
    if (!profile) {
      throw new KnowledgeError('model_unavailable', '没有启用的对话模型配置')
    }
    const text = await send(
      { ...settings.polish, ...profileOverlay(profile) },
      {
        messages: call.messages,
        maxTokens: call.maxTokens,
        signal: call.signal,
        // A knowledge synthesis is a real task, not dictation: it thinks by
        // default instead of inheriting the thinking-off setting.
        effort: call.effort || 'high'
      }
    )
    return text
  }
}
