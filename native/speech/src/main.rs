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
        "voices" => voices::installed().map(|names| json::voices(&names)),
        "speak" => speak(&value, &receiver),
        _ => Err("unsupported action"),
    };
    if let Err(message) = result {
        json::fail(message);
        std::process::exit(1);
    }
    drop(com);
}

fn speak(request: &Value, controls: &Receiver<Option<String>>) -> Result<(), &'static str> {
    let raw = request.get("text").and_then(Value::as_str).unwrap_or("");
    let text = speakable(raw).ok_or("empty text")?;
    let rate = clamp_rate(request.get("rate").and_then(Value::as_i64));
    let volume = clamp_volume(request.get("volume").and_then(Value::as_i64));
    let wanted = request.get("voice").and_then(Value::as_str).unwrap_or("");

    unsafe {
        let voice: ISpVoice =
            CoCreateInstance(&SpVoice, None, CLSCTX_ALL).map_err(|_| "unavailable")?;
        voice.SetRate(rate).map_err(|_| "unavailable")?;
        voice.SetVolume(volume).map_err(|_| "unavailable")?;
        voices::select(&voice, wanted);
        voice.SetNotifyWin32Event().map_err(|_| "unavailable")?;
        let interest = spfei(SPEI_START_INPUT_STREAM.0) | spfei(SPEI_END_INPUT_STREAM.0);
        voice
            .SetInterest(interest, interest)
            .map_err(|_| "unavailable")?;

        let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        // SPF_IS_NOT_XML keeps markup-shaped text literal; SPF_ASYNC returns as
        // soon as the text is queued, so completion is read from events.
        let flags = (SPF_ASYNC.0 | SPF_IS_NOT_XML.0) as u32;
        let mut stream = 0u32;
        voice
            .Speak(PCWSTR(wide.as_ptr()), flags, Some(&mut stream))
            .map_err(|_| "unavailable")?;

        let mut started = false;
        let mut paused = false;
        loop {
            let mut events = [SPEVENT::default(); 8];
            let mut fetched = 0u32;
            if voice
                .GetEvents(events.len() as u32, events.as_mut_ptr(), &mut fetched)
                .is_ok()
            {
                for event in events.iter().take(fetched as usize) {
                    let kind = event._bitfield & 0xFFFF;
                    if event.ulStreamNum != stream {
                        continue;
                    }
                    if kind == SPEI_START_INPUT_STREAM.0 && !started {
                        started = true;
                        json::started();
                    } else if kind == SPEI_END_INPUT_STREAM.0 {
                        if !started {
                            json::started();
                        }
                        json::done();
                        return Ok(());
                    }
                }
            }

            loop {
                match controls.try_recv() {
                    Ok(Some(line)) => match control(&voice, &line, &mut paused) {
                        Some(true) => return Ok(()),
                        Some(false) => {}
                        None => {}
                    },
                    Ok(None) | Err(TryRecvError::Disconnected) => {
                        cancel(&voice);
                        return Ok(());
                    }
                    Err(TryRecvError::Empty) => break,
                }
            }

            // Event waiting, not polling: 50 ms only bounds latency for control
            // input while the queue is empty.
            let _ = voice.WaitForNotifyEvent(50);
        }
    }
}

/// Returns `Some(true)` when the request stops speaking, `Some(false)` after
/// answering a pause/resume, and `None` for input it ignores.
fn control(voice: &ISpVoice, line: &str, paused: &mut bool) -> Option<bool> {
    let value: Value = serde_json::from_str(line).ok()?;
    let action = value.get("action").and_then(Value::as_str)?;
    let id = value.get("id").and_then(Value::as_u64).unwrap_or(0);
    match action {
        "pause" | "resume" => {
            let pause = action == "pause";
            // SAPI's Pause() and Resume() are not a counter, but a second
            // Pause() still leaves the voice paused after one Resume(), so a
            // repeated control must not reach the engine again.
            if pause == *paused {
                json::control(id, *paused);
                return Some(false);
            }
            let applied = unsafe { if pause { voice.Pause() } else { voice.Resume() } };
            if applied.is_err() {
                json::fail("unavailable");
                return Some(true);
            }
            *paused = pause;
            json::control(id, *paused);
            Some(false)
        }
        "stop" => {
            cancel(voice);
            Some(true)
        }
        _ => None,
    }
}

fn cancel(voice: &ISpVoice) {
    unsafe {
        let _ = voice.Speak(PCWSTR::null(), SPF_PURGEBEFORESPEAK.0 as u32, None);
    }
}

/// Cuts the text at a NUL, which would otherwise truncate the wide string
/// inside SAPI, and rejects input that has nothing to speak.
fn speakable(raw: &str) -> Option<&str> {
    let text = raw.split('\0').next().unwrap_or("");
    if text.trim().is_empty() {
        return None;
    }
    Some(text)
}

fn clamp_rate(rate: Option<i64>) -> i32 {
    rate.unwrap_or(0).clamp(-10, 10) as i32
}

fn clamp_volume(volume: Option<i64>) -> u16 {
    volume.unwrap_or(100).clamp(0, 100) as u16
}

#[cfg(test)]
mod tests {
    use super::{clamp_rate, clamp_volume, speakable};

    #[test]
    fn keeps_the_whole_line_and_stops_at_a_nul() {
        assert_eq!(speakable("你好，世界。"), Some("你好，世界。"));
        assert_eq!(speakable("前半句\0后半句"), Some("前半句"));
        assert_eq!(speakable("   "), None);
        assert_eq!(speakable("\0"), None);
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
