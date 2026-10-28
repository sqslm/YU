import type { ProviderSettings } from './types'

/** Protocol allowlist, not a guess based on an arbitrary model name. */
export function asrEnhancementCapability(profile: Pick<ProviderSettings, 'baseUrl' | 'model' | 'asrAdapter'>): 'prompt' | 'context' | 'none' {
  let host = ''
  try { host = new URL(profile.baseUrl).hostname } catch { return 'none' }
  if ((profile.asrAdapter === 'aliyun' || host === 'dashscope.aliyuncs.com') && profile.model === 'qwen3-asr-flash') return 'context'
  if (!profile.asrAdapter && host === 'api.openai.com' && /^(?:whisper-1|gpt-transcribe|gpt-4o(?:-mini)?-transcribe)$/.test(profile.model)) return 'prompt'
  return 'none'
}

/** Whole terms only, below Whisper's 224-token prompt limit even as UTF-8 bytes. */
export function asrTermContext(words: string[]): string {
  const keep: string[] = []
  for (const word of [...new Set(words)].slice(0, 20)) {
    if (new TextEncoder().encode([...keep, word].join(', ')).length <= 200) keep.push(word)
  }
  return keep.join(', ')
}
