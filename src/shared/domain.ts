/**
 * Site-level routing helpers (REQ-18).
 *
 * The reference product routes on the browser's URL, which it reads from its own
 * context helper. We read the focused window instead, so a site is only
 * identifiable when the window title exposes one — which is the common case for
 * electron apps, PWAs, and document tabs (`design doc — notion.so`), and rare for
 * plain Chrome windows (`标题 - Google Chrome`). The matching itself is therefore
 * deliberately tolerant: a rule may name a bare domain, a subdomain, or a
 * `*.domain` wildcard, and any of those beats a plain title substring rule.
 */

/** Extensions that look like top-level domains but are file names in a title. */
const FILE_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'pdf',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'rtf', 'odt',
  'exe', 'msi', 'dmg', 'pkg', 'deb', 'rpm', 'apk', 'zip', 'rar', '7z', 'tar', 'gz',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'yml', 'yaml', 'toml', 'ini', 'cfg',
  'log', 'lock', 'map', 'css', 'scss', 'less', 'html', 'htm', 'xml', 'sql',
  'py', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'php', 'sh',
  'mp3', 'mp4', 'wav', 'mov', 'avi', 'mkv', 'flac', 'ogg', 'webm'
])

const HOST_RE = /^(?:[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?\.)+[a-z]{2,24}$/i
const TRAILING_PUNCT = /[.,;:!?)\]}»"'”’、。，；：！？）】》]+$/u

/** Drops scheme, credentials, port, path, query, and a leading `www.`. */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null
  let text = input.trim().toLowerCase()
  if (!text) return null
  text = text.replace(TRAILING_PUNCT, '')
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(text)) {
    try {
      const host = new URL(text).hostname.toLowerCase()
      return host ? stripWww(host) : null
    } catch {
      return null
    }
  }
  text = text.replace(/^\/\//, '')
  const host = text.split(/[/?#]/)[0] ?? ''
  const bare = host.replace(/^[^@]*@/, '').replace(/:\d+$/, '')
  if (!HOST_RE.test(bare)) return null
  const tld = bare.slice(bare.lastIndexOf('.') + 1)
  if (FILE_EXTENSIONS.has(tld)) return null
  return stripWww(bare)
}

function stripWww(host: string): string {
  return host.startsWith('www.') ? host.slice(4) : host
}

/**
 * Finds a domain inside arbitrary window text: a URL, a bare host, or a host
 * with a path. Returns the first plausible one, `null` when the title carries
 * no domain at all.
 */
export function extractDomain(text: string | null | undefined): string | null {
  if (typeof text !== 'string' || !text) return null

  const asUrl = /\b[a-z][a-z0-9+.-]*:\/\/[^\s]+/i.exec(text)
  if (asUrl) {
    const domain = normalizeDomain(asUrl[0])
    if (domain) return domain
  }

  for (const token of text.split(/[\s|·•—–\-–/\\()[\]{}<>"'，。、；：！？（）【】《》]+/u)) {
    if (!token || token.length < 4) continue
    if (!token.includes('.')) continue
    // Versions and decimals (`1.2`, `v2.10.3`) are not domains.
    if (/^\d+(?:\.\d+)+$/.test(token)) continue
    const domain = normalizeDomain(token)
    if (domain) return domain
  }
  return null
}

/**
 * Splits a typed matcher into the field it belongs to. A rule row has one input,
 * because asking a user to choose between "keyword" and "domain" is a worse
 * question than accepting either: `github.com` becomes a site rule, `dsh`
 * becomes a title substring, and `*.notion.so` stays a wildcard site rule.
 */
export function parseMatcher(input: string | null | undefined): {
  match: string
  domain: string
} {
  const text = typeof input === 'string' ? input.trim() : ''
  if (!text) return { match: '', domain: '' }
  if (text.startsWith('*.')) {
    const wildcard = normalizeDomain(text.slice(2))
    return wildcard ? { match: '', domain: `*.${wildcard}` } : { match: text, domain: '' }
  }
  const domain = normalizeDomain(text)
  if (domain) return { match: '', domain }
  return { match: text, domain: '' }
}

/**
 * True when `actual` is the rule's domain or a subdomain of it. `*.example.com`
 * additionally requires at least one label in front of the rule domain.
 */
export function matchDomain(
  rule: string | null | undefined,
  actual: string | null | undefined
): boolean {
  const wanted = normalizeDomain(typeof rule === 'string' ? rule.replace(/^\*\./, '') : rule)
  const seen = normalizeDomain(actual)
  if (!wanted || !seen) return false
  if (seen === wanted) {
    return !(typeof rule === 'string' && rule.trim().startsWith('*.'))
  }
  return seen.endsWith(`.${wanted}`)
}
