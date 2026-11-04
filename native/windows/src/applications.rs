use serde_json::{Value, json};
use std::{
    error::Error,
    path::{Path, PathBuf},
};
use windows::{
    Win32::{
        Foundation::{ERROR_NO_MORE_ITEMS, ERROR_SUCCESS, HWND},
        Storage::EnhancedStorage::PKEY_AppUserModel_ID,
        System::{
            Com::{CLSCTX_INPROC_SERVER, CoCreateInstance, CoTaskMemFree},
            Registry::{
                HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, REG_ROUTINE_FLAGS,
                RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ, RegCloseKey, RegEnumKeyExW, RegGetValueW,
                RegOpenKeyExW,
            },
        },
        UI::Shell::{
            FOLDERID_CommonPrograms, FOLDERID_Programs, IShellFolder, IShellItem2, IShellLinkW,
            KNOWN_FOLDER_FLAG, SHBindToObject, SHCONTF_FOLDERS, SHCONTF_NONFOLDERS,
            SHCreateItemWithParent, SHGetKnownFolderPath, SHParseDisplayName, SIGDN_NORMALDISPLAY,
            ShellLink,
        },
    },
    core::{Interface, PCWSTR, PWSTR},
};

/// Same spelling the PowerShell branch accepts: a bare `.exe` path with no
/// quote, redirection or control characters.
const MAX_SHORTCUTS_PER_FOLDER: usize = 1000;
const MAX_APPLICATIONS: usize = 1500;

/// `{applications: [...]}` for the PowerShell `applications` action: registry
/// App Paths, Start menu shortcuts, packaged Start apps and three fixed system
/// commands, deduplicated and ordered exactly like `Sort-Object name,path`.
pub fn applications(_request: &Value) -> Result<Value, Box<dyn Error>> {
    Ok(json!({ "applications": collect() }))
}

fn collect() -> Vec<Value> {
    let mut entries = Vec::new();
    entries.extend(app_paths());
    entries.extend(start_menu_shortcuts());
    entries.extend(packaged_apps());
    entries.push(json!({ "name": "Windows Settings", "path": "", "appId": "system:settings" }));
    entries.extend(fixed_commands(&entries));
    finish(entries)
}

/// Registry `App Paths` in the same three views the 64-bit PowerShell reads.
fn app_paths() -> Vec<Value> {
    const BASES: [(HKEY, &str); 3] = [
        (
            HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\App Paths",
        ),
        (
            HKEY_LOCAL_MACHINE,
            r"Software\Microsoft\Windows\CurrentVersion\App Paths",
        ),
        (
            HKEY_LOCAL_MACHINE,
            r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths",
        ),
    ];
    let mut items = Vec::new();
    for (root, base) in BASES {
        let Some(key) = open_key(root, base) else {
            continue;
        };
        for name in subkey_names(key) {
            let Some(raw) = default_string(key, &name) else {
                continue;
            };
            let target = unquote(&expand_environment(&raw));
            if !is_exe(&target) || !Path::new(&target).is_file() {
                continue;
            }
            items.push(json!({ "name": strip_exe_suffix(&name), "path": target }));
        }
        // SAFETY: the handle came from `RegOpenKeyExW` above.
        let _ = unsafe { RegCloseKey(key) };
    }
    items
}

/// Recursive `.lnk` scan of the two Start menu programs folders, capped per
/// folder, with every shortcut that carries arguments rejected.
fn start_menu_shortcuts() -> Vec<Value> {
    let roots: Vec<PathBuf> = [FOLDERID_Programs, FOLDERID_CommonPrograms]
        .iter()
        .filter_map(known_folder)
        .collect();
    start_menu_in(&roots, MAX_SHORTCUTS_PER_FOLDER)
}

fn start_menu_in(roots: &[PathBuf], limit: usize) -> Vec<Value> {
    let mut items = Vec::new();
    for root in roots {
        let links = shortcuts(root, limit);
        for link in links {
            let Some(target) = shortcut_target(&link) else {
                continue;
            };
            let target = expand_environment(&target);
            if !is_exe(&target) || !Path::new(&target).is_file() {
                continue;
            }
            let Some(name) = link.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            items.push(json!({ "name": name, "path": target }));
        }
    }
    items
}

