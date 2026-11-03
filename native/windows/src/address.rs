use crate::input;
use serde_json::{Value, json};
use std::{error::Error, path::Path};
use windows::{
    Win32::{
        Foundation::HWND,
        System::{
            Com::{CLSCTX_INPROC_SERVER, CoCreateInstance},
            Variant::VARIANT,
        },
        UI::{
            Accessibility::{
                CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTreeWalker,
                IUIAutomationValuePattern, TreeScope_Descendants, UIA_CONTROLTYPE_ID,
                UIA_ComboBoxControlTypeId, UIA_ControlTypePropertyId, UIA_DocumentControlTypeId,
                UIA_EditControlTypeId, UIA_ToolBarControlTypeId, UIA_ValuePatternId,
            },
            WindowsAndMessaging::{GetWindowTextW, GetWindowThreadProcessId, IsWindow},
        },
    },
    core::Interface,
};

// Same bounds as resources/current-content.ps1: at most 20 exposed documents,
// the first 100 Edit/ComboBox elements and 40 ancestors per walk.
const MAX_DOCUMENTS: usize = 20;
const MAX_EDITS: usize = 100;
const MAX_DEPTH: usize = 40;
const ADDRESS_IDS: [&str; 4] = ["addresseditbox", "urlbar-input", "urlbar", "omnibox"];
const ADDRESS_NAMES: [&str; 6] = [
    "地址",
    "網址",
    "address",
    "search or enter",
    "搜索或输入",
    "搜尋或輸入",
];

/// The address bar is the only Edit/ComboBox that may hold the URL: it is never
/// a password field, must be visible, and must look like browser chrome.
struct EditFacts<'a> {
    id: &'a str,
    name: &'a str,
    password: bool,
    offscreen: bool,
}

fn is_address_edit(facts: &EditFacts) -> bool {
    if facts.password || facts.offscreen {
        return false;
    }
    ADDRESS_IDS
        .iter()
        .any(|id| facts.id.eq_ignore_ascii_case(id))
        || ADDRESS_NAMES
            .iter()
            .any(|name| facts.name.to_lowercase().contains(name))
}

/// Only an absolute http(s) or file URL counts as the document's own value.
fn is_document_url(value: &str) -> bool {
    let lower = value.to_lowercase();
    ["http://", "https://", "file://"]
        .iter()
        .any(|s| lower.starts_with(s))
}

/// Mirrors [uri]::LocalPath for the plain file URLs a browser exposes.
fn local_path(url: &str) -> Option<String> {
    let rest = url.strip_prefix("file://")?;
    // A host component means a remote SMB/registry path, not a local file.
    let path = rest.strip_prefix('/')?;
    let mut decoded = Vec::with_capacity(path.len());
    let bytes = path.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok()?;
            decoded.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
            continue;
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    // file:///E:/page.html -> rest "/E:/page.html" -> path "E:/page.html"
    String::from_utf8(decoded).ok()
}

fn text(element: &IUIAutomationElement) -> String {
    // SAFETY: callers hold the worker thread that owns the element.
    unsafe { element.CurrentName() }
        .map(|v| v.to_string())
        .unwrap_or_default()
}

fn address(element: &IUIAutomationElement) -> String {
    // SAFETY: callers hold the worker thread that owns the element.
    unsafe { element.CurrentAutomationId() }
        .map(|v| v.to_string())
        .unwrap_or_default()
}

fn value(element: &IUIAutomationElement) -> Option<String> {
    // SAFETY: callers hold the worker thread that owns the element.
    let pattern: IUIAutomationValuePattern =
        unsafe { element.GetCurrentPatternAs(UIA_ValuePatternId) }.ok()?;
    unsafe { pattern.CurrentValue() }
        .ok()
        .map(|v| v.to_string())
        .filter(|v| !v.is_empty())
}

fn control_type(element: &IUIAutomationElement) -> UIA_CONTROLTYPE_ID {
    // SAFETY: callers hold the worker thread that owns the element.
    unsafe { element.CurrentControlType() }.unwrap_or(UIA_CONTROLTYPE_ID(0))
}

fn unique(values: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for value in values {
        if !out.contains(&value) {
            out.push(value);
        }
    }
    out
}

