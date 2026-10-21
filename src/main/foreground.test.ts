import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { resolvePromptKind } from '@shared/promptLibrary'
import type { AppRule, PromptKind, Settings } from '@shared/types'
import {
  classifyWindow,
  classifyWindows,
  routingSource,
  type RoutingInput,
  type VisibleWindow
} from './foreground'

/**
 * Only the pure routing helpers are covered here. `foreground.ts` also owns the
 * Win32 enumeration, but that needs a real window stack; the koffi bindings are
 * created lazily precisely so this file can import the module in plain Node.
 */

function windowOf(appName: string, title: string, pid = 4242): VisibleWindow {
  return { title, appName, pid, className: 'Chrome_WidgetWin_1', handle: 'ff' }
}

function rule(match: string, kind: PromptKind, extra: Partial<AppRule> = {}): AppRule {
  return { id: `rule-${match}`, match, kind, ...extra }
}

const AUTOMATIC: RoutingInput = { autoActivatePrompts: true, mainPromptKind: 'polish', appRules: [] }

function settingsWith(input: RoutingInput): Settings {
  return {
    ...DEFAULT_SETTINGS,
    autoActivatePrompts: input.autoActivatePrompts ?? true,
    mainPromptKind: input.mainPromptKind ?? 'polish',
    appRules: [...(input.appRules ?? [])]
  }
}

/** The pure classifier must agree with the pipeline's own resolver, always. */
function expectAgreesWithPipeline(
  window: VisibleWindow,
  input: RoutingInput,
  expectedKind: PromptKind
): void {
  const routed = classifyWindow(window, input)
  expect(routed.matchedKind).toBe(expectedKind)
  expect(resolvePromptKind(settingsWith(input), window.appName, window.title)).toBe(
    routed.matchedKind
  )
}

describe('routingSource', () => {
  it('reports a concrete hint hit as heuristic', () => {
    expect(routingSource('ai', 'Cursor', 'project — Cursor')).toBe('heuristic')
    expect(routingSource('document', 'winword', 'report.docx')).toBe('heuristic')
    expect(routingSource('email', 'thunderbird', 'inbox')).toBe('heuristic')
  })

  it('separates a chat-bucket polish from an unrecognised polish', () => {
    // Chat hints resolve to polish, so polish alone cannot mean "fallback".
    expect(routingSource('polish', 'WeChat', '微信')).toBe('heuristic')
    // Nothing in the built-in table knows this app.
    expect(routingSource('polish', 'dsh', 'DeepSeek Harness')).toBe('fallback')
  })
})

describe('classifyWindow — routing order', () => {
  it('lets a manual rule override the built-in table', () => {
    // Cursor is a strong built-in AI hint; the rule still wins.
    const input: RoutingInput = { ...AUTOMATIC, appRules: [rule('cursor', 'document')] }
    const routed = classifyWindow(windowOf('Cursor', 'project — Cursor'), input)
    expect(routed).toMatchObject({
      matchedKind: 'document',
      matchedBy: 'rule',
      matchedRuleId: 'rule-cursor',
      pinned: false
    })
    expectAgreesWithPipeline(windowOf('Cursor', 'project — Cursor'), input, 'document')
  })

  it('routes the DSH window to AI once a process-name rule exists', () => {
    const window = windowOf('dsh', 'DeepSeek Harness')
    // Before the fix, nobody recognises it: built-in table falls through to polish.
    const before = classifyWindow(window, AUTOMATIC)
    expect(before).toMatchObject({ matchedKind: 'polish', matchedBy: 'fallback' })

    const input: RoutingInput = { ...AUTOMATIC, appRules: [rule('dsh', 'ai')] }
    const after = classifyWindow(window, input)
    expect(after).toMatchObject({ matchedKind: 'ai', matchedBy: 'rule', pinned: false })
    expectAgreesWithPipeline(window, input, 'ai')
  })

  it('does not need the process name: the title is matched too', () => {
    const input: RoutingInput = { ...AUTOMATIC, appRules: [rule('harness', 'ai')] }
    const routed = classifyWindow(windowOf('electron', 'DeepSeek Harness — 对话'), input)
    expect(routed).toMatchObject({ matchedKind: 'ai', matchedBy: 'rule' })
    expectAgreesWithPipeline(windowOf('electron', 'DeepSeek Harness — 对话'), input, 'ai')
  })

  it('matches case-insensitively in both directions', () => {
    const input: RoutingInput = { ...AUTOMATIC, appRules: [rule('DEEPSEEK', 'ai')] }
    expect(classifyWindow(windowOf('dsh', 'deepseek harness'), input).matchedKind).toBe('ai')
    expect(classifyWindow(windowOf('DSH', 'DEEPSEEK HARNESS'), input).matchedKind).toBe('ai')
  })

  it('applies the first matching rule, in list order', () => {
    const input: RoutingInput = {
      ...AUTOMATIC,
      appRules: [rule('dsh', 'translate'), rule('harness', 'ai')]
    }
    const routed = classifyWindow(windowOf('dsh', 'DeepSeek Harness'), input)
    expect(routed.matchedKind).toBe('translate')
    expect(routed.matchedRuleId).toBe('rule-dsh')
  })

  it('ignores rules with an empty match', () => {
    const input: RoutingInput = { ...AUTOMATIC, appRules: [rule('   ', 'ai')] }
    expect(classifyWindow(windowOf('dsh', 'DeepSeek Harness'), input).matchedBy).toBe('fallback')
  })
})

