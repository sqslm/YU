use super::assert_original;
use crate::input;
use serde_json::{Value, json};
use std::{error::Error, path::Path};
use windows::{
    Win32::{
        Foundation::HWND,
        System::{
            Com::{CLSCTX_ALL, CoCreateInstance},
            Variant::VARIANT,
        },
        UI::Shell::{Folder2, IShellFolderViewDual, IShellWindows, IWebBrowser2, ShellWindows},
    },
    core::Interface,
};

/// Reads the folder of the explorer window and re-asserts the frozen window
/// afterwards. Mirrors the PowerShell branch: shell windows bound to this HWND
/// only, `Document.Folder.Self.Path`, unique result, existing directory.
pub fn explorer_folder(request: &Value) -> Result<Value, Box<dyn Error>> {
    let handle = input::window_handle(request)?;
    let window = HWND(handle as *mut _);
    assert_original(window, request)?;
    let folder = shell_folder(window.0 as isize)?;
    assert_original(window, request)?;
    Ok(json!({ "folder": folder }))
}

/// SAFETY note: the interfaces never leave this one-shot worker thread and no
/// pointer outlives the call; `Runtime::initialize` already ran for this action.
fn shell_folder(window: isize) -> Result<Option<String>, Box<dyn Error>> {
    // SAFETY: shell automation is created and released on the calling thread.
    unsafe {
        let shell: IShellWindows = CoCreateInstance(&ShellWindows, None, CLSCTX_ALL)?;
        let mut paths = Vec::new();
        for index in 0..shell.Count()? {
            let item = shell.Item(&VARIANT::from(index))?;
            // Windows from other apps (for example the browser) bind to the same
            // HWND space but expose a non-folder document; only matched windows
            // are inspected, exactly like the PowerShell pipeline.
            let Ok(browser) = item.cast::<IWebBrowser2>() else {
                continue;
            };
            if browser.HWND()?.0 != window {
                continue;
            }
            let view: IShellFolderViewDual = browser.Document()?.cast()?;
            // Document.Folder is the extended Folder object, which is the one
            // that exposes Self -> FolderItem -> Path.
            let folder: Folder2 = view.Folder()?.cast()?;
            paths.push(folder.Self_()?.Path()?.to_string());
        }
        Ok(select(paths))
    }
}

/// `Sort-Object -Unique`, then only a single existing directory is reported.
fn select(paths: Vec<String>) -> Option<String> {
    let mut unique: Vec<String> = Vec::new();
    for path in paths {
        if !unique.iter().any(|seen| seen.eq_ignore_ascii_case(&path)) {
            unique.push(path);
        }
    }
    match unique.as_slice() {
        [only] if Path::new(only).is_dir() => Some(only.clone()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_only_a_single_existing_directory() {
        let temp = std::env::temp_dir();
        let path = temp.to_string_lossy().to_string();
        assert_eq!(select(vec![path.clone()]), Some(path.clone()));
        assert_eq!(select(vec![path.clone(), path.clone()]), Some(path));
    }

    #[test]
    fn dedupes_case_insensitively_and_rejects_ambiguity() {
        let temp = std::env::temp_dir().to_string_lossy().to_string();
        // The same folder reported with different casing is one result, not two.
        assert_eq!(
            select(vec![temp.clone(), temp.to_uppercase()]),
            Some(temp.clone())
        );
        let other = std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert_eq!(select(vec![temp, other]), None);
    }

    #[test]
    fn ignores_missing_directories_and_empty_results() {
        assert_eq!(select(Vec::new()), None);
        assert_eq!(
            select(vec!["E:\\definitely-missing-yu-folder".into()]),
            None
        );
    }
}
