import { describe, expect, it } from 'vitest'
import { directVoiceIntent, parseVoiceIntent } from './voice-intent'

describe('unified voice decisions', () => {
  it.each(['明天提醒我上午十点去银行办一张银行卡。', '20分钟后提醒我打扫卫生，强提醒。', 'Remind me to call Sam in twenty minutes.'])('keeps the complete original reminder: %s', text => {
    expect(directVoiceIntent(text)).toEqual({ kind: 'reminder' })
  })
  it.each(['给 Agent 写提示词：帮我打开下载目录，然后创建提醒。', '请帮我实现一个功能，每天提醒用户开会。', '“打开 VS Code”，把这句写在需求里。', 'Write a prompt for Codex: open the folder, then create a note.'])('protects dictated requirements and quotations: %s', text => {
    expect(directVoiceIntent(text)).toEqual({ kind: 'dictation' })
  })
  it.each(['明天提醒我开会，然后打开下载目录', 'Remind me in ten minutes and then open downloads'])('does not drop another operation from a multi-step request: %s', text => {
    expect(directVoiceIntent(text)).toBeNull()
  })
  it('extracts only explicitly supplied note text', () => {
    expect(directVoiceIntent('帮我保存到随记：今天的灵感。')).toEqual({ kind: 'notes', text: '今天的灵感。' })
    expect(directVoiceIntent('Take a note: My idea.')).toEqual({ kind: 'notes', text: 'My idea.' })
  })
  it('keeps normal Ask and arbitrary supported assistant requests available to the model', () => {
    for (const kind of ['ask', 'assistant', 'dictation', 'reminder']) expect(parseVoiceIntent(JSON.stringify({ kind }), 'input')).toEqual({ kind })
  })
  it('accepts a supplied translation passage and explicit per-take target', () => {
    expect(parseVoiceIntent('{"kind":"translate","text":"今天一起吃烧烤吧。","target":"en"}', '帮我翻译成英语，今天一起吃烧烤吧。'))
      .toEqual({ kind: 'translate', text: '今天一起吃烧烤吧。', target: 'en' })
    expect(parseVoiceIntent('{"kind":"selection","operation":"translate","target":"zh"}', 'Translate my selection into Chinese'))
      .toEqual({ kind: 'selection', operation: 'translate', target: 'zh' })
  })
  it.each(['{"kind":"shell"}', '{"kind":"translate","text":"invented"}', '{"kind":"translate","text":"input","target":"English; exec"}', '{"kind":"selection","operation":"delete"}', 'not json', 'null'])('rejects invalid or invented model output: %s', raw => {
    expect(() => parseVoiceIntent(raw, 'input')).toThrow()
  })
  it('leaves note references to the existing assistant session instead of saving an empty note', () => {
    expect(parseVoiceIntent('{"kind":"notes","text":null}', '把刚才的内容存到随记')).toEqual({ kind: 'assistant' })
  })
})
