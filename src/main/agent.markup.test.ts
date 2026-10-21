import { describe, expect, it } from 'vitest'
import { parseTextToolCalls, scrubToolCallMarkup } from './agent'

/**
 * DeepSeek serialises a tool call into the message content when a gateway does
 * not translate it back into `tool_calls`. These helpers are what turns that
 * into a working tool round instead of markup in the answer.
 */
const CALL = [
  '<｜｜DSML｜｜ calls>',
  '<｜｜DSML｜｜ invoke name="read_webpage">',
  '<｜｜DSML｜｜ parameter name="url" string="true">https://example.com/news</｜｜DSML｜｜ parameter>',
  '</｜｜DSML｜｜ invoke>',
  '<｜｜DSML｜｜ invoke name="web_search">',
  '<｜｜DSML｜｜ parameter name="freshness" string="true">day</｜｜DSML｜｜ parameter>',
  '<｜｜DSML｜｜ parameter name="query" string="true">AI news today</｜｜DSML｜｜ parameter>',
  '</｜｜DSML｜｜ invoke>',
  '</｜｜DSML｜｜ calls>'
].join('\n')

describe('text-format tool calls', () => {
  it('reads invocations and their parameters in order', () => {
    const calls = parseTextToolCalls(CALL)

    expect(calls.map((call) => call.function?.name)).toEqual(['read_webpage', 'web_search'])
    expect(JSON.parse(calls[0].function?.arguments ?? '{}')).toEqual({
      url: 'https://example.com/news'
    })
    expect(JSON.parse(calls[1].function?.arguments ?? '{}')).toEqual({
      freshness: 'day',
      query: 'AI news today'
    })
    // Ids are synthesised because the gateway never supplied any.
    expect(calls[0].id).toBe('textcall_1')
    expect(calls[0].type).toBe('function')
  })

  it('decodes non-string parameters as JSON', () => {
    const calls = parseTextToolCalls(
      '<invoke name="widget"><parameter name="count" string="false">3</parameter>' +
        '<parameter name="flags" string="false">{"a":1}</parameter></invoke>'
    )

    expect(JSON.parse(calls[0].function?.arguments ?? '{}')).toEqual({ count: 3, flags: { a: 1 } })
  })

  it('keeps prose untouched and finds nothing in a plain answer', () => {
    expect(parseTextToolCalls('今天有三条 AI 新闻。')).toEqual([])
    expect(parseTextToolCalls('')).toEqual([])
  })

  it('ignores an invocation with no name', () => {
    expect(parseTextToolCalls('<｜｜DSML｜｜ invoke>没有名字</｜｜DSML｜｜ invoke>')).toEqual([])
  })
})

describe('tool markup scrubbing', () => {
  it('removes the whole call block', () => {
    expect(scrubToolCallMarkup(CALL)).toBe('')
  })

  it('keeps the prose around a call', () => {
    const text = `这是今天的 AI 新闻：\n${CALL}\n稍等，我先查一下。`
    const cleaned = scrubToolCallMarkup(text)

    expect(cleaned).toContain('这是今天的 AI 新闻：')
    expect(cleaned).toContain('稍等，我先查一下。')
    expect(cleaned).not.toMatch(/DSML/)
    expect(cleaned).not.toContain('invoke')
  })

  it('drops a call the model never closed', () => {
    const cleaned = scrubToolCallMarkup(
      '我来查。<｜｜DSML｜｜ invoke name="web_search">\n<｜｜DSML｜｜ parameter name="query" string="true">AI'
    )

    expect(cleaned).toBe('我来查。')
  })

  it('leaves ordinary answers alone', () => {
    const text = '第一，OpenAI 发布了新模型。\n第二，Google 更新了 Gemini。'
    expect(scrubToolCallMarkup(text)).toBe(text)
  })

  it('is a no-op on an empty answer', () => {
    expect(scrubToolCallMarkup('')).toBe('')
  })
})
