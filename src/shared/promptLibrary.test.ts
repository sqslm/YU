import { describe, expect, it } from 'vitest'
import {
  BUILTIN_PROMPT_ID,
  activePrompt,
  builtinPrompt,
  builtinPromptText,
  defaultPromptLibrary,
  isBuiltinPromptCustomized,
  matchAppRule,
  newPromptId,
  normalizePromptLibrary,
  pickPromptKind
} from './promptLibrary'
import { PROMPT_KINDS } from './promptLibrary'
import shippedTexts from './builtin-prompts.json'

describe('defaultPromptLibrary', () => {
  it('gives every kind exactly one builtin card and selects it', () => {
    const library = defaultPromptLibrary()
    for (const kind of PROMPT_KINDS) {
      expect(library.cards[kind]).toHaveLength(1)
      expect(library.cards[kind][0].builtin).toBe(true)
      expect(library.active[kind]).toBe(BUILTIN_PROMPT_ID)
    }
    expect(PROMPT_KINDS).toEqual(['ai', 'polish', 'translate', 'document', 'email'])
  })
})

describe('normalizePromptLibrary', () => {
  it('falls back to defaults for junk input', () => {
    const library = normalizePromptLibrary('nonsense')
    expect(library.cards.polish[0].id).toBe(BUILTIN_PROMPT_ID)
    expect(library.active.email).toBe(BUILTIN_PROMPT_ID)
  })

  it('keeps a per-card temperature and clamps it to 0–1.5', () => {
    const library = normalizePromptLibrary({
      cards: {
        ...defaultPromptLibrary().cards,
        polish: [
          { id: 'warm', name: '温度卡', content: 'x', temperature: 0.35 },
          { id: 'hot', name: '过高', content: 'x', temperature: 9 },
          { id: 'cold', name: '负数', content: 'x', temperature: -2 },
          { id: 'junk', name: '脏值', content: 'x', temperature: 'high' }
        ]
      },
      active: { polish: 'warm' }
    })
    const byId = new Map(library.cards.polish.map((card) => [card.id, card]))
    expect(byId.get('warm')?.temperature).toBe(0.35)
    expect(byId.get('hot')?.temperature).toBe(1.5)
    expect(byId.get('cold')?.temperature).toBe(0)
    // A non-numeric value means "inherit the global temperature", not zero.
    expect(byId.get('junk')?.temperature).toBeUndefined()
  })


  it('keeps user cards and drops duplicate ids without re-adding the builtin', () => {
    const library = normalizePromptLibrary({
      cards: {
        ...defaultPromptLibrary().cards,
        email: [
          { id: 'a', name: '正式邮件', content: '语气正式' },
          { id: 'a', name: '重复', content: 'x' }
        ]
      },
      active: { email: 'a' }
    })
    // The stored list no longer holds a builtin card: that is a deletion the
    // user made, so normalising must not resurrect it.
    expect(library.cards.email.map((card) => card.id)).toEqual(['a'])
    expect(library.active.email).toBe('a')
  })

  it('keeps an emptied card list empty and clears the dangling active id', () => {
    const library = normalizePromptLibrary({
      cards: { ...defaultPromptLibrary().cards, polish: [] },
      active: { polish: 'ghost' }
    })
    expect(library.cards.polish).toHaveLength(0)
    expect(library.active.polish).toBe('')
  })

  it('starts from the shipped builtin card when a kind has no list at all', () => {
    const library = normalizePromptLibrary({ cards: { ...defaultPromptLibrary().cards, email: undefined } })
    expect(library.cards.email).toHaveLength(1)
    expect(library.cards.email[0].id).toBe(BUILTIN_PROMPT_ID)
    expect(library.cards.email[0].content).toBe(builtinPrompt('email').content)
    expect(library.active.email).toBe(BUILTIN_PROMPT_ID)
  })

  it('names an unnamed card instead of storing an empty label', () => {
    const library = normalizePromptLibrary({
      cards: { ...defaultPromptLibrary().cards, document: [{ id: 'd', name: '   ', content: 'x' }] }
    })
    expect(library.cards.document).toHaveLength(1)
    expect(library.cards.document[0].name).toBe('未命名提示词')
  })
})

