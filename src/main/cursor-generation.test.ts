import { expect, it } from 'vitest'
import { cursorGeneration, cursorGenerationPrompt } from './cursor-generation'
import { directVoiceIntent } from './voice-intent'
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
