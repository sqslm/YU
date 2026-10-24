param([switch]$ListDevices)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  Add-Type -AssemblyName System.Speech
  Add-Type -AssemblyName System.Web.Extensions
  # The whole recogniser lives in one Add-Type block: it needs P/Invoke into winmm.dll
  # (the only dependency-free way to capture a *chosen* input device - NAudio is out,
  # and System.Speech itself can only open the system default endpoint).
  Add-Type -ReferencedAssemblies System.Speech,System.Web.Extensions -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Speech.AudioFormat;
using System.Speech.Recognition;
using System.Threading;
using System.Web.Script.Serialization;

public static class YUWake {
  // ---- WinMM waveIn: enumeration and capture, both from the Windows SDK ----
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct WAVEINCAPS {
    public ushort wMid;
    public ushort wPid;
    public uint vDriverVersion;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
    public string szPname;
    public uint dwFormats;
    public ushort wChannels;
    public ushort wReserved1;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct WAVEFORMATEX {
    public ushort wFormatTag;
    public ushort nChannels;
    public uint nSamplesPerSec;
    public uint nAvgBytesPerSec;
    public ushort nBlockAlign;
    public ushort wBitsPerSample;
    public ushort cbSize;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct WAVEHDR {
    public IntPtr lpData;
    public uint dwBufferLength;
    public uint dwBytesRecorded;
    public IntPtr dwUser;
    public uint dwFlags;
    public uint dwLoops;
    public IntPtr lpNext;
    public IntPtr reserved;
  }

  public delegate void WaveInProc(IntPtr hwi, uint message, IntPtr instance, IntPtr param1, IntPtr param2);

  [DllImport("winmm.dll")]
  static extern int waveInGetNumDevs();
  [DllImport("winmm.dll")]
  static extern int waveInGetDevCapsW(UIntPtr deviceId, out WAVEINCAPS caps, uint size);
  [DllImport("winmm.dll")]
  static extern int waveInOpen(out IntPtr hwi, UIntPtr deviceId, ref WAVEFORMATEX format, WaveInProc callback, IntPtr instance, uint flags);
  [DllImport("winmm.dll")]
  static extern int waveInPrepareHeader(IntPtr hwi, IntPtr header, uint size);
  [DllImport("winmm.dll")]
  static extern int waveInUnprepareHeader(IntPtr hwi, IntPtr header, uint size);
  [DllImport("winmm.dll")]
  static extern int waveInAddBuffer(IntPtr hwi, IntPtr header, uint size);
  [DllImport("winmm.dll")]
  static extern int waveInStart(IntPtr hwi);
  [DllImport("winmm.dll")]
  static extern int waveInStop(IntPtr hwi);
  [DllImport("winmm.dll")]
  static extern int waveInReset(IntPtr hwi);
  [DllImport("winmm.dll")]
  static extern int waveInClose(IntPtr hwi);

  static readonly object OutputLock = new object();
  static void Emit(object value) {
    lock (OutputLock) { Console.WriteLine(new JavaScriptSerializer().Serialize(value)); Console.Out.Flush(); }
  }

  /** One human-readable line on stderr; main drains it, so it never reaches the JSON parser. */
  static void Log(string message) {
    try { Console.Error.WriteLine("[voice-wake] " + message); Console.Error.Flush(); } catch { }
  }

  public static int DeviceCount() { return waveInGetNumDevs(); }

  public static string DeviceName(int index) {
    if (index < 0 || index >= DeviceCount()) return "";
    try {
      WAVEINCAPS caps;
      if (waveInGetDevCapsW(new UIntPtr((uint)index), out caps, (uint)Marshal.SizeOf(typeof(WAVEINCAPS))) != 0) return "";
      return caps.szPname == null ? "" : caps.szPname.Trim();
    } catch { return ""; }
  }

  /** `-ListDevices`: the same enumeration and the same indexes the recogniser below uses. */
  public static void ListDevices() {
    List<object> devices = new List<object>();
    int count = DeviceCount();
    for (int index = 0; index < count; index++) {
      devices.Add(new { id = index.ToString(), name = DeviceName(index) });
    }
    Emit(new { type = "devices", devices = devices });
  }

  /**
   * A blocking PCM stream fed by waveIn: SpeechRecognitionEngine only accepts
   * `SetInputToAudioStream`, so the chosen device has to arrive as bytes.
   */
  public sealed class MicStream : Stream {
    readonly object gate = new object();
    byte[] pending = new byte[0];
    int head;
    bool closed;

    public override bool CanRead { get { return true; } }
    public override bool CanSeek { get { return false; } }
    public override bool CanWrite { get { return false; } }
    public override long Length { get { return ReportedLength; } }
    public override long Position { get { return 0; } set { throw new NotSupportedException(); } }
    public override void Flush() { }
    // The recogniser re-reads from zero on teardown; honouring offset 0 keeps it from
    // dying with NotSupportedException after a perfectly good session.
    public override long Seek(long offset, SeekOrigin origin) {
      if (offset == 0) { lock (gate) { pending = new byte[0]; head = 0; } return 0; }
      throw new NotSupportedException();
    }
    public override void SetLength(long value) { throw new NotSupportedException(); }
    public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }

    /**
     * One second of audio. SAPI sizes its first read from Length, so reporting the
     * empty backlog (0) made it read zero bytes and treat that as end of stream;
     * a positive constant keeps the session alive for as long as main lets it run.
     */
    public const long ReportedLength = 32000;

    public void Push(byte[] data, int count) {
      lock (gate) {
        if (closed || count <= 0) return;
        int have = pending.Length - head;
        // If recognition ever stalls, drop audio instead of growing without bound.
        if (have + count > 160000) { pending = new byte[0]; head = 0; have = 0; }
        byte[] next = new byte[have + count];
        Buffer.BlockCopy(pending, head, next, 0, have);
        Buffer.BlockCopy(data, 0, next, have, count);
        pending = next;
        head = 0;
        Monitor.PulseAll(gate);
      }
    }

    public void Finish() { lock (gate) { closed = true; Monitor.PulseAll(gate); } }

    // SAPI treats any read shorter than the requested count as end of stream, so a
    // live input must block until it can hand over exactly `count` bytes.
    public override int Read(byte[] buffer, int offset, int count) {
      if (count <= 0) return 0;
      lock (gate) {
        while (!closed && pending.Length - head < count) Monitor.Wait(gate);
        int take = Math.Min(count, pending.Length - head);
        if (take <= 0) return 0;
        Buffer.BlockCopy(pending, head, buffer, offset, take);
        head += take;
        if (head >= pending.Length) { pending = new byte[0]; head = 0; }
        return take;
      }
    }
  }

  /** waveIn capture of one device index, 16 kHz / 16-bit / mono - System.Speech's native shape. */
  sealed class WaveInCapture {
    const uint CallbackFunction = 0x00030000;
    const uint DataMessage = 0x3C0;
    const int BufferCount = 4;
    const int BufferBytes = 6400; // 200 ms at 32 kB/s

    readonly MicStream stream = new MicStream();
    readonly IntPtr[] headers = new IntPtr[BufferCount];
    readonly IntPtr[] blocks = new IntPtr[BufferCount];
    readonly WaveInProc callback; // WinMM would call a collected delegate: keep it rooted.
    readonly object gate = new object();
    IntPtr handle = IntPtr.Zero;
    bool running;

    public WaveInCapture() { callback = OnData; }
    public MicStream Stream { get { return stream; } }

    void OnData(IntPtr hwi, uint message, IntPtr instance, IntPtr param1, IntPtr param2) {
      // Nothing may escape into native code: an exception here takes the process down.
      try {
        if (message != DataMessage || param1 == IntPtr.Zero) return;
        WAVEHDR header = (WAVEHDR)Marshal.PtrToStructure(param1, typeof(WAVEHDR));
        int recorded = (int)header.dwBytesRecorded;
        if (recorded > 0 && header.lpData != IntPtr.Zero) {
          byte[] chunk = new byte[recorded];
          Marshal.Copy(header.lpData, chunk, 0, recorded);
          stream.Push(chunk, recorded);
        }
        lock (gate) {
          if (running) waveInAddBuffer(handle, param1, (uint)Marshal.SizeOf(typeof(WAVEHDR)));
        }
      } catch { }
    }

    public bool Open(int index, out int code) {
      WAVEFORMATEX format = new WAVEFORMATEX();
      format.wFormatTag = 1; // WAVE_FORMAT_PCM
      format.nChannels = 1;
      format.nSamplesPerSec = 16000;
      format.wBitsPerSample = 16;
      format.nBlockAlign = (ushort)(format.nChannels * format.wBitsPerSample / 8);
      format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
      format.cbSize = 0;
      IntPtr opened;
      code = waveInOpen(out opened, new UIntPtr((uint)index), ref format, callback, IntPtr.Zero, CallbackFunction);
      if (code != 0) return false;
      handle = opened;
      int size = Marshal.SizeOf(typeof(WAVEHDR));
      for (int i = 0; i < BufferCount; i++) {
        blocks[i] = Marshal.AllocHGlobal(BufferBytes);
        IntPtr header = Marshal.AllocHGlobal(size);
        WAVEHDR value = new WAVEHDR();
        value.lpData = blocks[i];
        value.dwBufferLength = (uint)BufferBytes;
        value.dwBytesRecorded = 0;
        value.dwUser = IntPtr.Zero;
        value.dwFlags = 0;
        value.dwLoops = 0;
        value.lpNext = IntPtr.Zero;
        value.reserved = IntPtr.Zero;
        Marshal.StructureToPtr(value, header, false);
        headers[i] = header;
        if (waveInPrepareHeader(handle, header, (uint)size) != 0 || waveInAddBuffer(handle, header, (uint)size) != 0) {
          code = -1;
          Close();
          return false;
        }
      }
      lock (gate) { running = true; }
      if (waveInStart(handle) != 0) { code = -2; Close(); return false; }
      return true;
    }

    public void Close() {
      IntPtr current = handle;
      lock (gate) { running = false; }
      if (current != IntPtr.Zero) {
        waveInStop(current);
        waveInReset(current);
        int size = Marshal.SizeOf(typeof(WAVEHDR));
        for (int i = 0; i < BufferCount; i++) {
          if (headers[i] != IntPtr.Zero) {
            waveInUnprepareHeader(current, headers[i], (uint)size);
            Marshal.FreeHGlobal(headers[i]);
            headers[i] = IntPtr.Zero;
          }
          if (blocks[i] != IntPtr.Zero) { Marshal.FreeHGlobal(blocks[i]); blocks[i] = IntPtr.Zero; }
        }
        waveInClose(current);
        handle = IntPtr.Zero;
      }
      stream.Finish();
    }
  }

  /**
   * Index from settings, "-1"/"" for the system default. A saved index that no
   * longer exists (unplugged headset, reordered devices) falls back to the default
   * with one logged line: silently listening to nothing reads as a broken app.
   */
  static int Resolve(string device, bool hasWave) {
    if (hasWave) return -1;
    if (String.IsNullOrEmpty(device)) return -1;
    int index;
    if (!Int32.TryParse(device, out index)) { Log("device '" + device + "' is not an index; using the default input"); return -1; }
    if (index < 0) return -1;
    int count = DeviceCount();
    if (index >= count) {
      Log("device " + index + " is missing (" + count + " inputs); using the default input");
      Emit(new { type = "log", reason = "device-missing", device = index });
      return -1;
    }
    return index;
  }

  public static void Run(string phrase, string language, string wave, string device) {
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
      int index = Resolve(device, !String.IsNullOrEmpty(wave));
      WaveInCapture capture = null;
      try {
        if (!String.IsNullOrEmpty(wave)) {
          engine.SetInputToWaveFile(wave);
          Log("reading a wave file instead of a live input");
        } else if (index >= 0) {
          capture = new WaveInCapture();
          int code;
          if (capture.Open(index, out code)) {
            try {
              engine.SetInputToAudioStream(capture.Stream, new SpeechAudioFormatInfo(16000, AudioBitsPerSample.Sixteen, AudioChannel.Mono));
              Emit(new { type = "device", device = index, name = DeviceName(index) });
            } catch {
              capture.Close();
              capture = null;
              Log("device " + index + " opened but could not feed the recogniser; using the default input");
              Emit(new { type = "log", reason = "device-stream-failed", device = index });
              engine.SetInputToDefaultAudioDevice();
            }
          } else {
            capture = null;
            Log("device " + index + " would not open (waveIn code " + code + "); using the default input");
            Emit(new { type = "log", reason = "device-open-failed", device = index, code = code });
            engine.SetInputToDefaultAudioDevice();
          }
        } else {
          engine.SetInputToDefaultAudioDevice();
        }
      } catch { Emit(new { type = "error", error = "microphone" }); return; }
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
        Emit(new { type = "ready" });
        engine.RecognizeAsync(RecognizeMode.Multiple);
        // Also release the microphone when main kills us: nothing else stops waveIn,
        // and an open input keeps the device's "in use" light on.
        using (var stop = new ManualResetEvent(false)) {
          Console.CancelKeyPress += (sender, e) => { e.Cancel = true; stop.Set(); };
          WaitHandle.WaitAny(new WaitHandle[] { ended, stop });
        }
      }
      if (capture != null) capture.Close();
    }
  }
}
'@
  if ($ListDevices) { [YUWake]::ListDevices(); exit 0 }
  $request = [Console]::ReadLine() | ConvertFrom-Json
  if (-not $request.phrase -or $request.phrase.Length -gt 40) { throw 'Invalid phrase' }
  # Test input is never exposed as a user setting. Production always uses the microphone.
  [YUWake]::Run([string]$request.phrase, [string]$request.language, [string]$request.wave, [string]$request.device)
} catch {
  [Console]::WriteLine('{"type":"error","error":"unavailable"}')
  exit 1
}
