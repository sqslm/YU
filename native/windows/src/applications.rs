use serde_json::{Value, json};
#[cfg(test)]
use std::sync::atomic::Ordering as AtomicOrdering;
use std::{
    error::Error,
    path::{Path, PathBuf},
};
#[cfg(test)]
static FORCE_COMPARE_FAILURE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

use windows::{
    Win32::{
        Foundation::{ERROR_NO_MORE_ITEMS, ERROR_SUCCESS, GetLastError, HWND},
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
    Ok(json!({ "applications": collect()? }))
}

type Failure = Box<dyn Error>;

/// A source that cannot be read must fail the whole read instead of yielding a
/// shorter list, because the caller treats the list as the complete registry.
fn failed(stage: &str, detail: String) -> Failure {
    format!("applications read failed at {stage}: {detail}").into()
}

fn collect() -> Result<Vec<Value>, Failure> {
    let mut entries = Vec::new();
    entries.extend(app_paths()?);
    entries.extend(start_menu_shortcuts()?);
    entries.extend(packaged_apps()?);
    entries.push(json!({ "name": "Windows Settings", "path": "", "appId": "system:settings" }));
    entries.extend(fixed_commands(&entries));
    finish(entries)
}

/// Registry `App Paths` in the same three views the 64-bit PowerShell reads.
fn app_paths() -> Result<Vec<Value>, Failure> {
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
        let Some(key) = open_key(root, base)? else {
            continue;
        };
        for name in subkey_names(key)? {
            if let Some(target) = app_path_entry(key, &name)? {
                items.push(json!({ "name": strip_exe_suffix(&name), "path": target }));
            }
        }
        // SAFETY: the handle came from `RegOpenKeyExW` above.
        let _ = unsafe { RegCloseKey(key) };
    }
    Ok(items)
}

/// Recursive `.lnk` scan of the two Start menu programs folders, capped per
/// folder, with every shortcut that carries arguments rejected.
fn start_menu_shortcuts() -> Result<Vec<Value>, Failure> {
    let mut roots = Vec::new();
    for id in [FOLDERID_Programs, FOLDERID_CommonPrograms] {
        roots.push(known_folder(&id)?);
    }
    start_menu_in(&roots, MAX_SHORTCUTS_PER_FOLDER)
}

