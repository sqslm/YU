import { describe, expect, it, vi } from 'vitest'
import { assertPublicHost, inspectUrl, isPrivateAddress, safeFetch } from './safe-fetch'
import { inspectUrl as inspectUrlFromTool } from './tools/read-webpage'

/**
 * The guard that stands between a model-chosen URL and the user's network.
 *
 * A string check is not enough — `localtest.me` is an ordinary public name whose
 * A record is 127.0.0.1 — and `redirect: 'follow'` sends the request to the
 * redirect target before anyone can look at it. Every case here injects the
 * resolver and the transport, so no test opens a socket.
 */

/** 203.0.113.10 and friends: TEST-NET-3, public as far as any routing table cares. */
const PUBLIC_V4 = '203.0.113.10'

function resolverFor(map: Record<string, string[]>): (host: string) => Promise<Array<{ address: string; family?: number }>> {
  return async (host: string) => {
    const addresses = map[host]
    if (!addresses) throw new Error(`ENOTFOUND ${host}`)
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
  }
}

function htmlResponse(body: string, url = ''): Response {
  return {
    ok: true,
    status: 200,
    url,
    headers: new Headers({ 'content-type': 'text/html' }),
    text: async () => body
  } as unknown as Response
}

describe('isPrivateAddress', () => {
  it('refuses loopback, RFC1918, link-local, CGNAT and the unspecified address', () => {
    for (const address of [
      '127.0.0.1',
      '127.255.255.254',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.0.5',
      '169.254.169.254',
      '0.0.0.0',
      '100.64.0.1',
      '::1',
      '::',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '64:ff9b::a00:1'
    ]) {
      expect(isPrivateAddress(address), address).toBe(true)
    }
  })

  it('allows public unicast addresses', () => {
    for (const address of ['8.8.8.8', PUBLIC_V4, '1.1.1.1', '2606:4700:4700::1111']) {
      expect(isPrivateAddress(address), address).toBe(false)
    }
  })

  it('treats anything it cannot parse as private, so no caller is told "public" by accident', () => {
    expect(isPrivateAddress('')).toBe(true)
    expect(isPrivateAddress('999.1.1.1')).toBe(true)
    expect(isPrivateAddress('example.com')).toBe(true)
  })
})

describe('inspectUrl', () => {
  it('still passes a public-looking name — the DNS layer is what catches it', () => {
    // This is the QA finding in one line: the string check cannot know that
    // localtest.me resolves to 127.0.0.1, so it must not be the only check.
    expect(inspectUrl('https://localtest.me/c.ics').ok).toBe(true)
    expect(inspectUrl('https://lvh.me/c.ics').ok).toBe(true)
  })

  it('is re-exported from read-webpage unchanged, for the callers that import it there', () => {
    expect(inspectUrlFromTool).toBe(inspectUrl)
    expect(inspectUrlFromTool('http://127.0.0.1/x').error).toContain('内网')
    expect(inspectUrlFromTool('http://printer.local/x').error).toContain('内网域名')
    expect(inspectUrlFromTool('file:///etc/passwd').error).toContain('http')
  })
})

