// The helper talks NDJSON on stdout, one event per line, exactly like the PowerShell host.

use serde_json::{Value, json};

pub fn emit(value: &Value) {
    println!("{value}");
}

pub fn devices_event(devices: &[(String, String)]) -> Value {
    json!({
        "type": "devices",
        "devices": devices
            .iter()
            .map(|(id, name)| json!({ "id": id, "name": name }))
            .collect::<Vec<_>>(),
    })
}

pub fn ready_event() -> Value {
    json!({ "type": "ready" })
}

pub fn device_event(id: i32, name: &str) -> Value {
    json!({ "type": "device", "device": id, "name": name })
}

pub fn level_event(level: u8) -> Value {
    json!({ "type": "level", "value": level })
}

pub fn wake_event(phrase: &str, confidence: f32, duration_ms: f64) -> Value {
    json!({ "type": "wake", "phrase": phrase, "confidence": confidence, "durationMs": duration_ms.round() as i64 })
}

pub fn log_event(reason: &str, device: i32) -> Value {
    json!({ "type": "log", "reason": reason, "device": device })
}

pub fn error_event(code: &str) -> Value {
    json!({ "type": "error", "error": code })
}