describe('activePrompt', () => {
  it('returns the selected card', () => {
    const library = defaultPromptLibrary()
    library.cards.polish.push({ id: 'p1', name: '短句', content: '精简' })
    library.active.polish = 'p1'
    expect(activePrompt(library, 'polish').content).toBe('精简')
  })

  it('falls back to the builtin card when the id is unknown', () => {
    const library = defaultPromptLibrary()
    library.active.polish = 'missing'
    expect(activePrompt(library, 'polish').builtin).toBe(true)
  })

  it('falls back to the shipped text when the builtin card was deleted', () => {
    const library = normalizePromptLibrary({
      cards: { ...defaultPromptLibrary().cards, polish: [] },
      active: { polish: BUILTIN_PROMPT_ID }
    })
    const card = activePrompt(library, 'polish')
    expect(card.builtin).toBe(true)
    expect(card.content).toBe(builtinPromptText('polish'))
    expect(card.content.trim().length).toBeGreaterThan(0)
  })
})

describe('editing and deleting the builtin card', () => {
  it('keeps a user rewrite of the builtin card through normalisation', () => {
    const base = defaultPromptLibrary()
    const rewritten = '只输出结果，去掉口头语，保留原意。'
    const library = normalizePromptLibrary({
      cards: {
        ...base.cards,
        polish: [{ ...base.cards.polish[0], name: '我的润色', content: rewritten }]
      },
      active: { polish: BUILTIN_PROMPT_ID }
    })
    expect(library.cards.polish).toHaveLength(1)
    expect(library.cards.polish[0]).toEqual({
      id: BUILTIN_PROMPT_ID,
      name: '我的润色',
      content: rewritten,
      builtin: true
    })
    // activePrompt must hand the rewrite to the pipeline, not the factory text.
    expect(activePrompt(library, 'polish').content).toBe(rewritten)
  })

  it('does not overwrite a blanked builtin card with the shipped text', () => {
    const base = defaultPromptLibrary()
    const library = normalizePromptLibrary({
      cards: { ...base.cards, document: [{ ...base.cards.document[0], content: '' }] }
    })
    expect(library.cards.document[0].content).toBe('')
  })

  it('keeps a surviving custom card active after the builtin is deleted', () => {
    const library = normalizePromptLibrary({
      cards: {
        ...defaultPromptLibrary().cards,
        polish: [{ id: 'mine', name: '我的', content: 'x' }]
      },
      active: { polish: 'mine' }
    })
    expect(library.cards.polish.map((card) => card.id)).toEqual(['mine'])
    expect(activePrompt(library, 'polish').id).toBe('mine')
  })

  it('reports customisation for builtin cards only', () => {
    const card = builtinPrompt('email')
    expect(isBuiltinPromptCustomized('email', card)).toBe(false)
    expect(isBuiltinPromptCustomized('email', { ...card, content: '改写过的' })).toBe(true)
    expect(isBuiltinPromptCustomized('email', { ...card, content: '' })).toBe(false)
    expect(isBuiltinPromptCustomized('email', { id: 'x', name: 'x', content: '改写过的' })).toBe(
      false
    )
    expect(isBuiltinPromptCustomized('email', null)).toBe(false)
  })
})

describe('builtinPrompt text', () => {
  it('ships all five supplied prompt documents without truncation', () => {
    const texts = PROMPT_KINDS.map((kind) => builtinPrompt(kind).content)
    expect(new Set(texts).size).toBe(PROMPT_KINDS.length)
    for (const text of texts) {
      expect(text.trim().length).toBeGreaterThan(80)
      // The output contract is the whole point of these prompts.
      const lines = text.split('\n').filter((line) => line.trim())
      expect(lines.length).toBeGreaterThanOrEqual(5)
      expect(lines.length).toBeGreaterThan(100)
    }
    for (const kind of PROMPT_KINDS) expect(builtinPromptText(kind)).toBe(shippedTexts[kind])
    expect(PROMPT_KINDS.map(kind => builtinPrompt(kind).name)).toEqual(['内置协作', '内置润色', '内置翻译', '内置文档', '内置邮件'])
  })

  it('keeps builtinPrompt and builtinPromptText in sync', () => {
    for (const kind of PROMPT_KINDS) {
      expect(builtinPrompt(kind).content).toBe(builtinPromptText(kind))
      expect(builtinPrompt(kind).builtin).toBe(true)
      expect(builtinPrompt(kind).id).toBe(BUILTIN_PROMPT_ID)
    }
  })
})

