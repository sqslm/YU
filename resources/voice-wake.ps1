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
public static class YUWake {
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
      engine.LoadGrammar(new Grammar(grammar) { Name = "wake" });
      // Competing ordinary speech can be rejected instead of forced into the one wake phrase.
      engine.LoadGrammar(new DictationGrammar { Name = "background", Weight = 0.5f });
      using (var ended = new ManualResetEvent(false)) {
        engine.SpeechRecognized += (sender, e) => {
          if (e.Result.Grammar.Name == "wake" && String.Equals(e.Result.Text, phrase, StringComparison.OrdinalIgnoreCase)) {
            float wordConfidence = 1;
            foreach (var word in e.Result.Words) wordConfidence = Math.Min(wordConfidence, word.Confidence);
            Emit(new { type = "wake", phrase = phrase, confidence = e.Result.Confidence,
              wordConfidence = wordConfidence, durationMs = e.Result.Audio.Duration.TotalMilliseconds });
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
  [YUWake]::Run([string]$request.phrase, [string]$request.language, [string]$request.wave)
} catch {
  [Console]::WriteLine('{"type":"error","error":"unavailable"}')
  exit 1
}
