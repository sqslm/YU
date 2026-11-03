// SAPI listener. The grammar is the same control scheme the PowerShell host runs after
// its grammar-competition fix: the complete phrase, the phrase plus whatever follows,
// and the pieces either side of a silence gap, which only feed the carry path.

use std::ffi::c_void;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use windows::Win32::Foundation::WAIT_OBJECT_0;
use windows::Win32::Media::Audio::WAVEFORMATEX;
use windows::Win32::Media::Speech::{
    ISpDataKey, ISpObjectToken, ISpObjectTokenCategory, ISpPhrase, ISpRecoContext, ISpRecoGrammar,
    ISpRecoResult, ISpRecognizer, ISpStream, ISpStreamFormat, SPEI_END_SR_STREAM,
    SPEI_FALSE_RECOGNITION, SPEI_RECOGNITION, SPEI_SR_AUDIO_LEVEL, SPFM_OPEN_READONLY,
    SPGS_ENABLED, SPLO_DYNAMIC, SPPHRASE, SPRST_ACTIVE, SPRST_INACTIVE, SPRULESTATE,
    SPSTREAMFORMATTYPE, SpInprocRecognizer, SpObjectTokenCategory, SpStream,
};
use windows::Win32::System::Com::{
    CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree,
    CoUninitialize,
};
use windows::Win32::System::Threading::WaitForSingleObject;
use windows::core::{HSTRING, Interface, PCWSTR};

use crate::json;
use crate::matching::{self, Outcome, Tracker, Word};

/// Which input the recogniser reads from.
pub enum Input {
    /// Synthetic or recorded wave; used by tests and benchmarks, never by the app.
    Wave(String),
    /// Wave file pushed through the live capture stream (test mode).
    Stream(String),
    /// Live capture. `-1` means the system default device.
    Device(i32),
}

pub struct Config {
    pub phrase: String,
    pub language: String,
    pub input: Input,
    pub variants: Vec<(String, String)>,
}

#[derive(Debug)]
pub enum Failure {
    Language,
    Microphone,
    Unavailable,
}

impl Failure {
    pub fn code(&self) -> &'static str {
        match self {
            Failure::Language => "language",
            Failure::Microphone => "microphone",
            Failure::Unavailable => "unavailable",
        }
    }
}

struct Com;

impl Com {
    fn start() -> Result<Self, Failure> {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .ok()
            .map_err(|_| Failure::Unavailable)?;
        Ok(Com)
    }
}