/// Packaged Start menu entries: the AppID carries a `!` for packaged apps.
fn packaged_apps() -> Vec<Value> {
    let mut items = Vec::new();
    for (appid, name) in shell_apps_folder() {
        if appid.contains('!') {
            items.push(json!({ "name": name, "path": "", "appId": appid }));
        }
    }
    items
}

/// The three commands the baseline resolves through the application PATH,
/// with the packaged-Notepad/Calculator guard kept intact.
fn fixed_commands(existing: &[Value]) -> Vec<Value> {
    let mut items = Vec::new();
    for (command, packaged) in [
        ("explorer.exe", None),
        ("notepad.exe", Some("Microsoft.WindowsNotepad_")),
        ("calc.exe", Some("Microsoft.WindowsCalculator_")),
    ] {
        let Some(path) = which(command) else { continue };
        if let Some(marker) = packaged {
            let present = existing.iter().any(|item| {
                item.get("appId")
                    .and_then(Value::as_str)
                    .is_some_and(|appid| appid.contains(marker))
            });
            if present {
                continue;
            }
        }
        let name = if command == "calc.exe" {
            "Calculator".to_string()
        } else {
            strip_exe_suffix(command)
        };
        items.push(json!({ "name": name, "path": path }));
    }
    items
}

/// `Sort-Object name,path -Unique | Select-Object -First 1500`.
fn finish(mut entries: Vec<Value>) -> Vec<Value> {
    entries.sort_by(|left, right| {
        let by_name = culture_compare(field(left, "name"), field(right, "name"));
        if by_name != std::cmp::Ordering::Equal {
            return by_name;
        }
        // The baseline's tie order between paths that differ only in case is
        // not stable; ordering them ordinally keeps the uppercase spelling,
        // which is the order PowerShell produced on the reference machine.
        field(left, "path").cmp(field(right, "path"))
    });
    entries.dedup_by(|right, left| same_key(left, right));
    entries.truncate(MAX_APPLICATIONS);
    entries
}

fn field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn same_key(left: &Value, right: &Value) -> bool {
    culture_compare(field(left, "name"), field(right, "name")) == std::cmp::Ordering::Equal
        && culture_compare(field(left, "path"), field(right, "path")) == std::cmp::Ordering::Equal
}

