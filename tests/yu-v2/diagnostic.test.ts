import { it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveReminderTime } from '../../src/main/reminder-time'
import { screenshotNeedsEditor } from '../../src/main/voice-intent'
import { personalCommand } from '../../src/main/tools/personal'
import { WindowsTools } from '../../src/main/tools/windows'

// Supplemental source-level probes, separate from the 150 acceptance results.
// No network, desktop, account data or long-term memory is accessed here.
it('records parser variants and routing boundaries without changing product rules', () => {
  const now = Date.parse('2026-10-26T16:00:00+08:00')
  const expressions = [
    '每个月一号晚上八点', '每月1号晚上八点',
    '从下周二开始，每两周上午九点', '每两周周二上午九点',
    '每天晚上十点，一直到这个月底', '每天晚上十点，直到2026-10-31',
    '按纽约时间明天上午九点', '明天上午九点'
  ]
  const tools = new WindowsTools({
    folders: { downloads: '', desktop: '', documents: '' },
    native: async () => { throw Error('Native access forbidden in parser probe') },
    openPath: async () => { throw Error('Opening forbidden in parser probe') },
    openUrl: async () => { throw Error('Opening forbidden in parser probe') }
  })
  const originals = JSON.parse(readFileSync('tests/yu-v2/YU_V2_150_cases.json', 'utf8')).cases
  const screenshotInputs = [originals[139].utterance,
    '先让我确认要发给AI的图片，再分析截图。',
    '分析屏幕前请让我确认图片。', '先预览截图，再发给模型。']
  const routeInputs = ['打开我最近的一条随记。', '打开最近保存的笔记。',
    '帮我打开E盘的A I文件夹', '帮我打开E盘的 E盘的AI文件夹',
    '帮我打开E盘的software文件夹', '帮我打开E盘的softwares文件夹']
  const data = {
    scope: 'Supplemental parser/command probes; no real speech or GUI assertion.',
    fixed_clock: new Date(now).toISOString(),
    reminder_expressions: expressions.map(input => ({ input, result: resolveReminderTime(input, now) })),
    screenshot_preview: screenshotInputs.map(input => ({ input, opensEditor: screenshotNeedsEditor(input) })),
    command_routes: routeInputs.map(input => ({ input, result: personalCommand(input) ?? tools.command(input) })),
    new_york_reference: ['2026-01-27T14:00:00Z', '2026-07-27T13:00:00Z'].map(instant => ({ instant,
      wall_clock: new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', dateStyle: 'short', timeStyle: 'short' }).format(new Date(instant)) }))
  }
  mkdirSync('tests/yu-v2/evidence', { recursive: true })
  writeFileSync(join('tests/yu-v2/evidence', 'parser-diagnostics.json'), JSON.stringify(data, null, 2) + '\n')
  expect(data.reminder_expressions).toHaveLength(expressions.length)
  expect(data.screenshot_preview[0].input).toBe(originals[139].utterance)
})