impl Drop for Com {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

fn lcid(language: &str) -> u32 {
    match language {
        "zh" => 0x804,
        "en" => 0x409,
        _ => 0x409,
    }
}

fn recognizer_for(language: &str) -> Result<ISpRecognizer, Failure> {
    fn stage(name: &str, error: windows::core::Error) -> Failure {
        eprintln!("{name}: {error}");
        Failure::Language
    }
    unsafe {
        let category: ISpObjectTokenCategory =
            CoCreateInstance(&SpObjectTokenCategory, None, CLSCTX_ALL)
                .map_err(|error| stage("category", error))?;
        category
            .SetId(
                &HSTRING::from("HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Speech\\Recognizers"),
                false,
            )
            .map_err(|error| stage("category id", error))?;
        let tokens = category
            .EnumTokens(&HSTRING::new(), &HSTRING::new())
            .map_err(|error| stage("enum tokens", error))?;
        let wanted = format!("{:X}", lcid(language));
        let mut chosen: Option<ISpObjectToken> = None;
        loop {
            let mut token: [Option<ISpObjectToken>; 1] = [None];
            let mut fetched = 0u32;
            if tokens
                .Next(1, token.as_mut_ptr(), Some(&mut fetched))
                .is_err()
                || fetched == 0
            {
                break;
            }
            let Some(token) = token[0].take() else { break };
            let attributes = token.OpenKey(&HSTRING::from("Attributes")).ok();
            let languages = attributes
                .as_ref()
                .map(|key| string_value(key, "Language"))
                .unwrap_or_default();
            let enabled = attributes
                .as_ref()
                .map(|key| string_value(key, "Enabled"))
                .unwrap_or_default();
            let usable = enabled.is_empty() || enabled == "1";
            if usable
                && languages
                    .split(';')
                    .any(|entry| entry.trim().eq_ignore_ascii_case(&wanted))
            {
                chosen = Some(token);
                break;
            }
        }
        let token = chosen.ok_or_else(|| {
            eprintln!("no recogniser token for language {language}");
            Failure::Language
        })?;
        let recognizer: ISpRecognizer = CoCreateInstance(&SpInprocRecognizer, None, CLSCTX_ALL)
            .map_err(|error| stage("recognizer", error))?;
        recognizer
            .SetRecognizer(&token)
            .map_err(|error| stage("set recognizer", error))?;
        Ok(recognizer)
    }
}

/// Reads an attribute; the string is owned by COM, so it is copied and freed.
fn string_value(token: &ISpDataKey, name: &str) -> String {
    unsafe {
        let Ok(pointer) = token.GetStringValue(&HSTRING::from(name)) else {
            return String::new();
        };
        if pointer.is_null() {
            return String::new();
        }
        let value = pointer.to_string().unwrap_or_default();
        CoTaskMemFree(Some(pointer.0 as *const c_void));
        value
    }
}

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn grammar_xml(config: &Config) -> (String, Vec<String>, bool) {
    let mut phrases = vec![config.phrase.clone()];
    for (text, _) in &config.variants {
        if !text.trim().is_empty() {
            phrases.push(text.clone());
        }
    }
    let items: Vec<String> = phrases
        .iter()
        .map(|phrase| format!("<item>{}</item>", xml_escape(phrase)))
        .collect();
    let leading = matching::leading_pieces(&config.phrase);
    let trailing = matching::trailing_pieces(&config.phrase);
    let mut rules = vec![
        format!(
            "<rule id=\"wake\" scope=\"public\"><one-of>{}</one-of></rule>",
            items.join("")
        ),
        format!(
            "<rule id=\"followed\" scope=\"public\"><one-of>{}</one-of><ruleref special=\"GARBAGE\"/></rule>",
            items.join("")
        ),
    ];
    let mut active = vec!["wake".to_string(), "followed".to_string()];
    if !leading.is_empty() {
        let pieces: Vec<String> = leading
            .iter()
            .map(|piece| format!("<item>{}</item>", xml_escape(piece)))
            .collect();
        rules.push(format!(
            "<rule id=\"leading\" scope=\"public\"><one-of>{}</one-of></rule>",
            pieces.join("")
        ));
        active.push("leading".to_string());
    }
    if !trailing.is_empty() {
        let pieces: Vec<String> = trailing
            .iter()
            .map(|piece| format!("<item>{}</item>", xml_escape(piece)))
            .collect();
        rules.push(format!(
            "<rule id=\"trailing\" scope=\"public\"><one-of>{}</one-of></rule>",
            pieces.join("")
        ));
        active.push("trailing".to_string());
    }
    let language = if config.language == "zh" {
        "zh-CN"
    } else {
        "en-US"
    };
    let xml = format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<grammar version=\"1.0\" xml:lang=\"{language}\" root=\"wake\" xmlns=\"http://www.w3.org/2001/06/grammar\">{}</grammar>",
        rules.join("")
    );
    (xml, active, !config.variants.is_empty())
}

fn word_from_element(element: &windows::Win32::Media::Speech::SPPHRASEELEMENT) -> Word {
    let text = if element.pszDisplayText.is_null() {
        read_wide(element.pszLexicalForm)
    } else {
        read_wide(element.pszDisplayText)
    };
    let phones = read_phones(element.pszPronunciation);
    let confidence = if element.SREngineConfidence > 0.0 && element.SREngineConfidence <= 1.0 {
        element.SREngineConfidence
    } else {
        match element.ActualConfidence {
            2 => 0.9,
            1 => 0.6,
            _ => 0.3,
        }
    };
    Word {
        text: matching::match_text(&text),
        phones,
        confidence,
        duration_ms: f64::from(element.ulAudioSizeTime) / 10_000.0,
    }
}

