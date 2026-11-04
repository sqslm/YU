import fs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { countMarker, ensureWrapper, sha256, WRAPPER_MARKER, WRAPPER_SOURCE, wrapperPath, wrapperSha256 } from './diagnostic-entry.mjs'

const root = mkdtempSync(join(tmpdir(), 'typeless-wrapper-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** Run the wrapper as CommonJS against a fake electron module and a fake entry. */
function runWrapper({ calls }) {
  const logs = []
  const app = {}
  const requireStub = (id) => {
    if (id === 'electron') return { app }
    if (id === './index.js') {
      calls.push(app)
      return {}
    }
    throw new Error(`unexpected require(${id})`)
  }
  // eslint-disable-next-line no-new-func
  new Function('require', 'console', WRAPPER_SOURCE)(requireStub, { log: (line) => logs.push(line) })
  return { app, logs }
}

describe('diagnostic wrapper source', () => {
  it('is fixed text without a timestamp', () => {
    expect(WRAPPER_SOURCE).toContain(`require('./index.js')`)
    expect(WRAPPER_SOURCE).toContain(WRAPPER_MARKER)
    expect(WRAPPER_SOURCE).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    expect(wrapperSha256()).toBe(sha256(WRAPPER_SOURCE))
    expect(wrapperSha256()).toMatch(/^[0-9a-f]{64}$/)
  })

  it('suppresses the login-item write and keeps a real entry loading afterwards', () => {
    const calls = []
    const { app, logs } = runWrapper({ calls })
    expect(calls).toHaveLength(1)
    expect(typeof calls[0]).toBe('object')
    expect(logs).toEqual([])

    // What src/main/index.ts does on every start, with the default setting
    // (openAtLogin === false, which would *remove* the Run entry).
    expect(() => app.setLoginItemSettings({ name: 'typeless-rebuild', openAtLogin: false, args: ['--background'] })).not.toThrow()
    expect(() => app.setLoginItemSettings({ name: 'typeless-rebuild', openAtLogin: true, args: ['--background'] })).not.toThrow()
    expect(logs).toEqual([WRAPPER_MARKER, WRAPPER_MARKER])
    expect(countMarker(logs.join('\n'))).toBe(2)
  })

  it('still loads the entry when the replacement cannot be installed', () => {
    const entry = { loaded: false }
    const logs = []
    const frozen = Object.freeze({ setLoginItemSettings() {} })
    const requireStub = (id) => {
      if (id === 'electron') return { app: frozen }
      if (id === './index.js') {
        entry.loaded = true
        return {}
      }
      throw new Error(`unexpected require(${id})`)
    }
    // eslint-disable-next-line no-new-func
    new Function('require', 'console', WRAPPER_SOURCE)(requireStub, { log: (line) => logs.push(line) })
    expect(entry.loaded).toBe(true)
    expect(logs).toEqual([])
  })
})

describe('ensureWrapper', () => {
  it('writes the wrapper under out/main and is idempotent', () => {
    const first = ensureWrapper(root)
    expect(first.file).toBe('out/main/diagnostic-entry.cjs')
    expect(first.written).toBe(true)
    expect(wrapperPath(root).endsWith(join('out', 'main', 'diagnostic-entry.cjs'))).toBe(true)
    expect(fs.readFileSync(first.absolutePath, 'utf8')).toBe(WRAPPER_SOURCE)
    expect(sha256(fs.readFileSync(first.absolutePath))).toBe(first.sha256)

    const second = ensureWrapper(root)
    expect(second.written).toBe(false)
    expect(second.sha256).toBe(first.sha256)
  })

  it('rewrites a wrapper that drifted', () => {
    fs.writeFileSync(wrapperPath(root), '// stale\n', 'utf8')
    const result = ensureWrapper(root)
    expect(result.written).toBe(true)
    expect(fs.readFileSync(wrapperPath(root), 'utf8')).toBe(WRAPPER_SOURCE)
  })
})
