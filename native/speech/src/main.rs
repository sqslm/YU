//! Local Windows TTS helper. One request per process, NDJSON on stdout.
//!
//! `voices` answers and exits. `speak` acknowledges the real start of its own
//! stream, keeps reading stdin for pause/resume, and reports completion once.

mod json;
mod voices;

use std::io::{self, BufRead};
use std::sync::mpsc::{self, Receiver, TryRecvError};

use serde_json::Value;
use windows::Win32::Media::Speech::{
    ISpVoice, SPEI_END_INPUT_STREAM, SPEI_START_INPUT_STREAM, SPEVENT, SPF_ASYNC, SPF_IS_NOT_XML,
    SPF_PURGEBEFORESPEAK, SpVoice,
};
use windows::Win32::System::Com::{
    CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
};
use windows::core::PCWSTR;

/// sapi.h defines SPFEI(id) as the bit plus these guard bits; SetInterest
/// rejects a mask that omits them.
const SPFEI_FLAGCHECK: u64 = (1 << 30) | (1 << 33);

fn spfei(id: i32) -> u64 {
    (1u64 << id) | SPFEI_FLAGCHECK
}

struct Com {
    ready: bool,
}

impl Com {
    fn start() -> Self {
        let ready = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
        Self { ready }
    }
}

impl Drop for Com {
    fn drop(&mut self) {
        if self.ready {
            unsafe { CoUninitialize() };
        }
    }
}

