import type { VoiceCommandMode, VoiceCommandsSettings } from './types'

export const VOICE_COMMAND_MODES: VoiceCommandMode[] = ['dictation', 'translate', 'ask', 'reminder', 'notes']
export const DEFAULT_VOICE_COMMANDS: VoiceCommandsSettings = {
  enabled: false,
  smartRouting: true,
  keywords: {
    dictation: ['指令输入', 'command dictation'],
    translate: ['指令翻译', 'command translate'],
    ask: ['指令问答', 'command ask'],
    reminder: ['指令提醒', 'command reminder'],
    notes: ['指令笔记', 'command note']
  }
}
const separators = '[\\s,，。.!！?？:：;；、]'
const identity = (text: string): string => text.replace(new RegExp(separators, 'gu'), '').toLowerCase()

export function normalizeVoiceCommands(input?: Partial<VoiceCommandsSettings>): VoiceCommandsSettings {
  const keywords = {} as VoiceCommandsSettings['keywords']
  for (const mode of VOICE_COMMAND_MODES) {
    const values = input?.keywords?.[mode]
    keywords[mode] = Array.isArray(values)
      ? [...new Set(values.filter((v): v is string => typeof v === 'string').map(v => v.trim()).filter(v => identity(v).length > 0))]
      : [...DEFAULT_VOICE_COMMANDS.keywords[mode]]
  }
  return { enabled: input?.enabled === true, smartRouting: input?.smartRouting !== false, keywords }
}

export function voiceCommandConflict(mode: VoiceCommandMode, keywords: string[], settings: VoiceCommandsSettings): boolean {
  const wanted = new Set(keywords.map(identity).filter(Boolean))
  return VOICE_COMMAND_MODES.some(other => other !== mode && settings.keywords[other].some(keyword => wanted.has(identity(keyword))))
}

/** Exact opening phrase only. No fuzzy matching, mid-sentence scanning or model call. */
export function matchVoiceCommand(text: string, settings: VoiceCommandsSettings): { mode: VoiceCommandMode; text: string } | null {
  if (!settings.enabled) return null
  const matches: Array<{ mode: VoiceCommandMode; end: number }> = []
  for (const mode of VOICE_COMMAND_MODES) for (const keyword of settings.keywords[mode]) {
    if (!identity(keyword)) continue
    const words = keyword.trim().split(/\s+/u)
    const pattern = words.map(word => Array.from(word).map((char, i, chars) => {
      const gap = i && /\p{Script=Han}/u.test(chars[i - 1]!) && /\p{Script=Han}/u.test(char) ? `${separators}*` : ''
      return gap + char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }).join('')).join(`${separators}+`)
    const boundary = /[\p{L}\p{N}_]$/u.test(keyword) && !/\p{Script=Han}$/u.test(keyword) ? '(?![\\p{L}\\p{N}_])' : ''
    const match = new RegExp(`^\\s*${pattern}${boundary}`, 'iu').exec(text)
    if (match) matches.push({ mode, end: match[0].length })
  }
  matches.sort((a, b) => b.end - a.end)
  const first = matches[0]
  if (!first || matches.some(match => match.end === first.end && match.mode !== first.mode)) return null
  return { mode: first.mode, text: text.slice(first.end).replace(new RegExp(`^${separators}+`, 'u'), '').trim() }
}
