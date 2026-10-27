import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const shell = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
function run(args: string[], input?: object): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(shell, ['-NoProfile', '-NonInteractive', ...args], { windowsHide: true, encoding: 'utf8', timeout: 20_000 }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout))
    child.stdin?.end(input ? JSON.stringify(input) + '\n' : '')
  })
}

it.skipIf(process.platform !== 'win32')('recognizes a custom Chinese name after a one-second pause through the real offline engine', async context => {
  const root = await mkdtemp(join(tmpdir(), 'yu-wake-replay-'))
  try {
    const synth = join(root, 'synthesize.ps1')
    await writeFile(synth, '\uFEFF' + `param([string]$OutputRoot)
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voice = $synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'zh-CN' } | Select-Object -First 1
  $recognizer = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | Where-Object { $_.Culture.Name -eq 'zh-CN' }
  if (!$voice -or !$recognizer) { Write-Output 'unavailable'; exit }
  $synth.SelectVoice($voice.VoiceInfo.Name)
  $synth.SetOutputToWaveFile((Join-Path $OutputRoot 'name.wav'))
  $synth.SpeakSsml('<speak version="1.0" xml:lang="zh-CN">你好<break time="1000ms"/>胡小杨</speak>')
  $synth.SetOutputToNull()
  $synth.SetOutputToWaveFile((Join-Path $OutputRoot 'homophone.wav'))
  $synth.Speak('你好，胡晓阳。')
  $synth.SetOutputToNull()
  $synth.SetOutputToWaveFile((Join-Path $OutputRoot 'unrelated.wav'))
  $synth.Speak('今天下午我们讨论项目进展。')
  $synth.SetOutputToNull()
} finally { $synth.Dispose() }
`)
    if ((await run(['-File', synth, root])).includes('unavailable')) { context.skip(); return }
    for (const name of ['name', 'homophone', 'unrelated']) {
      const stdout = await run(['-File', join(process.cwd(), 'resources/voice-wake.ps1')], { phrase: '你好，胡小杨', language: 'zh', wave: join(root, name + '.wav') })
      const events = stdout.trim().split('\n').map(line => JSON.parse(line.replace(/^\uFEFF/, '')))
      expect(events.some(event => event.type === 'error')).toBe(false)
      const wakes = events.filter(event => event.type === 'wake')
      if (name === 'unrelated') expect(wakes).toEqual([])
      else {
        expect(wakes).toHaveLength(1)
        expect(wakes[0].phrase).toBe('你好，胡小杨')
        // These are the actual host acceptance bounds, not just a raw candidate.
        expect(wakes[0].confidence).toBeGreaterThanOrEqual(0.5)
        expect(wakes[0].durationMs).toBeGreaterThanOrEqual(300)
        expect(wakes[0].durationMs).toBeLessThanOrEqual(9000)
      }
    }
  } finally { await rm(root, { recursive: true }) }
}, 60_000)