fn read_wide(pointer: PCWSTR) -> String {
    if pointer.is_null() {
        return String::new();
    }
    unsafe { pointer.to_string() }.unwrap_or_default()
}

/// Phone ids arrive as a null-terminated `WORD` array; the PowerShell host stores the
/// same ids as characters, so converting one to one keeps trained variants valid.
fn read_phones(pointer: *const u16) -> String {
    if pointer.is_null() {
        return String::new();
    }
    let mut ids = Vec::new();
    let mut index = 0usize;
    loop {
        let value = unsafe { *pointer.add(index) };
        if value == 0 || index > 512 {
            break;
        }
        ids.push(value);
        index += 1;
    }
    matching::phones(&ids)
}

struct GrammarFile {
    path: std::path::PathBuf,
}

impl Drop for GrammarFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn write_grammar(xml: &str) -> Result<GrammarFile, Failure> {
    let path = std::env::temp_dir().join(format!("yu-wake-{}.grxml", std::process::id()));
    std::fs::write(&path, xml).map_err(|_| Failure::Unavailable)?;
    Ok(GrammarFile { path })
}

fn bytes_per_ms(recognizer: &ISpRecognizer) -> f64 {
    unsafe {
        let mut guid = windows::core::GUID::zeroed();
        let mut format: *mut WAVEFORMATEX = std::ptr::null_mut();
        if recognizer
            .GetFormat(SPSTREAMFORMATTYPE(0), &mut guid, &mut format)
            .is_err()
            || format.is_null()
        {
            // 16 kHz, 16 bit, mono, which is what the wave path and the tests use.
            return 32.0;
        }
        let rate = f64::from((*format).nAvgBytesPerSec as i32).max(1.0) / 1000.0;
        if rate > 0.0 { rate } else { 32.0 }
    }
}

fn opening(name: &str, error: windows::core::Error) -> Failure {
    eprintln!("{name}: {error}");
    Failure::Microphone
}

fn step<T>(name: &str, result: windows::core::Result<T>) -> Result<T, Failure> {
    result.map_err(|error| {
        eprintln!("{name}: {error}");
        Failure::Unavailable
    })
}

