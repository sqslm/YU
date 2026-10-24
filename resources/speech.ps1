# Fixed read-aloud bridge. The utterance arrives as JSON on stdin, never as a
# command-line argument: arguments are visible in every process listing and
# PowerShell would reinterpret quotes and `$` sigils inside them.
#
# Nothing here writes a temp file or a log line: the payload is the user's own
# text and may be private. There is one JSON object on stdout and the exit code
# is always 0, so the Node side decides success from the JSON, not from the
# process status.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
# No BOM: the Node side parses these bytes as JSON and a BOM would break that.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Write-BridgeResult($value) {
  # [Console]::Out bypasses the formatting pipeline, which would otherwise wrap
  # long lines and decorate the object with type headers.
  [Console]::Out.Write(($value | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}

function Get-ErrorMessage($errorRecord) {
  if ($errorRecord -and $errorRecord.Exception -and $errorRecord.Exception.Message) {
    return [string]$errorRecord.Exception.Message
  }
  return [string]$errorRecord
}

$request = $null
try {
  $raw = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($raw)) { throw 'Empty request' }
  $request = $raw | ConvertFrom-Json
  if (!$request) { throw 'Empty request' }
} catch {
  Write-BridgeResult @{ ok = $false; error = ('Invalid request: ' + (Get-ErrorMessage $_)) }
  exit 0
}

$action = [string]$request.action

if ($action -eq 'speak') {
  $text = [string]$request.text
  if ([string]::IsNullOrWhiteSpace($text)) {
    Write-BridgeResult @{ ok = $false; error = 'Nothing to speak' }
    exit 0
  }
  $synthesizer = $null
  try {
    # Loading SAPI is the step most likely to fail (no speech feature installed),
    # so it sits inside the same try as the synthesis itself.
    Add-Type -AssemblyName System.Speech
    $synthesizer = New-Object System.Speech.Synthesis.SpeechSynthesizer
    try {
      $synthesizer.SetOutputToDefaultAudioDevice()
      # Rate and Volume are integers on the SAPI object; clamp again here because
      # the settings file is hand-editable and could hold anything.
      if ($null -ne $request.rate) {
        $synthesizer.Rate = [int][Math]::Max(-10.0, [Math]::Min(10.0, [double]$request.rate))
      }
      if ($null -ne $request.volume) {
        $synthesizer.Volume = [int][Math]::Max(0.0, [Math]::Min(100.0, [double]$request.volume))
      }
      $voice = [string]$request.voice
      if ($voice) {
        # A voice can be uninstalled or renamed between the settings snapshot and
        # this call. Falling back to the default voice is better than silence.
        try { $synthesizer.SelectVoice($voice) } catch { }
      }
      # Blocking on purpose: the process lives exactly as long as the utterance,
      # and this process is what Node kills to interrupt it.
      $synthesizer.Speak($text)
    } finally {
      if ($synthesizer) { $synthesizer.Dispose(); $synthesizer = $null }
    }
    Write-BridgeResult @{ ok = $true }
  } catch {
    Write-BridgeResult @{ ok = $false; error = (Get-ErrorMessage $_) }
  } finally {
    if ($synthesizer) { $synthesizer.Dispose(); $synthesizer = $null }
  }
  exit 0
}

if ($action -eq 'voices') {
  $synthesizer = $null
  try {
    Add-Type -AssemblyName System.Speech
    $synthesizer = New-Object System.Speech.Synthesis.SpeechSynthesizer
    # Disabled voices cannot be selected, so they would only mislead the picker.
    $names = @($synthesizer.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name })
    $synthesizer.Dispose()
    $synthesizer = $null
    Write-BridgeResult @{ ok = $true; voices = $names }
  } catch {
    Write-BridgeResult @{ ok = $false; error = (Get-ErrorMessage $_) }
  } finally {
    if ($synthesizer) { $synthesizer.Dispose(); $synthesizer = $null }
  }
  exit 0
}

if ($action -eq 'stop') {
  # Limitation, stated here so nobody expects otherwise: this bridge speaks one
  # utterance per process and has no cross-process cancel. Node stops the audio
  # by killing the process that is speaking, so a stop request that reaches the
  # script has nothing left to interrupt.
  Write-BridgeResult @{ ok = $true }
  exit 0
}

Write-BridgeResult @{ ok = $false; error = ('Unknown action: ' + $action) }
exit 0
