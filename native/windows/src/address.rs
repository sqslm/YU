use super::assert_original;
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
                UIA_E_NOTSUPPORTED, UIA_EditControlTypeId, UIA_ToolBarControlTypeId,
                UIA_ValuePatternId,
            },
            Shell::PathCreateFromUrlW,
        },
    },
    core::{Interface, PCWSTR, PWSTR},
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

type Failure = Box<dyn Error>;

/// UIA failures are reported with the operation stage and the HRESULT: a value
/// an unknown property could not confirm is never treated as a safe default.
fn failed(stage: &str, error: windows::core::Error) -> Failure {
    format!(
        "UIA address read failed at {stage} (HRESULT 0x{:08X})",
        error.code().0 as u32
    )
    .into()
}

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

/// Converts a file URL the way `[uri]::LocalPath` does, using the system
/// converter for the unescaping, drive letters and UNC hosts.
///
/// Two differences from `PathCreateFromUrlW` are carried over from .NET: a
/// fragment is dropped, and a query stays appended to the local path
/// (`file:///E:/a.html?x=1#part` -> `E:\a.html?x=1`).
fn local_path(url: &str) -> Result<Option<String>, Failure> {
    let is_file = url
        .get(..5)
        .is_some_and(|scheme| scheme.eq_ignore_ascii_case("file:"));
    if !is_file {
        return Ok(None);
    }
    let without_fragment = url.split('#').next().unwrap_or(url);
    let (base, query) = match without_fragment.split_once('?') {
        Some((base, query)) => (base, Some(query)),
        None => (without_fragment, None),
    };
    let mut wide: Vec<u16> = base.encode_utf16().collect();
    wide.push(0);
    let mut buffer = vec![0u16; 32_768];
    let mut length = buffer.len() as u32;
    // SAFETY: both buffers are owned here and sized for the call; the URL is
    // NUL-terminated above.
    unsafe {
        PathCreateFromUrlW(
            PCWSTR(wide.as_ptr()),
            PWSTR(buffer.as_mut_ptr()),
            &mut length,
            0,
        )
    }
    .map_err(|error| failed("file url conversion", error))?;
    let converted = String::from_utf16_lossy(&buffer[..(length as usize).min(buffer.len())]);
    Ok(Some(match query {
        Some(query) => format!("{converted}?{query}"),
        None => converted,
    }))
}

fn text(element: &IUIAutomationElement) -> Result<String, Failure> {
    // SAFETY: callers hold the worker thread that owns the element.
    unsafe { element.CurrentName() }
        .map(|value| value.to_string())
        .map_err(|error| failed("element name", error))
}

fn address(element: &IUIAutomationElement) -> Result<String, Failure> {
    // SAFETY: callers hold the worker thread that owns the element.
    unsafe { element.CurrentAutomationId() }
        .map(|value| value.to_string())
        .map_err(|error| failed("element automation id", error))
}

/// `Ok(None)` means the element genuinely has no ValuePattern or an empty
/// value; a failed read is an error, not "no value".
fn value(element: &IUIAutomationElement) -> Result<Option<String>, Failure> {
    // SAFETY: callers hold the worker thread that owns the element.
    let pattern: IUIAutomationValuePattern =
        match unsafe { element.GetCurrentPatternAs(UIA_ValuePatternId) } {
            Ok(pattern) => pattern,
            Err(error) if error.code().0 as u32 == UIA_E_NOTSUPPORTED => return Ok(None),
            Err(error) => return Err(failed("value pattern", error)),
        };
    // SAFETY: the pattern above belongs to this thread's element.
    let text = unsafe { pattern.CurrentValue() }
        .map_err(|error| failed("value text", error))?
        .to_string();
    Ok((!text.is_empty()).then_some(text))
}

fn control_type(element: &IUIAutomationElement) -> Result<UIA_CONTROLTYPE_ID, Failure> {
    // SAFETY: callers hold the worker thread that owns the element.
    unsafe { element.CurrentControlType() }.map_err(|error| failed("control type", error))
}

