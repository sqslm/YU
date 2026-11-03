//! NDJSON replies. The host reads one event per line, so every writer flushes.

use std::io::Write;

use serde_json::{Value, json};

fn emit(value: &Value) {
    let mut stdout = std::io::stdout().lock();
    // The protocol is UTF-8; a broken pipe means the host is gone, which the
    // exit paths already handle.
    let _ = writeln!(stdout, "{value}");
    let _ = stdout.flush();
}

pub fn voices(names: &[String]) {
    emit(&json!({ "ok": true, "voices": names }));
}

pub fn started() {
    emit(&json!({ "ok": true, "event": "started" }));
}

pub fn control(id: u64, paused: bool) {
    emit(&json!({ "ok": true, "event": "control", "id": id, "paused": paused }));
}

pub fn done() {
    emit(&json!({ "ok": true }));
}

pub fn fail(error: &str) {
    emit(&json!({ "ok": false, "error": error }));
}
