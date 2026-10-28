import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  $synth.SetOutputToWaveFile((Join-Path $OutputRoot 'homophone.wav'), [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono))
  $synth.Speak('你好，胡晓阳。')
  $synth.SetOutputToNull()
  $synth.SetOutputToWaveFile((Join-Path $OutputRoot 'unrelated.wav'))
  $synth.Speak('今天下午我们讨论项目进展。')
  $synth.SetOutputToNull()
} finally { $synth.Dispose() }
`)
    if ((await run(['-File', synth, root])).includes('unavailable')) { context.skip(); return }
    // A recognizer's internal rejection setting must not discard a matching
    // candidate before the app's user-selected confidence gate can judge it.
    const rejected = join(root, 'rejected.ps1')
    const source = await readFile(join(process.cwd(), 'resources/voice-wake.ps1'), 'utf8')
    await writeFile(rejected, '\uFEFF' + source.replace('engine.RecognizeAsync(RecognizeMode.Multiple);', 'engine.UpdateRecognizerSetting("CFGConfidenceRejectionThreshold", 100); engine.RecognizeAsync(RecognizeMode.Multiple);'))
    const replay = await run(['-File', rejected], { phrase: '你好，胡小杨', language: 'zh', wave: join(root, 'homophone.wav') })
    expect(replay.split('\n').some(line => line.includes('"type":"wake"'))).toBe(true)
    // Exercise the actual microphone Stream.Read implementation too. File-only
    // recognition bypasses the stream that is used for a selected live device.
    const streamScript = join(root, 'stream.ps1')
    await writeFile(streamScript, '\uFEFF' + source.replace('engine.SetInputToWaveFile(wave);', `
          byte[] pcm = null;
          using (var reader = new BinaryReader(File.OpenRead(wave))) {
            reader.ReadBytes(12);
            while (reader.BaseStream.Position + 8 <= reader.BaseStream.Length) {
              string id = new string(reader.ReadChars(4)); int size = reader.ReadInt32();
              if (id == "data") { pcm = reader.ReadBytes(size); break; }
              reader.BaseStream.Seek(size + (size % 2), SeekOrigin.Current);
            }
          }
          var input = new MicStream();
          engine.SetInputToAudioStream(input, new SpeechAudioFormatInfo(16000, AudioBitsPerSample.Sixteen, AudioChannel.Mono));
          ThreadPool.QueueUserWorkItem(ignored => {
            for (int at = 0; at < pcm.Length; at += 6400) {
              int count = Math.Min(6400, pcm.Length - at); var part = new byte[count];
              Buffer.BlockCopy(pcm, at, part, 0, count); input.Push(part, count); Thread.Sleep(10);
            }
            input.Finish();
          });`))
    const streamed = await run(['-File', streamScript], { phrase: '你好，胡小杨', language: 'zh', wave: join(root, 'homophone.wav') })
    expect(streamed.split('\n').some(line => line.includes('"type":"wake"'))).toBe(true)
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
