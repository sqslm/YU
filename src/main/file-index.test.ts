import { describe, expect, it } from 'vitest'
import { deflateRawSync } from 'node:zlib'
import { join, sep } from 'node:path'
import {
  FileIndex, MAX_FILE_BYTES, compileTokens, decodePlainText, defaultRoots, documentText,
  escapeRegExp, listZipEntries, officeText, snippetAround, stripXmlText,
  type DirEntry, type FileIndexDeps
} from './file-index'

const at = (...parts: string[]): string => join(...parts)
const ROOT = at('C:', 'docs')
const HOME = at('C:', 'Users', 'me')

interface FakeFile {
  text?: string
  bytes?: Uint8Array
  mtimeMs?: number
  /** Reported size override; lets a test claim "too large" without allocating. */
  size?: number
  /** Directory marker for a folder that holds no files of its own. */
  dir?: boolean
  symlink?: boolean
  /** readFile rejects, like a locked file. */
  deny?: boolean
}
type Tree = Record<string, FakeFile>

/** No byte-order marks are implied: readers must honour the real prefix. */
const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

/** In-memory file system, keyed by full path; directories are inferred. */
function mount(tree: Tree, options: { home?: string; now?: () => number } = {}): { deps: FileIndexDeps; reads: string[] } {
  const reads: string[] = []
  const locate = (path: string): FakeFile | undefined => {
    const exact = tree[path]
    if (exact) return exact
    const key = Object.keys(tree).find(candidate => candidate.toLowerCase() === path.toLowerCase())
    return key ? tree[key] : undefined
  }
  const deps: FileIndexDeps = {
    readdir: async (path): Promise<DirEntry[]> => {
      const prefix = path.endsWith(sep) ? path : path + sep
      const children = new Map<string, boolean>()
      for (const [key, file] of Object.entries(tree)) {
        if (!key.toLowerCase().startsWith(prefix.toLowerCase())) continue
        const rest = key.slice(prefix.length)
        if (!rest) continue
        const head = rest.split(sep)[0]
        children.set(head, (children.get(head) ?? false) || rest.includes(sep) || file.dir === true)
      }
      return [...children].map(([name, isDirectory]) => {
        const entry = locate(at(path, name))
        return { name, isFile: !isDirectory, isDirectory, isSymbolicLink: entry?.symlink === true }
      })
    },
    stat: async path => {
      const file = locate(path)
      if (!file) throw new Error(`ENOENT ${path}`)
      return {
        isFile: file.dir !== true,
        isDirectory: file.dir === true,
        size: file.size ?? file.bytes?.length ?? encode(file.text ?? '').length,
        mtimeMs: file.mtimeMs ?? 0
      }
    },
    readFile: async path => {
      const file = locate(path)
      if (!file || file.deny) throw new Error(`EACCES ${path}`)
      reads.push(path)
      return file.bytes ?? encode(file.text ?? '')
    },
    homeDir: () => options.home ?? HOME,
    now: options.now ?? (() => 0)
  }
  return { deps, reads }
}

/** Minimal zip writer: enough for the OOXML reader, not a general archiver. */
function zipBytes(files: Record<string, string>, method: 0 | 8 = 8): Uint8Array {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8')
    const body = method === 8 ? deflateRawSync(data) : data
    const nameBytes = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    locals.push(local, nameBytes, body)
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0x0800, 8)
    header.writeUInt16LE(method, 10)
    header.writeUInt32LE(body.length, 20)
    header.writeUInt32LE(data.length, 24)
    header.writeUInt16LE(nameBytes.length, 28)
    header.writeUInt32LE(offset, 42)
    central.push(header, nameBytes)
    offset += 30 + nameBytes.length + body.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...locals, directory, end]))
}

const docx = (body: string): Uint8Array => zipBytes({
  '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
  'word/document.xml': `<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`
})

describe('literal matching', () => {
  it('matches regex metacharacters as characters instead of patterns', () => {
    const [token] = compileTokens('报告(终稿)')
    expect(token.test('这是报告(终稿)的说明')).toBe(true)
    expect(token.test('这是报告终稿的说明')).toBe(false)
    // A stray quantifier used to throw at RegExp construction time.
    expect(() => compileTokens('a*b(c[d')).not.toThrow()
    expect(compileTokens('a*b(c[d')[0].test('x a*b(c[d y')).toBe(true)
  })
  it('splits one token per word, keeps at most six and ignores case', () => {
    expect(compileTokens('  One   two ').map(token => token.source)).toEqual(['One', 'two'])
    expect(compileTokens('a b c d e f g h').length).toBe(6)
    expect(compileTokens('')[0]).toBeUndefined()
  })
  it('escapes only what a pattern would misread', () => {
    expect(escapeRegExp('a.b*c')).toBe('a\\.b\\*c')
    expect(escapeRegExp('路径/文档')).toBe('路径/文档')
  })
})

