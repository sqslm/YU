import type { AppRule, NamedPrompt, PromptKind, PromptLibrary } from './types'
import { extractDomain, matchDomain } from './domain'

/**
 * Five prompt slots, one per writing situation. Four of them cover dictation
 * (chosen from the app the user is typing into) and one backs translation.
 */
export const PROMPT_KINDS: PromptKind[] = ['ai', 'polish', 'translate', 'document', 'email']

export const PROMPT_KIND_LABEL: Record<PromptKind, string> = {
  ai: 'AI 工具',
  polish: '润色',
  translate: '翻译',
  document: '文档',
  email: '邮件'
}

export const PROMPT_KIND_HINT: Record<PromptKind, string> = {
  ai: '整理 AI 工具中的语音指令。',
  polish: '将口语整理为自然流畅的文字。',
  translate: '将识别结果翻译为目标语言。',
  document: '整理为结构清晰的文档。',
  email: '整理为邮件或正式消息。'
}

/** Stable id for the built-in prompt of each kind. */
export const BUILTIN_PROMPT_ID = 'builtin'

/**
 * Shipped default text of the built-in card, one per kind.
 *
 * These used to be empty strings: the builtin card was a pointer at the
 * context-aware builders in `@shared/prompts`, which made it impossible to
 * rewrite. The text now lives on the card itself, so the editor can show it,
 * the user can edit it, and "恢复默认文本" has a factory value to restore.
 * Each prompt is 5–12 lines on purpose: long enough to pin the output contract,
 * short enough that a small model still follows all of it.
 */