/// A visible address field is only trusted when its ControlView ancestors reach
/// this exact window and include a toolbar (browser chrome, not page content).
fn browser_chrome(
    automation: &IUIAutomation,
    walker: &IUIAutomationTreeWalker,
    element: &IUIAutomationElement,
    edit: &IUIAutomationElement,
) -> (bool, bool) {
    let (mut toolbar, mut chrome) = (false, false);
    let mut ancestor = edit.clone();
    for _ in 0..MAX_DEPTH {
        // SAFETY: elements stay on this initialized worker thread.
        let Ok(parent) = (unsafe { walker.GetParentElement(&ancestor) }) else {
            break;
        };
        if parent.as_raw().is_null() || control_type(&parent) == UIA_DocumentControlTypeId {
            break;
        }
        if unsafe { automation.CompareElements(element, &parent) }
            .map(|v| v.as_bool())
            .unwrap_or(false)
        {
            chrome = true;
            break;
        }
        if control_type(&parent) == UIA_ToolBarControlTypeId {
            toolbar = true;
        }
        ancestor = parent;
    }
    (toolbar, chrome)
}

fn documents(
    automation: &IUIAutomation,
    element: &IUIAutomationElement,
) -> Vec<IUIAutomationElement> {
    let mut out = Vec::new();
    // SAFETY: every interface stays on this initialized worker thread.
    unsafe {
        let condition = automation
            .CreatePropertyCondition(
                UIA_ControlTypePropertyId,
                &VARIANT::from(UIA_DocumentControlTypeId.0),
            )
            .ok();
        let Some(found) =
            condition.and_then(|condition| element.FindAll(TreeScope_Descendants, &condition).ok())
        else {
            return out;
        };
        for index in 0..found.Length().unwrap_or(0) {
            let Ok(document) = found.GetElement(index) else {
                continue;
            };
            if document
                .CurrentIsOffscreen()
                .map(|v| v.as_bool())
                .unwrap_or(false)
            {
                continue;
            }
            out.push(document);
            if out.len() == MAX_DOCUMENTS {
                break;
            }
        }
    }
    out
}

fn address_bar(automation: &IUIAutomation, element: &IUIAutomationElement) -> Option<String> {
    // SAFETY: see documents(); all calls are synchronous on this thread.
    unsafe {
        let edits_condition = automation
            .CreateOrCondition(
                &automation
                    .CreatePropertyCondition(
                        UIA_ControlTypePropertyId,
                        &VARIANT::from(UIA_EditControlTypeId.0),
                    )
                    .ok()?,
                &automation
                    .CreatePropertyCondition(
                        UIA_ControlTypePropertyId,
                        &VARIANT::from(UIA_ComboBoxControlTypeId.0),
                    )
                    .ok()?,
            )
            .ok()?;
        let edits = element
            .FindAll(TreeScope_Descendants, &edits_condition)
            .ok()?;
        let walker = automation.ControlViewWalker().ok()?;
        let mut addresses = Vec::new();
        for index in 0..edits.Length().unwrap_or(0).min(MAX_EDITS as i32) {
            let Ok(edit) = edits.GetElement(index) else {
                continue;
            };
            let facts = EditFacts {
                id: &address(&edit),
                name: &text(&edit),
                password: edit
                    .CurrentIsPassword()
                    .map(|v| v.as_bool())
                    .unwrap_or(false),
                offscreen: edit
                    .CurrentIsOffscreen()
                    .map(|v| v.as_bool())
                    .unwrap_or(false),
            };
            if !is_address_edit(&facts) {
                continue;
            }
            let (toolbar, chrome) = browser_chrome(automation, &walker, element, &edit);
            if let (true, true, Some(value)) = (toolbar, chrome, value(&edit)) {
                addresses.push(value);
            }
        }
        let addresses = unique(addresses);
        (addresses.len() == 1).then(|| addresses[0].clone())
    }
}

fn document_url(
    documents: &[IUIAutomationElement],
    metadata_only: bool,
    address_bar: Option<&String>,
) -> Option<String> {
    let urls = unique(
        documents
            .iter()
            .filter(|_| !(metadata_only && address_bar.is_none()))
            .filter_map(value)
            .filter(|url| is_document_url(url))
            .collect(),
    );
    (urls.len() == 1).then(|| urls[0].clone())
}

