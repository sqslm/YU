#!/usr/bin/env node
/**
 * Self-check for tests/yu-v2/fixtures/uia-provider.ps1.
 *
 * For every fixture mode it:
 *   1. records GetForegroundWindow, starts the fixture, waits for the `ready` line;
 *   2. reads the tree through cross-process UI Automation (tests/yu-v2/fixtures/uia-tree.ps1)
 *      and asserts the controls the mode promises really are exposed;
 *   3. asserts GetForegroundWindow is unchanged (the fixture must never activate);
 *   4. sends `quit`, waits for the process to exit and checks the pid is gone.
 *
 * Every external call is bounded: a wedged UI Automation call cannot interrupt itself,
 * so the timeout is enforced from outside (spawnSync timeout / abort timer) and the
 * fixture is killed by its own pid instead of hanging the run.
 *
 * Usage:
 *   node scripts/uia-fixture-check.mjs                 # all modes
 *   node scripts/uia-fixture-check.mjs --only deep-40  # one mode
 *   node scripts/uia-fixture-check.mjs --helper        # also probe native/bin/yu-windows.exe
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixturesDir = path.join(repoRoot, 'tests', 'yu-v2', 'fixtures')
const fixtureScript = path.join(fixturesDir, 'uia-provider.ps1')
const treeScript = path.join(fixturesDir, 'uia-tree.ps1')
const foregroundScript = path.join(fixturesDir, 'uia-foreground.ps1')
const helperExe = path.join(repoRoot, 'native', 'bin', 'yu-windows.exe')
const bridgeScript = path.join(repoRoot, 'resources', 'windows-tools.ps1')

const POWERSHELL = 'powershell'
const PS_ARGS = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File']

const READY_TIMEOUT_MS = 30000
const COMMAND_TIMEOUT_MS = 15000
const TREE_TIMEOUT_MS = 30000
const EXIT_TIMEOUT_MS = 15000
const HELPER_TIMEOUT_MS = 30000

function runPowerShell(script, args = [], timeoutMs = COMMAND_TIMEOUT_MS) {
  const result = spawnSync(POWERSHELL, [...PS_ARGS, script, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  })
  if (result.error) {
    const code = result.error.code === 'ETIMEDOUT' ? 'timed out' : result.error.message
    throw new Error(`${path.basename(script)} ${code} after ${timeoutMs}ms`)
  }
  if (result.status !== 0) {
    throw new Error(`${path.basename(script)} exited ${result.status}: ${(result.stderr || '').trim()}`)
  }
  return result.stdout
}

const readForeground = () => runPowerShell(foregroundScript).trim()

function parseTree(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

class FixtureSession {
  static async launch(mode, extraArgs = []) {
    const child = spawn(POWERSHELL, [...PS_ARGS, fixtureScript, '-Mode', mode, ...extraArgs], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const session = new FixtureSession(mode, child)
    const ready = await session.next((event) => event.type === 'ready', READY_TIMEOUT_MS, 'ready')
    session.handle = ready.handle
    session.pid = ready.pid
    session.title = ready.title
    session.file = ready.file || null
    return session
  }

  constructor(mode, child) {
    this.mode = mode
    this.child = child
    this.pending = []
    this.waiters = []
    // Every event ever seen, for "what did this particular read touch?" assertions.
    this.log = []
    this.stderr = ''
    this.exit = null
    this.handle = null
    this.pid = null
    this.title = null

    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line) continue
        try {
          const event = JSON.parse(line)
          this.pending.push(event)
          this.log.push(event)
        } catch {
          this.stderr += `\nunparsable stdout line: ${line}`
        }
        this.pump()
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      this.stderr += chunk
    })
    child.on('exit', (code, signal) => {
      this.exit = { code, signal }
      this.pump()
    })
  }

  pump() {
    for (const waiter of this.waiters.slice()) {
      const index = this.pending.findIndex(waiter.predicate)
      if (index < 0) continue
      const [event] = this.pending.splice(index, 1)
      this.waiters.splice(this.waiters.indexOf(waiter), 1)
      clearTimeout(waiter.timer)
      waiter.resolve(event)
    }
  }

  next(predicate, timeoutMs, label) {
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: null }
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        const exitText = this.exit ? ` exit=${JSON.stringify(this.exit)}` : ''
        reject(
          new Error(
            `${this.mode}: no ${label} within ${timeoutMs}ms${exitText}${this.stderr ? `\nstderr: ${this.stderr.trim()}` : ''}`,
          ),
        )
      }, timeoutMs)
      this.waiters.push(waiter)
      this.pump()
    })
  }

  send(command) {
    this.child.stdin.write(Buffer.from(`${JSON.stringify(command)}\n`, 'utf8'))
  }

  async command(command, expectType, timeoutMs = COMMAND_TIMEOUT_MS) {
    this.send(command)
    return this.next((event) => event.type === expectType, timeoutMs, expectType)
  }

  async describe() {
    return this.command({ command: 'describe' }, 'describe')
  }

  async dumpTree() {
    return parseTree(runPowerShell(treeScript, ['-Handle', this.handle, '-MaxDepth', '64'], TREE_TIMEOUT_MS))
  }

  // The window must never take activation: sample the foreground a few times while
  // the fixture is alive. Other applications may grab the foreground during a run,
  // so only our own HWND appearing there is a failure.
  async sampleForeground(samples = 5, intervalMs = 120) {
    const seen = []
    for (let index = 0; index < samples; index += 1) {
      seen.push(readForeground().toLowerCase())
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
    return seen
  }

  ownsForeground(values) {
    const own = this.handle.toLowerCase()
    return values.includes(own)
  }

  async waitExit(timeoutMs = EXIT_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs
    while (!this.exit && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return this.exit
  }

  async close({ graceful = true } = {}) {
    if (!this.exit && graceful) {
      try {
        this.send({ command: 'quit' })
        await this.next((event) => event.type === 'quit', COMMAND_TIMEOUT_MS, 'quit')
      } catch (error) {
        this.stderr += `\n${error.message}`
      }
      await this.waitExit()
    }
    if (!this.exit) {
      // Bounded fallback: kill exactly the child we started, never by process name.
      this.child.kill()
      await this.waitExit(5000)
    }
    return this.exit
  }
}

function alivePid(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ---------- assertions ----------

function ancestors(tree, node) {
  return tree.filter((candidate) => node.path.startsWith(`${candidate.path}/`))
}

function hasAncestorType(tree, node, controlType) {
  return ancestors(tree, node).some((candidate) => candidate.controlType === controlType)
}

const controlTypeOf = (tree, controlType) => tree.filter((node) => node.controlType === controlType)
const sortedValues = (nodes) => nodes.map((node) => node.value).sort()

function checkMode(mode, tree) {
  const fails = []
  const expect = (condition, message) => {
    if (!condition) fails.push(message)
  }
  const expectCount = (nodes, expected, label) =>
    expect(
      nodes.length === expected,
      `${label}: expected ${expected}, got ${nodes.length}`,
    )
  const expectValue = (node, expected, label) =>
    expect(node && node.value === expected, `${label}: expected value ${expected}, got ${node && node.value}`)

  const root = tree.find((node) => node.depth === 0)
  expect(root !== undefined && root.controlType === 'Window', 'root element must be a Window')
  expect(tree.length > 0, 'tree dump is empty')

  const edits = controlTypeOf(tree, 'Edit')
  const combos = controlTypeOf(tree, 'ComboBox')
  const toolbars = controlTypeOf(tree, 'ToolBar')
  const documents = controlTypeOf(tree, 'Document')

  switch (mode) {
    case 'provider-error': // same tree as address-edit; the fault is injected in the provider
    case 'address-edit': {
      expectCount(edits, 1, 'Edit')
      const edit = edits[0]
      expect(edit && edit.automationId === 'addressEditBox', 'Edit automationId must be addressEditBox')
      expect(edit && edit.name === 'Address and search bar', 'Edit name must be "Address and search bar"')
      expectValue(edit, 'https://example.com/a', 'Edit')
      expect(edit && edit.isPassword === false && edit.isOffscreen === false, 'Edit must be visible and not a password field')
      expect(edit !== undefined && hasAncestorType(tree, edit, 'ToolBar'), 'Edit needs a ToolBar ancestor')
      expect(edit !== undefined && edit.depth === 2, `Edit depth must be 2, got ${edit && edit.depth}`)
      break
    }
    case 'address-combo': {
      expectCount(combos, 1, 'ComboBox')
      const combo = combos[0]
      expect(combo && combo.name === '地址和搜索栏', 'ComboBox name must be 地址和搜索栏')
      expectValue(combo, 'https://example.com/b', 'ComboBox')
      expect(combo !== undefined && hasAncestorType(tree, combo, 'ToolBar'), 'ComboBox needs a ToolBar ancestor')
      break
    }
    case 'no-candidate': {
      expectCount(edits, 0, 'Edit')
      expectCount(combos, 0, 'ComboBox')
      expect(toolbars.length >= 1, 'ToolBar must still be present')
      break
    }
    case 'duplicate': {
      expectCount(edits, 2, 'Edit')
      expect(sortedValues(edits).join('|') === 'https://example.com/c|https://example.com/c', 'both Edits must hold https://example.com/c')
      break
    }
    case 'ambiguous': {
      expectCount(edits, 2, 'Edit')
      expect(sortedValues(edits).join('|') === 'https://example.com/d|https://example.com/e', 'Edits must hold https://example.com/d and https://example.com/e')
      break
    }
    case 'document-overrides': {
      expectCount(edits, 1, 'Edit')
      expectValue(edits[0], 'https://example.com/f', 'Edit')
      expect(edits[0] !== undefined && hasAncestorType(tree, edits[0], 'ToolBar'), 'Edit needs a ToolBar ancestor')
      expectCount(documents, 1, 'Document')
      expectValue(documents[0], 'https://example.com/g', 'Document')
      expect(documents[0] && documents[0].isOffscreen === false, 'Document must be on screen')
      break
    }
    case 'document-ambiguous': {
      expectCount(documents, 2, 'Document')
      expect(new Set(documents.map((node) => node.value)).size === 2, 'the two Documents must carry different values')
      break
    }
    case 'pseudo-address': {
      expectCount(documents, 1, 'Document')
      const document = documents[0]
      const inside = edits.filter((node) => document && node.path.startsWith(`${document.path}/`))
      expectCount(inside, 1, 'Edit inside the Document')
      expect(inside[0] && inside[0].name === '地址和搜索栏', 'the pseudo address bar must be named 地址和搜索栏')
      expectValue(inside[0], 'https://evil.example/x', 'pseudo Edit')
      expect(inside[0] !== undefined && hasAncestorType(tree, inside[0], 'ToolBar'), 'pseudo Edit needs a ToolBar ancestor inside the Document')
      expect(document !== undefined && !edits.some((node) => !node.path.startsWith(`${document.path}/`)), 'no Edit may live outside the Document')
      break
    }
    case 'password': {
      expectCount(edits, 1, 'Edit')
      expect(edits[0] && edits[0].isPassword === true, 'Edit must report IsPassword=true')
      expectValue(edits[0], 'https://example.com/h', 'Edit')
      break
    }
    case 'offscreen': {
      expectCount(edits, 1, 'Edit')
      expect(edits[0] && edits[0].isOffscreen === true, 'Edit must report IsOffscreen=true')
      break
    }
    case 'file-url': {
      expectCount(edits, 1, 'Edit')
      expect(
        edits[0] !== undefined &&
          /^file:\/\/\/.*yu-uia-%E4%B8%AD%E6%96%87%20100%25%20[0-9a-f]{32}\.md$/i.test(edits[0].value || ''),
        `Edit value must be the fixture's file:// URI, got ${edits[0] && edits[0].value}`,
      )
      expect(edits[0] !== undefined && hasAncestorType(tree, edits[0], 'ToolBar'), 'Edit needs a ToolBar ancestor')
      break
    }
    case 'excluded-value-blocked': {
      expectCount(documents, 1, 'Document')
      expectCount(edits, 1, 'Edit')
      expect(edits[0] !== undefined && edits[0].name === '地址和搜索栏', `Edit name must be 地址和搜索栏, got ${edits[0] && edits[0].name}`)
      expectValue(edits[0], 'https://example.com/pseudo', 'Edit')
      expect(
        edits[0] !== undefined && hasAncestorType(tree, edits[0], 'Document'),
        'Edit must sit inside a Document so the ancestor walk stops before the window',
      )
      break
    }
    case 'no-value-pattern': {
      expectCount(edits, 1, 'Edit')
      expectCount(combos, 0, 'ComboBox')
      expect(
        edits[0] !== undefined && edits[0].hasValue === false,
        `Edit must expose no ValuePattern, got hasValue=${edits[0] && edits[0].hasValue}`,
      )
      expect(edits[0] !== undefined && hasAncestorType(tree, edits[0], 'ToolBar'), 'Edit needs a ToolBar ancestor')
      break
    }
    case 'metadata-document': {
      expectCount(documents, 1, 'Document')
      expectCount(edits, 0, 'Edit')
      expectCount(combos, 0, 'ComboBox')
      expectValue(documents[0], 'https://example.com/doc', 'Document')
      break
    }
    case 'metadata-override': {
      expectCount(edits, 1, 'Edit')
      expectValue(edits[0], 'https://example.com/from-bar', 'Edit')
      expect(edits[0] !== undefined && hasAncestorType(tree, edits[0], 'ToolBar'), 'Edit needs a ToolBar ancestor')
      expectCount(documents, 1, 'Document')
      expectValue(documents[0], 'https://example.com/from-doc', 'Document')
      break
    }
    case 'no-toolbar': {
      expectCount(edits, 1, 'Edit')
      expectValue(edits[0], 'https://example.com/j', 'Edit')
      expect(edits[0] !== undefined && !hasAncestorType(tree, edits[0], 'ToolBar'), 'Edit must have no ToolBar ancestor')
      break
    }
    case 'deep-40':
    case 'deep-41': {
      expectCount(edits, 1, 'Edit')
      const expectedDepth = mode === 'deep-40' ? 40 : 41
      expect(edits[0] !== undefined && edits[0].depth === expectedDepth, `Edit depth must be ${expectedDepth}, got ${edits[0] && edits[0].depth}`)
      expectValue(edits[0], `https://example.com/${mode}`, 'Edit')
      expect(edits[0] !== undefined && hasAncestorType(tree, edits[0], 'ToolBar'), 'Edit needs a ToolBar ancestor')
      break
    }
    case 'documents-20':
    case 'documents-21': {
      const expected = mode === 'documents-20' ? 20 : 21
      expectCount(documents, expected, 'Document')
      expect(documents.filter((node) => node.isOffscreen === false).length === expected, 'all Documents must be on screen')
      expect(documents.filter((node) => node.value === 'https://example.com/doc').length === 20, 'the first 20 Documents must share https://example.com/doc')
      if (expected === 21) expectValue(documents[20], 'https://example.com/late', 'Document 21')
      break
    }
    case 'edits-100':
    case 'edits-101': {
      const expected = mode === 'edits-100' ? 100 : 101
      expectCount(edits, expected, 'Edit')
      expect(edits.filter((node) => node.value === 'https://example.com/edit').length === 100, 'the first 100 Edits must share https://example.com/edit')
      if (expected === 101) expectValue(edits[100], 'https://example.com/late', 'Edit 101')
      expect(edits.every((node) => hasAncestorType(tree, node, 'ToolBar')), 'every Edit needs a ToolBar ancestor')
      break
    }
    default:
      fails.push(`no assertions defined for mode ${mode}`)
  }

  return fails
}

// ---------- the two readers under test ----------
//
// Both are driven with the SAME request shape, so any difference comes from the reader,
// not from the fixture. Stdin is written as a UTF-8 Buffer: PowerShell 5.1 pipeline
// encodings would corrupt non-ASCII titles.

function runReader(command, args, request, timeoutMs) {
  const result = spawnSync(command, args, {
    input: Buffer.from(JSON.stringify(request), 'utf8'),
    timeout: timeoutMs,
    windowsHide: true,
  })
  const stdout = result.stdout ? result.stdout.toString('utf8').trim() : ''
  const stderr = result.stderr ? result.stderr.toString('utf8').trim() : ''
  if (result.error) {
    const timedOut = result.error.code === 'ETIMEDOUT'
    return { ok: false, timedOut, status: null, stdout, stderr: stderr || result.error.message }
  }
  return { ok: result.status === 0, timedOut: false, status: result.status, stdout, stderr }
}

const browserUrlRequest = (session, extra = {}) => ({
  action: 'browser-url',
  handle: String(BigInt(session.handle)),
  pid: session.pid,
  title: session.title,
  ...extra,
})

function startReader(command, args, request) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  child.stdin.write(Buffer.from(JSON.stringify(request), 'utf8'))
  child.stdin.end()
  return child
}

const runRustHelper = (session, timeoutMs = HELPER_TIMEOUT_MS, extra = {}) =>
  runReader(helperExe, [], browserUrlRequest(session, extra), timeoutMs)

const runPowerShellBaseline = (session, timeoutMs = HELPER_TIMEOUT_MS, extra = {}) =>
  runReader(POWERSHELL, [...PS_ARGS, bridgeScript], browserUrlRequest(session, extra), timeoutMs)

function describeReader(name, result) {
  const parts = [`${name}: ${result.timedOut ? 'timeout' : `exit=${result.status}`}`]
  if (result.stdout) parts.push(`stdout=${result.stdout}`)
  if (result.stderr) parts.push(`stderr=${result.stderr.replace(/\s+/g, ' ').slice(0, 400)}`)
  return parts.join(' ')
}

function parseReaderJson(result) {
  try {
    return JSON.parse(result.stdout)
  } catch {
    return null
  }
}

// ---------- optional helper probe (Rust candidate) ----------

function probeHelper(session) {
  if (!existsSync(helperExe)) return { ok: false, detail: 'native/bin/yu-windows.exe missing' }
  const request = {
    action: 'browser-url',
    handle: String(BigInt(session.handle)),
    pid: session.pid,
    title: session.title,
  }
  const result = spawnSync(helperExe, [], {
    input: Buffer.from(JSON.stringify(request), 'utf8'),
    timeout: HELPER_TIMEOUT_MS,
    windowsHide: true,
  })
  if (result.error) {
    const code = result.error.code === 'ETIMEDOUT' ? 'timed out (window thread not pumping?)' : result.error.message
    return { ok: false, detail: `helper ${code} after ${HELPER_TIMEOUT_MS}ms` }
  }
  return {
    ok: result.status === 0,
    detail: `exit=${result.status} stdout=${result.stdout.toString('utf8').trim()} stderr=${result.stderr.toString('utf8').trim()}`,
  }
}

// ---------- block gate probe ----------
//
// `block` must stall a provider read while still leaving the fixture able to answer
// `unblock` and `quit` from its stdin thread. The stalled read is bounded from the
// outside: the client is killed on timeout, the gate is then released and a second
// read must succeed.
async function runBlockProbe() {
  const details = []
  const notes = []
  const session = await FixtureSession.launch('address-edit')
  try {
    session.send({ command: 'block' })
    await session.next((event) => event.type === 'blocking', COMMAND_TIMEOUT_MS, 'blocking')

    const startedAt = Date.now()
    let stalled = false
    try {
      runPowerShell(treeScript, ['-Handle', session.handle, '-MaxDepth', '8'], 6000)
    } catch {
      stalled = true
    }
    notes.push(`tree read while blocked: ${stalled ? 'stalled until timeout' : 'returned'} after ${Date.now() - startedAt}ms`)
    if (!stalled) details.push('block did not stall the provider read')

    const describeWhileBlocked = await session.describe()
    if (!describeWhileBlocked.blocking) details.push('describe should report blocking=true')

    session.send({ command: 'unblock' })
    await session.next((event) => event.type === 'unblocked', COMMAND_TIMEOUT_MS, 'unblocked')

    const tree = await session.dumpTree()
    for (const message of checkMode('address-edit', tree)) details.push(`after unblock: ${message}`)
    const describeAfter = await session.describe()
    if (describeAfter.blocking) details.push('describe still reports blocking=true after unblock')
  } catch (error) {
    details.push(error.message)
  } finally {
    const exit = await session.close()
    if (!exit) details.push('process did not exit after quit')
    else if (exit.code !== 0) details.push(`process exited with code=${exit.code} signal=${exit.signal}`)
    if (alivePid(session.pid)) details.push(`pid ${session.pid} still alive after close`)
    if (session.stderr.trim()) details.push(`stderr: ${session.stderr.trim()}`)
  }
  return { mode: 'block-gate', ok: details.length === 0, elements: 0, components: '', problems: details, notes }
}

// ---------- unicode round-trip probe ----------
//
// Proves the stdin side is raw UTF-8: a non-ASCII title written as a UTF-8 Buffer must
// come back unchanged in the `title` event and as the root element's Name. This is the
// exact pitfall that breaks PowerShell 5.1 pipeline writes, so drivers must use Buffer.
async function runUnicodeProbe() {
  const details = []
  const notes = []
  const title = 'UIA 非激活窗口 / 地址和搜索栏 test'
  const session = await FixtureSession.launch('address-edit')
  try {
    const event = await session.command({ command: 'retitle', title }, 'title', COMMAND_TIMEOUT_MS)
    if (event.title !== title) details.push(`retitle echoed ${JSON.stringify(event.title)}, expected ${JSON.stringify(title)}`)
    const describe = await session.describe()
    if (describe.title !== title) details.push(`describe title ${JSON.stringify(describe.title)}, expected ${JSON.stringify(title)}`)
    const tree = await session.dumpTree()
    const root = tree.find((node) => node.depth === 0)
    if (!root || root.name !== title) details.push(`root Name ${JSON.stringify(root && root.name)}, expected ${JSON.stringify(title)}`)
    notes.push(`stdin UTF-8 round-trip: ${JSON.stringify(title)}`)
  } catch (error) {
    details.push(error.message)
  } finally {
    const exit = await session.close()
    if (!exit) details.push('process did not exit after quit')
    else if (exit.code !== 0) details.push(`process exited with code=${exit.code} signal=${exit.signal}`)
    if (alivePid(session.pid)) details.push(`pid ${session.pid} still alive after close`)
    if (session.stderr.trim()) details.push(`stderr: ${session.stderr.trim()}`)
  }
  return { mode: 'unicode-stdin', ok: details.length === 0, elements: 0, components: '', problems: details, notes }
}


// ---------- file-url probe ----------
//
// The fixture owns a real temp file and advertises its long-path file:// URI in the
// address bar. Both readers must resolve it to {"path": ...} with no "url" key.
async function runFileUrlProbe() {
  const details = []
  const notes = []
  const session = await FixtureSession.launch('file-url')
  try {
    const file = session.file
    if (typeof file !== 'string' || !file) details.push('ready event carries no "file" field')
    else {
      notes.push(`ready file=${JSON.stringify(file)}`)
      if (!existsSync(file)) details.push(`advertised file does not exist: ${file}`)
      if (!/(^|[\\/])yu-uia-中文 100% [0-9a-f]{32}\.md$/i.test(file)) details.push(`temp file name is unexpected: ${file}`)
      if (file.includes('~')) details.push(`path looks like an 8.3 short name: ${file}`)

      const tree = await session.dumpTree()
      const edit = tree.find((node) => node.controlType === 'Edit')
      const expected = pathToFileURL(file).href
      if (!edit) details.push('no Edit in the file-url tree')
      else if (edit.value !== expected) details.push(`Edit value ${JSON.stringify(edit.value)}, expected ${JSON.stringify(expected)}`)
      notes.push(`address bar=${JSON.stringify(edit && edit.value)}`)

      const helper = runRustHelper(session)
      notes.push(describeReader('yu-windows.exe', helper))
      const helperJson = parseReaderJson(helper)
      if (!helperJson) details.push('yu-windows.exe returned no JSON')
      else {
        if (helperJson.path !== file) details.push(`helper path ${JSON.stringify(helperJson.path)}, expected ${JSON.stringify(file)}`)
        if ('url' in helperJson) details.push('helper kept a "url" key for a file:// address')
      }

      const baseline = runPowerShellBaseline(session)
      notes.push(describeReader('windows-tools.ps1', baseline))
      const baselineJson = parseReaderJson(baseline)
      if (!baselineJson) details.push('PowerShell baseline returned no JSON')
      else {
        if (baselineJson.path !== file) details.push(`baseline path ${JSON.stringify(baselineJson.path)}, expected ${JSON.stringify(file)}`)
        if ('url' in baselineJson) details.push('baseline kept a "url" key for a file:// address')
      }
    }
  } catch (error) {
    details.push(error.message)
  } finally {
    const file = session.file
    const exit = await session.close()
    if (!exit) details.push('process did not exit after quit')
    else if (exit.code !== 0) details.push(`process exited with code=${exit.code} signal=${exit.signal}`)
    if (alivePid(session.pid)) details.push(`pid ${session.pid} still alive after close`)
    if (session.stderr.trim()) details.push(`stderr: ${session.stderr.trim()}`)
    if (file && existsSync(file)) details.push(`temp file was not removed on quit: ${file}`)
  }
  return { mode: 'file-url', ok: details.length === 0, elements: 0, components: '', problems: details, notes }
}

// ---------- failure injection probe ----------
//
// A real provider exception must surface as a failed read, never as an empty result.
// Both readers are driven with the same request; the PowerShell baseline's behaviour is
// recorded verbatim because the two sides legitimately differ.
async function runProviderErrorProbe() {
  const details = []
  const notes = []
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  const closeWith = async (session, prefix) => {
    const exit = await session.close()
    if (!exit) details.push(`${prefix}: process did not exit after quit`)
    else if (exit.code !== 0) details.push(`${prefix}: process exited with code=${exit.code} signal=${exit.signal}`)
    if (alivePid(session.pid)) details.push(`${prefix}: pid ${session.pid} still alive after close`)
    if (session.stderr.trim()) details.push(`${prefix}: stderr: ${session.stderr.trim()}`)
  }

  // Part 1 — provider-side exceptions. The fault is real (the fixture raises it), but the
  // UIA core converts provider exceptions into "property unavailable"/"no children", so
  // both readers legitimately see an empty tree. The assertion is that neither reader
  // invents a URL, and that the fault was actually raised.
  for (const stage of ['get-property', 'find-children']) {
    const session = await FixtureSession.launch('provider-error', ['-FailStage', stage])
    try {
      const describe = await session.describe()
      if (describe.failStage !== stage) details.push(`${stage}: describe failStage=${JSON.stringify(describe.failStage)}`)
      const helper = runRustHelper(session)
      const baseline = runPowerShellBaseline(session)
      notes.push(`${stage} | ${describeReader('yu-windows.exe', helper)}`)
      notes.push(`${stage} | ${describeReader('windows-tools.ps1', baseline)}`)
      const injected = await session.next((event) => event.type === 'injected', 5000, 'injected event').catch(() => null)
      if (!injected) details.push(`${stage}: the fixture raised no injected failure`)
      else notes.push(`${stage} | injected call: ${injected.call}`)
      for (const [label, result] of [['yu-windows.exe', helper], ['windows-tools.ps1', baseline]]) {
        const json = parseReaderJson(result)
        if (json && typeof json.url === 'string' && json.url) details.push(`${stage}: ${label} returned url=${JSON.stringify(json.url)}`)
      }
      notes.push(`${stage} | both readers returned an empty result: the core swallowed the provider exception`)
      if (!(await session.describe()).alive) details.push(`${stage}: fixture died after the failed read`)
    } catch (error) {
      details.push(`${stage}: ${error.message}`)
    } finally {
      await closeWith(session, stage)
    }
  }

  // Part 2 — an unresponsive provider. This is the fault a client cannot miss, so the
  // fixture must stay answerable while the read is stuck: the caller has to give up, and
  // the fixture must still serve describe/quit from the stdin thread.
  {
    const session = await FixtureSession.launch('provider-error', ['-FailStage', 'unresponsive'])
    const read = startReader(POWERSHELL, [...PS_ARGS, bridgeScript], browserUrlRequest(session))
    let readDone = false
    read.on('exit', () => {
      readDone = true
    })
    try {
      await delay(2500)
      if (readDone) details.push('unresponsive: the stalled read finished on its own')
      const startedAt = Date.now()
      const describe = await session.describe()
      const elapsed = Date.now() - startedAt
      notes.push(`unresponsive | describe answered in ${elapsed}ms while a read was stalled, blocking=${describe.blocking}`)
      if (elapsed > 5000) details.push(`unresponsive: describe took ${elapsed}ms`)
      if (!describe.alive) details.push('unresponsive: fixture is not alive')
    } catch (error) {
      details.push(`unresponsive: ${error.message}`)
    } finally {
      const startedAt = Date.now()
      const exit = await session.close()
      notes.push(`unresponsive | quit exited in ${Date.now() - startedAt}ms code=${exit && exit.code}`)
      if (!exit) details.push('unresponsive: process did not exit after quit')
      else if (exit.code !== 0) details.push(`unresponsive: process exited with code=${exit.code}`)
      if (alivePid(session.pid)) details.push(`unresponsive: pid ${session.pid} still alive after close`)
      if (!readDone) {
        read.kill()
        notes.push('unresponsive | killed the stalled reader (its own pid only)')
      }
    }
  }

  // Part 3 — the window disappears mid-flight. This one the core cannot hide, so both
  // readers must fail loudly instead of reporting an empty read.
  {
    const session = await FixtureSession.launch('address-edit')
    try {
      await session.command({ command: 'destroy' }, 'destroyed')
      await delay(600)
      const helper = runRustHelper(session)
      const baseline = runPowerShellBaseline(session)
      notes.push(`destroyed | ${describeReader('yu-windows.exe', helper)}`)
      notes.push(`destroyed | ${describeReader('windows-tools.ps1', baseline)}`)
      for (const [label, result] of [['yu-windows.exe', helper], ['windows-tools.ps1', baseline]]) {
        const json = parseReaderJson(result)
        if (!result.ok && !result.timedOut) continue
        if (json && typeof json.url === 'string' && json.url) details.push(`destroyed: ${label} returned url for a destroyed window`)
        else if (result.ok) details.push(`destroyed: ${label} reported success on a destroyed window`)
      }
    } catch (error) {
      details.push(`destroyed: ${error.message}`)
    } finally {
      await closeWith(session, 'destroyed')
    }
  }

  return { mode: 'provider-error', ok: details.length === 0, elements: 0, components: '', problems: details, notes }
}

// ---------- value-read event probe ----------
//
// `value-read` is emitted only from the IValueProvider.Value getter, so the event
// stream records who actually evaluated a value (as opposed to merely walking the
// tree). This probe pins that boundary:
//   * excluded-value-blocked - a reader that skips the excluded candidate never enters
//     the getter; a full tree read (the positive control) does, and says so.
//   * no-value-pattern - a candidate without ValuePattern is never read.
//   * metadata-document / metadata-override - metadataOnly decides whether Documents
//     are read at all.

const VALUE_READ = 'value-read'
const VALUE_BLOCKED = 'value-blocked'

const readerLabel = (reader) => (reader === 'helper' ? 'yu-windows.exe' : 'windows-tools.ps1')

async function attemptRead(mode, reader, extra = {}) {
  const session = await FixtureSession.launch(mode)
  try {
    await session.describe()
    const mark = session.log.length
    const startedAt = Date.now()
    const result =
      reader === 'helper' ? runRustHelper(session, undefined, extra) : runPowerShellBaseline(session, undefined, extra)
    const elapsed = Date.now() - startedAt
    // The fixture writes events from its stdin thread; give the pipe a moment to drain.
    await new Promise((resolve) => setTimeout(resolve, 150))
    const events = session.log.slice(mark).filter((event) => event.type === VALUE_READ || event.type === VALUE_BLOCKED)
    return { result, elapsed, events }
  } finally {
    await session.close()
  }
}

function describeEvents(events) {
  if (events.length === 0) return '(none)'
  return events.map((event) => `${event.type}:${event.id === undefined ? '?' : event.id || '<no id>'}`).join(', ')
}

async function runEventsProbe() {
  const details = []
  const notes = []
  const readers = ['baseline', 'helper']

  // 1) The excluded candidate must not be evaluated by anyone who skips it.
  for (const reader of readers) {
    try {
      const run = await attemptRead('excluded-value-blocked', reader)
      notes.push(`excluded-value-blocked | ${readerLabel(reader)}: ${describeReader(readerLabel(reader), run.result)}`)
      notes.push(`excluded-value-blocked | ${readerLabel(reader)} events: ${describeEvents(run.events)} (${run.elapsed}ms)`)
      if (run.events.some((event) => event.type === VALUE_BLOCKED)) {
        details.push(`excluded-value-blocked: ${readerLabel(reader)} evaluated the excluded field (value-blocked seen)`)
      }
      if (run.events.some((event) => event.type === VALUE_READ && event.controlType === 'Edit')) {
        details.push(`excluded-value-blocked: ${readerLabel(reader)} read the excluded Edit value`)
      }
      if (!run.result.ok) details.push(`excluded-value-blocked: ${readerLabel(reader)} failed`)
      if (run.elapsed > 8000) {
        details.push(
          `excluded-value-blocked: ${readerLabel(reader)} took ${run.elapsed}ms - the skipped candidate must not block the read`,
        )
      }
    } catch (error) {
      details.push(`excluded-value-blocked (${readerLabel(reader)}): ${error.message}`)
    }
  }

  // 1b) Positive control: a full tree read does read that value, so the gate fires.
  {
    const session = await FixtureSession.launch('excluded-value-blocked')
    try {
      const mark = session.log.length
      const tree = await session.dumpTree()
      await new Promise((resolve) => setTimeout(resolve, 150))
      const blocked = session.log.slice(mark).filter((event) => event.type === VALUE_BLOCKED)
      const readIds = session.log
        .slice(mark)
        .filter((event) => event.type === VALUE_READ)
        .map((event) => event.id)
      notes.push(
        `excluded-value-blocked | uia-tree.ps1 positive control: value-blocked=${blocked.length} value-read ids=[${readIds.join(', ')}]`,
      )
      if (tree.length === 0) details.push('excluded-value-blocked: the tree dump was empty')
      if (blocked.length === 0) details.push('excluded-value-blocked: the value gate never fired even for a full tree read')
      for (const event of blocked) {
        if (event.id !== '') {
          details.push(`excluded-value-blocked: value-blocked id=${JSON.stringify(event.id)}, expected the anonymous page field`)
        }
      }
    } catch (error) {
      details.push(`excluded-value-blocked (positive control): ${error.message}`)
    } finally {
      await session.close()
    }
  }

  // 2) A candidate without ValuePattern is never read.
  for (const reader of readers) {
    try {
      const run = await attemptRead('no-value-pattern', reader)
      const json = parseReaderJson(run.result)
      notes.push(`no-value-pattern | ${readerLabel(reader)}: ${describeReader(readerLabel(reader), run.result)}`)
      notes.push(`no-value-pattern | ${readerLabel(reader)} events: ${describeEvents(run.events)}`)
      if (run.events.some((event) => event.type === VALUE_READ)) {
        details.push(`no-value-pattern: ${readerLabel(reader)} read a value from a candidate without ValuePattern`)
      }
      if (json && typeof json.url === 'string' && json.url) {
        details.push(`no-value-pattern: ${readerLabel(reader)} returned url=${JSON.stringify(json.url)}`)
      }
      if (!run.result.ok && reader === 'baseline') {
        details.push('no-value-pattern: the PowerShell baseline must exit 0 on a candidate without ValuePattern')
      }
      if (!run.result.ok && reader === 'helper') {
        const firstLine = run.result.stderr.trim().split('\n')[0]
        notes.push(`no-value-pattern | DIVERGENCE: yu-windows.exe failed where the baseline returned an empty result: ${firstLine}`)
      }
    } catch (error) {
      details.push(`no-value-pattern (${readerLabel(reader)}): ${error.message}`)
    }
  }

  // 3) metadataOnly decides whether Documents are read.
  const expectations = {
    'metadata-document': { false: ['Document:document'], true: [] },
    'metadata-override': { false: ['Edit:addressEditBox', 'Document:document'], true: ['Edit:addressEditBox', 'Document:document'] },
  }
  for (const mode of ['metadata-document', 'metadata-override']) {
    for (const metadataOnly of [false, true]) {
      for (const reader of readers) {
        try {
          const run = await attemptRead(mode, reader, { metadataOnly })
          const json = parseReaderJson(run.result)
          const sequence = run.events
            .filter((event) => event.type === VALUE_READ)
            .map((event) => `${event.controlType}:${event.id || '(no id)'}`)
          notes.push(
            `${mode} | metadataOnly=${metadataOnly} ${readerLabel(reader)}: ${describeReader(readerLabel(reader), run.result)}`,
          )
          notes.push(`${mode} | metadataOnly=${metadataOnly} ${readerLabel(reader)} value-read order=[${sequence.join(', ')}]`)
          const expected = expectations[mode][metadataOnly]
          if (sequence.join('|') !== expected.join('|')) {
            details.push(
              `${mode}: ${readerLabel(reader)} metadataOnly=${metadataOnly} value-read order [${sequence.join(', ')}] != [${expected.join(', ')}]`,
            )
          }
          const expectedUrl =
            mode === 'metadata-document' ? (metadataOnly ? undefined : 'https://example.com/doc') : 'https://example.com/from-doc'
          const actualUrl = json && typeof json.url === 'string' ? json.url : undefined
          if (actualUrl !== expectedUrl) {
            details.push(
              `${mode}: ${readerLabel(reader)} metadataOnly=${metadataOnly} url=${JSON.stringify(actualUrl)} != ${JSON.stringify(expectedUrl)}`,
            )
          }
          if (!run.result.ok) details.push(`${mode}: ${readerLabel(reader)} metadataOnly=${metadataOnly} failed`)
        } catch (error) {
          details.push(`${mode} (${readerLabel(reader)} metadataOnly=${metadataOnly}): ${error.message}`)
        }
      }
    }
  }

  return { mode: 'value-events', ok: details.length === 0, elements: 0, components: '', problems: details, notes }
}

// ---------- main ----------

function parseArgv(argv) {
  const options = { only: null, helper: false, block: false, unicode: false, file: false, error: false, events: false }
  for (const argument of argv) {
    if (argument === '--helper') options.helper = true
    else if (argument === '--block') options.block = true
    else if (argument === '--unicode') options.unicode = true
    else if (argument === '--file') options.file = true
    else if (argument === '--error') options.error = true
    else if (argument === '--events') options.events = true
    else if (argument.startsWith('--only=')) options.only = argument.slice('--only='.length)
    else if (argument === '--only') options.only = null
    else if (options.only === null && !argument.startsWith('--')) options.only = argument
  }
  return options
}

async function main() {
  const options = parseArgv(process.argv.slice(2))
  const modes = runPowerShell(fixtureScript, ['-ListModes']).split('\n').map((line) => line.trim()).filter(Boolean)
  const selected =
    (options.block || options.unicode || options.file || options.error || options.events) && !options.only
      ? []
      : options.only
        ? modes.filter((mode) => mode === options.only)
        : modes
  if (options.only && selected.length === 0) throw new Error(`unknown mode: ${options.only}`)

  const failures = []
  const report = []

  for (const mode of selected) {
    const details = []
    const notes = []
    let session = null
    let tree = null
    let foregroundBefore = null
    try {
      foregroundBefore = readForeground()
      session = await FixtureSession.launch(mode)

      const describe = await session.describe()
      if (describe.mode !== mode) details.push(`describe mode mismatch: ${describe.mode}`)
      if (describe.alive !== true) details.push('describe reported a dead window')
      if (describe.handle !== session.handle) details.push(`describe handle mismatch: ${describe.handle} vs ${session.handle}`)
      if (describe.title !== session.title) details.push(`describe title mismatch: ${describe.title} vs ${session.title}`)

      tree = await session.dumpTree()
      for (const message of checkMode(mode, tree)) details.push(message)

      const foregroundAfter = readForeground()
      if (foregroundAfter !== foregroundBefore) {
        notes.push(`another window owned the foreground: ${foregroundBefore} -> ${foregroundAfter}`)
      }
      const foregroundSamples = await session.sampleForeground()
      if (session.ownsForeground(foregroundSamples)) {
        details.push(`fixture took the foreground: ${foregroundSamples.join(' -> ')}`)
      }
      if (foregroundSamples.some((value) => value !== foregroundBefore.toLowerCase())) {
        notes.push(`foreground varied during the run: ${foregroundSamples.join(' -> ')}`)
      }

      if (options.helper) {
        const probe = probeHelper(session)
        if (probe.ok) {
          notes.push(`helper probe: ${probe.detail}`)
        } else {
          // A helper failure only counts against the fixture if the baseline fails too;
          // otherwise it is a reader divergence and belongs in the report, not in the
          // fixture's verdict.
          const baseline = runPowerShellBaseline(session)
          if (baseline.ok) notes.push(`DIVERGENCE helper vs baseline: ${probe.detail} | ${describeReader('windows-tools.ps1', baseline)}`)
          else details.push(`helper probe: ${probe.detail}`)
        }
      }
    } catch (error) {
      details.push(error.message)
    } finally {
      if (session) {
        const exit = await session.close()
        if (!exit) details.push('process did not exit after quit')
        else if (exit.code !== 0) details.push(`process exited with code=${exit.code} signal=${exit.signal}`)
        if (alivePid(session.pid)) details.push(`pid ${session.pid} still alive after close`)
        if (session.stderr.trim()) details.push(`stderr: ${session.stderr.trim()}`)
        if (foregroundBefore !== null) {
          const foregroundFinal = readForeground()
          if (foregroundFinal === session.handle.toLowerCase()) {
            details.push(`fixture still owned the foreground after close: ${foregroundFinal}`)
          } else if (foregroundFinal !== foregroundBefore) {
            notes.push(`foreground after teardown: ${foregroundBefore} -> ${foregroundFinal}`)
          }
        }
      }
    }

    const elementCount = tree ? tree.length : 0
    const componentCounts = tree
      ? ['Window', 'ToolBar', 'Edit', 'ComboBox', 'Document', 'Pane']
          .map((type) => [type, controlTypeOf(tree, type).length])
          .filter(([, count]) => count > 0)
          .map(([type, count]) => `${type}=${count}`)
          .join(' ')
      : ''

    const entry = {
      mode,
      ok: details.length === 0,
      elements: elementCount,
      components: componentCounts,
      problems: details,
      notes,
    }
    report.push(entry)
    if (!entry.ok) failures.push(entry)
    console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${mode.padEnd(20)} elements=${String(entry.elements).padStart(3)} ${componentCounts}`)
    for (const problem of details) console.log(`      - ${problem}`)
    for (const note of notes) console.log(`      · ${note}`)
  }

  if (options.block) {
    const probe = await runBlockProbe()
    report.push(probe)
    if (!probe.ok) failures.push(probe)
    console.log(`${probe.ok ? 'PASS' : 'FAIL'} ${probe.mode.padEnd(20)} (block / unblock / quit while a provider call is stalled)`)
    for (const problem of probe.problems) console.log(`      - ${problem}`)
    for (const note of probe.notes) console.log(`      · ${note}`)
  }

  if (options.unicode) {
    const probe = await runUnicodeProbe()
    report.push(probe)
    if (!probe.ok) failures.push(probe)
    console.log(`${probe.ok ? 'PASS' : 'FAIL'} ${probe.mode.padEnd(20)} (UTF-8 stdin -> title event -> UIA root Name)`)
    for (const problem of probe.problems) console.log(`      - ${problem}`)
    for (const note of probe.notes) console.log(`      · ${note}`)
  }

  const extraProbes = []
  if (options.file) extraProbes.push(['file-url', runFileUrlProbe])
  if (options.error) extraProbes.push(['provider-error', runProviderErrorProbe])
  if (options.events) extraProbes.push(['value-events', runEventsProbe])
  for (const [label, probe] of extraProbes) {
    const result = await probe()
    report.push(result)
    if (!result.ok) failures.push(result)
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${label.padEnd(20)} (fixture + both readers)`)
    for (const problem of result.problems) console.log(`      - ${problem}`)
    for (const note of result.notes) console.log(`      · ${note}`)
  }

  console.log('')
  console.log(
    JSON.stringify(
      {
        modes: report.length,
        passed: report.length - failures.length,
        failed: failures.length,
        results: report,
      },
      null,
      2,
    ),
  )

  if (failures.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