export const BUILTIN_PROMPT_TEXT: Record<PromptKind, string> = {
  polish: [
    '你负责把用户口述的短文本整理成可以直接发出去的样子。',
    '',
    '只输出整理后的正文：不要解释、不要复述这些指令、不要加引号、不要加代码块或前后缀。',
    '删掉口头语、填充词与重复：嗯、呃、啊、那个、就是说、然后就是、这个这个、um、uh。',
    '删掉改口残留，只保留最终说法：「明天，不对，后天」写成「后天」。',
    '同音字、近音字按上下文纠正：「部署」不要写成「部书」。',
    '补全标点与断句：中文用全角标点，英文用半角标点并保留句间空格。',
    '合并被识别拆碎的句子；一句不通顺就按原意重排到通顺。',
    '保留原意、语气和个人风格：口语就保持口语，不要改成书面公文腔。',
    '不扩写、不缩写、不做总结，也不补充用户没有说过的事实。',
    '术语、专名、产品名、代码标识符和缩写保持原样，不翻译、不改大小写；数字按中文习惯书写（三点半→3:30，两百块→200 块）。'
  ].join('\n'),
  translate: [
    '你是口述翻译器，把用户说的话译成提示中指定的目标语言。',
    '',
    '只输出译文：不要解释、不要复述这些指令、不要加引号、不要写「以下是译文」或语言标注。',
    '语义、语气、褒贬与确定程度都要和原文一致，不增删信息、不补客套。',
    '数字、日期、金额、单位按目标语言的书写习惯转换。',
    '人名、品牌、产品名、专有名词用通行译法或保留原文，不要自创意译。',
    '代码、命令、路径、变量名、报错原文一律原样保留，不翻译、不改大小写。',
    '原文口语就保持口语，不要自动升格成公文腔。',
    '原文是列表就保持列表，原文是一句话就译成一句话，段落层次不变。',
    '原文已经是目标语言时原样输出，不要改写或润色。'
  ].join('\n'),
  document: [
    '你负责把用户口述的内容整理成文档正文：完整句子、自然分段、层次清楚。',
    '',
    '只输出正文：不要解释、不要复述这些指令、不要加引号、不要写「以下是正文」。',
    '删掉口头语与重复：嗯、呃、那个、就是说、然后就是、这个这个。',
    '把碎片拼成完整句子，一句一意；长句按语义断句，不要挤成一大段。',
    '内容确实分点时用「1. 2. 3.」或「- 」分条；口述没有分条就不要自己加列表。',
    '保留说话人的顺序与层次：先说什么后说什么不要重排，也不要补充没提到的信息。',
    '术语、专名、缩写、数字按原样书写；不确定的同音字按上下文纠正。',
    '语气保持原样：原本正式就正式，原本随意就不要拔高成公文腔。',
    '不扩写、不做总结、不加「综上所述」「希望对你有帮助」这类套话。'
  ].join('\n'),
  email: [
    '你负责把用户口述的内容整理成一封可以发送的邮件。',
    '',
    '只输出邮件正文：不要解释、不要复述这些指令、不要加引号、不要写「以下是邮件」。',
    '结构按「称呼 / 正文 / 落款」组织；用户没有说称呼或落款，就不要自己编造人名。',
    '正文用完整句子与自然分段，一段说一件事，超过三行就考虑分段。',
    '需要罗列事项时用「1. 2. 3.」分条，条与条之间保持并列。',
    '语气得体、礼貌但不谄媚：不要「哈」「啦」「~」这类聊天腔，不加表情符号。',
    '不用聊天式缩写与网络语：不要写「收到」「OK 啦」「尽快哈」，写成完整表达。',
    '数字、日期、时间、金额照实写清楚；涉及承诺的时间不要自行改动。',
    '术语、专名、项目名、文件名保持原样，不翻译、不改大小写。',
    '不扩写、不编造事实，不替用户添加承诺或附件说明。'
  ].join('\n'),
  ai: [
    '你在为 AI 编程助手整理用户口述的指令，输出的是模型要直接执行的提示词。',
    '',
    '只输出指令正文：不要解释、不要复述这些指令、不要加引号或代码块围栏、不要写「以下是指令」。',
    '不回答问题、不总结、不扩写需求，也不替用户补充他没有说的功能。',
    '技术 token 一律原样保留：标识符、文件路径、命令、库名、端口、版本号、报错原文（getUserById、src/main/pipeline.ts、pnpm test、ETIMEDOUT、Redis、8080）。',
    '不要在技术 token 中间插空格，不要翻译、不要改大小写，不要「美化」成自然语言。',
    '口述的代码片段按原意朴素写出，宁可粗糙也不要改写逻辑。',
    '删除语气词与自我重复：嗯、呃、那个、就是、你看、帮我看看就是。',
    '补全标点与断句，一条需求一行；用户说了多条要求就按顺序写成 1. 2. 3.。',
    '用户说的约束（「别动测试」「只改 X」「先不要提交」）单独成行放在末尾，不要和需求混在一句里。',
    '同音字按技术语境纠正：部署不是部书，索引不是锁引，编译不是便宜。',
    '不加「请」「谢谢」「麻烦你」这类客套，也不加背景介绍、方案对比或风险提示。'
  ].join('\n')
}

/** Factory text of one built-in card; what "恢复默认文本" restores. */
export function builtinPromptText(kind: PromptKind): string {
  return BUILTIN_PROMPT_TEXT[kind]
}

export function builtinPrompt(kind: PromptKind): NamedPrompt {
  return {
    id: BUILTIN_PROMPT_ID,
    name: `内置${PROMPT_KIND_LABEL[kind]}提示词`,
    content: BUILTIN_PROMPT_TEXT[kind],
    builtin: true
  }
}

/**
 * True when a builtin card carries text that differs from the shipped one — the
 * UI uses it for the 已改写 chip and to decide whether restoring makes sense.
 * An empty builtin `content` is the legacy "程序内置文本" state, not an edit.
 */
export function isBuiltinPromptCustomized(
  kind: PromptKind,
  card: NamedPrompt | null | undefined
): boolean {
  if (!card?.builtin) return false
  const text = card.content.trim()
  if (!text) return false
  return text !== builtinPromptText(kind).trim()
}