pub fn run(config: &Config, stop: &AtomicBool, deadline_ms: u64) -> Result<(), Failure> {
    let _com = Com::start()?;
    let recognizer = recognizer_for(&config.language)?;
    let context: ISpRecoContext =
        unsafe { recognizer.CreateRecoContext() }.map_err(|_| Failure::Unavailable)?;
    let wave_input = matches!(config.input, Input::Wave(_) | Input::Stream(_));
    let (xml, rules, _) = grammar_xml(config);
    let grammar_file = write_grammar(&xml)?;
    let grammar: ISpRecoGrammar = step("create grammar", unsafe { context.CreateGrammar(0u64) })?;
    step("load grammar", unsafe {
        grammar.LoadCmdFromFile(
            &HSTRING::from(grammar_file.path.to_string_lossy().to_string()),
            SPLO_DYNAMIC,
        )
    })?;
    for rule in &rules {
        step("rule state", unsafe {
            grammar.SetRuleState(
                &HSTRING::from(rule.as_str()),
                std::ptr::null_mut(),
                SPRULESTATE(SPGS_ENABLED.0),
            )
        })?;
    }

    let factor = bytes_per_ms(&recognizer);
    let mut capture: Option<crate::capture::Capture> = None;
    let level_sink: Option<Arc<crate::capture::Shared>>;
    match &config.input {
        Input::Wave(path) => {
            let stream: ISpStream = unsafe { CoCreateInstance(&SpStream, None, CLSCTX_ALL) }
                .map_err(|error| opening("wave stream", error))?;
            unsafe {
                stream.BindToFile(
                    &HSTRING::from(path.as_str()),
                    SPFM_OPEN_READONLY,
                    None,
                    None,
                    0,
                )
            }
            .map_err(|error| opening("bind wave", error))?;
            unsafe { recognizer.SetInput(&stream, true) }
                .map_err(|error| opening("wave input", error))?;
            level_sink = None;
        }
        Input::Stream(path) => {
            let shared = Arc::new(crate::capture::Shared::new_for_test());
            let stream: ISpStreamFormat =
                crate::stream::CaptureStream::new(Arc::clone(&shared)).into();
            unsafe { recognizer.SetInput(&stream, true) }
                .map_err(|error| opening("stream input", error))?;
            crate::capture::feed(&shared, path).map_err(|_| Failure::Unavailable)?;
            level_sink = Some(shared);
        }
        Input::Device(index) => {
            let known = crate::devices::list();
            let requested = *index;
            let available =
                requested < 0 || known.iter().any(|(id, _)| id == &requested.to_string());
            let device = if available {
                crate::capture::map_device(requested)
            } else {
                // The remembered device disappeared; say so once and fall back to the
                // default input instead of failing the whole session.
                json::emit(&json::log_event("device-missing", requested));
                crate::capture::map_device(-1)
            };
            let opened = crate::capture::Capture::open(device).map_err(|code| {
                let _ = code;
                json::emit(&json::log_event("device-open-failed", requested));
                Failure::Microphone
            })?;
            let shared = opened.shared();
            let stream: ISpStreamFormat =
                crate::stream::CaptureStream::new(Arc::clone(&shared)).into();
            unsafe { recognizer.SetInput(&stream, true) }
                .map_err(|error| opening("device input", error))?;
            let name = if device == crate::capture::WAVE_MAPPER {
                String::new()
            } else {
                crate::capture::device_name(device)
            };
            json::emit(&json::device_event(requested, &name));
            level_sink = Some(shared);
            capture = Some(opened);
        }
    }

    step("notify", unsafe { context.SetNotifyWin32Event() })?;
    let interest = 1u64 << SPEI_RECOGNITION.0;
    let _ = interest;
    // step("interest", unsafe { context.SetInterest(interest, interest) })?;
    let handle = unsafe { context.GetNotifyEventHandle() };

    let mut tracker = Tracker::new(&config.phrase, &config.variants);
    let started = Instant::now();
    let mut last_level = Instant::now() - std::time::Duration::from_secs(1);
    let mut ended = false;
    step("active", unsafe { recognizer.SetRecoState(SPRST_ACTIVE) })?;
    // Ready means the session is really listening: the recogniser is active, so a
    // caller may speak as soon as this line arrives.
    json::emit(&json::ready_event());
    // SAPI rejects every interest mask on this machine, so the session runs on the
    // default interest; file input ends itself, which is why the wave deadline exists.
    if let Err(error) = unsafe { context.SetInterest(interest, interest) } {
        let _ = error;
    }
    // A wave file ends on its own, but without SPEI_END_SR_STREAM the only way to
    // notice is the length of the audio plus room for the final result.
    let limit_ms = match &config.input {
        Input::Wave(path) => {
            let bytes = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
            (bytes as f64 / factor + 1500.0).ceil() as u64
        }
        Input::Device(_) => deadline_ms,
        Input::Stream(_) => deadline_ms,
    }
    .min(deadline_ms);
    let mut drained = Instant::now();
    while !ended
        && (wave_input || !stop.load(Ordering::Relaxed))
        && started.elapsed().as_millis() < u128::from(limit_ms)
    {
        // A stream input finishes when the file is exhausted; give SAPI a moment to
        // deliver the last hypotheses before closing the session.
        if let (Input::Stream(_), Some(shared)) = (&config.input, level_sink.as_ref()) {
            if shared.is_finished() {
                if drained.elapsed().as_millis() >= 1200 {
                    ended = true;
                }
            } else {
                drained = Instant::now();
            }
        }
        let signalled = unsafe { WaitForSingleObject(handle, 100) } == WAIT_OBJECT_0;
        // SAPI never delivers audio-level events here, so the level comes from the
        // buffers we captured; silence marks where the next utterance may start.
        if let Some(shared) = level_sink.as_ref() {
            let level = shared.level().unwrap_or(0);
            tracker.note_level(level, shared.position_ms());
            if last_level.elapsed().as_millis() >= 500 {
                last_level = Instant::now();
                json::emit(&json::level_event(level.min(99) as u8));
            }
        }
        if !signalled {
            continue;
        }
        let mut events = [windows::Win32::Media::Speech::SPEVENT::default(); 8];
        let mut fetched = 0u32;
        if unsafe { context.GetEvents(events.len() as u32, events.as_mut_ptr(), &mut fetched) }
            .is_err()
        {
            continue;
        }
        for event in events.iter().take(fetched as usize) {
            let kind = event._bitfield & 0xFFFF;
            if kind == SPEI_SR_AUDIO_LEVEL.0 {
                let level = event.wParam.0 as u32;
                let position = level_sink
                    .as_ref()
                    .map(|shared| shared.position_ms())
                    .unwrap_or(0.0);
                tracker.note_level(level, position);
                if last_level.elapsed().as_millis() >= 500 {
                    last_level = Instant::now();
                    json::emit(&json::level_event(level.min(100) as u8));
                }
            } else if kind == SPEI_END_SR_STREAM.0 {
                ended = true;
            } else if kind == SPEI_RECOGNITION.0 || kind == SPEI_FALSE_RECOGNITION.0 {
                let Some(result) = take_result(event.lParam) else {
                    continue;
                };
                handle_result(&result, &mut tracker, factor, &config.phrase);
            }
        }
    }
    // Unblock the audio thread before SAPI waits for it: a read that can never fill
    // would otherwise hold the recogniser open for good.
    if let Some(shared) = level_sink.as_ref() {
        shared.close();
    }
    unsafe { recognizer.SetRecoState(SPRST_INACTIVE) }.ok();
    if let Some(capture) = capture.take() {
        capture.close();
    }
    Ok(())
}

