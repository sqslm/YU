use serde_json::{Value, json};
use std::error::Error;
use std::time::{SystemTime, UNIX_EPOCH};
use windows::{
    Win32::{
        Foundation::FILETIME,
        Storage::FileSystem::{FindClose, FindFirstFileW, FindNextFileW, WIN32_FIND_DATAW},
        System::Com::{
            CLSCTX_INPROC_SERVER, CoCreateInstance, CoTaskMemFree, IPersistFile, STGM_READ,
        },
        UI::Shell::{
            FOLDERID_Recent, IShellLinkW, KNOWN_FOLDER_FLAG, SHGetKnownFolderPath, ShellLink,
        },
    },
    core::{Interface, PCWSTR, PWSTR},
};

const MAX_FILES: usize = 300;
const SOURCE: &str = "Windows Recent";

pub fn recent_files(_request: &Value) -> Result<Value, Box<dyn Error>> {
    collect(&recent_directory()?)
}

fn collect(directory: &std::path::Path) -> Result<Value, Box<dyn Error>> {
    let mut entries = shortcuts(directory)?;
    // PowerShell sorts by LastWriteTimeUtc descending *before* truncating; a
    // stable sort keeps the enumeration order for equal timestamps.
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.1));
    entries.truncate(MAX_FILES);

    let mut files = Vec::new();
    for (path, modified) in entries {
        if let Some(target) = target_path(&path)? {
            // PowerShell serialises hashtable keys as path -> source -> recordedAt
            // and the report as source -> files; JSON.stringify keeps that order.
            files.push(json!({
                "path": target,
                "source": SOURCE,
                "recordedAt": recorded_at(modified),
            }));
        }
    }

    Ok(json!({ "source": SOURCE, "files": files }))
}

fn recent_directory() -> Result<std::path::PathBuf, Box<dyn Error>> {
    // SAFETY: the folder id is a static GUID and the returned string is owned by
    // the shell allocator, so it is freed once it has been copied into a PathBuf.
    let raw: PWSTR = unsafe { SHGetKnownFolderPath(&FOLDERID_Recent, KNOWN_FOLDER_FLAG(0), None)? };
    let path = unsafe {
        let text = raw.to_string()?;
        CoTaskMemFree(Some(raw.0 as *const _));
        std::path::PathBuf::from(text)
    };
    Ok(path)
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn shortcuts(
    directory: &std::path::Path,
) -> Result<Vec<(std::path::PathBuf, SystemTime)>, Box<dyn Error>> {
    let pattern = wide(&format!("{}\\*.lnk", directory.display()));
    let mut data = WIN32_FIND_DATAW::default();
    // SAFETY: the pattern is NUL terminated and `data` is a live buffer for the
    // duration of the call.
    let handle = unsafe { FindFirstFileW(PCWSTR(pattern.as_ptr()), &mut data) };
    let handle = match handle {
        Ok(handle) => handle,
        Err(_) => return Ok(Vec::new()),
    };

    let mut found = Vec::new();
    loop {
        if data.dwFileAttributes & 0x10 == 0 {
            let name = unsafe { PCWSTR(data.cFileName.as_ptr()).to_string()? };
            let path = directory.join(name);
            let modified = file_time(data.ftLastWriteTime);
            found.push((path, modified));
        }
        // SAFETY: the search handle stays valid until FindClose below.
        if unsafe { FindNextFileW(handle, &mut data) }.is_err() {
            break;
        }
    }
    // SAFETY: the handle came from FindFirstFileW and is closed exactly once.
    unsafe { FindClose(handle)? };
    Ok(found)
}

fn file_time(time: FILETIME) -> SystemTime {
    // NTFS timestamps are already 100 ns units, so nanos keep 7 useful digits.
    let ticks = ((time.dwHighDateTime as u64) << 32) | time.dwLowDateTime as u64;
    let nanos = (ticks % 10_000_000) * 100;
    let unix = ticks / 10_000_000 - 11_644_473_600;
    UNIX_EPOCH + std::time::Duration::new(unix, nanos as u32)
}

fn recorded_at(time: SystemTime) -> String {
    let since = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let seconds = since.as_secs() as i64;
    let days = seconds.div_euclid(86_400);
    let rest = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let fraction = since.subsec_nanos() / 100;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{fraction:07}Z",
        rest / 3600,
        (rest % 3600) / 60,
        rest % 60
    )
}

/// Days since 1970-01-01 → civil date (Howard Hinnant's short algorithm).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (
        if month <= 2 { year + 1 } else { year },
        month as u32,
        day as u32,
    )
}

