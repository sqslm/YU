import { describe, expect, it, vi } from 'vitest'
import { cleanHtml, inspectUrl, readWebpage } from './read-webpage'

/**
 * Two properties matter more than extraction quality: a model-chosen URL can
 * never reach the LAN, and the page is data. The fetch is always injected, so
 * nothing here opens a socket.
 */
describe('inspectUrl', () => {
  it('does not mistake HTML inside scripts for the visible article', () => {
    expect(cleanHtml('<script>const fake="<article>Wrong article</article>";</script><main>Actual long article</main>', true).text).toBe('Actual long article')
  })
  it('accepts public http(s) URLs', () => {
    for (const url of ['https://example.com/a?b=1#c', 'http://news.test/2026/10/19']) {
      const check = inspectUrl(url)
      expect(check.ok).toBe(true)
      expect(check.url?.protocol).toMatch(/^https?:$/)
    }
  })

  it('rejects non-http schemes', () => {
    expect(inspectUrl('file:///etc/passwd').error).toContain('http')
    expect(inspectUrl('ftp://example.com/x').error).toContain('http')
    expect(inspectUrl('javascript:alert(1)').error).toBeTruthy()
  })

  it('rejects loopback, RFC1918 and link-local hosts', () => {
    const blocked = [
      'http://localhost:8080/x',
      'http://127.0.0.1/x',
      'http://10.1.2.3/x',
      'http://192.168.0.5/x',
      'http://172.16.4.4/x',
      'http://172.31.255.1/x',
      'http://169.254.169.254/latest/meta-data/',
      'http://0.0.0.0/x'
    ]
    for (const url of blocked) {
      const check = inspectUrl(url)
      expect(check.ok, url).toBe(false)
      expect(check.error, url).toContain('内网')
    }
  })

  it('rejects IPv6 loopback and link-local literals', () => {
    expect(inspectUrl('http://[::1]/x').ok).toBe(false)
    expect(inspectUrl('http://[fe80::1]/x').ok).toBe(false)
    expect(inspectUrl('http://[::ffff:127.0.0.1]/x').ok).toBe(false)
  })

  it('rejects internal DNS suffixes', () => {
    expect(inspectUrl('http://printer.local/x').error).toContain('内网域名')
    expect(inspectUrl('http://wiki.internal/x').error).toContain('内网域名')
  })

  it('rejects garbage', () => {
    expect(inspectUrl('not a url').ok).toBe(false)
    expect(inspectUrl('').ok).toBe(false)
  })
})

describe('cleanHtml', () => {
  const page = `<!doctype html><html><head><title> 标题 &amp; 副标题 </title>
    <style>.a{color:red}</style><script>alert('x')</script></head>
    <body><nav>导航</nav><header>页头</header>
    <article><h1>正文标题</h1><p>第一段 &nbsp;文字</p><p>第二段</p></article>
    <aside>侧栏</aside><form>表单</form><iframe src="x"></iframe>
    <svg><text>矢量</text></svg><footer>页脚</footer>
    <script>var leak = 1</script></body></html>`

  it('keeps prose and drops chrome, code and vector blocks', () => {
    const { title, text } = cleanHtml(page)
    expect(title).toBe('标题 & 副标题')
    for (const kept of ['正文标题', '第一段', '第二段']) {
      expect(text).toContain(kept)
    }
    for (const dropped of ['导航', '页头', '侧栏', '表单', '矢量', '页脚', 'alert', 'color:red', 'var leak']) {
      expect(text, dropped).not.toContain(dropped)
    }
  })

  it('drops an unclosed script tail instead of eating nothing', () => {
    const { text } = cleanHtml('<p>正文</p><script>var x = "oops"')
    expect(text).toContain('正文')
    expect(text).not.toContain('oops')
  })

  it('collapses whitespace', () => {
    const { text } = cleanHtml('<p>a\n\n   b\t\tc</p>')
    expect(text).toBe('a b c')
  })

  it('returns an empty title when there is none', () => {
    expect(cleanHtml('<p>hi</p>').title).toBe('')
  })
})

describe('readWebpage', () => {
  function htmlResponse(html: string, url = 'https://example.test/article'): Response {
    return {
      ok: true,
      status: 200,
      url,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      text: async () => html
    } as unknown as Response
  }

  it('fetches, titles and cleans a page', async () => {
    const page = await readWebpage('https://example.test/article', {
      fetchImpl: vi.fn(async () => htmlResponse('<title>T</title><article><p>正文内容</p></article>'))
    })
    expect(page.ok).toBe(true)
    expect(page.title).toBe('T')
    expect(page.text).toBe('正文内容')
    expect(page.url).toBe('https://example.test/article')
    expect(page.truncated).toBe(false)
  })

  it('keeps plain text as-is', async () => {
    const page = await readWebpage('https://example.test/robots.txt', {
      fetchImpl: vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            url: 'https://example.test/robots.txt',
            headers: new Headers({ 'content-type': 'text/plain' }),
            text: async () => 'User-agent: *\nDisallow: /private'
          }) as unknown as Response
      )
    })
    expect(page.ok).toBe(true)
    expect(page.text).toContain('Disallow')
    expect(page.title).toBe('')
  })

  it('truncates long bodies and says so', async () => {
    const long = `<p>${'字'.repeat(500)}</p>`
    const page = await readWebpage('https://example.test/long', {
      fetchImpl: vi.fn(async () => htmlResponse(long)),
      maxChars: 50
    })
    expect(page.ok).toBe(true)
    expect(page.text?.length).toBe(50)
    expect(page.truncated).toBe(true)
  })

  it('reports the byte limit even when extracted text is shorter than the character limit', async () => {
    const page = await readWebpage('https://example.test/huge', { fetchImpl: vi.fn(async () => new Response('x'.repeat(300))), maxBytes: 100, maxChars: 1000 })
    expect(page.text).toBe('x'.repeat(100))
    expect(page.truncated).toBe(true)
  })

  it('never fetches a blocked URL', async () => {
    const fetchImpl = vi.fn()
    const page = await readWebpage('http://169.254.169.254/latest/meta-data/', { fetchImpl })
    expect(page.ok).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('re-validates the URL it was redirected to', async () => {
    const page = await readWebpage('https://example.test/go', {
      fetchImpl: vi.fn(async () => htmlResponse('<p>secret</p>', 'http://127.0.0.1/admin'))
    })
    expect(page.ok).toBe(false)
    expect(page.error).toContain('重定向')
    expect(page.text).toBeUndefined()
  })

  it('reports a bad status', async () => {
    const page = await readWebpage('https://example.test/x', {
      fetchImpl: vi.fn(async () => new Response('nope', { status: 503 }))
    })
    expect(page.ok).toBe(false)
    expect(page.error).toBe('HTTP 503')
  })

  it('reports a transport failure without throwing', async () => {
    const page = await readWebpage('https://example.test/x', {
      fetchImpl: vi.fn(async () => {
        throw new Error('ECONNRESET')
      })
    })
    expect(page.ok).toBe(false)
    expect(page.error).toContain('抓取失败')
  })
})