fn take_result(lparam: windows::Win32::Foundation::LPARAM) -> Option<ISpRecoResult> {
    if lparam.0 == 0 {
        return None;
    }
    Some(unsafe { ISpRecoResult::from_raw(lparam.0 as *mut c_void) })
}

fn handle_result(result: &ISpRecoResult, tracker: &mut Tracker, factor: f64, phrase_text: &str) {
    let phrase_interface: ISpPhrase = match result.cast() {
        Ok(interface) => interface,
        Err(_) => return,
    };
    let Ok(raw) = (unsafe { phrase_interface.GetPhrase() }) else {
        return;
    };
    if raw.is_null() {
        return;
    }
    // GetPhrase hands out a CoTaskMem block: read it, then release it on every path.
    let parsed = unsafe { read_phrase(&*raw) };
    unsafe { CoTaskMemFree(Some(raw as *const c_void)) };
    let Some((words, start_bytes, duration_ms)) = parsed else {
        return;
    };
    let start_ms = start_bytes / factor;
    let engine_confidence =
        words.iter().map(|word| word.confidence).sum::<f32>() / words.len() as f32;
    // A result from the leading/trailing piece grammars is never a wake on its own; it
    // only extends a pending prefix, which the tracker enforces by comparing against the
    // complete phrase.
    match tracker.on_result(&words, start_ms, duration_ms, engine_confidence) {
        Outcome::Wake {
            confidence,
            duration_ms,
        } => {
            json::emit(&json::wake_event(phrase_text, confidence, duration_ms));
        }
        Outcome::Pending => {}
        Outcome::Ignore => {}
    }
}

/// Reads the words and the audio timeline of one phrase: the stream position is a byte
/// offset, the size time is in 100 ns units, so both are converted for the tracker.
fn read_phrase(phrase: &SPPHRASE) -> Option<(Vec<Word>, f64, f64)> {
    let count = phrase.Base.Rule.ulCountOfElements as usize;
    if phrase.Base.pElements.is_null() || count == 0 {
        return None;
    }
    let elements = unsafe { std::slice::from_raw_parts(phrase.Base.pElements, count) };
    let words: Vec<Word> = elements.iter().map(word_from_element).collect();
    let start_ms = phrase.Base.ullAudioStreamPosition as f64;
    let duration_ms = f64::from(phrase.Base.ulAudioSizeTime) / 10_000.0;
    Some((words, start_ms, duration_ms))
}
