// Resident wake helper. Enumerates capture devices and listens through the same SAPI
// engine the PowerShell host uses.

mod capture;
mod devices;
mod json;
mod matching;
mod speech;
mod stream;

use std::io::{BufRead, BufReader};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::Value;
use speech::{Config, Input};

fn option(arguments: &[String], name: &str) -> Option<String> {
    arguments
        .iter()
        .position(|argument| argument == name)
        .and_then(|index| arguments.get(index + 1).cloned())
}

fn read_config(line: &str, arguments: &[String]) -> Result<Config, String> {
    let value: Value =
        serde_json::from_str(line).map_err(|error| format!("invalid config: {error}"))?;
    let phrase = value
        .get("phrase")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if phrase.is_empty() || phrase.chars().count() > 40 {
        return Err("invalid phrase".to_string());
    }
    let language = value
        .get("language")
        .and_then(Value::as_str)
        .unwrap_or("zh")
        .to_string();
    let wave = value
        .get("wave")
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty())
        .map(str::to_string)
        .or_else(|| option(arguments, "--file"));
    let device = value
        .get("device")
        .and_then(|device| match device {
            Value::String(text) => text.trim().parse::<i32>().ok(),
            Value::Number(number) => number.as_i64().map(|number| number as i32),
            _ => None,
        })
        .unwrap_or(-1);
    let mut variants = Vec::new();
    if let Some(list) = value.get("variants").and_then(Value::as_array) {
        for variant in list.iter().take(3) {
            let text = variant
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let phones = variant
                .get("phones")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if text.trim().chars().count() >= 2 && phones.chars().count() <= 240 {
                variants.push((text, phones));
            }
        }
    }
    let stream = value
        .get("stream")
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty())
        .map(str::to_string);
    let input = match (stream, wave) {
        (Some(path), _) => Input::Stream(path),
        (None, Some(wave)) => Input::Wave(wave),
        (None, None) => Input::Device(device),
    };
    Ok(Config {
        phrase,
        language,
        input,
        variants,
    })
}

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if arguments
        .iter()
        .any(|argument| argument == "--list-devices")
    {
        json::emit(&json::devices_event(&devices::list()));
        return;
    }

    let mut line = String::new();
    if std::io::stdin().lock().read_line(&mut line).unwrap_or(0) == 0 {
        json::emit(&json::error_event("unavailable"));
        std::process::exit(1);
    }
    let config = match read_config(&line, &arguments) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("{error}");
            json::emit(&json::error_event("unavailable"));
            std::process::exit(1);
        }
    };

    // The parent keeps the pipe open for the whole session. EOF is the stop signal, and
    // it is watched on a separate thread because the event loop must not block on stdin.
    let stop = Arc::new(AtomicBool::new(false));
    let watcher = stop.clone();
    std::thread::spawn(move || {
        let mut sink = String::new();
        let mut reader = BufReader::new(std::io::stdin());
        while reader.read_line(&mut sink).unwrap_or(0) > 0 {
            sink.clear();
        }
        watcher.store(true, Ordering::Relaxed);
    });

    // Only a file input has an obvious end; the stream-end event closes it. Everything
    // else runs until the parent closes the pipe, so the deadline is a wedge guard.
    let fallback = if matches!(config.input, Input::Wave(_)) {
        300_000
    } else {
        u64::MAX
    };
    let deadline = option(&arguments, "--deadline")
        .and_then(|value| value.parse().ok())
        .unwrap_or(fallback);
    match speech::run(&config, &stop, deadline) {
        Ok(()) => {}
        Err(failure) => {
            json::emit(&json::error_event(failure.code()));
            std::process::exit(1);
        }
    }
}
