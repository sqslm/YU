mod engine;
#[cfg(windows)]
mod windows;

use engine::{Engine, physical_vk};
use serde_json::{Value, json};
use std::io::{self, Read};

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// Deterministic, OS-free regression interface. Never installs a keyboard hook.
fn replay() -> Result<(), String> {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .map_err(|e| e.to_string())?;
    let steps: Vec<Value> = serde_json::from_str(&input).map_err(|e| e.to_string())?;
    let mut engine = Engine::default();
    let mut results = vec![];
    for step in steps {
        let at = step["at"].as_u64().unwrap_or(0);
        let desktop = step["desktop"].as_bool().unwrap_or(true);
        let swallowed = match step["type"].as_str() {
            Some("key") => {
                let flags = step["flags"].as_u64().unwrap_or(0) as u32;
                if flags & 0x10 != 0 && !step["allowInjected"].as_bool().unwrap_or(false) {
                    Some(false)
                } else {
                    Some(engine.key(
                        physical_vk(
                            step["vk"].as_u64().unwrap_or(0) as u32,
                            step["scan"].as_u64().unwrap_or(0) as u32,
                            flags,
                        ),
                        step["down"].as_bool().unwrap_or(false),
                        at,
                        || desktop,
                    ))
                }
            }
            Some("tick") => {
                let held = step["held"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|v| v.as_u64().map(|v| v as u32))
                    .collect();
                engine.reconcile(at, &held, || desktop);
                None
            }
            _ => {
                engine.command(&step, at)?;
                None
            }
        };
        results.push(json!({"events":std::mem::take(&mut engine.events), "swallowed":swallowed, "releases":std::mem::take(&mut engine.releases), "waitMs":engine.wait_ms()}));
    }
    println!("{}", Value::Array(results));
    Ok(())
}

fn main() {
    let result = if std::env::args().nth(1).as_deref() == Some("--replay") {
        replay()
    } else {
        #[cfg(windows)]
        {
            windows::run()
        }
        #[cfg(not(windows))]
        {
            Err("The keyboard hook requires Windows".into())
        }
    };
    if let Err(error) = result {
        eprintln!("yu-hotkey: {error}");
        std::process::exit(1);
    }
}
