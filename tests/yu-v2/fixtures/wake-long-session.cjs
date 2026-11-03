// Long single-process session: silence, then the positive and negative corpus, streamed in real time.
// Usage: node tests/yu-v2/fixtures/wake-long-session.cjs [--silence 600] [--out result.json]
// Feeds synthetic audio only; no capture device is opened and no audio is stored.
const path = require('node:path')
const fs = require('node:fs')
const { spawn, execFileSync } = require('node:child_process')
const { workspace, synthesize } = require('./wake-native.cjs')

const RATE = 32000
const root = path.resolve(__dirname, '../../..')
const argument = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}
const silenceSeconds = Number(argument('--silence', '600'))
const output = path.resolve(root, argument('--out', 'tests/yu-v2/evidence/.wake-long-session.json'))

const dir = workspace()
synthesize(dir)
const pcm = (name) => fs.readFileSync(path.join(dir, name)).subarray(44)
const silence = (seconds) => Buffer.alloc(Math.round(seconds * RATE))

const parts = [silence(silenceSeconds)]
let at = silenceSeconds
const marks = []
for (const [name, gap] of [['complete.wav', 5], ['unrelated.wav', 5], ['complete.wav', 3]]) {
  parts.push(pcm(name))
  at += pcm(name).length / RATE
  marks.push({ name, at: Number(at.toFixed(2)) })
  parts.push(silence(gap))
  at += gap
}

const body = Buffer.concat(parts)
const header = Buffer.alloc(44)
header.write('RIFF', 0)
header.writeUInt32LE(36 + body.length, 4)
header.write('WAVE', 8)
header.write('fmt ', 12)
header.writeUInt32LE(16, 16)
header.writeUInt16LE(1, 20)
header.writeUInt16LE(1, 22)
header.writeUInt32LE(RATE, 24)
header.writeUInt32LE(RATE, 28)
header.writeUInt16LE(2, 32)
header.writeUInt16LE(16, 34)
header.write('data', 36)
header.writeUInt32LE(body.length, 40)
const wave = path.join(dir, 'session.wav')
fs.writeFileSync(wave, Buffer.concat([header, body]))

const exe = path.join(root, 'native/bin/yu-wake.exe')
const samples = []
const events = []
const started = Date.now()
const child = spawn(exe, [], { windowsHide: true })
let buffer = ''
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line) events.push({ at: Date.now() - started, ...JSON.parse(line) })
  }
})
const sampler = setInterval(() => {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$p = Get-Process -Id ${child.pid}; "$($p.PrivateMemorySize64) $($p.WorkingSet64) $($p.Threads.Count) $($p.HandleCount)"`],
    { encoding: 'utf8', windowsHide: true }).trim().split(/\s+/).map(Number)
    samples.push({
      at: Date.now() - started,
      privateMb: Number((out[0] / 1048576).toFixed(1)),
      workingMb: Number((out[1] / 1048576).toFixed(1)),
      threads: out[2],
      handles: out[3],
    })
  } catch {}
}, 10000)
child.on('exit', (code) => {
  clearInterval(sampler)
  const result = { code, pid: child.pid, silenceSeconds, seconds: Math.round((Date.now() - started) / 1000), marks, events, samples }
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ code, seconds: result.seconds, wakes: events.filter((event) => event.type === 'wake').map((event) => event.at) }))
  fs.rmSync(dir, { recursive: true, force: true })
})
child.stdin.write(JSON.stringify({ phrase: '你好，胡小杨', language: 'zh', stream: wave }) + '\n')
