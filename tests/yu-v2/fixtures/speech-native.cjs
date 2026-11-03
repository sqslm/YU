/**
 * Drives the real `native/bin/yu-speech.exe` for the integration tests.
 *
 * Everything here speaks through the default audio device with volume 0 and
 * short utterances: the helper's protocol is what is under test, not the room.
 */
const { spawn } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { performance } = require('node:perf_hooks')

const root = resolve(__dirname, '../../..')
const exe = join(root, 'native/bin/yu-speech.exe')
const shell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

const available = () => process.platform === 'win32' && existsSync(exe)

/** Runs one request; `lines` are written in order, the last one decides stdin. */
function request(lines, { keepOpenMs = 0, timeoutMs = 30_000 } = {}) {
  return new Promise((done) => {
    const started = performance.now()
    const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const events = []
    let buffer = ''
    let settled = false
    const finish = (extra = {}) => {
      if (settled) return
      settled = true
      done({ pid: child.pid, ms: Math.round(performance.now() - started), events, ...extra })
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line) continue
        events.push({ at: Math.round(performance.now() - started), line })
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', () => {})
    child.on('exit', (code, signal) => finish({ code, signal }))
    child.on('error', (error) => finish({ code: -1, error: String(error) }))
    for (const line of lines) child.stdin.write(line + '\n')
    // For `speak`, closing stdin is the stop signal: keep it open until the
    // helper reports its own completion, exactly like the production runner.
    let speaking = false
    try { speaking = JSON.parse(lines[lines.length - 1]).action === 'speak' } catch {}
    if (keepOpenMs > 0) setTimeout(() => child.stdin.end(), keepOpenMs)
    else if (lines.length && !speaking) child.stdin.end()
    setTimeout(() => { try { child.kill() } catch {} }, timeoutMs)
  })
}

const parse = (result) => result.events.map((event) => {
  try { return { ...JSON.parse(event.line), at: event.at } } catch { return { at: event.at, raw: event.line } }
})

/** Waits for an event, then runs the next step; used for pause/resume timing. */
function live(request_, actions, { timeoutMs = 30_000 } = {}) {
  return new Promise((done) => {
    const started = performance.now()
    const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const events = []
    let buffer = ''
    let step = 0
    let settled = false
    const finish = (extra = {}) => {
      if (settled) return
      settled = true
      done({ pid: child.pid, ms: Math.round(performance.now() - started), events, ...extra })
    }
    const pump = () => {
      if (step >= actions.length) return
      const action = actions[step]
      step += 1
      if (action.write) child.stdin.write(JSON.stringify(action.write) + '\n')
      if (action.end) child.stdin.end()
      if (action.waitMs) setTimeout(pump, action.waitMs)
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line) continue
        let parsed = { raw: line }
        try { parsed = JSON.parse(line) } catch {}
        events.push({ ...parsed, at: Math.round(performance.now() - started) })
        const next = actions[step]
        if (next && next.on && next.on(parsed)) pump()
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', () => {})
    child.on('exit', (code, signal) => finish({ code, signal }))
    child.on('error', (error) => finish({ code: -1, error: String(error) }))
    child.stdin.write(JSON.stringify(request_) + '\n')
    const first = actions[0]
    if (first && !first.on) pump()
    setTimeout(() => { try { child.kill() } catch {} }, timeoutMs)
  })
}

/** Voice names as the PowerShell host reports them, for a value-for-value check. */
function powershellVoices() {
  return new Promise((done) => {
    const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'resources/speech.ps1')], { windowsHide: true })
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('exit', () => {
      try { done(JSON.parse(out.trim().split('\n')[0]).voices) } catch { done(null) }
    })
    child.on('error', () => done(null))
    child.stdin.end(JSON.stringify({ action: 'voices' }) + '\n')
  })
}

/** Private bytes, handles and threads of a helper process. */
function sample(pid) {
  return new Promise((done) => {
    const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if (-not $p) { '{}'; exit 0 }; [pscustomobject]@{ handles = $p.HandleCount; threads = $p.Threads.Count; privateKb = [math]::Round($p.PrivateMemorySize64 / 1kb, 1) } | ConvertTo-Json -Compress`
    const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('exit', () => { try { done(JSON.parse(out.trim() || '{}')) } catch { done({}) } })
    child.on('error', () => done({}))
  })
}

/** Which of these helpers are still running, in one shell call per pass. */
function survivors(pids) {
  return new Promise((done) => {
    const ids = pids.join(',')
    const script = `$ids = @(${ids}); $ids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue } | ForEach-Object { $_.Id }`
    const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('exit', () => done(out.split(/\s+/).filter(Boolean).map(Number).filter((id) => pids.includes(id))))
    child.on('error', () => done(pids.slice()))
  })
}

/** Waits until every listed helper has exited, and reports the ones that did not. */
async function leftovers(pids, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  let living = pids.slice()
  while (living.length > 0 && Date.now() < deadline) {
    living = await survivors(living)
    if (living.length > 0) await new Promise((done) => setTimeout(done, 250))
  }
  return living
}

module.exports = { available, exe, parse, request, live, powershellVoices, sample, leftovers }
