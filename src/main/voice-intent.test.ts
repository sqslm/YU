import { describe, expect, it } from 'vitest'
import { directVoiceIntent, parseVoiceIntent, isCurrentWindowQuestion, needsAssistantContext, screenshotNeedsEditor } from './voice-intent'

describe('unified voice decisions', () => {
  it.each(['暂停朗读','继续朗读','把朗读音量调到40','查看我的CPU型号','跨屏截图','把选中文字先润色给我看','把刚才润色结果替换回原选区','我今天下载了哪些文件','查我最近打开的文件','这次用的是哪个提示词卡片？','哪些随记同步失败'])('routes the completed entry capability to real assistant tools: %s',text=>{
    expect(directVoiceIntent(text)).toEqual({kind:'assistant'})
  })
  it('keeps generic CPU questions and dictated development requirements out of system actions',()=>{
    expect(directVoiceIntent('什么是CPU？')).not.toEqual({kind:'assistant'})
    expect(directVoiceIntent('帮我开发一个查询电脑CPU的功能')).toEqual({kind:'dictation'})
  })
  it.each(['把我框选区域里的文字提取出来。', '我想让你分析这张截图，但先给我看一下准备发送的内容。'])('keeps region and upload-preview requests in the local editor first: %s', text => {
    expect(screenshotNeedsEditor(text)).toBe(true)
    expect(directVoiceIntent(text)).toEqual({ kind: 'assistant' })
  })
  it('answers development advice without executing or dictating the feature request', () => {
    expect(directVoiceIntent('我想让软件能自动打开应用，这个功能应该怎么开发？')).toEqual({ kind: 'ask' })
  })
  it('saves an explicitly requested offline note without requiring the intent model', () => {
    expect(directVoiceIntent('断网了，帮我记一下，明天检查网络设备。')).toMatchObject({ kind: 'notes', text: '明天检查网络设备。' })
  })
  it.each(['总结一下我刚刚复制到剪贴板里的这段文字。', 'Explain the text I copied to the clipboard'])('reads an explicitly requested clipboard through tools before answering: %s', text => {
    expect(directVoiceIntent(text)).toEqual({ kind: 'assistant' })
  })
  it.each(['明天下午三点到四点有个项目讨论。', '后天上午十点到十一点开项目会议。'])('routes a concrete calendar time range to the calendar rather than dictation: %s', text => {
    expect(directVoiceIntent(text)).toEqual({ kind: 'assistant' })
  })
  it.each(['呃，我想记一下，那个，做个能自动整理下载文件的小功能。', '帮我记一下，今天完成了软件测试。', '我想到一种新的提醒软件设计，帮我记下来。'])('recognizes note intent without turning mentioned features into actions: %s', text => {
    expect(directVoiceIntent(text)?.kind).toBe('notes')
  })
  it.each(['这是什么窗口？', '我在什么窗口？', '告诉我当前是什么应用', '现在用的什么软件？', 'What app am I using?', 'Which window is active?', 'What is this window?'])('uses the new task window without conversational context: %s', text => {
    expect(isCurrentWindowQuestion(text)).toBe(true)
    expect(directVoiceIntent(text)).toEqual({ kind: 'assistant' })
    expect(needsAssistantContext(text)).toBe(false)
  })
  it.each(['What app should I use for screenshots?', '为什么这个应用关闭了？', '刚才是什么窗口？', '给 Agent 写提示词：识别当前是什么窗口。'])('does not mistake advice, old references or dictation for current-window identification: %s', text => {
    expect(isCurrentWindowQuestion(text)).toBe(false)
  })
  it.each(['打开第二个', '把刚才的答案存到随记', '那我要怎么解决？', '为什么？', '那明天呢？', '再详细一点', 'Why?', 'Tell me more', 'Explain that answer', 'Open the second one', 'Copy it', 'How do I fix it?'])('retains real follow-up context: %s', text => expect(needsAssistantContext(text)).toBe(true))
  it.each(['How long does it take to boil an egg?', 'What is the weather in London?', '今天有什么 AI 新闻？'])('does not attach unrelated prior data to a self-contained question: %s', text => expect(needsAssistantContext(text)).toBe(false))
  it('carries the existing intent model context decision without another classification request', () => {
    expect(parseVoiceIntent('{"kind":"assistant","useContext":true}', '再详细一点')).toEqual({ kind: 'assistant', useContext: true })
    expect(parseVoiceIntent('{"kind":"assistant","useContext":false}', '打开飞书')).toEqual({ kind: 'assistant', useContext: false })
  })
  it.each(['明天提醒我上午十点去银行办一张银行卡。', '20分钟后提醒我打扫卫生，强提醒。', '二十分钟后提醒我喝水，不对，半小时后。', 'Remind me to call Sam in twenty minutes.'])('keeps the complete original reminder: %s', text => {
    expect(directVoiceIntent(text)).toEqual({ kind: 'reminder' })
  })
  it.each(['给 Agent 写提示词：帮我打开下载目录，然后创建提醒。', '请帮我实现一个功能，每天提醒用户开会。', '“打开 VS Code”，把这句写在需求里。', 'Write a prompt for Codex: open the folder, then create a note.'])('protects dictated requirements and quotations: %s', text => {
    expect(directVoiceIntent(text)).toEqual({ kind: 'dictation' })
  })
  it.each(['明天提醒我开会，然后打开下载目录', 'Remind me in ten minutes and then open downloads'])('does not drop another operation from a multi-step request: %s', text => {
    expect(directVoiceIntent(text)).toBeNull()
  })
  it.each(['帮我给这条随记分类到工作', '把上一条随记重命名为发布计划', 'Rename the latest note to Release plan', 'Categorize this note as Work'])('routes note organization to actual assistant tools: %s', text => {
    expect(directVoiceIntent(text)).toEqual({ kind: 'assistant' })
  })
  it('extracts only explicitly supplied note text', () => {
    expect(directVoiceIntent('帮我保存到随记：今天的灵感。')).toEqual({ kind: 'notes', text: '今天的灵感。' })
    expect(directVoiceIntent('Take a note: My idea.')).toEqual({ kind: 'notes', text: 'My idea.' })
  })
  it('keeps normal Ask and arbitrary supported assistant requests available to the model', () => {
    for (const kind of ['ask', 'assistant', 'dictation', 'reminder']) expect(parseVoiceIntent(JSON.stringify({ kind }), 'Remind me in ten minutes')).toEqual({ kind })
  })
  it.each(['我明天得把旧文件整理一下。', 'Tomorrow afternoon I have a meeting.'])('does not let a date alone authorize a reminder: %s', text => {
    expect(parseVoiceIntent('{"kind":"reminder"}', text)).toEqual({ kind: 'dictation' })
  })
  it('retains the actual supplied note when classification rewrites fillers or punctuation', () => {
    const input = '呃，帮我记一下。我想做一个功能，就是，嗯，整理文件。'
    expect(parseVoiceIntent('{"kind":"notes","text":"我想做一个整理文件的功能。"}', input)).toEqual({ kind: 'notes', text: input })
  })
  it('does not substitute a reminder or note for an unavailable assistant capability', () => {
    expect(directVoiceIntent('记住，以后写开发提示词尽量简洁。')).toEqual({ kind: 'assistant' })
    expect(directVoiceIntent('Remember that I prefer short prompts.')).toEqual({ kind: 'assistant' })
    expect(parseVoiceIntent('{"kind":"reminder"}', '每天早上给我一份任务简报。')).toEqual({ kind: 'assistant' })
    expect(parseVoiceIntent('{"kind":"reminder"}', 'Schedule a meeting tomorrow afternoon.')).toEqual({ kind: 'assistant' })
  })
  it('resolves a reminder referring to a prior task through the existing assistant instead of creating a generic new task', () => {
    expect(directVoiceIntent('明天十点提醒我做这件事，强提醒。')).toEqual({ kind: 'assistant' })
    expect(directVoiceIntent('Remind me about that in twenty minutes.')).toEqual({ kind: 'assistant' })
  })
  it.each(['把明天取东西的提醒改成下午两点。', '刚才那个强提醒改成普通提醒。', '再改成强提醒。', '算了，这个提醒不要了。', 'Cancel the bank reminder.', 'Update that task to 2 PM.'])('never creates a second task for an existing-task edit: %s', text => {
    expect(directVoiceIntent(text)).toEqual({ kind: 'assistant' })
  })
  it('keeps a real answer available for a voice follow-up without assuming unrelated speech refers to it', () => {
    expect(directVoiceIntent('那我要怎么解决？', true)).toEqual({ kind: 'assistant' })
    expect(directVoiceIntent('So how do I fix that?', true)).toEqual({ kind: 'assistant' })
    expect(directVoiceIntent('那我要怎么解决？', false)).toBeNull()
    expect(directVoiceIntent('今天晚上吃烧烤。', true)).toBeNull()
  })
  it.each(['我想让我的软件支持自动打开程序，你觉得怎么实现？', 'How would you implement support for opening applications?'])('answers an explicit request for advice instead of dictating or executing it: %s', text => {
    expect(directVoiceIntent(text)).toEqual({ kind: 'ask' })
  })
  it('accepts a supplied translation passage and explicit per-take target', () => {
    expect(parseVoiceIntent('{"kind":"translate","text":"今天一起吃烧烤吧。","target":"en"}', '帮我翻译成英语，今天一起吃烧烤吧。'))
      .toEqual({ kind: 'translate', text: '今天一起吃烧烤吧。', target: 'en' })
    expect(parseVoiceIntent('{"kind":"selection","operation":"translate","target":"zh"}', 'Translate my selection into Chinese'))
      .toEqual({ kind: 'selection', operation: 'translate', target: 'zh' })
  })
  it('keeps read-only selection questions out of the editing branch and reads a referenced translation source', () => {
    expect(directVoiceIntent('帮我解释一下选中的这段代码。')).toEqual({ kind: 'ask' })
    expect(parseVoiceIntent('{"kind":"dictation"}', 'Explain the selected code')).toEqual({ kind: 'ask' })
    expect(parseVoiceIntent('{"kind":"selection","operation":"polish"}', '帮我解释一下选中的这段代码。')).toEqual({ kind: 'ask' })
    expect(parseVoiceIntent('{"kind":"selection","operation":"explain"}', 'Explain the selected code')).toEqual({ kind: 'ask' })
    expect(parseVoiceIntent('{"kind":"translate","text":null,"target":"zh"}', '这段英文是什么意思，翻译成中文。'))
      .toEqual({ kind: 'selection', operation: 'translate', target: 'zh' })
    expect(() => parseVoiceIntent('{"kind":"translate","text":null,"target":"run script"}', 'Translate this text')).toThrow()
  })
  it.each(['{"kind":"shell"}', '{"kind":"translate","text":"invented"}', '{"kind":"translate","text":"input","target":"English; exec"}', '{"kind":"selection","operation":"delete"}', 'not json', 'null'])('rejects invalid or invented model output: %s', raw => {
    expect(() => parseVoiceIntent(raw, 'input')).toThrow()
  })
  it('leaves note references to the existing assistant session instead of saving an empty note', () => {
    expect(parseVoiceIntent('{"kind":"notes","text":null}', '把刚才的内容存到随记')).toEqual({ kind: 'assistant' })
  })
})