fn target_path(path: &std::path::Path) -> Result<Option<String>, Box<dyn Error>> {
    let name = wide(&path.to_string_lossy());
    // SAFETY: the shell link object is created, used and dropped on this thread;
    // both buffers outlive the calls that borrow them.
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        let file: IPersistFile = link.cast()?;
        file.Load(PCWSTR(name.as_ptr()), STGM_READ)?;
        let mut buffer = [0u16; 1024];
        let mut data = WIN32_FIND_DATAW::default();
        link.GetPath(&mut buffer, &mut data, 0)?;
        let target = PCWSTR(buffer.as_ptr()).to_string()?;
        Ok((!target.is_empty()).then_some(target))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(seconds: i64) -> SystemTime {
        UNIX_EPOCH + std::time::Duration::from_secs(seconds as u64)
    }

    #[test]
    fn formats_the_dotnet_o_shape() {
        // 2026-11-04T00:04:26.9200000Z
        assert_eq!(
            recorded_at(at(1_793_750_666)),
            "2026-11-04T00:04:26.0000000Z"
        );
    }

    #[test]
    fn keeps_seven_fraction_digits() {
        let time = at(1_793_750_666) + std::time::Duration::from_nanos(912_345_600);
        assert_eq!(recorded_at(time), "2026-11-04T00:04:26.9123456Z");
    }

    #[test]
    fn formats_epoch_and_leap_day() {
        assert_eq!(recorded_at(at(0)), "1970-01-01T00:00:00.0000000Z");
        assert_eq!(recorded_at(at(951_782_400)), "2000-02-29T00:00:00.0000000Z");
        assert_eq!(
            recorded_at(at(1_735_689_599)),
            "2024-12-31T23:59:59.0000000Z"
        );
    }

    #[test]
    fn converts_filetime_to_system_time() {
        // 0x01DD_6BF0_0E6B_0280 = 2026-11-04T00:04:26.920Z in 100 ns units.
        let ticks: u64 = 0x01DD_6BF0_0E6B_0280;
        let time = file_time(FILETIME {
            dwLowDateTime: ticks as u32,
            dwHighDateTime: (ticks >> 32) as u32,
        });
        assert_eq!(recorded_at(time), "2026-11-04T00:04:26.9200000Z");
    }

    fn write_link(path: &std::path::Path, target: &std::path::Path) {
        let target = wide(&target.to_string_lossy());
        let name = wide(&path.to_string_lossy());
        // SAFETY: both wide buffers outlive the calls and the objects stay on
        // this thread.
        unsafe {
            let link: IShellLinkW =
                CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).unwrap();
            link.SetPath(PCWSTR(target.as_ptr())).unwrap();
            let file: IPersistFile = link.cast().unwrap();
            file.Save(PCWSTR(name.as_ptr()), true).unwrap();
        }
    }

    fn stamp(path: &std::path::Path, seconds: i64) {
        let file = std::fs::File::options().write(true).open(path).unwrap();
        file.set_times(
            std::fs::FileTimes::new()
                .set_modified(UNIX_EPOCH + std::time::Duration::from_secs(seconds as u64)),
        )
        .unwrap();
    }

    #[test]
    fn reports_the_shape_the_consumer_expects() {
        // SAFETY: the test thread initialises COM once for the shell link objects.
        unsafe {
            windows::Win32::System::Com::CoInitializeEx(
                None,
                windows::Win32::System::Com::COINIT_MULTITHREADED,
            )
            .unwrap();
        }
        let directory = std::env::temp_dir().join("yu-recent-unit");
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        let target = directory.join("target.txt");
        std::fs::write(&target, "hello").unwrap();
        for (index, day) in [1, 2, 3].into_iter().enumerate() {
            let link = directory.join(format!("link{}.lnk", index + 1));
            write_link(&link, &target);
            // 2026-11-02T00:00:00Z, 2026-11-03T00:00:00Z, 2026-11-04T00:00:00Z
            stamp(&link, 1_793_577_600 + (day as i64 - 1) * 86_400);
        }
        std::fs::write(directory.join("ignored.txt"), "x").unwrap();

        let report = serde_json::to_string(&collect(&directory).unwrap()).unwrap();
        // serde_json orders object keys alphabetically, so the reference below is
        // files -> path/recordedAt/source; PowerShell's hashtable order differs and
        // is compared semantically by the benchmark.
        let target = std::fs::canonicalize(&target)
            .unwrap()
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .replace('\\', "\\\\");
        let expected = format!(
            "{{\"files\":[{{\"path\":\"{target}\",\"recordedAt\":\"2026-11-04T00:00:00.0000000Z\",\"source\":\"Windows Recent\"}},{{\"path\":\"{target}\",\"recordedAt\":\"2026-11-03T00:00:00.0000000Z\",\"source\":\"Windows Recent\"}},{{\"path\":\"{target}\",\"recordedAt\":\"2026-11-02T00:00:00.0000000Z\",\"source\":\"Windows Recent\"}}],\"source\":\"Windows Recent\"}}"
        );
        assert_eq!(report, expected);
        std::fs::remove_dir_all(&directory).unwrap();
    }
}