fn password(element: &IUIAutomationElement) -> Result<bool, Failure> {
    // SAFETY: callers hold the worker thread that owns the element.
    unsafe { element.CurrentIsPassword() }
        .map(|value| value.as_bool())
        .map_err(|error| failed("password flag", error))
}

fn offscreen(element: &IUIAutomationElement) -> Result<bool, Failure> {
    // SAFETY: callers hold the worker thread that owns the element.
    unsafe { element.CurrentIsOffscreen() }
        .map(|value| value.as_bool())
        .map_err(|error| failed("offscreen flag", error))
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
) -> Result<(bool, bool), Failure> {
    let (mut toolbar, mut chrome) = (false, false);
    let mut ancestor = edit.clone();
    for _ in 0..MAX_DEPTH {
        // SAFETY: elements stay on this initialized worker thread.
        let parent = unsafe { walker.GetParentElement(&ancestor) }
            .map_err(|error| failed("ancestor walk", error))?;
        if parent.as_raw().is_null() || control_type(&parent)? == UIA_DocumentControlTypeId {
            break;
        }
        if unsafe { automation.CompareElements(element, &parent) }
            .map_err(|error| failed("ancestor identity", error))?
            .as_bool()
        {
            chrome = true;
            break;
        }
        if control_type(&parent)? == UIA_ToolBarControlTypeId {
            toolbar = true;
        }
        ancestor = parent;
    }
    Ok((toolbar, chrome))
}

fn documents(
    automation: &IUIAutomation,
    element: &IUIAutomationElement,
) -> Result<Vec<IUIAutomationElement>, Failure> {
    let mut out = Vec::new();
    // SAFETY: every interface stays on this initialized worker thread.
    unsafe {
        let condition = automation
            .CreatePropertyCondition(
                UIA_ControlTypePropertyId,
                &VARIANT::from(UIA_DocumentControlTypeId.0),
            )
            .map_err(|error| failed("document condition", error))?;
        let found = element
            .FindAll(TreeScope_Descendants, &condition)
            .map_err(|error| failed("document search", error))?;
        let length = found
            .Length()
            .map_err(|error| failed("document count", error))?;
        for index in 0..length {
            let document = found
                .GetElement(index)
                .map_err(|error| failed("document element", error))?;
            if offscreen(&document)? {
                continue;
            }
            out.push(document);
            if out.len() == MAX_DOCUMENTS {
                break;
            }
        }
    }
    Ok(out)
}

fn address_bar(
    automation: &IUIAutomation,
    element: &IUIAutomationElement,
) -> Result<Option<String>, Failure> {
    // SAFETY: see documents(); all calls are synchronous on this thread.
    unsafe {
        let edits_condition = automation
            .CreateOrCondition(
                &automation
                    .CreatePropertyCondition(
                        UIA_ControlTypePropertyId,
                        &VARIANT::from(UIA_EditControlTypeId.0),
                    )
                    .map_err(|error| failed("edit condition", error))?,
                &automation
                    .CreatePropertyCondition(
                        UIA_ControlTypePropertyId,
                        &VARIANT::from(UIA_ComboBoxControlTypeId.0),
                    )
                    .map_err(|error| failed("combo condition", error))?,
            )
            .map_err(|error| failed("candidate condition", error))?;
        let edits = element
            .FindAll(TreeScope_Descendants, &edits_condition)
            .map_err(|error| failed("candidate search", error))?;
        let length = edits
            .Length()
            .map_err(|error| failed("candidate count", error))?;
        let walker = automation
            .ControlViewWalker()
            .map_err(|error| failed("control view walker", error))?;
        let mut addresses = Vec::new();
        for index in 0..length.min(MAX_EDITS as i32) {
            let edit = edits
                .GetElement(index)
                .map_err(|error| failed("candidate element", error))?;
            let id = address(&edit)?;
            let name = text(&edit)?;
            let facts = EditFacts {
                id: &id,
                name: &name,
                password: password(&edit)?,
                offscreen: offscreen(&edit)?,
            };
            if !is_address_edit(&facts) {
                continue;
            }
            let (toolbar, chrome) = browser_chrome(automation, &walker, element, &edit)?;
            if let (true, true, Some(value)) = (toolbar, chrome, value(&edit)?) {
                addresses.push(value);
            }
        }
        let addresses = unique(addresses);
        Ok((addresses.len() == 1).then(|| addresses[0].clone()))
    }
}