describe('assertPublicHost', () => {
  it('refuses a name whose A record is the loopback address', async () => {
    const fetchImpl = vi.fn()
    await expect(
      safeFetch('https://localtest.me/c.ics', {}, {
        fetchImpl,
        resolveHost: resolverFor({ 'localtest.me': ['127.0.0.1'] })
      })
    ).rejects.toThrow('拒绝访问内网地址')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses a name whose AAAA record is loopback', async () => {
    const fetchImpl = vi.fn()
    await expect(
      safeFetch('https://lvh.me/c.ics', {}, {
        fetchImpl,
        resolveHost: resolverFor({ 'lvh.me': ['::1'] })
      })
    ).rejects.toThrow('拒绝访问内网地址')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('judges every answer, not just the first, so a mixed record set cannot win', async () => {
    const fetchImpl = vi.fn()
    await expect(
      safeFetch('https://dual.example.com/c.ics', {}, {
        fetchImpl,
        resolveHost: resolverFor({ 'dual.example.com': [PUBLIC_V4, '10.0.0.7'] })
      })
    ).rejects.toThrow('拒绝访问内网地址')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses when the name does not resolve at all', async () => {
    const fetchImpl = vi.fn()
    await expect(
      safeFetch('https://missing.example.com/c.ics', {}, {
        fetchImpl,
        resolveHost: resolverFor({})
      })
    ).rejects.toThrow('域名解析失败')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses when the resolver hangs instead of falling back to the OS', async () => {
    const fetchImpl = vi.fn()
    let settled = 0
    await expect(
      safeFetch('https://slow.example.com/c.ics', {}, {
        fetchImpl,
        dnsTimeoutMs: 10,
        resolveHost: () => new Promise(() => {
          settled += 1
        })
      })
    ).rejects.toThrow('域名解析失败')
    expect(settled).toBe(1)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('passes a host whose answers are all public', async () => {
    const resolveHost = vi.fn(async () => [{ address: PUBLIC_V4, family: 4 }])
    await expect(assertPublicHost('feeds.example.com', { resolveHost })).resolves.toBeUndefined()
    expect(resolveHost).toHaveBeenCalledWith('feeds.example.com')
  })
})

describe('safeFetch', () => {
  it('returns the response for a public URL', async () => {
    const fetchImpl = vi.fn(async () => htmlResponse('<p>ok</p>'))
    const response = await safeFetch('https://feeds.example.com/c.ics', { headers: { accept: 'text/calendar' } }, {
      fetchImpl,
      resolveHost: resolverFor({ 'feeds.example.com': [PUBLIC_V4] })
    })
    expect(response.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    // Manual, because `follow` would issue the redirect before the check runs.
    expect(init.redirect).toBe('manual')
  })

  it('refuses a 302 that points at the loopback address, without requesting it', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'https://feeds.example.com/c.ics') {
        return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8080/c.ics' } })
      }
      return htmlResponse('BEGIN:VCALENDAR')
    })
    await expect(
      safeFetch('https://feeds.example.com/c.ics', {}, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        resolveHost: resolverFor({ 'feeds.example.com': [PUBLIC_V4] })
      })
    ).rejects.toThrow('重定向到不允许的地址')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('re-checks the resolver on every hop, not only the first URL', async () => {
    const resolveHost = vi.fn(async (host: string) => {
      if (host === 'feeds.example.com') return [{ address: PUBLIC_V4, family: 4 }]
      if (host === 'cdn.example.net') return [{ address: '198.51.100.7', family: 4 }]
      throw new Error(`unexpected ${host}`)
    })
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'https://feeds.example.com/c.ics') {
        return new Response(null, { status: 301, headers: { location: 'https://cdn.example.net/c.ics' } })
      }
      return htmlResponse('BEGIN:VCALENDAR')
    })
    const response = await safeFetch('https://feeds.example.com/c.ics', {}, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveHost
    })
    expect(response.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(resolveHost.mock.calls.map((call) => call[0])).toEqual(['feeds.example.com', 'cdn.example.net'])
  })

  it('refuses a redirect whose host resolves into the LAN', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'https://feeds.example.com/c.ics') {
        return new Response(null, { status: 302, headers: { location: 'https://intranet.example.com/c.ics' } })
      }
      return htmlResponse('secret')
    })
    await expect(
      safeFetch('https://feeds.example.com/c.ics', {}, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        resolveHost: resolverFor({
          'feeds.example.com': [PUBLIC_V4],
          'intranet.example.com': ['192.168.1.10']
        })
      })
    ).rejects.toThrow('拒绝访问内网地址')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('stops a redirect loop instead of following it forever', async () => {
    let hop = 0
    const fetchImpl = vi.fn(async () => {
      hop += 1
      return new Response(null, { status: 302, headers: { location: `https://feeds.example.com/${hop}` } })
    })
    await expect(
      safeFetch('https://feeds.example.com/0', {}, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        resolveHost: resolverFor({ 'feeds.example.com': [PUBLIC_V4] }),
        maxRedirects: 2
      })
    ).rejects.toThrow('重定向次数过多')
    expect(hop).toBe(3)
  })

  it('refuses a landing URL the transport produced on its own', async () => {
    const fetchImpl = vi.fn(async () => htmlResponse('secret', 'http://169.254.169.254/latest/meta-data/'))
    await expect(
      safeFetch('https://feeds.example.com/c.ics', {}, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        resolveHost: resolverFor({ 'feeds.example.com': [PUBLIC_V4] })
      })
    ).rejects.toThrow('重定向到不允许的地址')
  })

  it('reports a transport failure as one sentence, not a stack', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET')
    })
    await expect(
      safeFetch('https://feeds.example.com/c.ics', {}, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        resolveHost: resolverFor({ 'feeds.example.com': [PUBLIC_V4] })
      })
    ).rejects.toThrow('抓取失败：ECONNRESET')
  })

  it('skips only the address check when asked, keeping the URL check', async () => {
    const fetchImpl = vi.fn(async () => htmlResponse('ok'))
    const response = await safeFetch('https://fictional.test/c.ics', {}, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      skipAddressCheck: true
    })
    expect(response.status).toBe(200)
    await expect(
      safeFetch('http://127.0.0.1/c.ics', {}, { fetchImpl: fetchImpl as unknown as typeof fetch, skipAddressCheck: true })
    ).rejects.toThrow('拒绝访问内网地址')
  })
})
