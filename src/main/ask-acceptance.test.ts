import { spawn, type ChildProcess } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SearchSettings, Settings } from '@shared/types'
import { defaultSearchProviders } from '@shared/searchProviders'
import { askAgent, evidenceNote } from './agent'

/**
 * Acceptance scenarios A–I, driven end to end through `askAgent` against the
 * local mock stub (`scripts/mock-openai.mjs`). Everything here is offline: the
 * stub is a real HTTP server on loopback, article bodies are synthesised in
 * `fetchImpl`, and no provider credentials are involved.
 */

const PORT = 8793
const BASE = `http://127.0.0.1:${PORT}`
const ROOT = process.cwd()

let child: ChildProcess | null = null
let logs = ''
let ready: () => void
const readyPromise = new Promise<void>((resolve) => {
  ready = resolve
})

interface ScenarioRun {
  text: string
  sources: Array<{ title: string; url: string; snippet: string }>
  searched: boolean
  chatBodies: string[]
  searchLogs: string[]
}

let chatBodies: string[] = []

/**
 * Today, not a hardcoded date.
 *
 * The answer stage drops pages older than its recency window (48 h for "today"
 * questions), so a literal `2026-10-19` silently turned this file into a time
 * bomb: the fixtures aged out of the window two days after they were written and
 * every scenario started ranking the aggregator first.
 */
const TODAY = new Date().toISOString().slice(0, 10)

function articleHtml(title: string, body: string): string {
  const filler = `${body} `.repeat(6)
  return [
    '<html><head><title>' + title + '</title></head><body>',
    '<nav><a href="/x">menu</a></nav>',
    `<article><h1>${title}</h1><time datetime="${TODAY}">${TODAY}</time><p>${filler}</p></article>`,
    '<footer>© 2026</footer>',
    '</body></html>'
  ].join('')
}

/** Serves article bodies for the fake public hosts the scenarios cite. */
const scenarioPages: Record<string, { title: string; content: string }> = {}

const fetchImpl: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url.startsWith(BASE)) {
    const body = typeof init?.body === 'string' ? init.body : ''
    if (url.includes('/chat/completions')) chatBodies.push(body)
    return fetch(url, init)
  }
  const page = scenarioPages[url]
  return new Response(articleHtml(page?.title ?? 'Untitled', page?.content ?? 'No content.'), {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' }
  })
}

function settings(): Settings {
  const providers = defaultSearchProviders()
  providers.searxng = { apiKey: '', endpoint: BASE, maxResults: 5 }
  const search: SearchSettings = {
    enabled: true,
    provider: 'searxng',
    providers,
    apiKey: '',
    endpoint: BASE,
    maxResults: 5,
    decideWithModel: true
  }
  return {
    polish: {
      baseUrl: `${BASE}/v1`,
      apiKey: '',
      model: 'mock-model',
      askPrompt: '',
      useBuiltInPrompts: true,
      temperature: 0,
      extraHeaders: ''
    },
    search
  } as unknown as Settings
}

async function setScenario(id: string): Promise<Array<{ title: string; url: string; content: string }>> {
  const res = await fetch(`${BASE}/__scenario?id=${id}`)
  expect(res.ok).toBe(true)
  const payload = (await res.json()) as {
    ok: boolean
    results: Array<{ title: string; url: string; content: string }>
  }
  if (id) expect(payload.ok).toBe(true)
  return payload.results ?? []
}

function searchLogsSince(mark: number): string[] {
  return logs
    .slice(mark)
    .split('\n')
    .filter((line) => line.includes('[mock] search:'))
}

async function run(id: string, question: string): Promise<ScenarioRun> {
  // Register the article bodies the stub is about to cite.
  const results = await setScenario(id)
  for (const item of results) scenarioPages[item.url] = { title: item.title, content: item.content }

  const mark = logs.length
  chatBodies = []
  const result = await askAgent(settings(), question, {}, undefined, () => {}, {
    reset: true,
    fetchImpl
  })
  return {
    text: result.text,
    sources: result.sources.map((item) => ({ title: item.title, url: item.url, snippet: item.snippet })),
    searched: result.searched,
    chatBodies: [...chatBodies],
    searchLogs: searchLogsSince(mark)
  }
}

beforeAll(async () => {
  const proc = spawn(process.execPath, ['scripts/mock-openai.mjs', '--port', String(PORT)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child = proc
  proc.stdout.setEncoding('utf8')
  proc.stderr.setEncoding('utf8')
  proc.stdout.on('data', (chunk: string) => {
    logs += chunk
    if (chunk.includes('stub on')) ready()
  })
  proc.stderr.on('data', (chunk: string) => {
    logs += chunk
  })
  await Promise.race([
    readyPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`mock did not start:\n${logs}`)), 10000))
  ])
}, 20000)

afterAll(async () => {
  await setScenario('').catch(() => undefined)
  child?.kill()
  child = null
})