describe('classifyWindow — built-in table', () => {
  it('recognises an AI editor without any rule', () => {
    const routed = classifyWindow(windowOf('Cursor', 'project — Cursor'), AUTOMATIC)
    expect(routed).toMatchObject({
      matchedKind: 'ai',
      matchedBy: 'heuristic',
      matchedRuleId: null,
      matchedRuleLabel: null
    })
  })

  it('recognises a chat app as polish and marks it as recognised', () => {
    const routed = classifyWindow(windowOf('WeChat', '微信'), AUTOMATIC)
    expect(routed).toMatchObject({ matchedKind: 'polish', matchedBy: 'heuristic' })
  })

  it('flags an unknown app as fallback polish', () => {
    const routed = classifyWindow(windowOf('someapp', 'Some Window'), AUTOMATIC)
    expect(routed).toMatchObject({ matchedKind: 'polish', matchedBy: 'fallback' })
  })

  it('surfaces the rule text as the label when the rule has no note', () => {
    const input: RoutingInput = { ...AUTOMATIC, appRules: [rule('dsh', 'ai')] }
    expect(classifyWindow(windowOf('dsh', 'DeepSeek Harness'), input).matchedRuleLabel).toBe('dsh')
    expect(
      classifyWindow(windowOf('dsh', 'DeepSeek Harness'), {
        ...AUTOMATIC,
        appRules: [rule('dsh', 'ai', { label: 'DeepSeek Harness 客户端' })]
      }).matchedRuleLabel
    ).toBe('DeepSeek Harness 客户端')
  })
})

describe('classifyWindow — auto activation off', () => {
  it('pins every window to the main kind and skips rules and hints', () => {
    const input: RoutingInput = {
      autoActivatePrompts: false,
      mainPromptKind: 'email',
      appRules: [rule('dsh', 'ai')]
    }
    const routed = classifyWindow(windowOf('dsh', 'DeepSeek Harness'), input)
    expect(routed).toMatchObject({
      matchedKind: 'email',
      pinned: true,
      matchedRuleId: null,
      matchedRuleLabel: null
    })
    expectAgreesWithPipeline(windowOf('dsh', 'DeepSeek Harness'), input, 'email')
  })
})

describe('classifyWindows', () => {
  it('classifies every window and keeps the source fields intact', () => {
    const windows = [
      windowOf('dsh', 'DeepSeek Harness', 10),
      windowOf('Cursor', 'project — Cursor', 20),
      windowOf('WeChat', '微信', 30)
    ]
    const routed = classifyWindows(windows, {
      ...AUTOMATIC,
      appRules: [rule('dsh', 'ai')]
    })
    expect(routed.map((w) => [w.appName, w.matchedKind, w.matchedBy])).toEqual([
      ['dsh', 'ai', 'rule'],
      ['Cursor', 'ai', 'heuristic'],
      ['WeChat', 'polish', 'heuristic']
    ])
    expect(routed.map((w) => w.pid)).toEqual([10, 20, 30])
    expect(routed.every((w) => w.className === 'Chrome_WidgetWin_1')).toBe(true)
  })
})
