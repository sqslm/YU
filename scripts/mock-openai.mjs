// Local OpenAI-compatible stub used to exercise the whole pipeline without any
// real credentials. Run: node scripts/mock-openai.mjs [--port 8787]
//
//   POST /v1/audio/transcriptions  -> canned transcript (or $MOCK_TRANSCRIPT)
//   POST /v1/chat/completions      -> deterministic "cleanup" of the user text
//   GET  /v1/models                -> model list (used by the settings probe)
import { createServer } from 'node:http'

const portArg = process.argv.indexOf('--port')
const PORT = portArg > 0 ? Number(process.argv[portArg + 1]) : 8787
const TRANSCRIPT =
  process.env.MOCK_TRANSCRIPT ?? '嗯 那个 我们今天 下午三点 开个会 讨论一下 复刻的事情 啊'

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// A chat request may ask for SSE (`stream: true`) — the app's answer card uses
// it so text shows up while the model is still writing. Every chat handler below
// builds the full completion first, so `json()` can replay it as chunks: that
// keeps the mock deterministic while still exercising the real streaming path.
let streamChat = false

async function json(res, status, payload) {
  const content = payload?.choices?.[0]?.message?.content
  if (streamChat && status === 200 && typeof content === 'string') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    const delta = (text) =>
      `data: ${JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: text ? { content: text } : {}, finish_reason: null }]
      })}\n\n`
    res.write(delta(''))
    const step = Math.max(2, Math.ceil(content.length / 12))
    // `MOCK_STREAM_DELAY_MS` stretches the stream so a human (or a test) can see
    // the text grow instead of it appearing in one frame.
    const delay = Number(process.env.MOCK_STREAM_DELAY_MS ?? 0)
    for (let i = 0; i < content.length; i += step) {
      res.write(delta(content.slice(i, i + step)))
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    }
    res.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
      })}\n\n`
    )
    res.end('data: [DONE]\n\n')
    return
  }
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  })
  res.end(body)
}

/** Very small "polisher": drops filler words, normalises whitespace. */
function polish(text) {
  return text
    .replace(/(嗯|呃|那个|然后呢|就是)/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([，。！？])/g, '$1')
    .trim()
}

/** "10 月 19 日" — keeps the mock's answers date-specific like the real model. */
function todayLabel() {
  const now = new Date()
  return `${now.getMonth() + 1} 月 ${now.getDate()} 日`
}

/** Detailed, number-first answer so the Ask card has something realistic to show. */
function weatherAnswer(question) {
  const city = (question.match(/[\u4e00-\u9fa5]{2,4}(?=天气)/) ?? ['河南安阳'])[0]
  return [
    `${city}今天（${todayLabel()}）多云转晴，气温 12～23℃，东南风 2 级，空气质量良。[1]`,
    '',
    `白天最高 23℃ 出现在 14 时前后，夜间降到 12℃，早晚温差 11℃，出门建议带一件外套。`,
    `未来两天：明天晴，11～24℃；后天多云，13～22℃，没有降水。[2]`,
    '',
    '## 来源',
    `- [${city}天气 - 中国天气网](https://weather.example.com/${encodeURIComponent(city)})`,
    `- [${city}天气预报 15 天](https://weather.example.com/${encodeURIComponent(city)}/15d)`
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Ask acceptance scenarios (A–I)
//
// The app decides *how* to search; this stub only has to answer like a search
// engine whose index happens to contain exactly the traps the scenarios are
// about: an aggregator copy, a syndicated reprint, a stale-but-fresh-looking
// page, two sources that disagree on a number, and a first-party page.
// `setScenario()` is the hook the acceptance test uses; when no scenario is
// active every existing route behaves exactly as before.
// ---------------------------------------------------------------------------

/**
 * Fixture dates are relative, not literal.
 *
 * The answer stage drops pages older than its recency window, so a hardcoded
 * "2026-10-19" made every scenario age out of the window a couple of days after it
 * was written — the original announcement got filtered and the aggregator took
 * first place.
 */
const daysAgo = (days) => {
  const date = new Date()
  date.setDate(date.getDate() - days)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const SCENARIOS = {
  A: {
    answer: `OpenAI 今天发布了 GPT-5.2，官方页面给出的发布时间是 ${daysAgo(0)}。`,
    results: [
      {
        title: 'AI news roundup: today in artificial intelligence',
        url: 'https://news.google.com/rss/articles/ai-roundup',
        content: 'Aggregated links about AI, no original reporting of its own.'
      },
      {
        title: 'Introducing GPT-5.2',
        url: 'https://openai.com/index/gpt-5-2/',
        content: `Today we are introducing GPT-5.2. Published ${daysAgo(0)} by OpenAI.`
      },
      {
        title: 'Introducing GPT-5.2',
        url: 'https://www.theverge.com/ai/gpt-5-2-launch',
        content: 'Introducing GPT-5.2 — this article is a syndicated copy of the OpenAI announcement.'
      },
      {
        title: 'AI chip demand keeps rising into 2026',
        url: 'https://www.reuters.com/technology/ai-chips-2026-10-18/',
        content: 'Reuters reports on datacenter demand, 2026-10-18.'
      },
      {
        title: 'AI news: the state of artificial intelligence in 2023',
        url: 'https://example.com/2023/05/01/ai-news-2023',
        content: 'An older survey of AI published 2023-05-01.'
      }
    ]
  },
  B: {
    answer: 'DeepSeek 目前最新的模型是 DeepSeek V5，官方文档站有发布说明。',
    results: [
      {
        title: 'DeepSeek V5 release notes',
        url: 'https://api-docs.deepseek.com/news/deepseek-v5',
        content: 'DeepSeek V5 released 2026-10-16. Official release notes from DeepSeek.'
      },
      {
        title: 'DeepSeek V5 全面解读：参数、价格和实测',
        url: 'https://www.example-news.com/tech/deepseek-v5-review',
        content: '第三方评测，转载自官方发布说明，另有少量实测数据。'
      },
      {
        title: 'DeepSeek models overview',
        url: 'https://github.com/deepseek-ai/DeepSeek-V3',
        content: 'Repository README listing model versions and weights.'
      }
    ]
  },
  C: {
    answer: 'RTX 5070 的显存是 12GB GDDR7，官方规格页写得很清楚。',
    results: [
      {
        title: 'GeForce RTX 5070 Graphics Card',
        url: 'https://www.nvidia.com/en-us/geforce/graphics-cards/rtx-5070/',
        content: 'RTX 5070 specifications: 12GB GDDR7 memory, 192-bit bus.'
      },
      {
        title: 'RTX 5070 review roundup',
        url: 'https://www.tomshardware.com/reviews/rtx-5070',
        content: 'Independent testing of the RTX 5070, 12GB GDDR7 confirmed.'
      }
    ]
  },
  D: {
    answer: 'Vite 7.2 新增了 environment API 的稳定版本，发行说明在 GitHub 上。',
    results: [
      {
        title: 'v7.2.0 release notes',
        url: 'https://github.com/vitejs/vite/releases/tag/v7.2.0',
        content: 'Release notes: environment API is now stable. Published 2026-10-15.'
      },
      {
        title: 'Vite 7.2 released with a stable environment API',
        url: 'https://www.example-dev-blog.com/vite-7-2',
        content: 'Blog summary of the Vite 7.2 release.'
      }
    ]
  },
  E: {
    answer: '这项研究是小样本随机对照试验，结论需要更多独立重复才能当作定论。',
    results: [
      {
        title: 'Effect of X on Y: a randomised controlled trial',
        url: 'https://pubmed.ncbi.nlm.nih.gov/40000001/',
        content: 'Randomised controlled trial, n=42. Published 2026-09-30 in a peer-reviewed journal.'
      },
      {
        title: 'New study claims X changes everything',
        url: 'https://www.example-tabloid.com/health/x-changes-everything',
        content: 'News aggregator rewriting the press release, no methods reported.'
      },
      {
        title: 'X and Y: a systematic review',
        url: 'https://www.nature.com/articles/s41586-026-00001-2',
        content: 'Systematic review of 18 trials, published 2026-08-11.'
      }
    ]
  },
  F: {
    answer: '国际科技新闻：欧盟通过了新的 AI 责任规则，路透社与 BBC 均有报道。',
    results: [
      {
        title: 'EU agrees AI liability rules',
        url: 'https://www.reuters.com/technology/eu-ai-liability-2026-10-19/',
        content: 'Reuters, 2026-10-19: EU member states agreed on AI liability rules.'
      },
      {
        title: 'Brussels seals AI liability deal',
        url: 'https://www.bbc.com/news/technology-eu-ai-liability',
        content: 'BBC News, 2026-10-19: separate reporting from Brussels.'
      }
    ]
  },
  G: {
    answer: '这条消息本身是 2026-10-18 发布的；2023 年那篇是同名旧文。',
    results: [
      {
        title: 'Nvidia announces next-gen Rubin GPUs',
        url: 'https://nvidianews.nvidia.com/news/rubin-gpus',
        content: 'Official announcement, 2026-10-18.'
      },
      {
        title: 'Nvidia announces next-gen Rubin GPUs',
        url: 'https://www.example-reprint.com/nvidia-rubin',
        content: '转载自 NVIDIA 新闻稿，正文相同。'
      },
      {
        title: 'Nvidia announces next-gen Rubin GPUs (2023)',
        url: 'https://example.com/2023/03/21/nvidia-rubin-gpus',
        content: 'An old article from 2023-03-21 that merely reuses the headline.'
      }
    ]
  },
  H: {
    answer: '两家来源对显存容量的说法不一致：官方规格写 12GB，第三方评测写 16GB。',
    results: [
      {
        title: 'GeForce RTX 5070 specifications',
        url: 'https://www.nvidia.com/en-us/geforce/graphics-cards/rtx-5070/',
        content: 'Official specifications list 12GB GDDR7 memory.'
      },
      {
        title: 'RTX 5070 hands-on: 16GB versions spotted',
        url: 'https://www.example-hardware.com/rtx-5070-16gb',
        content: 'A third-party outlet measured 16GB GDDR7 on a retail board.'
      }
    ]
  },
  I: {
    answer: '天空看起来是蓝色，是因为大气把短波长的蓝光散射得更多（瑞利散射）。',
    results: []
  }
}

let ACTIVE_SCENARIO = null

/** Selects the scenario the next requests should behave as; `null` restores. */
export function setScenario(id) {
  ACTIVE_SCENARIO = id ? SCENARIOS[id] ?? null : null
  return Boolean(ACTIVE_SCENARIO)
}

/** Query the stub router would hand to `web_search` for this user message. */
function scenarioQuery(user) {
  if (ACTIVE_SCENARIO === SCENARIOS.A) return '人工智能 新闻'
  if (ACTIVE_SCENARIO === SCENARIOS.B) return 'DeepSeek latest model'
  if (ACTIVE_SCENARIO === SCENARIOS.C) return 'RTX 5070 VRAM specifications'
  if (ACTIVE_SCENARIO === SCENARIOS.D) return 'Vite latest release notes'
  if (ACTIVE_SCENARIO === SCENARIOS.E) return 'X Y randomised controlled trial credibility'
  if (ACTIVE_SCENARIO === SCENARIOS.F) return 'EU AI liability rules news'
  if (ACTIVE_SCENARIO === SCENARIOS.G) return 'Nvidia Rubin GPUs announcement'
  if (ACTIVE_SCENARIO === SCENARIOS.H) return 'RTX 5070 VRAM specifications'
  return ''
}

/** Answer built only from the links the search tool actually returned. */
function scenarioAnswer(toolText) {
  /** @type {Array<{title: string, url: string}>} */
  let items = []
  const trimmed = toolText.trim()
  // The native-tools round hands the model JSON; the intent path hands it the
  // formatted list. Accept both so the stub answers the same way either way.
  if (trimmed.startsWith('{')) {
    try {
      const data = JSON.parse(trimmed)
      if (Array.isArray(data.results)) {
        items = data.results.map((item) => ({ title: String(item.title ?? ''), url: String(item.url ?? '') }))
      }
    } catch {
      for (const match of toolText.matchAll(/"title":"([^"]*)","url":"([^"]*)"/g)) {
        items.push({ title: match[1], url: match[2] })
      }
    }
  }
  if (items.length === 0) {
    for (const match of toolText.matchAll(/^\[(\d+)\] (.+?) — ([^\s（]+)/gm)) {
      items.push({ title: match[2], url: match[3] })
    }
  }
  items = items.filter((item) => /^https?:\/\//.test(item.url)).slice(0, 4)
  if (items.length === 0) return '没有检索到足够可靠的结果，这一点无法确认。'
  const lines = [`结论：${ACTIVE_SCENARIO.answer}`]
  items.forEach((item, index) => lines.push(`- ${item.title} [${index + 1}]`))
  lines.push('', '## 来源')
  for (const item of items) lines.push(`- [${item.title}](${item.url})`)
  return lines.join('\n')
}

function createMockServer() {
  return createServer(async (req, res) => {

  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  const auth = req.headers.authorization ?? ''
  streamChat = false

  if (url.pathname === '/v1/models' && req.method === 'GET') {
    // Covers the three shapes the settings page has to render: a flagship model
    // with reasoning effort levels, one without any reasoning metadata, and one
    // that can never stop thinking.
    return json(res, 200, {
      object: 'list',
      data: [
        {
          id: 'cn:deepseek-v4.1-flash',
          object: 'model',
          name: 'DeepSeek V4.1 Flash',
          description: '[x0.11 credit] DeepSeek 旗舰模型…',
          context_length: 1000000,
          max_output_tokens: 393216,
          supports_reasoning: true,
          only_reasoning: false,
          can_disable_thinking: true,
          reasoning_supported_efforts: ['low', 'high', 'max'],
          reasoning_default_effort: 'high'
        },
        {
          id: 'mock-no-thinking',
          object: 'model',
          name: 'Mock · 无思考档位',
          description: '没有 reasoning 元数据的普通模型'
        },
        {
          id: 'mock-always-thinking',
          object: 'model',
          name: 'Mock · 始终思考',
          description: '只能思考，不能关闭',
          supports_reasoning: true,
          only_reasoning: true,
          can_disable_thinking: false,
          reasoning_supported_efforts: ['low', 'high'],
          reasoning_default_effort: 'low'
        }
      ]
    })
  }

  if (url.pathname === '/v1/audio/transcriptions' && req.method === 'POST') {
    const body = await readBody(req)
    // The multipart body is not parsed: we only prove the request shape (WAV
    // magic + model field) reached a real HTTP endpoint.
    const hasRiff = body.includes(Buffer.from('RIFF'))
    console.log(
      `[mock] transcriptions: ${body.length} bytes, riff=${hasRiff}, auth=${auth ? 'yes' : 'no'}`
    )
    if (!hasRiff) return json(res, 400, { error: { message: 'no RIFF payload received' } })
    return json(res, 200, { text: TRANSCRIPT })
  }

  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    const body = await readBody(req)
    const parsed = JSON.parse(body.toString('utf8'))
    streamChat = parsed.stream === true
    const messages = parsed.messages ?? []
    const system = messages.find((m) => m.role === 'system')?.content ?? ''
    const user = messages.find((m) => m.role === 'user')?.content ?? ''
    console.log(
      `[mock] chat: model=${parsed.model} temperature=${parsed.temperature ?? '-'} sys=${system.slice(0, 40)}… user=${user.slice(0, 40)}…`
    )

    // Scenario mode: answer like a model that has function calling, so the
    // whole native-tools path (dispatch -> tool -> narrated answer) is exercised
    // against a real HTTP endpoint without any provider credentials.
    if (ACTIVE_SCENARIO) {
      const hasToolResult = messages.some((message) => message.role === 'tool')
      const query = scenarioQuery(user)
      if (Array.isArray(parsed.tools) && parsed.tools.length > 0 && query && !hasToolResult) {
        console.log(`[mock] scenario tool_call: web_search "${query}"`)
        return json(res, 200, {
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          model: parsed.model,
          choices: [
            {
              index: 0,
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_mock_1',
                    type: 'function',
                    function: { name: 'web_search', arguments: JSON.stringify({ query }) }
                  }
                ]
              }
            }
          ]
        })
      }
      const toolText = messages
        .filter((message) => message.role === 'tool')
        .map((message) => String(message.content ?? ''))
        .join('\n')
      const content = hasToolResult ? scenarioAnswer(toolText) : ACTIVE_SCENARIO.answer
      return json(res, 200, {
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        model: parsed.model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]
      })
    }

    // Mode detection looks at the prompt's *role statement* (first line) instead
    // of matching loose keywords: the built-in prompts mention "翻译" and "回答"
    // inside their negative rules, which used to misroute dictation to translate.
    const role = system.split('\n')[0] ?? ''
    let content
    if (/检索调度器|need_search/.test(system)) {
      // Stage 1 of Ask+search: answer the router, never with prose.
      content = JSON.stringify({
        need_search: /天气|新闻|今天|现在|价格|比分/.test(user),
        query: user.replace(/[?？。，,！!]/g, '').replace(/(怎么样|如何|呢|吗)$/g, '')
      })
    } else if (/口述翻译器|^You translate|Target language:/i.test(role) || /Target language:/i.test(system)) {
      content = `[translated] ${user}`
    } else if (/语音助手|helpful assistant answering/i.test(role)) {
      content = system.includes('<web_results>')
        ? weatherAnswer(user)
        : `关于「${user}」：这是 mock 模型的简要回答。`
    } else {
      content = polish(user)
    }

    return json(res, 200, {
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      model: parsed.model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]
    })
  }

  // Gemini-compatible multimodal route: one audio-in, one text-out.
  if (req.method === 'POST' && url.pathname.endsWith(':generateContent')) {
    const body = await readBody(req)
    const parsed = JSON.parse(body.toString('utf8'))
    const system = parsed.systemInstruction?.parts?.map((p) => p.text).join('') ?? ''
    const inline = parsed.contents?.[0]?.parts?.find((part) => part.inline_data)?.inline_data
    const audioBytes = inline ? Math.round((inline.data.length * 3) / 4) : 0
    console.log(
      `[mock] generateContent: model=${url.pathname} audio=${audioBytes}B mime=${inline?.mime_type ?? 'none'}`
    )
    console.log(`[mock]   system="${system.replace(/\s+/g, ' ').slice(0, 160)}"`)
    if (!inline || audioBytes < 44) {
      return json(res, 400, { error: { message: 'no inline audio received' } })
    }
    const isTranslate = system.includes('翻译') && system.includes('目标语言')
    // Echo which card spoke, so an E2E run can prove the prompt actually reached
    // the model instead of only proving that audio was accepted.
    const tag = system.includes('AI 编程助手')
      ? 'ai'
      : system.includes('邮件正文')
        ? 'email'
        : system.includes('文档正文')
          ? 'document'
          : isTranslate
            ? 'translate'
            : 'polish'
    const content = isTranslate
      ? '[gemini] 我们今天下午三点开个会，讨论复刻的事情。'
      : `[gemini:${tag}] 我们今天下午三点开个会，讨论复刻的事情。`
    return json(res, 200, {
      candidates: [{ content: { parts: [{ text: content }] }, finishReason: 'STOP' }]
    })
  }

  // Open-Meteo shapes, so the weather shortcut is testable without the internet.
  if (url.pathname === '/geocoding-api/v1/search' && req.method === 'GET') {
    const name = url.searchParams.get('name') ?? '安阳'
    console.log(`[mock] geocode: name=${name}`)
    return json(res, 200, {
      results: [
        {
          name: name.replace(/^(河南|河北|山东|山西)/, '') || name,
          admin1: '河南省',
          country: '中国',
          latitude: 36.1,
          longitude: 114.39,
          timezone: 'Asia/Shanghai'
        }
      ]
    })
  }

  if (url.pathname === '/v1/forecast' && req.method === 'GET') {
    console.log(`[mock] forecast: ${url.search}`)
    const days = Number(url.searchParams.get('forecast_days') ?? '2')
    const dates = Array.from({ length: days }, (_, index) => {
      const date = new Date(Date.now() + index * 86400000)
      return date.toISOString().slice(0, 10)
    })
    return json(res, 200, {
      current: {
        temperature_2m: 18.4,
        apparent_temperature: 17.1,
        relative_humidity_2m: 62,
        precipitation: 0,
        weather_code: 3,
        wind_speed_10m: 9.7
      },
      daily: {
        time: dates,
        weather_code: [3, 61, 1, 2].slice(0, days),
        temperature_2m_max: [23.1, 21.4, 24.8, 25.2].slice(0, days),
        temperature_2m_min: [12.2, 13.6, 11.9, 12.4].slice(0, days),
        precipitation_probability_max: [10, 65, 5, 20].slice(0, days)
      }
    })
  }

  // SearXNG-shaped search endpoint so the Ask+search path can be exercised offline.
  if (url.pathname === '/search' && req.method === 'GET') {
    const q = url.searchParams.get('q') ?? ''
    console.log(
      `[mock] search: q=${q} lang=${url.searchParams.get('language') ?? '-'} range=${url.searchParams.get('time_range') ?? '-'}`
    )
    // Scenario index: same result set for the zh and the en round, which is what
    // a real engine mostly returns for a bilingual pair.
    if (ACTIVE_SCENARIO) {
      return json(res, 200, {
        results: ACTIVE_SCENARIO.results.map((item) => ({
          title: item.title,
          url: item.url,
          content: item.content,
          publishedDate: item.publishedDate ?? ''
        }))
      })
    }
    const city = (q.match(/[\u4e00-\u9fa5]{2,4}(?=天气)/) ?? ['安阳'])[0]
    return json(res, 200, {
      results: [
        {
          title: `${city}天气 - 中国天气网`,
          url: `https://weather.example.com/${encodeURIComponent(city)}`,
          content: `${city}今天（${todayLabel()}）多云转晴，气温 12～23℃，东南风 2 级，空气质量良。`
        },
        {
          title: `${city}天气预报 15 天`,
          url: `https://weather.example.com/${encodeURIComponent(city)}/15d`,
          content: `${city}未来三天：今天多云转晴 12～23℃；明天晴 11～24℃；后天多云 13～22℃。`
        }
      ]
    })
  }

  // Test hook: pick the acceptance scenario (A–I) the next requests answer as.
  // Returns the scenario's own result set so a test can serve matching article
  // bodies without importing this module.
  if (url.pathname === '/__scenario' && req.method === 'GET') {
    const id = url.searchParams.get('id')
    const ok = setScenario(id)
    console.log(`[mock] scenario: ${id ?? 'off'} ok=${ok}`)
    return json(res, 200, {
      scenario: id ?? '',
      ok,
      results: ACTIVE_SCENARIO ? ACTIVE_SCENARIO.results : []
    })
  }

  json(res, 404, { error: { message: `no route for ${req.method} ${url.pathname}` } })
  })
}

const server = createMockServer()

// Only bind the port when this file is run directly (`pnpm mock`); importing it
// from a test must not steal 8787.
const invokedDirectly = process.argv[1] ? process.argv[1].endsWith('mock-openai.mjs') : false
if (invokedDirectly) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[mock] OpenAI-compatible stub on http://127.0.0.1:${PORT}/v1`)
  })
}

export { SCENARIOS, createMockServer, server }
