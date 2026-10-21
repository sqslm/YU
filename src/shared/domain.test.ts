import { describe, expect, it } from 'vitest'
import { extractDomain, matchDomain, normalizeDomain, parseMatcher } from './domain'

describe('normalizeDomain', () => {
  it('keeps a bare host and lowercases it', () => {
    expect(normalizeDomain('Notion.SO')).toBe('notion.so')
  })

  it('strips scheme, port, path, query, and www', () => {
    expect(normalizeDomain('https://www.github.com:443/a/b?c=1')).toBe('github.com')
  })

  it('strips trailing punctuation', () => {
    expect(normalizeDomain('example.com,')).toBe('example.com')
    expect(normalizeDomain('example.com）。')).toBe('example.com')
  })

  it('rejects file names that look like domains', () => {
    expect(normalizeDomain('notes.md')).toBeNull()
    expect(normalizeDomain('build.log')).toBeNull()
    expect(normalizeDomain('photo.jpeg')).toBeNull()
  })

  it('rejects garbage and empty input', () => {
    expect(normalizeDomain('')).toBeNull()
    expect(normalizeDomain('   ')).toBeNull()
    expect(normalizeDomain('localhost')).toBeNull()
    expect(normalizeDomain(undefined)).toBeNull()
  })
})

describe('extractDomain', () => {
  it('reads a host out of a url embedded in prose', () => {
    expect(extractDomain('看这个 https://www.notion.so/page 很好')).toBe('notion.so')
  })

  it('reads a bare host from an app window title', () => {
    expect(extractDomain('设计稿 — figma.com')).toBe('figma.com')
    expect(extractDomain('Pull requests · github.com/org/repo')).toBe('github.com')
  })

  it('prefers an explicit url over a bare token', () => {
    expect(extractDomain('docs https://docs.example.com/x — other.example.com')).toBe(
      'docs.example.com'
    )
  })

  it('ignores versions, decimals, and file names', () => {
    expect(extractDomain('v2.10.3 release notes')).toBeNull()
    expect(extractDomain('README.md — 编辑器')).toBeNull()
    expect(extractDomain('未命名 - Notepad')).toBeNull()
  })

  it('returns null for empty or non-string input', () => {
    expect(extractDomain('')).toBeNull()
    expect(extractDomain(null)).toBeNull()
  })
})

describe('matchDomain', () => {
  it('matches the bare domain and its subdomains', () => {
    expect(matchDomain('notion.so', 'notion.so')).toBe(true)
    expect(matchDomain('notion.so', 'www.notion.so')).toBe(true)
    expect(matchDomain('notion.so', 'team.notion.so')).toBe(true)
  })

  it('does not match an unrelated domain that merely ends with the same text', () => {
    expect(matchDomain('notion.so', 'notnotion.so')).toBe(false)
    expect(matchDomain('example.com', 'example.com.evil.test')).toBe(false)
  })

  it('requires a subdomain for a wildcard rule', () => {
    expect(matchDomain('*.example.com', 'a.example.com')).toBe(true)
    expect(matchDomain('*.example.com', 'example.com')).toBe(false)
  })

  it('accepts a rule written as a url and an actual written as one', () => {
    expect(matchDomain('https://www.github.com/x', 'https://github.com/y')).toBe(true)
  })

  it('is false when either side is unusable', () => {
    expect(matchDomain('', 'github.com')).toBe(false)
    expect(matchDomain('github.com', '')).toBe(false)
    expect(matchDomain('github.com', 'README.md')).toBe(false)
  })
})

describe('parseMatcher', () => {
  it('sends a bare keyword to match and leaves domain empty', () => {
    expect(parseMatcher('dsh')).toEqual({ match: 'dsh', domain: '' })
    expect(parseMatcher('  Visual Studio Code  ')).toEqual({
      match: 'Visual Studio Code',
      domain: ''
    })
  })

  it('sends a host or url to domain, normalised', () => {
    expect(parseMatcher('github.com')).toEqual({ match: '', domain: 'github.com' })
    expect(parseMatcher('https://www.GitHub.com/x')).toEqual({ match: '', domain: 'github.com' })
    expect(parseMatcher('notion.so:443')).toEqual({ match: '', domain: 'notion.so' })
  })

  it('keeps a wildcard prefix instead of stripping it', () => {
    expect(parseMatcher('*.example.com')).toEqual({ match: '', domain: '*.example.com' })
  })

  it('falls back to a keyword when the text only looks like a file name', () => {
    expect(parseMatcher('README.md')).toEqual({ match: 'README.md', domain: '' })
  })

  it('returns empty for blank input', () => {
    expect(parseMatcher('   ')).toEqual({ match: '', domain: '' })
    expect(parseMatcher(null)).toEqual({ match: '', domain: '' })
  })
})