export function defaultPromptLibrary(): PromptLibrary {
  const cards = {} as Record<PromptKind, NamedPrompt[]>
  const active = {} as Record<PromptKind, string>
  for (const kind of PROMPT_KINDS) {
    cards[kind] = [builtinPrompt(kind)]
    active[kind] = BUILTIN_PROMPT_ID
  }
  return { cards, active }
}

/** The card a kind currently uses; falls back to the built-in card. */
export function activePrompt(library: PromptLibrary, kind: PromptKind): NamedPrompt {
  const cards = library.cards?.[kind] ?? []
  const id = library.active?.[kind]
  return cards.find((card) => card.id === id) ?? cards[0] ?? builtinPrompt(kind)
}

/**
 * AI coding / agent tools. The text dictated here is not prose for a human —
 * it becomes the prompt for a model, so the AI card is told to keep structure,
 * identifiers and constraints intact instead of polishing language.
 */
const AI_HINTS = [
  'codex',
  'claude code',
  'claude-code',
  'opencode',
  'open code',
  'cursor',
  'windsurf',
  'codex cli',
  'gemini cli',
  'aider',
  'cline',
  'copilot',
  'trae',
  'zed',
  'terminal',
  'powershell',
  'windows terminal',
  'cmd.exe',
  'iterm',
  'warp',
  'hyper'
]

/**
 * WeChat and other chat apps keep the plain polish card: people want their
 * spoken sentence tidied, not rewritten into model instructions.
 */
const CHAT_HINTS = ['wechat', 'weixin', '微信', '企业微信', 'qq', 'telegram', 'whatsapp', 'slack', 'discord']

const EMAIL_HINTS = [
  'outlook',
  'gmail',
  'foxmail',
  'thunderbird',
  'mail',
  '邮件',
  '网易邮箱',
  'superhuman',
  'spark'
]

const DOCUMENT_HINTS = [
  'word',
  'wps',
  'notion',
  'docs',
  'obsidian',
  'typora',
  'pages',
  'libreoffice',
  'writer',
  'evernote',
  'onenote',
  '语雀',
  '飞书文档',
  '石墨',
  '文档',
  'typora'
]

/**
 * Which dictation prompt fits the app being typed into. Deliberately a small
 * hint list instead of a hard allowlist: anything unknown gets plain polish.
 * The order matters — an AI tool called "Claude Code" must not be swallowed by
 * the generic chat hints, and a mail window titled "... - Gmail" must win over
 * a browser profile that happens to mention "code".
 */
export function pickPromptKind(appName: string, windowTitle: string): PromptKind {
  const haystack = `${appName} ${windowTitle}`.toLowerCase()
  if (AI_HINTS.some((hint) => haystack.includes(hint))) return 'ai'
  if (EMAIL_HINTS.some((hint) => haystack.includes(hint))) return 'email'
  if (CHAT_HINTS.some((hint) => haystack.includes(hint))) return 'polish'
  if (DOCUMENT_HINTS.some((hint) => haystack.includes(hint))) return 'document'
  return 'polish'
}

/**
 * First manual rule matching the window, or null when none applies. Site rules
 * win over text rules: a rule naming the domain found in the window title beats
 * a rule that merely matches the same substring.
 */
export function matchAppRule(
  rules: readonly AppRule[] | undefined,
  appName: string,
  windowTitle: string
): AppRule | null {
  if (!rules || rules.length === 0) return null
  const domain = extractDomain(windowTitle)
  if (domain) {
    const byDomain = rules.find((rule) => !!rule.domain && matchDomain(rule.domain, domain))
    if (byDomain) return byDomain
  }
  const haystack = `${appName} ${windowTitle}`.toLowerCase()
  const hit = rules.find((rule) => rule.match && haystack.includes(rule.match.toLowerCase()))
  return hit ?? null
}

export interface PromptRoutingSettings {
  autoActivatePrompts: boolean
  mainPromptKind: PromptKind
  mainPromptCardId: string
  appRules: AppRule[]
}

