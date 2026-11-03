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

pub fn error_event(code: &str) -> Value {
    json!({ "type": "error", "error": code })
}