fn main() {
    let com = Com::start();
    if !com.ready {
        json::fail("unavailable");
        std::process::exit(1);
    }
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let stdin = io::stdin();
        let mut lines = stdin.lock();
        let mut line = String::new();
        loop {
            line.clear();
            match lines.read_line(&mut line) {
                Ok(0) | Err(_) => {
                    let _ = sender.send(None);
                    break;
                }
                Ok(_) => {
                    if sender.send(Some(line.trim_end().to_string())).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let request = match receiver.recv() {
        Ok(Some(line)) => line,
        _ => {
            json::fail("unavailable");
            std::process::exit(1);
        }
    };
    let value: Value = match serde_json::from_str(&request) {
        Ok(value) => value,
        Err(_) => {
            json::fail("invalid request");
            std::process::exit(1);
        }
    };
    let action = value.get("action").and_then(Value::as_str).unwrap_or("");
    let result = match action {
        "voices" => voices::installed()
            .map(|names| json::voices(&names))
            .map_err(|error| error.to_string()),
        "speak" => speak(&value, &receiver),
        _ => Err("unsupported action".to_string()),
    };
    if let Err(message) = result {
        json::fail(&message);
        std::process::exit(1);
    }
    drop(com);
}

fn speak(request: &Value, controls: &Receiver<Option<String>>) -> Result<(), String> {
    let raw = request.get("text").and_then(Value::as_str).unwrap_or("");
    let text = speakable(raw)?;
    let rate = clamp_rate(request.get("rate").and_then(Value::as_i64));
    let volume = clamp_volume(request.get("volume").and_then(Value::as_i64));
    let wanted = request.get("voice").and_then(Value::as_str).unwrap_or("");

    unsafe {
        let voice: ISpVoice = CoCreateInstance(&SpVoice, None, CLSCTX_ALL)
            .map_err(|error| stage("create", &error))?;
        voice.SetRate(rate).map_err(|error| stage("rate", &error))?;
        voice
            .SetVolume(volume)
            .map_err(|error| stage("volume", &error))?;
        voices::select(&voice, wanted);
        voice
            .SetNotifyWin32Event()
            .map_err(|error| stage("notify", &error))?;
        let interest = spfei(SPEI_START_INPUT_STREAM.0) | spfei(SPEI_END_INPUT_STREAM.0);
        voice
            .SetInterest(interest, interest)
            .map_err(|error| stage("interest", &error))?;

        let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        // SPF_IS_NOT_XML keeps markup-shaped text literal; SPF_ASYNC returns as
        // soon as the text is queued, so completion is read from events.
        let flags = (SPF_ASYNC.0 | SPF_IS_NOT_XML.0) as u32;
        let mut stream = 0u32;
        voice
            .Speak(PCWSTR(wide.as_ptr()), flags, Some(&mut stream))
            .map_err(|error| stage("queue", &error))?;

        let mut surface = SpVoiceSurface { voice: &voice };
        converse(&mut surface, stream, controls)
    }
}

/// The SAPI calls the utterance loop needs. Keeping them behind a tiny local
/// trait is what lets the loop's failure and stream rules be unit tested
/// without an audio device; it is not a general abstraction.
trait Surface {
    /// Returns how many events were written into the buffer. No events is a
    /// normal answer, not a failure.
    fn events(&mut self, buffer: &mut [SPEVENT]) -> Result<usize, String>;
    fn wait(&mut self, milliseconds: u32) -> Result<(), String>;
    fn set_paused(&mut self, paused: bool) -> Result<(), String>;
    fn cancel(&mut self);
}

struct SpVoiceSurface<'a> {
    voice: &'a ISpVoice,
}

impl Surface for SpVoiceSurface<'_> {
    fn events(&mut self, buffer: &mut [SPEVENT]) -> Result<usize, String> {
        let mut fetched = 0u32;
        // A real failure here would otherwise strand the loop: the startup
        // deadline is already cleared and nothing else would fire.
        unsafe {
            self.voice
                .GetEvents(buffer.len() as u32, buffer.as_mut_ptr(), &mut fetched)
        }
        .map_err(|error| stage("events", &error))?;
        Ok(fetched as usize)
    }

    fn wait(&mut self, milliseconds: u32) -> Result<(), String> {
        // Event waiting, not polling: the timeout only bounds how long control
        // input can wait behind an idle event queue (see README).
        unsafe { self.voice.WaitForNotifyEvent(milliseconds) }
            .map_err(|error| stage("wait", &error))
    }

    fn set_paused(&mut self, paused: bool) -> Result<(), String> {
        unsafe {
            if paused {
                self.voice.Pause()
            } else {
                self.voice.Resume()
            }
        }
        .map_err(|error| stage("control", &error))
    }

    fn cancel(&mut self) {
        unsafe {
            let _ = self
                .voice
                .Speak(PCWSTR::null(), SPF_PURGEBEFORESPEAK.0 as u32, None);
        }
    }
}

/// Drives one utterance until its own stream ends, a control stops it, or the
/// parent closes stdin.
fn converse<S: Surface>(
    surface: &mut S,
    stream: u32,
    controls: &Receiver<Option<String>>,
) -> Result<(), String> {
    let mut started = false;
    let mut paused = false;
    loop {
        let mut events = [SPEVENT::default(); 8];
        let fetched = surface.events(&mut events)?;
        for event in events.iter().take(fetched) {
            let kind = event._bitfield & 0xFFFF;
            match classify(kind, event.ulStreamNum, stream, started) {
                Step::Started => {
                    started = true;
                    json::started();
                }
                Step::Done => {
                    json::done();
                    return Ok(());
                }
                // Without the start of this stream there is no evidence the
                // text was spoken, so completion must not be reported.
                Step::MissingStart => {
                    return Err("end of stream without a start event".to_string());
                }
                Step::Ignore => {}
            }
        }

        loop {
            match controls.try_recv() {
                Ok(Some(line)) => {
                    if let Some(true) = control(surface, &line, &mut paused)? {
                        return Ok(());
                    }
                }
                Ok(None) | Err(TryRecvError::Disconnected) => {
                    surface.cancel();
                    return Ok(());
                }
                Err(TryRecvError::Empty) => break,
            }
        }

        surface.wait(50)?;
    }
}

/// What one SAPI event means for the utterance this process queued.
#[derive(Debug, PartialEq)]
enum Step {
    /// The start of our own stream: the text is now really being spoken.
    Started,
    /// The end of our own stream, after a start we already reported.
    Done,
    /// The end of our stream without its start: never confirm that as spoken.
    MissingStart,
    /// Another stream, a repeat, or an event we did not subscribe to.
    Ignore,
}

fn classify(kind: i32, event_stream: u32, our_stream: u32, started: bool) -> Step {
    if event_stream != our_stream {
        return Step::Ignore;
    }
    if kind == SPEI_START_INPUT_STREAM.0 {
        return if started { Step::Ignore } else { Step::Started };
    }
    if kind == SPEI_END_INPUT_STREAM.0 {
        return if started {
            Step::Done
        } else {
            Step::MissingStart
        };
    }
    Step::Ignore
}

/// Prefixes a failure with the step and its HRESULT, so a report says where it
/// broke without echoing any of the text being spoken.
fn stage(step: &str, error: &windows::core::Error) -> String {
    format!("{step} failed 0x{:08X}", error.code().0 as u32)
}

/// Returns `Some(true)` when the request stops speaking, `Some(false)` after
/// answering a pause/resume, and `None` for input it ignores.
fn control<S: Surface>(
    surface: &mut S,
    line: &str,
    paused: &mut bool,
) -> Result<Option<bool>, String> {
    let value: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    let action = value.get("action").and_then(Value::as_str).unwrap_or("");
    let id = value.get("id").and_then(Value::as_u64).unwrap_or(0);
    match action {
        "pause" | "resume" => {
            let pause = action == "pause";
            // SAPI's Pause() and Resume() are not a counter, but a second
            // Pause() still leaves the voice paused after one Resume(), so a
            // repeated control must not reach the engine again.
            if pause == *paused {
                json::control(id, *paused);
                return Ok(Some(false));
            }
            surface.set_paused(pause)?;
            *paused = pause;
            json::control(id, *paused);
            Ok(Some(false))
        }
        "stop" => {
            surface.cancel();
            Ok(Some(true))
        }
        _ => Ok(None),
    }
}

/// SAPI speaks a NUL-terminated wide string, so a NUL inside the request would
/// silently drop everything after it. Truncating and reporting success would
/// claim text was spoken that never was, so the request is refused instead.
fn speakable(raw: &str) -> Result<&str, String> {
    if raw.contains('\0') {
        return Err("text contains a NUL".to_string());
    }
    if raw.trim().is_empty() {
        return Err("empty text".to_string());
    }
    Ok(raw)
}

fn clamp_rate(rate: Option<i64>) -> i32 {
    rate.unwrap_or(0).clamp(-10, 10) as i32
}

fn clamp_volume(volume: Option<i64>) -> u16 {
    volume.unwrap_or(100).clamp(0, 100) as u16
}

#[cfg(test)]
mod tests {
    use super::{Step, Surface, clamp_rate, clamp_volume, classify, converse, speakable};
    use std::collections::VecDeque;
    use std::sync::mpsc;
    use windows::Win32::Media::Speech::{SPEI_END_INPUT_STREAM, SPEI_START_INPUT_STREAM, SPEVENT};

    /// Stands in for the SAPI calls so the utterance loop's rules can be
    /// exercised without a voice, a device or an event queue.
    struct Fake {
        batches: VecDeque<Vec<SPEVENT>>,
        fail_events: Option<String>,
        fail_wait: Option<String>,
        waits: u32,
        cancelled: u32,
        pauses: Vec<bool>,
    }

    impl Fake {
        fn new(batches: Vec<Vec<SPEVENT>>) -> Self {
            Self {
                batches: batches.into(),
                fail_events: None,
                fail_wait: None,
                waits: 0,
                cancelled: 0,
                pauses: Vec::new(),
            }
        }
    }

    impl Surface for Fake {
        fn events(&mut self, buffer: &mut [SPEVENT]) -> Result<usize, String> {
            if let Some(error) = &self.fail_events {
                return Err(error.clone());
            }
            match self.batches.pop_front() {
                Some(batch) => {
                    let take = batch.len().min(buffer.len());
                    buffer[..take].copy_from_slice(&batch[..take]);
                    Ok(take)
                }
                // A real queue answering "no events" is normal, but running out
                // of scripted answers means the loop did not finish when it
                // should have, so fail instead of spinning.
                None => Err("scripted events exhausted".to_string()),
            }
        }

        fn wait(&mut self, _milliseconds: u32) -> Result<(), String> {
            if let Some(error) = &self.fail_wait {
                return Err(error.clone());
            }
            self.waits += 1;
            Ok(())
        }

        fn set_paused(&mut self, paused: bool) -> Result<(), String> {
            self.pauses.push(paused);
            Ok(())
        }

        fn cancel(&mut self) {
            self.cancelled += 1;
        }
    }

    fn event(kind: i32, stream: u32) -> SPEVENT {
        SPEVENT {
            _bitfield: kind,
            ulStreamNum: stream,
            ..Default::default()
        }
    }

    #[test]
    fn confirms_a_start_only_from_this_streams_own_start() {
        let start = SPEI_START_INPUT_STREAM.0;
        let end = SPEI_END_INPUT_STREAM.0;
        assert_eq!(classify(start, 7, 7, false), Step::Started);
        // A repeat of the start must not be acknowledged twice.
        assert_eq!(classify(start, 7, 7, true), Step::Ignore);
        assert_eq!(classify(end, 7, 7, true), Step::Done);
        // No start means no evidence the text was spoken; reporting success
        // here would be a fabricated acknowledgement.
        assert_eq!(classify(end, 7, 7, false), Step::MissingStart);
        // Events from the previous utterance cannot confirm this one.
        assert_eq!(classify(start, 6, 7, false), Step::Ignore);
        assert_eq!(classify(end, 6, 7, true), Step::Ignore);
        assert_eq!(classify(99, 7, 7, false), Step::Ignore);
    }

    #[test]
    fn stops_on_a_control_line_after_an_empty_tick() {
        let (sender, receiver) = mpsc::channel::<Option<String>>();
        // One tick with no events at all, then a stop request; the control is
        // read before the wait, so no tick is spent waiting first.
        sender
            .send(Some("{\"action\":\"stop\"}".to_string()))
            .unwrap();
        let mut fake = Fake::new(vec![Vec::new()]);
        assert_eq!(converse(&mut fake, 3, &receiver), Ok(()));
        assert_eq!(fake.waits, 0);
        assert_eq!(fake.cancelled, 1);
    }

    #[test]
    fn stops_when_the_parent_closes_stdin() {
        let (sender, receiver) = mpsc::channel::<Option<String>>();
        let sender_clone = sender.clone();
        let mut fake = Fake::new(vec![Vec::new()]);
        drop(sender_clone);
        drop(sender);
        assert_eq!(converse(&mut fake, 3, &receiver), Ok(()));
        assert_eq!(fake.cancelled, 1);
    }

    #[test]
    fn answers_pause_and_resume_once_each() {
        let (sender, receiver) = mpsc::channel::<Option<String>>();
        sender
            .send(Some("{\"action\":\"pause\",\"id\":1}".to_string()))
            .unwrap();
        sender
            .send(Some("{\"action\":\"pause\",\"id\":2}".to_string()))
            .unwrap();
        sender
            .send(Some("{\"action\":\"resume\",\"id\":3}".to_string()))
            .unwrap();
        sender
            .send(Some("{\"action\":\"stop\"}".to_string()))
            .unwrap();
        let mut fake = Fake::new(vec![Vec::new()]);
        assert_eq!(converse(&mut fake, 3, &receiver), Ok(()));
        // The repeat pause was answered from state without reaching the engine;
        // only the first pause and the resume were applied.
        assert_eq!(fake.pauses, vec![true, false]);
        assert_eq!(fake.cancelled, 1);
    }

    #[test]
    fn reports_a_failed_event_read() {
        let (_sender, receiver) = mpsc::channel::<Option<String>>();
        let mut fake = Fake::new(vec![]);
        fake.fail_events = Some("events failed 0x80004005".to_string());
        assert_eq!(
            converse(&mut fake, 3, &receiver),
            Err("events failed 0x80004005".to_string())
        );
    }

    #[test]
    fn reports_a_failed_wait_and_stops() {
        let (_sender, receiver) = mpsc::channel::<Option<String>>();
        let mut fake = Fake::new(vec![Vec::new()]);
        fake.fail_wait = Some("wait failed 0x80070057".to_string());
        assert_eq!(
            converse(&mut fake, 3, &receiver),
            Err("wait failed 0x80070057".to_string())
        );
        assert_eq!(fake.cancelled, 0);
    }

    #[test]
    fn refuses_to_confirm_an_end_without_its_start() {
        let (_sender, receiver) = mpsc::channel::<Option<String>>();
        let end = SPEI_END_INPUT_STREAM.0;
        let mut fake = Fake::new(vec![vec![event(end, 3)]]);
        assert_eq!(
            converse(&mut fake, 3, &receiver),
            Err("end of stream without a start event".to_string())
        );
    }

    #[test]
    fn ignores_another_streams_events() {
        let (_sender, receiver) = mpsc::channel::<Option<String>>();
        let start = SPEI_START_INPUT_STREAM.0;
        let end = SPEI_END_INPUT_STREAM.0;
        // A previous utterance's start and end, then our own pair. Treating the
        // foreign end as ours would report an error or finish too early.
        let mut fake = Fake::new(vec![
            vec![event(start, 2)],
            vec![event(end, 2)],
            vec![event(start, 3), event(end, 3)],
        ]);
        assert_eq!(converse(&mut fake, 3, &receiver), Ok(()));
        assert_eq!(fake.cancelled, 0);
        assert_eq!(fake.waits, 2);
    }

    #[test]
    fn keeps_the_whole_line_and_refuses_a_nul() {
        assert_eq!(speakable("你好，世界。"), Ok("你好，世界。"));
        // Truncating here would speak half a sentence and report success.
        assert_eq!(
            speakable("前半句\0后半句"),
            Err("text contains a NUL".to_string())
        );
        assert_eq!(speakable("\0"), Err("text contains a NUL".to_string()));
        assert_eq!(speakable("   "), Err("empty text".to_string()));
    }

    #[test]
    fn clamps_rate_and_volume_to_the_sapi_range() {
        assert_eq!(clamp_rate(None), 0);
        assert_eq!(clamp_rate(Some(-25)), -10);
        assert_eq!(clamp_rate(Some(25)), 10);
        assert_eq!(clamp_volume(None), 100);
        assert_eq!(clamp_volume(Some(-1)), 0);
        assert_eq!(clamp_volume(Some(140)), 100);
    }
}
