import { expect, it } from 'vitest'
import { cleanPolishedText } from './polish'

it('removes model-only reasoning, output labels, replacement glyphs and exact duplicated requirements', () => {
  const source = '修复任务栏图标，保留现有功能。不要增加额外功能。'
  expect(cleanPolishedText('<think>分析如何修改</think>\n以下是润色后的文本：\n修复任务栏图标，保留现有功能。\n不要增加额外功能。\n修复任务栏图标，保留现有功能。\uFFFD', source))
    .toBe('修复任务栏图标，保留现有功能。\n不要增加额外功能。')
})
it('preserves deliberate repetition, code, identifiers, comments, names and meaningful single characters', () => {
  expect(cleanPolishedText('测试。测试。', '把测试写两遍。')).toBe('测试。测试。')
  const code = '```js\nconsole.log("test");\nconsole.log("test");\n```'
  expect(cleanPolishedText(code, code)).toBe(code)
  const source = '版本 1.0.0-rc.12，端口 8080，getUserById。请重复两遍。'
  const output = '版本 1.0.0-rc.12，端口 8080，getUserById。版本 1.0.0-rc.12，端口 8080，getUserById。'
  expect(cleanPolishedText(output, source)).toBe(output)
  expect(cleanPolishedText('语 YU 支持 A 股查询。', '语 YU 支持 A 股查询。')).toBe('语 YU 支持 A 股查询。')
})