/**
 * Which kind to use for a window. Manual rules win over the built-in hint list
 * (that is the whole point of the table: the classifier mislabels an app, the
 * user fixes it once). Auto-activation off pins everything to one main kind.
 */
export function resolvePromptKind(
  settings: PromptRoutingSettings,
  appName: string,
  windowTitle: string
): PromptKind {
  if (!settings.autoActivatePrompts) return settings.mainPromptKind
  const rule = matchAppRule(settings.appRules, appName, windowTitle)
  if (rule) return rule.kind
  return pickPromptKind(appName, windowTitle)
}

/** Card for `kind`, honouring the pinned main card when auto-activation is off. */
export function resolvePromptCard(
  settings: PromptRoutingSettings,
  library: PromptLibrary,
  kind: PromptKind
): NamedPrompt {
  if (
    !settings.autoActivatePrompts &&
    kind === settings.mainPromptKind &&
    settings.mainPromptCardId
  ) {
    const pinned = library.cards[kind]?.find((card) => card.id === settings.mainPromptCardId)
    if (pinned) return pinned
  }
  return activePrompt(library, kind)
}

/**
 * Normalise untrusted settings input. Never throws.
 *
 * Two rules matter for the editing/deleting workflow:
 *
 * - a stored card list is taken as the user left it, including an empty list —
 *   forcing the builtin card back in would resurrect a card the user deleted on
 *   every settings read (this runs from `defaults.mergeSettings`);
 * - a stored builtin card keeps its own name/content. The shipped text is only
 *   used when the card does not exist yet (or has no list at all, i.e. settings
 *   written before the library existed).
 */
export function normalizePromptLibrary(input: unknown): PromptLibrary {
  const base = defaultPromptLibrary()
  if (!input || typeof input !== 'object') return base
  const raw = input as Partial<PromptLibrary>
  const cards = {} as Record<PromptKind, NamedPrompt[]>
  const active = {} as Record<PromptKind, string>

  for (const kind of PROMPT_KINDS) {
    const stored = raw.cards?.[kind]
    const list: unknown[] | null = Array.isArray(stored) ? stored : null
    const shipped = builtinPrompt(kind)
    const cleaned: NamedPrompt[] = []
    for (const card of list ?? []) {
      if (!card || typeof card !== 'object') continue
      const source = card as Partial<NamedPrompt>
      const id = typeof source.id === 'string' ? source.id.trim() : ''
      if (!id || cleaned.some((c) => c.id === id)) continue
      const isBuiltin = source.builtin === true
      const temperature =
        typeof source.temperature === 'number' && Number.isFinite(source.temperature)
          ? Math.min(1.5, Math.max(0, Math.round(source.temperature * 100) / 100))
          : undefined
      cleaned.push({
        id,
        // A builtin card that lost its label falls back to the shipped one; a
        // custom card keeps the generic placeholder.
        name:
          typeof source.name === 'string' && source.name.trim()
            ? source.name.trim()
            : isBuiltin
              ? shipped.name
              : '未命名提示词',
        content: typeof source.content === 'string' ? source.content : '',
        ...(isBuiltin ? { builtin: true } : {}),
        ...(temperature === undefined ? {} : { temperature })
      })
    }
    // No list at all = settings predating the library: start from the shipped
    // card. An existing (even empty) list is a decision and is kept verbatim.
    cards[kind] = list ? cleaned : [shipped]

    const ids = new Set(cards[kind].map((card) => card.id))
    const wanted = typeof raw.active?.[kind] === 'string' ? raw.active![kind] : ''
    active[kind] = ids.has(wanted) ? wanted : (cards[kind][0]?.id ?? '')
  }

  return { cards, active }
}

/** A fresh id for a new card; readable and collision-free enough for local use. */
export function newPromptId(kind: PromptKind, existing: NamedPrompt[]): string {
  let n = existing.length
  let id = `${kind}-${Date.now().toString(36)}-${n}`
  while (existing.some((card) => card.id === id)) {
    n += 1
    id = `${kind}-${Date.now().toString(36)}-${n}`
  }
  return id
}