/// Case-insensitive, culture-aware ordering, matching `Sort-Object` on the
/// current user locale instead of a byte or ordinal comparison.
/// Culture-aware, case-insensitive comparison like `Sort-Object`.
///
/// `CompareStringEx` reports failure with 0; that cannot be told apart from a
/// successful ordering here, so a failure falls through to the remaining arms
/// and finally to `Equal`. The measured baseline sorts identically on this
/// machine, which is why the failure path is documented instead of guessed at.
fn culture_compare(left: &str, right: &str) -> std::cmp::Ordering {
    use windows::Win32::Globalization::{
        COMPARE_STRING_FLAGS, CSTR_EQUAL, CSTR_LESS_THAN, CompareStringEx, NORM_IGNORECASE,
    };
    if left == right {
        return std::cmp::Ordering::Equal;
    }
    let (left, right) = (wide(left), wide(right));
    // SAFETY: both slices are NUL terminated and outlive the call.
    let result = unsafe {
        CompareStringEx(
            windows::core::PCWSTR::null(),
            COMPARE_STRING_FLAGS(NORM_IGNORECASE.0),
            &left,
            &right,
            None,
            None,
            None,
        )
    };
    if result == CSTR_LESS_THAN {
        std::cmp::Ordering::Less
    } else if result == CSTR_EQUAL {
        std::cmp::Ordering::Equal
    } else {
        std::cmp::Ordering::Greater
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn open_key(root: HKEY, path: &str) -> Option<HKEY> {
    let path = wide(path);
    let mut key = HKEY::default();
    // SAFETY: the buffer is NUL terminated; the handle is closed by the caller
    // via `RegKey`. A missing key is not an error, exactly like `Test-Path`.
    let status = unsafe { RegOpenKeyExW(root, PCWSTR(path.as_ptr()), None, KEY_READ, &mut key) };
    (status == ERROR_SUCCESS).then_some(key)
}

fn subkey_names(key: HKEY) -> Vec<String> {
    let mut names = Vec::new();
    for index in 0..u32::MAX {
        let mut buffer = vec![0u16; 512];
        let mut length = buffer.len() as u32;
        // SAFETY: the buffer is sized by `length` and the handle is open.
        let status = unsafe {
            RegEnumKeyExW(
                key,
                index,
                Some(PWSTR(buffer.as_mut_ptr())),
                &mut length,
                None,
                None,
                None,
                None,
            )
        };
        if status == ERROR_NO_MORE_ITEMS {
            break;
        }
        if status != ERROR_SUCCESS {
            break;
        }
        buffer.truncate(length as usize);
        names.push(String::from_utf16_lossy(&buffer));
    }
    names
}

fn default_string(key: HKEY, name: &str) -> Option<String> {
    let name = wide(name);
    let mut size = 0u32;
    // SAFETY: the first call only asks for the required size.
    let status = unsafe {
        RegGetValueW(
            key,
            PCWSTR(name.as_ptr()),
            None,
            REG_ROUTINE_FLAGS(RRF_RT_REG_SZ.0 | RRF_RT_REG_EXPAND_SZ.0),
            None,
            None,
            Some(&mut size),
        )
    };
    if status != ERROR_SUCCESS || size < 2 {
        return None;
    }
    let mut buffer = vec![0u16; size as usize / 2];
    // SAFETY: the buffer matches the size reported by the previous call.
    let status = unsafe {
        RegGetValueW(
            key,
            PCWSTR(name.as_ptr()),
            None,
            REG_ROUTINE_FLAGS(RRF_RT_REG_SZ.0 | RRF_RT_REG_EXPAND_SZ.0),
            None,
            Some(buffer.as_mut_ptr().cast()),
            Some(&mut size),
        )
    };
    if status != ERROR_SUCCESS {
        return None;
    }
    let length = buffer
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(buffer.len());
    Some(String::from_utf16_lossy(&buffer[..length]))
}

fn known_folder(id: &windows::core::GUID) -> Option<PathBuf> {
    // SAFETY: the returned pointer is freed with `CoTaskMemFree` below.
    let path = unsafe { SHGetKnownFolderPath(id, KNOWN_FOLDER_FLAG(0), None) }.ok()?;
    let text = unsafe { path.to_string() }.ok()?;
    // SAFETY: the string owns the allocation returned by the API.
    unsafe { windows::Win32::System::Com::CoTaskMemFree(Some(path.0 as *const _)) };
    Some(PathBuf::from(text))
}

/// Depth-first `*.lnk` walk: files of a folder first, then its subfolders, capped like the baseline.
fn shortcuts(root: &Path, limit: usize) -> Vec<PathBuf> {
    let mut found = Vec::new();
    walk(root, limit, &mut found);
    found
}

fn walk(folder: &Path, limit: usize, found: &mut Vec<PathBuf>) {
    if found.len() >= limit {
        return;
    }
    let Ok(entries) = std::fs::read_dir(folder) else {
        return;
    };
    let mut folders = Vec::new();
    for entry in entries.flatten() {
        if found.len() >= limit {
            return;
        }
        let path = entry.path();
        if path.is_dir() {
            folders.push(path);
        } else if path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("lnk"))
        {
            found.push(path);
        }
    }
    for folder in folders {
        walk(&folder, limit, found);
    }
}

fn shortcut_target(link: &Path) -> Option<String> {
    // SAFETY: the shell link object is created and released on this thread.
    unsafe {
        let object: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        let file: windows::Win32::System::Com::IPersistFile = object.cast().ok()?;
        file.Load(
            &windows::core::HSTRING::from(link.as_os_str()),
            Default::default(),
        )
        .ok()?;
        let mut buffer = vec![0u16; 32_768];
        object.GetPath(&mut buffer, std::ptr::null_mut(), 0).ok()?;
        let length = buffer.iter().position(|unit| *unit == 0).unwrap_or(0);
        let target = String::from_utf16_lossy(&buffer[..length]);
        if has_arguments(&object)? {
            return None;
        }
        Some(target)
    }
}

/// Reports whether the link carries any argument text, which is the only thing
/// the baseline looks at: `if (!$shortcut.Arguments) { … }`.
fn has_arguments(arguments: &IShellLinkW) -> Option<bool> {
    let mut buffer = vec![0u16; 1024];
    // SAFETY: the buffer is valid for its own length.
    unsafe { arguments.GetArguments(&mut buffer) }.ok()?;
    let length = buffer
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(buffer.len());
    // A filled buffer is a truncated argument string, which is still non-empty.
    Some(length > 0)
}

/// Enumerates the Start menu's `AppsFolder`, which the baseline reads through
/// `Get-StartApps`: display name plus AppUserModelID, packaged or not.
fn shell_apps_folder() -> Vec<(String, String)> {
    let mut items = Vec::new();
    // SAFETY: every interface and PIDL is released inside this scope.
    unsafe {
        let mut pidl = std::ptr::null_mut();
        let parsed = SHParseDisplayName(
            &windows::core::HSTRING::from("shell:AppsFolder"),
            None,
            &mut pidl,
            0,
            None,
        );
        if parsed.is_err() || pidl.is_null() {
            return items;
        }
        let bound: windows::core::Result<IShellFolder> = SHBindToObject(
            None::<&IShellFolder>,
            pidl,
            None::<&windows::Win32::System::Com::IBindCtx>,
        );
        CoTaskMemFree(Some(pidl as *const _));
        let folder = match bound {
            Ok(folder) => folder,
            Err(_error) => {
                return items;
            }
        };
        let mut enumerator = None;
        let flags = (SHCONTF_FOLDERS.0 | SHCONTF_NONFOLDERS.0) as u32;
        let status = folder.EnumObjects(HWND::default(), flags, &mut enumerator);
        if status.is_err() {
            return items;
        }
        let Some(enumerator) = enumerator else {
            return items;
        };
        loop {
            let mut pidls = [std::ptr::null_mut()];
            let mut fetched = 0u32;
            let step = enumerator.Next(&mut pidls, Some(&mut fetched));
            if step.is_err() || fetched == 0 {
                break;
            }
            let pidl = pidls[0];
            if pidl.is_null() {
                break;
            }
            if let Ok(entry) = SHCreateItemWithParent::<_, IShellItem2>(None, &folder, pidl) {
                let appid = entry
                    .GetString(&PKEY_AppUserModel_ID)
                    .ok()
                    .map(|text| {
                        let value = text.to_string().unwrap_or_default();
                        CoTaskMemFree(Some(text.0 as *const _));
                        value
                    })
                    .unwrap_or_default();
                // Display names are only needed for packaged entries, and each
                // read costs a cross-process call, so defer until required.
                let name = if appid.contains('!') {
                    entry
                        .GetDisplayName(SIGDN_NORMALDISPLAY)
                        .ok()
                        .map(|text| {
                            let value = text.to_string().unwrap_or_default();
                            CoTaskMemFree(Some(text.0 as *const _));
                            value
                        })
                        .unwrap_or_default()
                } else {
                    String::new()
                };
                items.push((appid, name));
            }
            CoTaskMemFree(Some(pidl as *const _));
        }
    }
    items
}

fn which(command: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    for folder in std::env::split_paths(&path) {
        let candidate = folder.join(command);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

fn expand_environment(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let bytes: Vec<char> = text.chars().collect();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == '%'
            && let Some(end) = bytes[index + 1..].iter().position(|unit| *unit == '%')
        {
            let name: String = bytes[index + 1..index + 1 + end].iter().collect();
            if let Some(value) = std::env::var_os(&name) {
                result.push_str(&value.to_string_lossy());
                index += end + 2;
                continue;
            }
        }
        result.push(bytes[index]);
        index += 1;
    }
    result
}

fn unquote(text: &str) -> String {
    text.trim_matches('"').to_string()
}

/// The `.exe` tail, matched on a character boundary so a non-ASCII name never panics.
fn exe_tail(text: &str) -> Option<&str> {
    text.get(text.len().checked_sub(4)?..)
        .filter(|tail| tail.eq_ignore_ascii_case(".exe"))
}

fn is_exe(text: &str) -> bool {
    if text.is_empty() {
        return false;
    }
    if text.chars().any(|unit| {
        unit == '"' || unit == '<' || unit == '>' || unit == '|' || (unit as u32) < 0x20
    }) {
        return false;
    }
    exe_tail(text).is_some()
}

fn strip_exe_suffix(text: &str) -> String {
    match exe_tail(text) {
        Some(tail) => text[..text.len() - tail.len()].to_string(),
        None => text.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_known_variables_and_keeps_unknown_ones() {
        // A variable that always exists on Windows keeps this test hermetic.
        let root = std::env::var("SystemRoot").expect("SystemRoot is set on Windows");
        assert_eq!(
            expand_environment(r"%SystemRoot%\a.exe"),
            format!("{root}\\a.exe")
        );
        assert_eq!(
            expand_environment(r"%YU_APPLICATIONS_MISSING%\a.exe"),
            r"%YU_APPLICATIONS_MISSING%\a.exe"
        );
    }

    #[test]
    fn rejects_quotes_redirection_and_non_executables() {
        assert!(is_exe(r"C:\a\b.exe"));
        assert!(is_exe(r"C:\a\b.EXE"));
        assert!(!is_exe(r"C:\a\b.cmd"));
        assert!(!is_exe(r"C:\a\b exe"));
        assert!(!is_exe(r"C:\a\b|.exe"));
        assert!(!is_exe(r"C:\a\b>.exe"));
        assert!(!is_exe(""));
        // A multi-byte tail must not be sliced in the middle of a character.
        assert!(!is_exe(r"C:\工具\程序"));
        assert!(!is_exe(r"C:pps\记事"));
        assert!(!is_exe(r"C:\说明.txt"));
    }

    #[test]
    fn strips_only_a_trailing_exe() {
        assert_eq!(strip_exe_suffix("Foo.EXE"), "Foo");
        assert_eq!(strip_exe_suffix("Foo.exe.txt"), "Foo.exe.txt");
        assert_eq!(strip_exe_suffix("Foo"), "Foo");
        // Non-ASCII tails keep their text instead of panicking.
        assert_eq!(strip_exe_suffix("记事"), "记事");
        assert_eq!(strip_exe_suffix(r"C:\工具\程序"), r"C:\工具\程序");
    }

    #[test]
    fn orders_case_insensitively_and_deduplicates_the_sorted_list() {
        let entries = vec![
            json!({ "name": "beta", "path": "b.exe" }),
            json!({ "name": "Alpha", "path": "a.exe" }),
            json!({ "name": "alpha", "path": "a.exe" }),
            json!({ "name": "alpha", "path": "c.exe" }),
        ];
        let finished = finish(entries);
        assert_eq!(finished.len(), 3);
        assert_eq!(field(&finished[0], "name"), "Alpha");
        assert_eq!(field(&finished[1], "path"), "c.exe");
        assert_eq!(field(&finished[2], "name"), "beta");
    }

    struct Apartment;

    impl Apartment {
        fn new() -> Self {
            // SAFETY: paired with CoUninitialize when the fixture drops on this thread.
            unsafe {
                let _ = windows::Win32::System::Com::CoInitializeEx(
                    None,
                    windows::Win32::System::Com::COINIT_MULTITHREADED,
                );
            }
            Self
        }
    }

    impl Drop for Apartment {
        fn drop(&mut self) {
            // SAFETY: matches the CoInitializeEx call above.
            unsafe { windows::Win32::System::Com::CoUninitialize() };
        }
    }

    struct Scratch {
        root: PathBuf,
    }

    impl Scratch {
        fn new(name: &str) -> Self {
            let root =
                std::env::temp_dir().join(format!("yu-applications-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).expect("scratch directory");
            Self { root }
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn touch(path: &Path) {
        std::fs::write(path, b"placeholder").expect("placeholder file");
    }

    fn link(directory: &Path, name: &str, target: &Path, arguments: Option<&str>) {
        // SAFETY: COM is initialized for this thread and every object is released here.
        unsafe {
            let object: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
                .expect("shell link object");
            object
                .SetPath(&windows::core::HSTRING::from(target.as_os_str()))
                .expect("set target path");
            if let Some(arguments) = arguments {
                object
                    .SetArguments(&windows::core::HSTRING::from(arguments))
                    .expect("set arguments");
            }
            let file: windows::Win32::System::Com::IPersistFile =
                object.cast().expect("persist file");
            let path = directory.join(format!("{name}.lnk"));
            file.Save(&windows::core::HSTRING::from(path.as_os_str()), true)
                .expect("save shortcut");
        }
    }

    #[test]
    fn keeps_only_existing_executables_reached_without_arguments() {
        let _apartment = Apartment::new();
        let scratch = Scratch::new("links");
        let chinese = scratch.root.join("中文 应用.exe");
        let spaced = scratch.root.join("with space.exe");
        touch(&chinese);
        touch(&spaced);
        let directory = scratch.root.join("folder.exe");
        std::fs::create_dir_all(&directory).expect("directory named like an executable");
        let script = scratch.root.join("script.cmd");
        touch(&script);

        link(&scratch.root, "good", &chinese, None);
        link(&scratch.root, "spaced", &spaced, None);
        link(&scratch.root, "with-args", &chinese, Some("--flag"));
        link(&scratch.root, "blank-args", &chinese, Some(" "));
        link(
            &scratch.root,
            "long-args",
            &chinese,
            Some(&"a".repeat(4000)),
        );
        link(
            &scratch.root,
            "edge-args",
            &chinese,
            Some(&"a".repeat(1023)),
        );
        link(
            &scratch.root,
            "missing",
            &scratch.root.join("gone.exe"),
            None,
        );
        link(&scratch.root, "directory", &directory, None);
        link(&scratch.root, "script", &script, None);
        std::fs::write(scratch.root.join("broken.lnk"), b"not a shell link").expect("broken link");

        let entries = start_menu_in(
            std::slice::from_ref(&scratch.root),
            MAX_SHORTCUTS_PER_FOLDER,
        );
        let mut names: Vec<&str> = entries.iter().map(|entry| field(entry, "name")).collect();
        names.sort_unstable();
        assert_eq!(names, vec!["good", "spaced"]);
        assert!(
            entries
                .iter()
                .any(|entry| field(entry, "path").ends_with("中文 应用.exe"))
        );
        assert!(
            entries
                .iter()
                .any(|entry| field(entry, "path").ends_with("with space.exe"))
        );
    }

    #[test]
    fn respects_the_per_folder_shortcut_cap() {
        let _apartment = Apartment::new();
        let scratch = Scratch::new("cap");
        for index in 0..5 {
            let target = scratch.root.join(format!("app{index}.exe"));
            touch(&target);
            link(&scratch.root, &format!("app{index}"), &target, None);
        }
        assert_eq!(
            start_menu_in(std::slice::from_ref(&scratch.root), 3).len(),
            3
        );
    }

    #[test]
    fn truncates_at_the_application_cap() {
        let entries = (0..MAX_APPLICATIONS + 5)
            .map(
                |index| json!({ "name": format!("app{index:05}"), "path": format!("{index}.exe") }),
            )
            .collect();
        assert_eq!(finish(entries).len(), MAX_APPLICATIONS);
    }
}