describe('plain text decoding', () => {
  it('decodes utf-8 with and without a byte-order mark', () => {
    expect(decodePlainText(encode('营收增长'))).toBe('营收增长')
    expect(decodePlainText(new Uint8Array([0xef, 0xbb, 0xbf, ...encode('营收')]))).toBe('营收')
  })
  it('honours the utf-16le mark before sniffing for binary', () => {
    // Every second byte of a UTF-16LE body is NUL: sniffing first loses the file.
    const body = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('季度报告', 'utf16le')])
    expect(decodePlainText(new Uint8Array(body))).toBe('季度报告')
  })
  it('treats a NUL byte as binary', () => {
    expect(decodePlainText(new Uint8Array([0x50, 0x4b, 0x03, 0x00, 0x00, 0x41]))).toBeNull()
    expect(decodePlainText(new Uint8Array())).toBe('')
  })
})

describe('office containers', () => {
  it('reads paragraphs as separate lines so cells never fuse into a fake phrase', () => {
    const text = stripXmlText('<w:p><w:r><w:t>Alpha</w:t></w:r></w:p><w:p><w:r><w:t>Beta</w:t></w:r></w:p>')
    expect(text).toBe('Alpha\nBeta')
    // Cells become a whitespace boundary, never a joined word.
    expect(stripXmlText('<c><v>甲</v></c><c><v>乙</v></c>')).toBe('甲 乙')
  })
  it('decodes entities and collapses the whitespace XML leaves behind', () => {
    expect(stripXmlText('<a:r><a:t>R&amp;D&nbsp;预算</a:t></a:r>')).toBe('R&D 预算')
    expect(stripXmlText('<!-- hidden --><w:t>可见</w:t>')).toBe('可见')
    expect(stripXmlText('&#x62A5;&#21578;')).toBe('报告')
  })
  it('pulls the body out of a deflated docx and out of a stored one', () => {
    expect(officeText(docx('<w:p><w:r><w:t>季度复盘</w:t></w:r></w:p>'), '.docx')).toContain('季度复盘')
    expect(officeText(zipBytes({ 'word/document.xml': '<w:t>存储模式</w:t>' }, 0), '.docx')).toContain('存储模式')
    expect(officeText(zipBytes({ 'word/footnotes.xml': '<w:t>脚注正文</w:t>' }), '.docx')).toContain('脚注正文')
  })
  it('reads shared strings and cells of a workbook', () => {
    const bytes = zipBytes({
      'xl/sharedStrings.xml': '<sst><si><t>营收</t></si></sst>',
      'xl/worksheets/sheet1.xml': '<worksheet><row><c><v>42</v></c></row></worksheet>'
    })
    const text = officeText(bytes, '.xlsx') ?? ''
    expect(text).toContain('营收')
    expect(text).toContain('42')
  })
  it('reads slides in numeric order', () => {
    const bytes = zipBytes({
      'ppt/slides/slide10.xml': '<a:p><a:t>第十页</a:t></a:p>',
      'ppt/slides/slide2.xml': '<a:p><a:t>第二页</a:t></a:p>'
    })
    const text = officeText(bytes, '.pptx') ?? ''
    expect(text.indexOf('第二页')).toBeLessThan(text.indexOf('第十页'))
  })
  it('refuses a container that is not a zip instead of inventing text', () => {
    expect(officeText(encode('plain text pretending to be docx'), '.docx')).toBeNull()
    expect(() => listZipEntries(encode('nope'))).toThrow()
    expect(documentText(new Uint8Array([0x00, 0x01]), '.txt')).toBeNull()
  })
})

describe('snippets', () => {
  it('stays on one line and marks the cut edges', () => {
    const text = `${'前'.repeat(200)}关键词${'后'.repeat(200)}`
    const snippet = snippetAround(text, 200, 3)
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
    expect(snippet).toContain('关键词')
    expect(snippet).not.toContain('\n')
    expect(snippetAround('开头关键词结尾', 2, 3)).toBe('开头关键词结尾')
  })
})