describe('A · today in AI news (bilingual, time-bounded, original first)', () => {
  it('searches in Chinese and English, keeps the original and drops stale rows', async () => {
    const runA = await run('A', '今天的人工智能新闻有哪些')
    const queries = runA.searchLogs.map((line) => line.split('q=')[1].split(' lang=')[0])
    expect(queries.length).toBeGreaterThanOrEqual(2)
    // Chinese question, but the second round must be the English variant.
    expect(queries.some((q) => /artificial intelligence/i.test(q))).toBe(true)
    expect(queries.some((q) => /新闻/.test(q))).toBe(true)
    expect(runA.searchLogs.some((line) => line.includes('lang=en'))).toBe(true)
    expect(runA.searchLogs.some((line) => line.includes('range=day'))).toBe(true)
    // The original announcement outranks the aggregator and the reprint.
    expect(runA.sources[0].url).toBe('https://openai.com/index/gpt-5-2/')
    // 2023 row is older than the 48h window and must not survive.
    expect(runA.sources.some((item) => item.url.includes('/2023/'))).toBe(false)
    // The syndicated copy is not counted twice.
    expect(runA.sources.some((item) => item.url.includes('theverge.com'))).toBe(false)
    // The answer reads a real body, not only the snippet.
    const finalBody = runA.chatBodies[runA.chatBodies.length - 1] ?? ''
    // Quotes inside the JSON-encoded tool payload arrive escaped.
    expect(finalBody).toMatch(/\\?"pages\\?":/)
    expect(finalBody).toContain('openai.com/index/gpt-5-2')
    expect(runA.text).toContain('## 来源')
    expect(runA.text).toContain('https://openai.com/index/gpt-5-2/')
  }, 20000)
})

describe('B · newest DeepSeek model (official docs first)', () => {
  it('ranks the vendor documentation above a third-party rewrite', async () => {
    const runB = await run('B', 'DeepSeek 最新的模型是哪个')
    expect(runB.sources[0].url).toContain('api-docs.deepseek.com')
    expect(runB.sources[0].url).not.toContain('example-news.com')
    expect(runB.searchLogs.some((line) => /range=month|range=week/.test(line))).toBe(true)
  }, 20000)
})

describe('C · RTX 5070 VRAM (spec sheet is the evidence)', () => {
  it('answers from the official specification page', async () => {
    const runC = await run('C', 'RTX 5070 的显存是多少')
    expect(runC.sources[0].url).toContain('nvidia.com')
    const finalBody = runC.chatBodies[runC.chatBodies.length - 1] ?? ''
    expect(finalBody).toContain('12GB GDDR7')
  }, 20000)
})

describe('D · GitHub project new feature (release notes first)', () => {
  it('prefers the repository release note', async () => {
    const runD = await run('D', 'Vite 项目的这个新功能是什么')
    expect(runD.sources[0].url).toContain('github.com/vitejs/vite')
  }, 20000)
})

describe('E · medical study credibility (primary literature first)', () => {
  it('ranks the indexed paper above the press rewrite', async () => {
    const runE = await run('E', '这项医学研究可信吗')
    expect(runE.sources[0].url).toMatch(/pubmed|nature\.com/)
    expect(runE.sources[0].url).not.toContain('example-tabloid.com')
  }, 20000)
})

describe('F · international tech news (independent second source)', () => {
  it('keeps both independent reports and no aggregator', async () => {
    const runF = await run('F', '最新的国际科技新闻')
    const hosts = runF.sources.map((item) => new URL(item.url).hostname)
    expect(hosts).toContain('www.reuters.com')
    expect(hosts).toContain('www.bbc.com')
    expect(runF.sources.every((item) => !item.url.includes('news.google.com'))).toBe(true)
  }, 20000)
})

describe('G · old news vs reprints', () => {
  it('drops the 2023 look-alike and collapses the reprint', async () => {
    const runG = await run('G', '英伟达 Rubin 显卡最新消息')
    expect(runG.sources.some((item) => item.url.includes('/2023/'))).toBe(false)
    expect(runG.sources.some((item) => item.url.includes('example-reprint.com'))).toBe(false)
    expect(runG.sources.filter((item) => item.title.startsWith('Nvidia announces')).length).toBe(1)
    const finalBody = runG.chatBodies[runG.chatBodies.length - 1] ?? ''
    expect(finalBody).toContain('2026-10-18')
  }, 20000)
})

describe('H · conflicting sources', () => {
  it('reports the disagreement instead of picking a side', async () => {
    const runH = await run('H', 'RTX 5070 的显存到底是多少')
    expect(runH.sources.length).toBeGreaterThanOrEqual(2)
    const finalBody = runH.chatBodies[runH.chatBodies.length - 1] ?? ''
    // The evidence note is JSON-embedded in the prompt, so its quotes are escaped.
    expect(finalBody).toMatch(/numericConflict\\?":\s*true/)
  }, 20000)

  it('flags the conflict in the evidence note it renders', () => {
    const note = evidenceNote([
      { title: 'Official specs', url: 'https://www.nvidia.com/rtx-5070/', snippet: '12GB GDDR7' },
      { title: 'Hands-on', url: 'https://www.example-hardware.com/rtx-5070', snippet: '16GB GDDR7 measured' }
    ])
    expect(note.numericConflict).toBe(true)
    expect(note.independentDomains).toBe(2)
    expect(note.singleSourced).toBe(false)
  })
})

describe('I · common knowledge that needs no web', () => {
  it('answers without searching at all', async () => {
    const runI = await run('I', '为什么天空是蓝色的')
    expect(runI.searchLogs).toEqual([])
    expect(runI.searched).toBe(false)
    expect(runI.sources).toEqual([])
    expect(runI.text).toContain('瑞利散射')
  }, 20000)
})
