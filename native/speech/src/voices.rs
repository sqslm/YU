//! Reads the installed voice tokens through SAPI.
//!
//! The token category is the same one System.Speech walks in `speech.ps1`, so
//! the names it reports here are the names the settings already store.

use windows::Win32::Media::Speech::{
    ISpDataKey, ISpObjectToken, ISpObjectTokenCategory, ISpVoice, SpObjectTokenCategory,
};
use windows::Win32::System::Com::{CLSCTX_ALL, CoCreateInstance, CoTaskMemFree};
use windows::core::HSTRING;
use windows::core::PWSTR;

const VOICES: &str = "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Speech\\Voices";

/// Lists the enabled voices in the order SAPI enumerates them.
pub fn installed() -> Result<Vec<String>, &'static str> {
    let mut names = Vec::new();
    each_token(|token| {
        if !enabled(&token) {
            return;
        }
        let name = display_name(&token);
        if !name.is_empty() {
            names.push(name);
        }
    })?;
    Ok(names)
}

/// Selects a voice by name; an unknown or uninstalled name keeps the default.
pub fn select(voice: &ISpVoice, wanted: &str) {
    if wanted.trim().is_empty() {
        return;
    }
    let mut chosen: Option<ISpObjectToken> = None;
    let _ = each_token(|token| {
        if chosen.is_none() && display_name(&token).eq_ignore_ascii_case(wanted.trim()) {
            chosen = Some(token);
        }
    });
    if let Some(token) = chosen {
        unsafe {
            let _ = voice.SetVoice(&token);
        }
    }
}

fn each_token(mut visit: impl FnMut(ISpObjectToken)) -> Result<(), &'static str> {
    unsafe {
        let category: ISpObjectTokenCategory =
            CoCreateInstance(&SpObjectTokenCategory, None, CLSCTX_ALL)
                .map_err(|_| "unavailable")?;
        category
            .SetId(&HSTRING::from(VOICES), false)
            .map_err(|_| "unavailable")?;
        let tokens = category
            .EnumTokens(&HSTRING::new(), &HSTRING::new())
            .map_err(|_| "unavailable")?;
        loop {
            let mut slot: [Option<ISpObjectToken>; 1] = [None];
            let mut fetched = 0u32;
            if tokens
                .Next(1, slot.as_mut_ptr(), Some(&mut fetched))
                .is_err()
                || fetched == 0
            {
                break;
            }
            let Some(token) = slot[0].take() else { break };
            visit(token);
        }
        Ok(())
    }
}

fn attributes(token: &ISpObjectToken) -> Option<ISpDataKey> {
    unsafe { token.OpenKey(&HSTRING::from("Attributes")).ok() }
}

fn enabled(token: &ISpObjectToken) -> bool {
    // System.Speech drops tokens whose Enabled attribute is explicitly off; a
    // missing attribute counts as enabled.
    attributes(token)
        .map(|key| string_value(&key, "Enabled") != "0")
        .unwrap_or(true)
}

fn display_name(token: &ISpObjectToken) -> String {
    attributes(token)
        .map(|key| string_value(&key, "Name"))
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| default_value(token))
}

fn default_value(token: &ISpObjectToken) -> String {
    unsafe {
        let Ok(pointer) = token.GetStringValue(&HSTRING::new()) else {
            return String::new();
        };
        if pointer.is_null() {
            return String::new();
        }
        let value: PWSTR = pointer;
        let text = value.to_string().unwrap_or_default();
        CoTaskMemFree(Some(value.0 as *const core::ffi::c_void));
        text
    }
}

fn string_value(key: &ISpDataKey, name: &str) -> String {
    unsafe {
        let Ok(pointer) = key.GetStringValue(&HSTRING::from(name)) else {
            return String::new();
        };
        if pointer.is_null() {
            return String::new();
        }
        let text = pointer.to_string().unwrap_or_default();
        CoTaskMemFree(Some(pointer.0 as *const core::ffi::c_void));
        text
    }
}
