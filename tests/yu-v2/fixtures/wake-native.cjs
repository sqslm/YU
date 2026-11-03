// Drives the real Rust wake helper the way the host does: one JSON line on stdin, the
// pipe left open, NDJSON events back. Speech is synthesised with the same SAPI voice the
// PowerShell host uses, so the corpus never contains recorded audio.
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..', '..')
const EXE = path.join(ROOT, 'native', 'bin', 'yu-wake.exe')
const POWERSHELL = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'

const PHRASES = [
  { name: 'complete', text: '你好胡小杨。' },
  { name: 'command', text: '你好胡小杨，帮我朗读一下随记。' },
  { name: 'split', ssml: '你好<break time="700ms"/>胡小杨' },
  { name: 'homophone', text: '你好，胡晓阳。' },
  { name: 'lead-silence', ssml: '<break time="10000ms"/>你好胡小杨' },
  { name: 'long-gap', ssml: '你好<break time="10000ms"/>胡小杨' },
  { name: 'pause2s', ssml: '你好<break time="2000ms"/>阿语' },
  { name: 'partial', text: '你好胡。' },
  { name: 'embedded', text: '今天开会的时候大家都说你好胡小杨这个人做事很认真。' },
  { name: 'unrelated', text: '请把窗外的雨声关小一点。' },
]

/// UTF-8 BOM matters: PowerShell reads the script as GBK otherwise.
function synthesize(directory) {
  const lines = [
    'Add-Type -AssemblyName System.Speech',
    '$directory = $env:YU_WAKE_CORPUS',
    '$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    "$speaker.SelectVoice('Microsoft Huihui Desktop')",
    '$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)',
  ]
  for (const phrase of PHRASES) {
    const target = path.join(directory, `${phrase.name}.wav`)
    lines.push(`$speaker.SetOutputToWaveFile('${target}', $format)`)
    if (phrase.ssml) {
      const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN">${phrase.ssml}</speak>`
      lines.push(`$speaker.SpeakSsml('${ssml}')`)
    } else {
      lines.push(`$speaker.Speak('${phrase.text}')`)
    }
  }
  lines.push('$speaker.SetOutputToNull()', '$speaker.Dispose()')
  lines.push("$noise = New-Object System.Random 20261103")
  lines.push("$bytes = New-Object byte[] 96000")
  lines.push("$noise.NextBytes($bytes)")
  lines.push("$writer = New-Object System.IO.BinaryWriter([System.IO.File]::Create((Join-Path $directory 'noise.raw')))")
  lines.push("$writer.Write([byte[]](0x52,0x49,0x46,0x46))")
  lines.push("$writer.Write([int](96036)); $writer.Write([byte[]](0x57,0x41,0x56,0x45,0x66,0x6d,0x74,0x20))")
  lines.push("$writer.Write([int]16); $writer.Write([int16]1); $writer.Write([int16]1)")
  lines.push("$writer.Write([int]16000); $writer.Write([int]32000); $writer.Write([int16]2); $writer.Write([int16]16)")
  lines.push("$writer.Write([byte[]](0x64,0x61,0x74,0x61)); $writer.Write([int]96000); $writer.Write($bytes)")
  lines.push("$writer.Close()")
  const script = path.join(directory, 'synthesize.ps1')
  fs.writeFileSync(script, `\uFEFF${lines.join('\n')}`, 'utf8')
  const result = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    env: { ...process.env, YU_WAKE_CORPUS: directory },
    encoding: 'utf8',
    timeout: 120_000,
  })
  if (result.status !== 0) {
    throw new Error(`synthesis failed (${result.status}): ${result.stderr || result.stdout}`)
  }
  const corpus = {}
  for (const phrase of PHRASES) corpus[phrase.name] = path.join(directory, `${phrase.name}.wav`)
  corpus.noise = path.join(directory, 'noise.raw')
  return corpus
}

/// One helper process: writes `config`, optionally closes stdin after `keepOpenMs`, and
/// returns the parsed events with the moment each one arrived.
function listen({ exe = EXE, config, keepOpenMs = 0, timeoutMs = 45_000, env = {} }) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const child = spawn(exe, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ...env },
    })
    const events = []
    let buffer = ''
    let stderr = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`helper timed out after ${timeoutMs}ms; events=${JSON.stringify(events)}`))
    }, timeoutMs)
    child.on('error', reject)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line) {
          try {
            events.push({ ...JSON.parse(line), at: Date.now() - started })
          } catch {
            events.push({ type: 'unparsed', raw: line, at: Date.now() - started })
          }
        }
        index = buffer.indexOf('\n')
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('exit', (code) => {
      finish({ code, ms: Date.now() - started, events, stderr })
    })
    const payload = typeof config === 'string' ? config : JSON.stringify(config)
    child.stdin.write(`${payload}\n`)
    if (keepOpenMs > 0) {
      setTimeout(() => child.stdin.end(), keepOpenMs)
    }
  })
}

/// Enumerates devices through the helper's own flag.
function devices(exe = EXE) {
  const result = spawnSync(exe, ['--list-devices'], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
  if (result.status !== 0) throw new Error(`enumeration failed (${result.status}): ${result.stderr}`)
  const line = result.stdout.trim().split('\n').find((entry) => entry.trim())
  return JSON.parse(line)
}

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'yu-wake-fixture-'))
}

module.exports = { EXE, PHRASES, devices, listen, synthesize, workspace, POWERSHELL }