fn document_url(
    documents: &[IUIAutomationElement],
    metadata_only: bool,
    address_bar: Option<&String>,
) -> Result<Option<String>, Failure> {
    if metadata_only && address_bar.is_none() {
        return Ok(None);
    }
    let mut urls = Vec::new();
    for document in documents {
        if let Some(value) = value(document)?
            && is_document_url(&value)
        {
            urls.push(value);
        }
    }
    let urls = unique(urls);
    Ok((urls.len() == 1).then(|| urls[0].clone()))
}

/// Reads the browser address for an unfrozen window. The window is re-checked
/// once more after every candidate and file check has finished, so a window
/// that changed mid-read never produces a result.
pub fn browser_url(request: &Value) -> Result<Value, Failure> {
    let handle = input::window_handle(request)?;
    let window = HWND(handle as *mut _);
    let title = assert_original(window, request)?;
    if request["expectedPath"]
        .as_str()
        .is_some_and(|path| !path.is_empty())
    {
        return Err("Original Office document is no longer available".into());
    }
    let metadata_only = request["metadataOnly"].as_bool().unwrap_or(false);
    // SAFETY: the caller asserts an exact window handle; interfaces stay on this
    // initialized worker thread (Runtime::initialize before this call).
    let url = unsafe {
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
                .map_err(|error| failed("automation", error))?;
        let element = automation
            .ElementFromHandle(window)
            .map_err(|error| failed("window element", error))?;
        let documents = documents(&automation, &element)?;
        let bar = address_bar(&automation, &element)?;
        document_url(&documents, metadata_only, bar.as_ref())?.or(bar)
    };
    let resolved = match url {
        None => None,
        Some(url) => match local_path(&url)? {
            Some(path) if Path::new(&path).is_file() => Some((url, path)),
            _ => Some((url, String::new())),
        },
    };
    assert_original(window, request)?;
    Ok(match resolved {
        None => json!({"title":title,"truncated":false}),
        Some((url, path)) if path.is_empty() => json!({"title":title,"truncated":false,"url":url}),
        Some((_, path)) => json!({"title":title,"truncated":false,"path":path}),
    })
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
    fn local_path_matches_the_dotnet_conversion() {
        let path = |url: &str| local_path(url).unwrap();
        assert_eq!(
            path("file:///E:/a%20b.html").as_deref(),
            Some("E:\\a b.html")
        );
        assert_eq!(
            path("file:///E:/a.html?x=1#part").as_deref(),
            Some("E:\\a.html?x=1")
        );
        assert_eq!(path("FILE:///E:/a.html").as_deref(), Some("E:\\a.html"));
        assert_eq!(
            path("file://server/share/a.html").as_deref(),
            Some("\\\\server\\share\\a.html")
        );
        assert_eq!(
            path("file:///E:/a.html#part").as_deref(),
            Some("E:\\a.html")
        );
        assert_eq!(
            path("file:///E:/中文/文件.html").as_deref(),
            Some("E:\\中文\\文件.html")
        );
        assert_eq!(path("https://example.com/a"), None);
    }

    #[test]
    fn local_path_keeps_only_files_as_local_paths() {
        let directory = std::env::temp_dir().join("yu-address-exists");
        std::fs::create_dir_all(&directory).unwrap();
        let file = directory.join("a b.html");
        std::fs::write(&file, b"x").unwrap();
        let file_url = format!(
            "file:///{}",
            file.to_string_lossy()
                .replace('\\', "/")
                .replace(' ', "%20")
        );
        let converted = local_path(&file_url).unwrap().unwrap();
        assert!(Path::new(&converted).is_file());
        assert!(!Path::new(&directory).is_file());
        let _ = std::fs::remove_dir_all(&directory);
    }
}
