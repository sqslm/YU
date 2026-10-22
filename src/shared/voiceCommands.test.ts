import { describe, expect, it } from 'vitest'
import { DEFAULT_VOICE_COMMANDS, matchVoiceCommand, normalizeVoiceCommands, voiceCommandConflict } from './voiceCommands'
import { applySettingsPatch, mergeSettings } from './defaults'

const enabled = { ...DEFAULT_VOICE_COMMANDS, enabled: true }
describe('opening voice commands', () => {
  it('keeps other phrases when toggling or updating one mode through a settings patch', () => {
    const current = mergeSettings({ voiceCommands: enabled })
    const updated = mergeSettings(applySettingsPatch(current, { voiceCommands: { enabled: false, keywords: { ask: ['助手问问'] } } as never }))
    expect(updated.voiceCommands.enabled).toBe(false)
    expect(updated.voiceCommands.keywords.ask).toEqual(['助手问问'])
    expect(updated.voiceCommands.keywords.notes).toEqual(DEFAULT_VOICE_COMMANDS.keywords.notes)
  })
  it.each([
    ['指令输入，今天一起吃饭。', 'dictation', '今天一起吃饭。'],
    ['指令，翻译。你好世界', 'translate', '你好世界'],
    ['指令问答今天有哪些新闻？', 'ask', '今天有哪些新闻？'],
    ['指令提醒，20分钟后打扫卫生', 'reminder', '20分钟后打扫卫生'],
    ['指令笔记：这是今天的灵感', 'notes', '这是今天的灵感'],
    ['  COMMAND ASK: What is new?', 'ask', 'What is new?'],
    ['command translate, ① “Hello”', 'translate', '① “Hello”'],
    ['command note\nMy new idea.', 'notes', 'My new idea.']
  ])('routes %s without altering its body', (text, mode, body) => {
    expect(matchVoiceCommand(text, enabled)).toEqual({ mode, text: body })
  })
  it.each(['请说指令翻译', '这是指令问答的设置', '“指令翻译”是什么意思？', 'command asking about it', 'command notebook', 'commandask now', '普通文字', ''])('does not mistake ordinary content for a command: %s', text => {
    expect(matchVoiceCommand(text, enabled)).toBeNull()
  })
  it('keeps command-only input distinguishable from missing commands', () => {
    expect(matchVoiceCommand('指令提醒。', enabled)).toEqual({ mode: 'reminder', text: '' })
    expect(matchVoiceCommand('指令提醒，20分钟后提醒我说指令翻译', enabled)?.text).toBe('20分钟后提醒我说指令翻译')
    expect(matchVoiceCommand('指令问答新闻', DEFAULT_VOICE_COMMANDS)).toBeNull()
  })
  it('supports literal custom phrases and detects cross-mode duplicates', () => {
    const settings = structuredClone(enabled)
    settings.keywords.ask = ['助手问问', 'hello assistant']
    expect(matchVoiceCommand('助手问问：世界有多大', settings)).toEqual({ mode: 'ask', text: '世界有多大' })
    expect(matchVoiceCommand('指令问答：你好', settings)).toBeNull()
    expect(voiceCommandConflict('notes', ['HELLO ASSISTANT'], settings)).toBe(true)
    settings.keywords.notes = ['hello assistant']
    expect(matchVoiceCommand('hello assistant, hello', settings)).toBeNull()
  })
  it('normalizes old settings, cleared modes and malformed saved values', () => {
    expect(mergeSettings({}).voiceCommands).toEqual(DEFAULT_VOICE_COMMANDS)
    const settings = normalizeVoiceCommands({ enabled: true, keywords: { ask: ['  你好助手 ', '', '，', '你好助手', 4], notes: [] } as never })
    expect(settings.keywords.ask).toEqual(['你好助手'])
    expect(settings.keywords.notes).toEqual([])
    expect(settings.keywords.reminder).toEqual(DEFAULT_VOICE_COMMANDS.keywords.reminder)
    settings.keywords.reminder.length = 0
    expect(DEFAULT_VOICE_COMMANDS.keywords.reminder).toHaveLength(2)
  })
})
