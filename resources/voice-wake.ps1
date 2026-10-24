$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  $request = [Console]::ReadLine() | ConvertFrom-Json
  Add-Type -AssemblyName System.Speech
  Add-Type -AssemblyName System.Web.Extensions
  Add-Type -ReferencedAssemblies System.Speech,System.Web.Extensions -TypeDefinition @'
using System;
using System.Globalization;
using System.Speech.Recognition;
using System.Threading;
using System.Web.Script.Serialization;
public static class QinlyWake {
  static readonly object OutputLock = new object();
  static void Emit(object value) {
    lock (OutputLock) { Console.WriteLine(new JavaScriptSerializer().Serialize(value)); Console.Out.Flush(); }
  }
  public static void Run(string phrase, string language, string wave) {
    RecognizerInfo selected = null;
    foreach (var info in SpeechRecognitionEngine.InstalledRecognizers()) {
      if (info.Culture.TwoLetterISOLanguageName == language) { selected = info; break; }
    }
    if (selected == null) { Emit(new { type = "error", error = "language" }); return; }
    using (var engine = new SpeechRecognitionEngine(selected)) {
      var grammar = new GrammarBuilder { Culture = selected.Culture };
      grammar.Append(phrase);
      engine.LoadGrammar(new Grammar(grammar));
      using (var ended = new ManualResetEvent(false)) {
        engine.SpeechRecognized += (sender, e) => {
          if (e.Result.Confidence >= 0.80 && String.Equals(e.Result.Text, phrase, StringComparison.OrdinalIgnoreCase)) {
            Emit(new { type = "wake" });
          }
        };
        engine.RecognizeCompleted += (sender, e) => ended.Set();
        try {
          if (String.IsNullOrEmpty(wave)) engine.SetInputToDefaultAudioDevice();
          else engine.SetInputToWaveFile(wave);
        } catch { Emit(new { type = "error", error = "microphone" }); return; }
        Emit(new { type = "ready" });
        engine.RecognizeAsync(RecognizeMode.Multiple);
        ended.WaitOne();
      }
    }
  }
}
'@
  if (-not $request.phrase -or $request.phrase.Length -gt 40) { throw 'Invalid phrase' }
  # Test input is never exposed as a user setting. Production always uses the microphone.
  [QinlyWake]::Run([string]$request.phrase, [string]$request.language, [string]$request.wave)
} catch {
  [Console]::WriteLine('{"type":"error","error":"unavailable"}')
  exit 1
}
