/**
 * Drives the real `native/bin/yu-speech.exe` for the integration tests.
 *
 * Everything here speaks through the default audio device with volume 0 and
 * short utterances: the helper's protocol is what is under test, not the room.
 *
 * A child is only reported finished once its stdio is closed, so a caller never
 * compares a result against a pipe that is still draining. Every exit path —
 * timeout, spawn failure, early EOF — clears its own timers and reaps the
 * child, because a fixture that leaks a helper makes the next leftover check
 * lie.
 */
const { spawn } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { performance } = require('node:perf_hooks')

const root = resolve(__dirname, '../../..')
const exe = join(root, 'native/bin/yu-speech.exe')
const shell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

const available = () => process.platform === 'win32' && existsSync(exe)

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/**
 * Turns NDJSON chunks into timestamped lines and hands each parsed event to
 * `onEvent`, so callers react to output instead of polling for it.
 */
function reader(child, started, onEvent) {
  const events = []
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      const entry = { at: Math.round(performance.now() - started), line }
      events.push(entry)
      if (!onEvent) continue
      let parsed = null
      try { parsed = JSON.parse(line) } catch {}
      onEvent(parsed ?? { raw: line }, entry)
    }
  })
  // stderr is diagnostic only; the protocol never travels there.
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', () => {})
  return events
}

/** Spawns one helper request and resolves once its stdio is closed. */
function request(lines, { keepOpenMs = 0, timeoutMs = 30_000 } = {}) {
  return new Promise((done) => {
    const started = performance.now()
    const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const events = reader(child, started)
    let speaking = false
    try { speaking = JSON.parse(lines[lines.length - 1]).action === 'speak' } catch {}
    let settled = false
    const timers = []
    const finish = (extra = {}) => {
      if (settled) return
      settled = true
      for (const timer of timers) clearTimeout(timer)
      done({ pid: child.pid, ms: Math.round(performance.now() - started), events, ...extra })
    }
    child.on('close', (code, signal) => finish({ code, signal, closed: true }))
    child.on('error', (error) => finish({ code: -1, error: String(error), closed: false }))
    // A helper that died first makes the write fail; close still reports it.
    child.stdin.on('error', () => {})
    timers.push(setTimeout(() => { try { child.kill() } catch {} }, timeoutMs))
    for (const line of lines) child.stdin.write(line + '\n')
    // For `speak`, closing stdin is the stop signal: keep it open until the
    // helper reports its own completion, exactly like the production runner.
    if (keepOpenMs > 0) timers.push(setTimeout(() => child.stdin.end(), keepOpenMs))
    else if (lines.length && !speaking) child.stdin.end()
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
    let step = 0
    let settled = false
    const timers = []
    const finish = (extra = {}) => {
      if (settled) return
      settled = true
      for (const timer of timers) clearTimeout(timer)
      done({ pid: child.pid, ms: Math.round(performance.now() - started), events, ...extra })
    }
    const pump = () => {
      if (settled || step >= actions.length) return
      const action = actions[step]
      step += 1
      if (action.write) child.stdin.write(JSON.stringify(action.write) + '\n')
      if (action.end) child.stdin.end()
      if (action.waitMs) timers.push(setTimeout(pump, action.waitMs))
    }
    reader(child, started, (event, entry) => {
      events.push({ ...event, at: entry.at })
      const next = actions[step]
      if (next && next.on && next.on(event)) pump()
    })
    child.on('close', (code, signal) => finish({ code, signal, closed: true }))
    child.on('error', (error) => finish({ code: -1, error: String(error), closed: false }))
    child.stdin.on('error', () => {})
    timers.push(setTimeout(() => { try { child.kill() } catch {} }, timeoutMs))
    child.stdin.write(JSON.stringify(request_) + '\n')
    const first = actions[0]
    if (first && !first.on) pump()
  })
}

/**
 * One real synthesis: start, optional pause/resume, then stop by closing stdin
 * (or let a short utterance finish). The helper is sampled while it is alive,
 * so the numbers describe a running process rather than one that already
 * exited — the mistake that made the old handle check vacuous.
 */