describe('content search over a bounded tree', () => {
  const tree = (): Tree => ({
    [at(ROOT, 'a.txt')]: { text: '会议纪要：下季度预算需要复核', mtimeMs: Date.parse('2026-10-01T00:00:00Z') },
    [at(ROOT, 'b.md')]: { text: '# 笔记\n下季度预算已通过', mtimeMs: Date.parse('2026-10-05T00:00:00Z') },
    [at(ROOT, 'c.txt')]: { text: '只有下季度，没有另一个词', mtimeMs: Date.parse('2026-10-03T00:00:00Z') },
    [at(ROOT, 'binary.txt')]: { bytes: new Uint8Array([0x41, 0x00, 0x42]) },
    [at(ROOT, 'scan.pdf')]: { text: '下季度预算' },
    [at(ROOT, 'node_modules', 'skip.txt')]: { text: '下季度预算' },
    [at(ROOT, 'nested', 'deeper', 'doc.txt')]: { text: '下季度预算 在子目录里', mtimeMs: Date.parse('2026-10-04T00:00:00Z') },
    [at(ROOT, 'locked.txt')]: { text: '下季度预算', deny: true }
  })

  it('finds bodies, newest first, with a real path, size and snippet', async () => {
    const { deps } = mount(tree())
    const result = await new FileIndex(deps).search({ query: '下季度预算', roots: [ROOT] })
    expect(result.hits.map(hit => hit.name)).toEqual(['b.md', 'doc.txt', 'a.txt'])
    const [first] = result.hits
    expect(first).toMatchObject({ name: 'b.md', path: at(ROOT, 'b.md'), modifiedAt: '2026-10-05T00:00:00.000Z' })
    expect(first.size).toBe(encode('# 笔记\n下季度预算已通过').length)
    expect(first.snippet).toContain('下季度预算')
    expect(result.truncated).toBe(false)
    expect(result.reason).toBe('')
  })
  it('requires every word, like a search phrase rather than an OR', async () => {
    const { deps } = mount(tree())
    const result = await new FileIndex(deps).search({ query: '下季度预算 复核', roots: [ROOT] })
    expect(result.hits.map(hit => hit.name)).toEqual(['a.txt'])
  })
  it('does not read or reuse cached content from an excluded directory',async()=>{
    const {deps,reads}=mount(tree()),index=new FileIndex(deps)
    await index.search({query:'下季度预算',roots:[ROOT]})
    const before=reads.length
    const result=await index.search({query:'下季度预算',roots:[ROOT],pathAllowed:async path=>!path.includes(`${sep}nested`)})
    expect(result.hits.map(hit=>hit.name)).not.toContain('doc.txt')
    expect(reads.slice(before).some(path=>path.includes(`${sep}nested`))).toBe(false)
  })
  it('counts binary, unsupported and unreadable files instead of hiding them', async () => {
    const { deps } = mount(tree())
    const result = await new FileIndex(deps).search({ query: '下季度预算', roots: [ROOT] })
    expect(result.skipped.binary).toBe(1)
    // This fixture only carries plain bytes under a PDF suffix: parsing must fail.
    expect(result.skipped.unsupported).toBe(0)
    expect(result.skipped.unreadable).toBe(2)
    expect(result.hits.some(hit => hit.path.endsWith('.pdf'))).toBe(false)
  })
  it('never walks into node_modules, and never follows a symlink', async () => {
    const files = tree()
    files[at(ROOT, 'link')] = { symlink: true }
    const { deps, reads } = mount(files)
    await new FileIndex(deps).search({ query: '下季度预算', roots: [ROOT] })
    expect(reads.some(path => path.includes('node_modules'))).toBe(false)
  })
  it('skips a file above the single-file ceiling', async () => {
    const files: Tree = { [at(ROOT, 'huge.txt')]: { text: 'x', size: MAX_FILE_BYTES + 1 } }
    const { deps } = mount(files)
    const result = await new FileIndex(deps).search({ query: 'x', roots: [ROOT] })
    expect(result.skipped.tooLarge).toBe(1)
    expect(result.hits).toEqual([])
  })
  it('stops at the requested result count and says why', async () => {
    const files: Tree = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [at(ROOT, `${index}.txt`), { text: '预算' }]))
    const { deps } = mount(files)
    const result = await new FileIndex(deps).search({ query: '预算', roots: [ROOT], limit: 2 })
    expect(result.hits).toHaveLength(2)
    expect(result.truncated).toBe(true)
    expect(result.reason).toBe('result-limit')
  })
  it('stops at the file budget so a huge folder cannot be walked', async () => {
    const files: Tree = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [at(ROOT, `${index}.txt`), { text: '没有这个词' }]))
    const { deps } = mount(files)
    const result = await new FileIndex(deps).search({ query: '别的', roots: [ROOT], maxFiles: 2 })
    expect(result.scanned).toBe(2)
    expect(result.reason).toBe('file-limit')
  })
  it('returns the part it already found when the time budget expires', async () => {
    let clock = 0
    const files: Tree = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [at(ROOT, `${index}.txt`), { text: '关键词' }]))
    // Each observation is 100 ms later, so a 450 ms budget lapses mid-walk.
    const { deps } = mount(files, { now: () => (clock += 100) })
    const result = await new FileIndex(deps).search({ query: '关键词', roots: [ROOT], timeoutMs: 450 })
    expect(result.truncated).toBe(true)
    expect(result.reason).toBe('timeout')
    expect(result.hits.length).toBeGreaterThanOrEqual(1)
    expect(result.scanned).toBeLessThan(6)
    expect(result.elapsedMs).toBeGreaterThan(0)
  })
  it('reuses a parsed body while mtime and size are unchanged, then re-reads it', async () => {
    const files = tree()
    const { deps, reads } = mount(files)
    const index = new FileIndex(deps)
    const first = await index.search({ query: '下季度预算', roots: [ROOT] })
    expect(first.cache.misses).toBeGreaterThan(0)
    expect(first.cache.hits).toBe(0)
    const before = reads.length
    const second = await index.search({ query: '下季度预算', roots: [ROOT] })
    // Binary, invalid PDF and locked files are re-examined (3 misses)
    // while every real body comes from the cache.
    expect(second.cache.hits).toBe(first.cache.misses - 3)
    expect(second.cache.misses).toBe(3)
    // Binary and invalid PDF bodies are read again; the locked read is refused.
    expect(reads.length).toBe(before + 2)
    expect(index.size).toBeGreaterThan(0)

    files[at(ROOT, 'a.txt')] = { text: '会议纪要：预算口径变了', mtimeMs: Date.parse('2026-10-09T00:00:00Z') }
    const third = await index.search({ query: '预算口径', roots: [ROOT] })
    expect(third.hits.map(hit => hit.name)).toEqual(['a.txt'])
    expect(reads.length).toBeGreaterThan(before)
  })
  it('refreshes on demand and clears on request', async () => {
    const { deps, reads } = mount(tree())
    const index = new FileIndex(deps)
    await index.search({ query: '下季度预算', roots: [ROOT] })
    const before = reads.length
    await index.search({ query: '下季度预算', roots: [ROOT], refresh: true })
    expect(reads.length).toBeGreaterThan(before)
    index.clear()
    expect(index.size).toBe(0)
  })
  it('keeps the cache bounded no matter how many files were scanned', async () => {
    const files: Tree = Object.fromEntries(Array.from({ length: 210 }, (_, index) => [at(ROOT, `f${index}.txt`), { text: '正文' }]))
    const { deps } = mount(files)
    const index = new FileIndex(deps)
    const result = await index.search({ query: '压根不存在的词', roots: [ROOT], maxFiles: 400 })
    expect(result.scanned).toBe(210)
    expect(index.size).toBe(200)
  })
  it('treats a request with no words as an empty result and never reads the disk', async () => {
    const { deps, reads } = mount(tree())
    const result = await new FileIndex(deps).search({ query: '   ', roots: [ROOT] })
    expect(result).toMatchObject({ hits: [], scanned: 0, truncated: false })
    expect(reads).toEqual([])
  })
  it('defaults to Documents, Desktop and Downloads under the profile', async () => {
    const { deps } = mount({})
    const result = await new FileIndex(deps).search({ query: 'x' })
    expect(result.roots).toEqual(defaultRoots(HOME))
    expect(result.roots.every(root => root.startsWith(HOME))).toBe(true)
  })
  it('drops duplicate and nested roots so no folder is paid for twice', async () => {
    const { deps } = mount(tree())
    const result = await new FileIndex(deps).search({ query: '下季度预算', roots: [ROOT, `${ROOT}${sep}`, at(ROOT, 'nested')] })
    expect(result.roots).toEqual([ROOT])
  })
  it('survives an unreadable root and an abort mid-walk', async () => {
    const { deps } = mount({})
    const missing = await new FileIndex(deps).search({ query: 'x', roots: [at('C:', 'gone')] })
    expect(missing).toMatchObject({ hits: [], scanned: 0 })
    const controller = new AbortController()
    controller.abort()
    await expect(new FileIndex(mount(tree()).deps).search({ query: '下季度预算', roots: [ROOT], signal: controller.signal })).rejects.toThrow()
  })
  it('finds a phrase inside a real docx body', async () => {
    const files: Tree = {
      [at(ROOT, '复盘.docx')]: { bytes: docx('<w:p><w:r><w:t>本季度营收未达目标</w:t></w:r></w:p>'), mtimeMs: 1_000 }
    }
    const result = await new FileIndex(mount(files).deps).search({ query: '营收 目标', roots: [ROOT] })
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0].snippet).toContain('营收')
    expect(result.hits[0].name).toBe('复盘.docx')
  })
})

describe('module surface', () => {
  it('keeps the documented defaults', () => {
    expect(MAX_FILE_BYTES).toBe(8 * 1024 * 1024)
    expect(defaultRoots('')).toEqual([])
  })
})