fn start_menu_in(roots: &[PathBuf], limit: usize) -> Result<Vec<Value>, Failure> {
    let mut items = Vec::new();
    for root in roots {
        let links = shortcuts(root, limit)?;
        for link in links {
            let Some(target) = shortcut_target(&link)? else {
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
    Ok(items)
}

/// Packaged Start menu entries: the AppID carries a `!` for packaged apps.
fn packaged_apps() -> Result<Vec<Value>, Failure> {
    let mut items = Vec::new();
    for (appid, name) in shell_apps_folder()? {
        if appid.contains('!') {
            items.push(json!({ "name": name, "path": "", "appId": appid }));
        }
    }
    Ok(items)
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
///
/// Every comparison can fail: `CompareStringEx` report failure with 0, and a
/// failed comparison must not quietly produce a list ordered by some other
/// relation. The sort is a stable merge sort so the comparator can return an
/// error instead of inventing an ordering.
fn finish(entries: Vec<Value>) -> Result<Vec<Value>, Failure> {
    let sorted = merge_sort(entries)?;
    let mut unique: Vec<Value> = Vec::with_capacity(sorted.len());
    for entry in sorted {
        if let Some(last) = unique.last()
            && same_key(last, &entry)?
        {
            continue;
        }
        unique.push(entry);
    }
    unique.truncate(MAX_APPLICATIONS);
    Ok(unique)
}

fn merge_sort(entries: Vec<Value>) -> Result<Vec<Value>, Failure> {
    if entries.len() <= 1 {
        return Ok(entries);
    }
    let mut head = entries;
    // `split_off` keeps the front and returns the tail, so the head stays the
    // first half and an equal pair keeps the earlier entry first (stable order,
    // which is what decides between two spellings of the same key).
    let tail = head.split_off(head.len() / 2);
    merge(merge_sort(head)?, merge_sort(tail)?)
}

fn merge(left: Vec<Value>, right: Vec<Value>) -> Result<Vec<Value>, Failure> {
    let mut merged = Vec::with_capacity(left.len() + right.len());
    let mut left = left.into_iter().peekable();
    let mut right = right.into_iter().peekable();
    loop {
        let order = match (left.peek(), right.peek()) {
            (Some(kept), Some(candidate)) => compare_entries(candidate, kept)?,
            (Some(_), None) => std::cmp::Ordering::Greater,
            (None, Some(_)) => std::cmp::Ordering::Less,
            (None, None) => break,
        };
        if order == std::cmp::Ordering::Less {
            merged.extend(right.next());
        } else {
            merged.extend(left.next());
        }
    }
    Ok(merged)
}

/// Name first, then path, both with the culture rule `Sort-Object` uses.
///
/// Paths that are equal apart from case are one key. Their relative order is
/// not defined by the culture rule, so the ordinal comparison only breaks that
/// tie: it is a secondary key applied after the culture results are equal, not
/// a substitute for a failed culture comparison.
fn compare_entries(left: &Value, right: &Value) -> Result<std::cmp::Ordering, Failure> {
    let by_name = culture_compare(field(left, "name"), field(right, "name"))?;
    if by_name != std::cmp::Ordering::Equal {
        return Ok(by_name);
    }
    let (left_path, right_path) = (field(left, "path"), field(right, "path"));
    let by_path = culture_compare(left_path, right_path)?;
    if by_path != std::cmp::Ordering::Equal {
        return Ok(by_path);
    }
    Ok(left_path.cmp(right_path))
}

fn field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn same_key(left: &Value, right: &Value) -> Result<bool, Failure> {
    Ok(
        culture_compare(field(left, "name"), field(right, "name"))? == std::cmp::Ordering::Equal
            && culture_compare(field(left, "path"), field(right, "path"))?
                == std::cmp::Ordering::Equal,
    )
}

/// Case-insensitive, culture-aware ordering, matching `Sort-Object` on the
/// current user locale instead of a byte or ordinal comparison.
///
/// `CompareStringEx` reports failure with 0 and the failure reason through
/// `GetLastError`; that is an error, not a comparison result, so it is returned
/// to the caller and the read fails instead of emitting a differently ordered
/// list.
fn culture_compare(left: &str, right: &str) -> Result<std::cmp::Ordering, Failure> {
    use windows::Win32::Globalization::{
        COMPARE_STRING_FLAGS, CSTR_EQUAL, CSTR_LESS_THAN, CompareStringEx, NORM_IGNORECASE,
    };
    #[cfg(test)]
    if FORCE_COMPARE_FAILURE.swap(false, AtomicOrdering::SeqCst) {
        return Err(failed("Application sort", win32(5)));
    }
    if left == right {
        return Ok(std::cmp::Ordering::Equal);
    }
    let (left_wide, right_wide) = (wide(left), wide(right));
    // SAFETY: both slices are NUL terminated and outlive the call.
    let result = unsafe {
        CompareStringEx(
            windows::core::PCWSTR::null(),
            COMPARE_STRING_FLAGS(NORM_IGNORECASE.0),
            &left_wide,
            &right_wide,
            None,
            None,
            None,
        )
    };
    if result == CSTR_LESS_THAN {
        return Ok(std::cmp::Ordering::Less);
    }
    if result == CSTR_EQUAL {
        return Ok(std::cmp::Ordering::Equal);
    }
    if result.0 == 0 {
        // SAFETY: no pointers are involved.
        let code = unsafe { GetLastError() }.0;
        return Err(failed("Application sort", win32(code)));
    }
    Ok(std::cmp::Ordering::Greater)
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn win32(code: u32) -> String {
    format!("Win32 error {code}")
}

fn hresult(error: &windows::core::Error) -> String {
    format!("HRESULT 0x{:08X}", error.code().0 as u32)
}

fn open_key(root: HKEY, path: &str) -> Result<Option<HKEY>, Failure> {
    let path = wide(path);
    let mut key = HKEY::default();
    // SAFETY: the buffer is NUL terminated; the handle is closed by the caller.
    let status = unsafe { RegOpenKeyExW(root, PCWSTR(path.as_ptr()), None, KEY_READ, &mut key) };
    match status.0 {
        // A missing view is normal on machines where the product key is absent.
        2 | 3 => Ok(None),
        0 => Ok(Some(key)),
        code => Err(failed("App Paths open", win32(code))),
    }
}

fn subkey_names(key: HKEY) -> Result<Vec<String>, Failure> {
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
            return Err(failed("App Paths subkeys", win32(status.0)));
        }
        buffer.truncate(length as usize);
        names.push(String::from_utf16_lossy(&buffer));
    }
    Ok(names)
}

/// Statuses that mean "this App Paths entry is not a usable string".
///
/// `2` is a missing value; `1630` is a present value of the wrong type, which the
/// baseline reads as text that fails the `.exe` pattern and skips. Anything else,
/// including access denial, is a real failure.
fn value_missing(status: u32) -> bool {
    matches!(status, 2 | 1630)
}

fn default_string(key: HKEY, name: &str) -> Result<Option<String>, Failure> {
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
    // 2: the value is missing. 1630 (ERROR_UNSUPPORTED_TYPE): the default value
    // is not a string, which the baseline reads as text that fails the `.exe`
    // pattern and skips. Access denial stays a real failure below.
    if value_missing(status.0) {
        return Ok(None);
    }
    if status != ERROR_SUCCESS {
        return Err(failed("App Paths value size", win32(status.0)));
    }
    if size < 2 {
        return Ok(None);
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
    if value_missing(status.0) {
        return Ok(None);
    }
    if status != ERROR_SUCCESS {
        return Err(failed("App Paths value", win32(status.0)));
    }
    let length = buffer
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(buffer.len());
    Ok(Some(String::from_utf16_lossy(&buffer[..length])))
}

fn known_folder(id: &windows::core::GUID) -> Result<PathBuf, Failure> {
    // SAFETY: the returned pointer is freed with `CoTaskMemFree` below.
    let path = unsafe { SHGetKnownFolderPath(id, KNOWN_FOLDER_FLAG(0), None) }
        .map_err(|error| failed("known folder", hresult(&error)))?;
    let text = unsafe { path.to_string() }
        .map_err(|error| failed("known folder text", error.to_string()))?;
    // SAFETY: the string owns the allocation returned by the API.
    unsafe { windows::Win32::System::Com::CoTaskMemFree(Some(path.0 as *const _)) };
    Ok(PathBuf::from(text))
}

/// One App Paths entry: the default value has to survive the same unquoting,
/// environment expansion and file checks the baseline applies.
fn app_path_entry(key: HKEY, name: &str) -> Result<Option<String>, Failure> {
    let Some(raw) = default_string(key, name)? else {
        return Ok(None);
    };
    let target = unquote(&expand_environment(&raw));
    if !is_exe(&target) || !Path::new(&target).is_file() {
        return Ok(None);
    }
    Ok(Some(target))
}

/// Depth-first `*.lnk` walk: files of a folder first, then its subfolders, capped like the baseline.
fn shortcuts(root: &Path, limit: usize) -> Result<Vec<PathBuf>, Failure> {
    let mut found = Vec::new();
    walk(root, limit, &mut found)?;
    Ok(found)
}

/// Files of a folder come before its subfolders, matching the order the
/// baseline's `Get-ChildItem -Recurse` produced on the reference tree.
fn walk(folder: &Path, limit: usize, found: &mut Vec<PathBuf>) -> Result<(), Failure> {
    if found.len() >= limit {
        return Ok(());
    }
    let entries = match std::fs::read_dir(folder) {
        Ok(entries) => entries,
        // The baseline skips a Start menu folder that is not present at all.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(failed(
                "Start menu scan",
                format!("{}: {error}", folder.display()),
            ));
        }
    };
    let mut folders = Vec::new();
    for entry in entries {
        if found.len() >= limit {
            return Ok(());
        }
        // The baseline reads the tree with `-ErrorAction SilentlyContinue`.
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        // Junctions and symlinks can loop; the baseline never follows them here.
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
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
        walk(&folder, limit, found)?;
    }
    Ok(())
}

fn shortcut_target(link: &Path) -> Result<Option<String>, Failure> {
    // SAFETY: the shell link object is created and released on this thread.
    unsafe {
        let object: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
            .map_err(|error| failed("shortcut object", hresult(&error)))?;
        let file: windows::Win32::System::Com::IPersistFile = object
            .cast()
            .map_err(|error| failed("shortcut cast", hresult(&error)))?;
        // `WScript.Shell.CreateShortcut` returns an object with an empty
        // `TargetPath` for a corrupt link, so the baseline skips that entry and
        // still returns the rest of the list. A load failure is skipped here for
        // the same reason; it is not a failure of the whole enumeration.
        if file
            .Load(
                &windows::core::HSTRING::from(link.as_os_str()),
                Default::default(),
            )
            .is_err()
        {
            return Ok(None);
        }
        let mut buffer = vec![0u16; 32_768];
        // A link without a target is normal (links to shell folders); the
        // baseline then reads an empty `TargetPath` and skips the entry.
        if object
            .GetPath(&mut buffer, std::ptr::null_mut(), 0)
            .is_err()
        {
            return Ok(None);
        }
        let length = buffer.iter().position(|unit| *unit == 0).unwrap_or(0);
        let target = String::from_utf16_lossy(&buffer[..length]);
        if has_arguments(&object)? {
            return Ok(None);
        }
        Ok(Some(target))
    }
}

/// Reports whether the link carries any argument text, which is the only thing
/// the baseline looks at: `if (!$shortcut.Arguments) { … }`.
fn has_arguments(arguments: &IShellLinkW) -> Result<bool, Failure> {
    let mut buffer = vec![0u16; 1024];
    // SAFETY: the buffer is valid for its own length.
    unsafe { arguments.GetArguments(&mut buffer) }
        .map_err(|error| failed("shortcut arguments", hresult(&error)))?;
    let length = buffer
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(buffer.len());
    // A filled buffer is a truncated argument string, which is still non-empty.
    Ok(length > 0)
}

/// Enumerates the Start menu's `AppsFolder`, which the baseline reads through
/// `Get-StartApps`: display name plus AppUserModelID, packaged or not.
fn shell_apps_folder() -> Result<Vec<(String, String)>, Failure> {
    let mut items = Vec::new();
    // SAFETY: every interface and PIDL is released inside this scope.
    unsafe {
        let mut pidl = std::ptr::null_mut();
        SHParseDisplayName(
            &windows::core::HSTRING::from("shell:AppsFolder"),
            None,
            &mut pidl,
            0,
            None,
        )
        .map_err(|error| failed("AppsFolder parse", hresult(&error)))?;
        if pidl.is_null() {
            return Err(failed(
                "AppsFolder parse",
                "shell:AppsFolder resolved to no item".to_string(),
            ));
        }
        let bound: windows::core::Result<IShellFolder> = SHBindToObject(
            None::<&IShellFolder>,
            pidl,
            None::<&windows::Win32::System::Com::IBindCtx>,
        );
        CoTaskMemFree(Some(pidl as *const _));
        let folder = bound.map_err(|error| failed("AppsFolder bind", hresult(&error)))?;
        let mut enumerator = None;
        let flags = (SHCONTF_FOLDERS.0 | SHCONTF_NONFOLDERS.0) as u32;
        folder
            .EnumObjects(HWND::default(), flags, &mut enumerator)
            .ok()
            .map_err(|error| failed("AppsFolder enumerate", hresult(&error)))?;
        let Some(enumerator) = enumerator else {
            return Ok(items);
        };
        loop {
            let mut pidls = [std::ptr::null_mut()];
            let mut fetched = 0u32;
            enumerator
                .Next(&mut pidls, Some(&mut fetched))
                .ok()
                .map_err(|error| failed("AppsFolder next", hresult(&error)))?;
            if fetched == 0 {
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
                    let text = entry
                        .GetDisplayName(SIGDN_NORMALDISPLAY)
                        .map_err(|error| failed("AppsFolder display name", hresult(&error)))?;
                    let value = text.to_string().unwrap_or_default();
                    CoTaskMemFree(Some(text.0 as *const _));
                    value
                } else {
                    String::new()
                };
                items.push((appid, name));
            }
            CoTaskMemFree(Some(pidl as *const _));
        }
    }
    Ok(items)
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
        assert!(!is_exe(r"C:\apps\记事"));
        assert!(!is_exe(r"C:\a\说明.txt"));
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
        let finished = finish(entries).expect("sorted");
        assert_eq!(finished.len(), 3);
        assert_eq!(field(&finished[0], "name"), "Alpha");
        assert_eq!(field(&finished[1], "path"), "c.exe");
        assert_eq!(field(&finished[2], "name"), "beta");
    }

    /// A throwaway `HKCU\Software\yu-applications-test-…` tree. The key name is
    /// unique per run, never under the real App Paths key, and is removed with
    /// its own children only.
    struct TestKey {
        path: String,
        wide_path: Vec<u16>,
        handle: HKEY,
        children: Vec<(String, HKEY)>,
    }

    impl TestKey {
        fn new() -> Self {
            use windows::Win32::System::Registry::{
                HKEY_CURRENT_USER, KEY_ALL_ACCESS, REG_OPTION_NON_VOLATILE, RegCreateKeyExW,
            };
            let unique = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let path = format!(
                r"Software\yu-applications-test-{}-{unique}",
                std::process::id()
            );
            let wide_path = wide(&path);
            let mut handle = HKEY::default();
            // SAFETY: the path is NUL terminated and the handle is closed in `Drop`.
            let status = unsafe {
                RegCreateKeyExW(
                    HKEY_CURRENT_USER,
                    PCWSTR(wide_path.as_ptr()),
                    None,
                    PCWSTR::null(),
                    REG_OPTION_NON_VOLATILE,
                    KEY_ALL_ACCESS,
                    None,
                    &mut handle,
                    None,
                )
            };
            assert_eq!(status.0, 0, "create {path}: Win32 error {}", status.0);
            Self {
                path,
                wide_path,
                handle,
                children: Vec::new(),
            }
        }

        fn subkey(&mut self, child: &str) -> HKEY {
            use windows::Win32::System::Registry::{
                KEY_ALL_ACCESS, REG_OPTION_NON_VOLATILE, RegCreateKeyExW,
            };
            let wide_child = wide(child);
            let mut handle = HKEY::default();
            // SAFETY: both paths are NUL terminated; the handle is closed in `Drop`.
            let status = unsafe {
                RegCreateKeyExW(
                    self.handle,
                    PCWSTR(wide_child.as_ptr()),
                    None,
                    PCWSTR::null(),
                    REG_OPTION_NON_VOLATILE,
                    KEY_ALL_ACCESS,
                    None,
                    &mut handle,
                    None,
                )
            };
            assert_eq!(
                status.0, 0,
                "delete child {child} under {}: Win32 error {}",
                self.path, status.0
            );
            self.children.push((child.to_string(), handle));
            handle
        }

        fn set_default(&self, key: HKEY, kind: REG_VALUE_TYPE, data: &[u8]) {
            use windows::Win32::System::Registry::RegSetValueExW;
            // SAFETY: `data` is a complete value buffer of the declared type.
            let status = unsafe { RegSetValueExW(key, PCWSTR::null(), None, kind, Some(data)) };
            assert_eq!(status.0, 0, "set default value: Win32 error {}", status.0);
        }
    }

    impl Drop for TestKey {
        fn drop(&mut self) {
            use windows::Win32::System::Registry::{RegCloseKey, RegDeleteKeyW};
            // SAFETY: every handle came from `RegCreateKeyExW` in this test and
            // the deletions target this run's own key only. Children go first so
            // the parent still has a live handle when they are removed.
            unsafe {
                for (child, handle) in &self.children {
                    let _ = RegCloseKey(*handle);
                    let wide_child = wide(child);
                    let status = RegDeleteKeyW(self.handle, PCWSTR(wide_child.as_ptr()));
                    assert_eq!(
                        status.0, 0,
                        "delete child {child} under {}: Win32 error {}",
                        self.path, status.0
                    );
                }
                let _ = RegCloseKey(self.handle);
                let status = RegDeleteKeyW(HKEY_CURRENT_USER, PCWSTR(self.wide_path.as_ptr()));
                assert_eq!(
                    status.0, 0,
                    "delete {}: Win32 error {}",
                    self.path, status.0
                );
            }
        }
    }

    use windows::Win32::System::Registry::REG_VALUE_TYPE;

    fn utf16_bytes(text: &str) -> Vec<u8> {
        text.encode_utf16()
            .chain(std::iter::once(0))
            .flat_map(u16::to_le_bytes)
            .collect()
    }

    #[test]
    fn reads_real_registry_values_like_the_baseline() {
        use windows::Win32::System::Registry::{REG_DWORD, REG_EXPAND_SZ, REG_SZ};

        let system_root = std::env::var("SystemRoot").expect("SystemRoot is set on Windows");
        let notepad = format!(r"{system_root}\System32\notepad.exe");
        assert!(Path::new(&notepad).is_file(), "missing {notepad}");

        let mut parent = TestKey::new();
        parent.subkey("missing.exe");
        let plain = parent.subkey("plain.exe");
        parent.set_default(plain, REG_SZ, &utf16_bytes(&format!("\"{notepad}\"")));
        let expanded = parent.subkey("expanded.exe");
        parent.set_default(
            expanded,
            REG_EXPAND_SZ,
            &utf16_bytes(r"%SystemRoot%\System32\notepad.exe"),
        );
        let dword = parent.subkey("dword.exe");
        parent.set_default(dword, REG_DWORD, &4660u32.to_ne_bytes());

        // The real `RegGetValueW` path, not the status classifier: a missing or
        // non-string default value is skipped, a string is unquoted/expanded and
        // accepted only when it names an existing `.exe`.
        assert!(matches!(
            app_path_entry(parent.handle, "missing.exe"),
            Ok(None)
        ));
        match app_path_entry(parent.handle, "plain.exe") {
            Ok(Some(path)) => assert_eq!(path, notepad),
            other => panic!("plain.exe: {other:?}"),
        }
        match app_path_entry(parent.handle, "expanded.exe") {
            Ok(Some(path)) => assert_eq!(path, notepad),
            other => panic!("expanded.exe: {other:?}"),
        }
        assert!(matches!(
            app_path_entry(parent.handle, "dword.exe"),
            Ok(None)
        ));
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
        let entries = start_menu_in(
            std::slice::from_ref(&scratch.root),
            MAX_SHORTCUTS_PER_FOLDER,
        )
        .expect("readable Start menu tree");
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
            start_menu_in(std::slice::from_ref(&scratch.root), 3)
                .expect("readable tree")
                .len(),
            3
        );
    }

    #[test]
    fn skips_unreadable_links_and_keeps_the_rest() {
        let _apartment = Apartment::new();
        let scratch = Scratch::new("broken");
        let target = scratch.root.join("good.exe");
        touch(&target);
        link(&scratch.root, "good.lnk", &target, None);
        std::fs::write(scratch.root.join("broken.lnk"), b"not a shell link").expect("broken link");
        // `CreateShortcut` yields an empty `TargetPath` for a corrupt link, so the
        // baseline skips that entry and still returns the rest of the list.
        let kept = start_menu_in(
            std::slice::from_ref(&scratch.root),
            MAX_SHORTCUTS_PER_FOLDER,
        )
        .expect("corrupt link must not fail the read");
        assert_eq!(kept.len(), 1, "kept: {kept:?}");
        let kept_path = kept[0]["path"].as_str().expect("path");
        assert!(
            kept_path.ends_with("good.exe"),
            "unexpected target: {kept_path}"
        );
    }

    #[test]
    fn keeps_the_folder_order_before_crossing_into_siblings() {
        let _apartment = Apartment::new();
        let scratch = Scratch::new("order");
        let (first, second) = (scratch.root.join("A"), scratch.root.join("B"));
        let deep = first.join("deep");
        std::fs::create_dir_all(&deep).expect("first tree");
        std::fs::create_dir_all(&second).expect("second tree");
        for (folder, name, target) in [
            (&first, "a", "a.exe"),
            (&deep, "one", "one.exe"),
            (&second, "two", "two.exe"),
        ] {
            let exe = scratch.root.join(target);
            touch(&exe);
            link(folder, name, &exe, None);
        }
        // The baseline recurses into `A/deep` before visiting `B`, so a limit
        // of two keeps `A/a.lnk` and `A/deep/one.lnk`, not `B/two.lnk`.
        let entries = start_menu_in(std::slice::from_ref(&scratch.root), 2).expect("readable tree");
        let names: Vec<&str> = entries.iter().map(|entry| field(entry, "name")).collect();
        assert_eq!(names, vec!["a", "one"]);
    }

    #[test]
    fn dedupes_paths_that_only_differ_in_case() {
        let entries = vec![
            json!({ "name": "Demo", "path": r"C:\Apps\a.exe" }),
            json!({ "name": "Demo", "path": r"C:\apps\b.exe" }),
            json!({ "name": "Demo", "path": r"c:\Apps\A.exe" }),
        ];
        // `Sort-Object name,path -Unique` treats the two `a.exe` spellings as
        // one entry, so the sorted list has to keep them adjacent.
        let kept = finish(entries).expect("sorted");
        assert_eq!(kept.len(), 2);
        let paths: Vec<&str> = kept.iter().map(|entry| field(entry, "path")).collect();
        assert!(paths.iter().any(|path| path.ends_with("b.exe")));
    }

    #[test]
    fn missing_and_non_string_default_values_are_not_failures() {
        // Observed on this platform: a REG_DWORD default value makes
        // RegGetValueW(RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ) report 1630, and the
        // baseline reads that number as text that fails the `.exe` pattern.
        assert!(value_missing(2), "ERROR_FILE_NOT_FOUND");
        assert!(value_missing(1630), "ERROR_UNSUPPORTED_TYPE");
        assert!(!value_missing(5), "access denied stays fatal");
    }

    #[test]
    fn failures_name_the_stage_and_the_platform_code() {
        assert_eq!(
            failed("App Paths open", win32(5)).to_string(),
            "applications read failed at App Paths open: Win32 error 5"
        );
        // A Start menu folder that is absent is not an error for the baseline.
        let missing = shortcuts(&PathBuf::from(r"Z:\yu-missing-start-menu"), 10)
            .expect("missing folder must read as empty");
        assert!(missing.is_empty(), "unexpected: {missing:?}");
    }

    #[test]
    fn a_failed_culture_comparison_fails_the_read() {
        let entries = vec![
            json!({ "name": "beta", "path": r"C:.exe" }),
            json!({ "name": "alpha", "path": r"C:.exe" }),
        ];
        FORCE_COMPARE_FAILURE.store(true, AtomicOrdering::SeqCst);
        let outcome = finish(entries);
        let message = match outcome {
            Ok(_) => panic!("a failed comparison produced a sorted list"),
            Err(error) => error.to_string(),
        };
        assert!(
            message.starts_with("applications read failed at Application sort: Win32 error"),
            "unexpected message: {message}"
        );
    }

    #[test]
    fn truncates_at_the_application_cap() {
        let entries = (0..MAX_APPLICATIONS + 5)
            .map(
                |index| json!({ "name": format!("app{index:05}"), "path": format!("{index}.exe") }),
            )
            .collect();
        assert_eq!(finish(entries).expect("sorted").len(), MAX_APPLICATIONS);
    }
}