function speakCycle(request_, { pause = false, sampleAfterMs = 300, stopAfterMs = 600, timeoutMs = 60_000 } = {}) {
  return new Promise((done) => {
    const started = performance.now()
    const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let sample = null
    let sampleTask = null
    let stage = 'spawned'
    let settled = false
    const events = []
    const timers = []
    const finish = (extra = {}) => {
      if (settled) return
      settled = true
      for (const timer of timers) clearTimeout(timer)
      // The probe is a separate PowerShell process: let it land even when the
      // helper exits first, otherwise the sample silently stays null.
      Promise.resolve(sampleTask).then(() => done({ pid: child.pid, ms: Math.round(performance.now() - started), events, sample, stage, ...extra }))
    }
    reader(child, started, (event, entry) => {
      if (settled) return
      events.push({ ...event, at: entry.at })
      if (event.event === 'started' && stage === 'spawned') {
        stage = 'speaking'
        // A promise from the start, so a control handler that waits for the
        // sample really waits instead of resuming past an empty slot.
        sampleTask = sleep(sampleAfterMs).then(() => probe(child.pid)).then((value) => { sample = value })
        if (pause) {
          stage = 'pausing'
          child.stdin.write(JSON.stringify({ action: 'pause', id: 1 }) + '\n')
          return
        }
        timers.push(setTimeout(() => { if (stage === 'speaking') { stage = 'stopping'; child.stdin.end() } }, stopAfterMs))
      } else if (event.event === 'control' && event.id === 1 && stage === 'pausing') {
        stage = 'paused'
        // Resume only after the probe has landed, so the helper is still
        // paused — alive — when its handles are read.
        Promise.resolve(sampleTask).then(() => {
          if (!settled) child.stdin.write(JSON.stringify({ action: 'resume', id: 2 }) + '\n')
        })
      } else if (event.event === 'control' && event.id === 2 && stage === 'paused') {
        stage = 'stopping'
        child.stdin.end()
      }
    })
    child.on('close', (code, signal) => finish({ code, signal, closed: true }))
    child.on('error', (error) => finish({ code: -1, error: String(error), closed: false }))
    child.stdin.on('error', () => {})
    timers.push(setTimeout(() => { try { child.kill() } catch {} }, timeoutMs))
    child.stdin.write(JSON.stringify(request_) + '\n')
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

/** Private bytes, handles and threads of a helper process, or why it failed. */
function probe(pid) {
  return new Promise((done) => {
    const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if (-not $p) { '{"missing":true}'; exit 0 }; [pscustomobject]@{ handles = $p.HandleCount; threads = $p.Threads.Count; privateKb = [math]::Round($p.PrivateMemorySize64 / 1kb, 1) } | ConvertTo-Json -Compress`
    const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
    let out = ''
    let settled = false
    let timer = null
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done(value)
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('close', () => {
      try { finish(JSON.parse(out.trim() || '{}')) } catch { finish({ error: 'unreadable probe output' }) }
    })
    child.on('error', (error) => finish({ error: String(error) }))
    timer = setTimeout(() => { try { child.kill() } catch {} finish({ error: 'probe timeout' }) }, 10_000)
  })
}

/**
 * Existence of each PID, using Node's own signal-0 probe rather than a
 * PowerShell pipeline (an integer has no `Id` property, which is exactly how
 * the previous check could report a running process as gone).
 */
function existence(pids) {
  const alive = []
  const unknown = []
  for (const pid of pids) {
    try {
      process.kill(pid, 0)
      alive.push(pid)
    } catch (error) {
      if (error && error.code === 'EPERM') alive.push(pid)
      else if (error && error.code === 'ESRCH') continue
      else unknown.push(pid)
    }
  }
  return { alive, unknown }
}

/** Waits until every listed helper has exited, reporting what it could not tell. */
async function leftovers(pids, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let state = existence(pids)
  while (state.alive.length > 0 && Date.now() < deadline) {
    await sleep(100)
    state = existence(state.alive)
  }
  return { living: state.alive, unknown: state.unknown }
}

module.exports = { available, exe, parse, request, live, speakCycle, powershellVoices, probe, existence, leftovers, sleep }
