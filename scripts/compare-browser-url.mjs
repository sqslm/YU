// Drives the owned UIA fixture through both the shipped PowerShell baseline and
// the Rust helper, comparing every field of the browser-url result.
//
// The fixture is an owned, non-activating provider; no user browser window,
// profile or session is touched.
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const fixture = resolve('tests/yu-v2/fixtures/uia-provider.ps1')
const helpers = {
  powershell: { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-File', resolve('resources/windows-tools.ps1')] },
  rust: { command: resolve('native/bin/yu-windows.exe'), args: [] },
}

// Modes and the payload both helpers must return for them. `null` means the
// mode is expected to fail with that message on both sides.
const cases = [
  { mode: 'address-edit', url: 'https://example.com/a' },
  { mode: 'address-combo', url: 'https://example.com/b' },
  { mode: 'no-candidate' },
  { mode: 'duplicate', url: 'https://example.com/c' },
  { mode: 'ambiguous' },
  { mode: 'document-overrides', url: 'https://example.com/g' },
  { mode: 'document-ambiguous' },
  { mode: 'pseudo-address' },
  { mode: 'password' },
  { mode: 'offscreen' },
  { mode: 'no-toolbar' },
  { mode: 'deep-40', url: 'https://example.com/deep-40' },
  { mode: 'deep-41' },
  { mode: 'documents-20', url: 'https://example.com/doc' },
  { mode: 'documents-21', url: 'https://example.com/doc' },
  { mode: 'edits-100', url: 'https://example.com/edit' },
  { mode: 'edits-101', url: 'https://example.com/edit' },
]

function start(mode) {
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fixture, '-Mode', mode], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buffered = ''
  const events = []
  const waiters = []
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    buffered += chunk
    let index
    while ((index = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, index).trim()
      buffered = buffered.slice(index + 1)
      if (!line) continue
      let parsed
      try { parsed = JSON.parse(line) } catch { continue }
      events.push(parsed)
      for (const waiter of [...waiters]) if (waiter.match(parsed)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(parsed) }
    }
  })
  const ready = new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error(`fixture ${mode} did not become ready`)), 20000)
    waiters.push({ match: event => event.type === 'ready', resolve: event => { clearTimeout(timer); resolveReady(event) } })
    child.once('exit', code => rejectReady(new Error(`fixture ${mode} exited early (${code})`)))
  })
  return { child, ready, events, send: command => child.stdin.write(`${JSON.stringify(command)}\n`) }
}

function call(helper, body, timeoutMs = 20000) {
  return new Promise(resolveCall => {
    const started = performance.now()
    const child = spawn(helper.command, helper.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.once('close', code => {
      clearTimeout(timer)
      resolveCall({ code, stdout: stdout.trim(), stderr: stderr.trim(), ms: performance.now() - started })
    })
    child.stdin.end(Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'))
  })
}

function parse(result) {
  try { return JSON.parse(result.stdout) } catch { return null }
}

const report = { cases: [], failures: [] }
for (const { mode, url: expect } of cases) {
  const fixtureRun = start(mode)
  let ready
  try {
    ready = await fixtureRun.ready
    const handle = String(Number(BigInt(ready.handle)))
    const body = { action: 'browser-url', handle, pid: ready.pid, title: ready.title }
    const [powershell, rust] = [await call(helpers.powershell, body), await call(helpers.rust, body)]
    const left = parse(powershell), right = parse(rust)
    // Both helpers must return the same body and, where the case defines one,
    // exactly that URL; the fixture never produces a local file, so `path`
    // must stay absent.
    const matched = Boolean(left && right)
      && left.title === right.title
      && left.truncated === right.truncated
      && left.url === right.url
      && left.url === expect
      && left.path === undefined
      && right.path === undefined
    report.cases.push({ mode, matched, powershell: { ...powershell, json: left }, rust: { ...rust, json: right } })
    if (!matched) report.failures.push(mode)
  } catch (error) {
    report.cases.push({ mode, matched: false, error: String(error) })
    report.failures.push(mode)
  } finally {
    try { fixtureRun.send({ command: 'quit' }) } catch {}
    setTimeout(() => { try { fixtureRun.child.kill() } catch {} }, 1500).unref()
  }
}

for (const entry of report.cases) {
  const status = entry.matched ? 'ok  ' : 'FAIL'
  const ps = entry.powershell?.json ? JSON.stringify(entry.powershell.json) : entry.powershell?.stderr || entry.error || ''
  const rs = entry.rust?.json ? JSON.stringify(entry.rust.json) : entry.rust?.stderr || ''
  console.log(`${status} ${entry.mode.padEnd(20)} ps=${ps} rust=${rs}`)
}
console.log(report.failures.length ? `FAILED: ${report.failures.join(', ')}` : 'all modes match')
process.exit(report.failures.length ? 1 : 0)