/// Reads the browser address for an unfrozen window and re-asserts the window
/// afterwards, so a title/PID change is never reported as a valid URL.
pub fn browser_url(request: &Value) -> Result<Value, Box<dyn Error>> {
    let handle = input::window_handle(request)?;
    let window = HWND(handle as *mut _);
    let title = assert_original(window, request)?;
    let metadata_only = request["metadataOnly"].as_bool().unwrap_or(false);
    // SAFETY: the caller asserts an exact window handle; interfaces stay on this
    // initialized worker thread (Runtime::initialize before this call).
    let url = unsafe {
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
        let element = automation.ElementFromHandle(window)?;
        let documents = documents(&automation, &element);
        let bar = address_bar(&automation, &element);
        document_url(&documents, metadata_only, bar.as_ref()).or(bar)
    };
    assert_original(window, request)?;
    Ok(match url {
        None => json!({"title":title,"truncated":false}),
        Some(url) => match local_path(&url).filter(|path| Path::new(path).exists()) {
            Some(path) => json!({"title":title,"truncated":false,"path":path}),
            None => json!({"title":title,"truncated":false,"url":url}),
        },
    })
}

/// The frozen HWND/PID/title guard shared with window-check.
fn assert_original(window: HWND, request: &Value) -> Result<String, Box<dyn Error>> {
    // SAFETY: caller-supplied handles are validated by the OS, never dereferenced.
    unsafe {
        let mut pid = 0;
        GetWindowThreadProcessId(window, Some(&mut pid));
        let mut title = [0u16; 1024];
        let length = GetWindowTextW(window, &mut title).max(0) as usize;
        let title = String::from_utf16_lossy(&title[..length]);
        if !IsWindow(Some(window)).as_bool()
            || request["pid"].as_u64() != Some(pid as u64)
            || title != request["title"].as_str().unwrap_or("")
        {
            return Err("Original window has changed or closed".into());
        }
        Ok(title)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edit<'a>(id: &'a str, name: &'a str) -> EditFacts<'a> {
        EditFacts {
            id,
            name,
            password: false,
            offscreen: false,
        }
    }

    #[test]
    fn address_bar_ids_match_a_whole_id_only() {
        assert!(is_address_edit(&edit("omnibox", "")));
        assert!(is_address_edit(&edit("URLBAR-INPUT", "")));
        assert!(!is_address_edit(&edit("omnibox_extended", "")));
        assert!(!is_address_edit(&edit("page_address", "")));
    }

    #[test]
    fn address_bar_names_match_a_substring_case_insensitively() {
        assert!(is_address_edit(&edit("", "地址和搜索栏")));
        assert!(is_address_edit(&edit("", "Address and search bar")));
        assert!(is_address_edit(&edit("", "Search or enter address")));
        assert!(is_address_edit(&edit("", "搜尋或輸入地址")));
        assert!(!is_address_edit(&edit("", "Your name")));
        assert!(!is_address_edit(&edit("", "")));
    }

    #[test]
    fn password_and_offscreen_fields_are_never_addresses() {
        let mut facts = edit("omnibox", "地址");
        facts.password = true;
        assert!(!is_address_edit(&facts));
        let mut facts = edit("omnibox", "地址");
        facts.offscreen = true;
        assert!(!is_address_edit(&facts));
    }

    #[test]
    fn only_absolute_http_and_file_values_count_as_document_urls() {
        assert!(is_document_url("https://example.com/a"));
        assert!(is_document_url("FILE:///C:/a.html"));
        assert!(is_document_url("http://127.0.0.1:9/x"));
        assert!(!is_document_url("javascript:alert(1)"));
        assert!(!is_document_url("example.com"));
        assert!(!is_document_url(""));
    }

    #[test]
    fn local_path_matches_uri_local_path() {
        assert_eq!(
            local_path("file:///E:/page.html").as_deref(),
            Some("E:/page.html")
        );
        assert_eq!(
            local_path("file:///C:/a%20b/c.html").as_deref(),
            Some("C:/a b/c.html")
        );
        assert_eq!(local_path("file://server/share/a.html"), None);
        assert_eq!(local_path("https://example.com/a"), None);
    }
}
