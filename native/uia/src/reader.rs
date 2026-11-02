use crate::snapshot::{Foreground, clip_tail, read_guarded};
use serde_json::{Value, json};
use std::{
    error::Error,
    io::{self, BufRead, Write},
    sync::mpsc,
    thread,
};
use windows::Win32::{
    System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
        CoUninitialize,
    },
    UI::{
        Accessibility::*,
        WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId},
    },
};

// The COM apartment and all interfaces stay on this windowless worker thread.
struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}

fn foreground() -> Option<Foreground> {
    // SAFETY: buffers and out parameters live for each synchronous Win32 call.
    unsafe {
        let window = GetForegroundWindow();
        if window.0.is_null() {
            return None;
        }
        let mut pid = 0;
        GetWindowThreadProcessId(window, Some(&mut pid));
        // Same title length and decimal HWND representation as foreground.ts.
        let mut title = [0u16; 512];
        let length = GetWindowTextW(window, &mut title).max(0) as usize;
        Some(Foreground {
            handle: (window.0 as usize).to_string(),
            pid,
            title: String::from_utf16_lossy(&title[..length]),
        })
    }
}

#[allow(non_upper_case_globals)] // Keep the Windows SDK's published identifiers.
fn control_type(id: UIA_CONTROLTYPE_ID) -> &'static str {
    match id {
        UIA_ButtonControlTypeId => "button",
        UIA_CalendarControlTypeId => "calendar",
        UIA_CheckBoxControlTypeId => "checkbox",
        UIA_ComboBoxControlTypeId => "combobox",
        UIA_EditControlTypeId => "edit",
        UIA_HyperlinkControlTypeId => "hyperlink",
        UIA_ImageControlTypeId => "image",
        UIA_ListItemControlTypeId => "listitem",
        UIA_ListControlTypeId => "list",
        UIA_MenuControlTypeId => "menu",
        UIA_MenuBarControlTypeId => "menubar",
        UIA_MenuItemControlTypeId => "menuitem",
        UIA_StatusBarControlTypeId => "statusbar",
        UIA_TabControlTypeId => "tab",
        UIA_TabItemControlTypeId => "tabitem",
        UIA_TextControlTypeId => "text",
        UIA_ToolBarControlTypeId => "toolbar",
        UIA_ToolTipControlTypeId => "tooltip",
        UIA_TreeControlTypeId => "tree",
        UIA_TreeItemControlTypeId => "treeitem",
        UIA_CustomControlTypeId => "custom",
        UIA_GroupControlTypeId => "group",
        UIA_ThumbControlTypeId => "thumb",
        UIA_DataGridControlTypeId => "datagrid",
        UIA_DataItemControlTypeId => "dataitem",
        UIA_DocumentControlTypeId => "document",
        UIA_WindowControlTypeId => "window",
        UIA_PaneControlTypeId => "pane",
        UIA_TableControlTypeId => "table",
        _ => "unknown",
    }
}

fn read_focused(automation: &IUIAutomation) -> Option<Value> {
    // SAFETY: generated COM bindings own interface/BSTR lifetimes; all calls are
    // made on the MTA that created automation. Provider errors become no context.
    unsafe {
        let element = automation.GetFocusedElement().ok()?;
        if element.CurrentIsPassword().ok()?.as_bool() {
            return None;
        }
        let id = element.CurrentControlType().ok()?;
        let name = element.CurrentName().unwrap_or_default().to_string();
        let class_name = element.CurrentClassName().unwrap_or_default().to_string();
        let automation_id = element
            .CurrentAutomationId()
            .unwrap_or_default()
            .to_string();
        let mut value = String::new();
        let mut truncated = false;
        let mut read_only = false;
        // Do not add TextRange access: some providers used to crash on it.
        if let Ok(pattern) =
            element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
        {
            if let Ok(text) = pattern.CurrentValue() {
                (value, truncated) = clip_tail(&text);
            }
            if let Ok(flag) = pattern.CurrentIsReadOnly() {
                read_only = flag.as_bool();
            }
        }
        Some(json!({"controlType":control_type(id), "controlTypeId":id.0,
            "className":class_name, "automationId":automation_id, "name":name,
            "value":value, "valueTruncated":truncated, "readOnly":read_only}))
    }
}

fn post(event: &Value) -> Result<(), Box<dyn Error>> {
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, event)?;
    stdout.write_all(b"\n")?;
    stdout.flush()?;
    Ok(())
}

pub fn run() -> Result<(), Box<dyn Error>> {
    // A provider can block a COM call indefinitely. The pipe reader must remain
    // independent so parent death still terminates the whole process promptly.
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            let parsed = line
                .map_err(|e| e.to_string())
                .and_then(|s| serde_json::from_str::<Value>(&s).map_err(|e| e.to_string()));
            match parsed {
                Ok(value) => {
                    if sender.send(value).is_err() {
                        return;
                    }
                }
                Err(_) => {
                    eprintln!("yu-uia: invalid input pipe message");
                    std::process::exit(1);
                }
            }
        }
        // No user state is written by this helper. Process exit also disconnects
        // an unresponsive COM provider; waiting for that call would orphan us.
        std::process::exit(0);
    });
    // SAFETY: the main thread owns no windows; initialize/uninitialize once, and
    // drop automation and its per-read interfaces before the apartment guard.
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
    }
    let _apartment = Apartment;
    let automation: IUIAutomation =
        unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)? };
    post(&json!({"type":"ready"}))?;
    for message in receiver {
        if message["type"] != "read" {
            return Err("unknown request type".into());
        }
        let id = message["id"]
            .as_u64()
            .ok_or("read.id must be an unsigned integer")?;
        let target = message.get("target").filter(|v| !v.is_null());
        let snapshot = read_guarded(target, || read_focused(&automation), foreground);
        post(&json!({"type":"result", "id":id, "snapshot":snapshot}))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_official_edit_document_and_related_control_ids() {
        assert_eq!(UIA_EditControlTypeId.0, 50004);
        assert_eq!(UIA_DocumentControlTypeId.0, 50030);
        for (id, expected) in [
            (UIA_EditControlTypeId, "edit"),
            (UIA_DocumentControlTypeId, "document"),
            (UIA_PaneControlTypeId, "pane"),
            (UIA_TextControlTypeId, "text"),
            (UIA_ComboBoxControlTypeId, "combobox"),
            (UIA_DataItemControlTypeId, "dataitem"),
        ] {
            assert_eq!(control_type(id), expected);
        }
        assert_eq!(control_type(UIA_CONTROLTYPE_ID(-1)), "unknown");
    }
}
