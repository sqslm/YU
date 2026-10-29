import { expect, it } from 'vitest'
import { cursorGeneration, cursorGenerationPrompt, cursorNeedsResearch } from './cursor-generation'
import { directVoiceIntent } from './voice-intent'
it('keeps screenshot development requirements in dictation', () => {
  expect(directVoiceIntent('截屏时使用框选、拉线条这类工具，鼠标只是点一下，不要直接往上面吸附上去，只有确实存在拖动时才产生对应内容。')).toEqual({ kind: 'dictation' })
  expect(directVoiceIntent('优化截图工具的双击完成逻辑。')).toEqual({ kind: 'dictation' })
})
it('routes only an explicit cursor insertion request to generation', () => {
  const text = '帮我在光标处插入一段冒泡排序带注释'
  expect(cursorGeneration(text)).toBe('一段冒泡排序带注释')
  expect(directVoiceIntent(text)).toEqual({ kind: 'dictation' })
  for (const value of ['帮我写一个冒泡排序', '他让我在光标处插入代码', '提醒我在光标处插入代码']) expect(cursorGeneration(value)).toBeNull()
})
it('uses file metadata only for code requests', () => {
  expect(cursorGenerationPrompt('冒泡排序带注释', 'example.py - Visual Studio Code')).toContain('example.py')
  expect(cursorGenerationPrompt('一段祝福文字', 'private.py')).not.toContain('private.py')
})
it('researches live facts but keeps ordinary prose, code and fictional examples on direct generation', () => {
  for (const request of ['今日国内外AI新闻', '联网查询最新天气', 'the latest AI news']) expect(cursorNeedsResearch(request)).toBe(true)
  for (const request of ['一段冒泡排序带注释', '一段祝福文字', '虚构的新闻示例']) expect(cursorNeedsResearch(request)).toBe(false)
  expect(cursorGenerationPrompt('今日AI新闻', '', true)).not.toContain('Never execute code or use tools')
  expect(cursorGenerationPrompt('今日AI新闻', '', true)).toContain('read-only web research')
})