describe('pickPromptKind', () => {
  it('routes mail clients to the email prompt', () => {
    expect(pickPromptKind('outlook.exe', '收件箱 - Outlook')).toBe('email')
    expect(pickPromptKind('chrome.exe', 'Gmail - 撰写邮件')).toBe('email')
  })

  it('routes editors to the document prompt', () => {
    expect(pickPromptKind('WINWORD.EXE', '文档1 - Word')).toBe('document')
    expect(pickPromptKind('chrome.exe', '设计稿 - Notion')).toBe('document')
  })

  it('keeps chat and search boxes on plain polish', () => {
    expect(pickPromptKind('chrome.exe', 'ChatGPT')).toBe('polish')
    expect(pickPromptKind('Code.exe', 'index.ts - Visual Studio Code')).toBe('polish')
  })

  it('keeps WeChat on the plain polish card', () => {
    expect(pickPromptKind('WeChat.exe', '微信')).toBe('polish')
    expect(pickPromptKind('Weixin.exe', '文件传输助手')).toBe('polish')
  })

  it('routes AI coding tools to the AI prompt', () => {
    expect(pickPromptKind('codex.exe', 'Codex')).toBe('ai')
    expect(pickPromptKind('WindowsTerminal.exe', 'Claude Code')).toBe('ai')
    expect(pickPromptKind('opencode.exe', 'opencode — zsh')).toBe('ai')
    expect(pickPromptKind('Cursor.exe', 'app.ts — Cursor')).toBe('ai')
  })

  it('prefers AI over document when an editor hosts a coding agent', () => {
    // Codex running inside VS Code: "Code" alone is not an AI hint, but the
    // window title is, and the AI card has to win over document/editor rules.
    expect(pickPromptKind('Code.exe', 'Codex — workspace')).toBe('ai')
  })
})

describe('newPromptId', () => {
  it('never collides with an existing card', () => {
    const cards = [builtinPrompt('polish'), { id: 'polish-x-0', name: 'x', content: '' }]
    const id = newPromptId('polish', cards)
    expect(cards.some((card) => card.id === id)).toBe(false)
  })
})

describe('matchAppRule site rules', () => {
  const rules = [
    { id: 'a', match: 'chrome', kind: 'polish' as const },
    { id: 'b', match: '', domain: 'github.com', kind: 'ai' as const },
    { id: 'c', match: 'notepad', kind: 'document' as const }
  ]

  it('prefers a domain rule over a text rule that also matches', () => {
    expect(matchAppRule(rules, 'chrome.exe', 'PR #12 · github.com')?.id).toBe('b')
  })

  it('matches subdomains through the rule domain', () => {
    expect(matchAppRule(rules, 'chrome.exe', 'Inbox — mail.github.com')?.id).toBe('b')
  })

  it('falls back to text matching when the title carries no domain', () => {
    expect(matchAppRule(rules, 'chrome.exe', '新标签页 - Google Chrome')?.id).toBe('a')
    expect(matchAppRule(rules, 'notepad.exe', '未命名 - 记事本')?.id).toBe('c')
  })

  it('ignores domain rules for unrelated sites', () => {
    expect(matchAppRule(rules, 'chrome.exe', 'Issues — gitlab.com')?.id).toBe('a')
  })

  it('returns null when nothing matches', () => {
    expect(matchAppRule(rules, 'explorer.exe', 'Downloads')).toBeNull()
    expect(matchAppRule(undefined, 'chrome.exe', 'github.com')).toBeNull()
  })
})
