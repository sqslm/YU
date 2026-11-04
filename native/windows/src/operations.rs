use crate::input;
use serde_json::{Value, json};
use std::{error::Error, io, thread};
use windows::{
    Win32::{
        Foundation::{CloseHandle, HANDLE, HWND, WAIT_OBJECT_0},
        Media::Audio::{
            Endpoints::IAudioEndpointVolume, IMMDeviceEnumerator, MMDeviceEnumerator, eMultimedia,
            eRender,
        },
        Storage::FileSystem::{
            GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDriveStringsW, GetVolumeInformationW,
        },
        System::{
            Com::{CLSCTX_ALL, CoCreateInstance},
            Threading::{INFINITE, OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
            WinRT::{RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize},
            WindowsProgramming::{DRIVE_FIXED, DRIVE_REMOVABLE},
        },
        UI::WindowsAndMessaging::{GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow},
    },
    core::{GUID, PCWSTR},
};

#[path = "address.rs"]
mod address;

#[path = "applications.rs"]
mod applications;
#[path = "folder.rs"]
mod folder;
#[path = "ocr.rs"]
mod ocr;
#[path = "recent.rs"]
mod recent;

struct Runtime;
impl Runtime {
    fn initialize() -> windows::core::Result<Self> {
        // SAFETY: this one-shot worker owns no UI and never transfers COM/WinRT
        // interfaces to another thread. RoInitialize also initializes COM.
        unsafe {
            RoInitialize(RO_INIT_MULTITHREADED)?;
        }
        Ok(Self)
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        unsafe {
            RoUninitialize();
        }
    }
}

pub fn watch_parent() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        return Ok(());
    }
    if args.len() != 2 || args[0] != "--parent-pid" {
        return Err("Unknown helper argument".into());
    }
    let pid = args[1]
        .parse::<u32>()
        .ok()
        .filter(|v| *v != 0)
        .ok_or("Invalid parent process")?;
    // stdin EOF marks the end of a request, so it cannot signal owner death.
    // A process handle keeps identity stable and also ends a blocked API call
    // if Electron crashes instead of leaving an orphan native worker.
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid)? };
    let raw = handle.0 as usize;
    thread::spawn(move || unsafe {
        // SAFETY: process handles are thread-independent; ownership moves here.
        let handle = HANDLE(raw as *mut _);
        let result = WaitForSingleObject(handle, INFINITE);
        let _ = CloseHandle(handle);
        if result == WAIT_OBJECT_0 {
            std::process::exit(0);
        }
    });
    Ok(())
}

pub fn run(request: &Value) -> Result<Value, Box<dyn Error>> {
    match request["action"].as_str() {
        Some("window-check") => window_check(request),
        Some("browser-url") => {
            let _runtime = Runtime::initialize()?;
            address::browser_url(request)
        }
        Some("applications") => {
            let _runtime = Runtime::initialize()?;
            applications::applications(request)
        }
        Some("explorer-folder") => {
            let _runtime = Runtime::initialize()?;
            folder::explorer_folder(request)
        }
        Some("recent-files") => {
            let _runtime = Runtime::initialize()?;
            recent::recent_files(request)
        }
        Some("disk-space") => disk_space(),
        Some("system-volume") => system_volume(request),
        Some("ocr") => {
            let _runtime = Runtime::initialize()?;
            ocr::recognize(request)
        }
        _ => Err("Unknown operation".into()),
    }
}

/// The frozen HWND/PID/title guard shared by the read-only window actions.
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

fn window_check(request: &Value) -> Result<Value, Box<dyn Error>> {
    let handle = input::window_handle(request)?;
    let window = HWND(handle as *mut _);
    // SAFETY: caller-supplied handles are validated by the OS, never dereferenced.
    unsafe {
        let mut pid = 0;
        GetWindowThreadProcessId(window, Some(&mut pid));
        let mut title = [0u16; 1024];
        let length = GetWindowTextW(window, &mut title).max(0) as usize;
        if !IsWindow(Some(window)).as_bool()
            || request["pid"].as_u64() != Some(pid as u64)
            || String::from_utf16_lossy(&title[..length]) != request["title"].as_str().unwrap_or("")
        {
            return Err("Original window has changed or closed".into());
        }
        if IsIconic(window).as_bool() {
            return Err("Original window is minimized; restore it before capture".into());
        }
    }
    Ok(json!({"valid":true}))
}

fn disk_space() -> Result<Value, Box<dyn Error>> {
    // SAFETY: all buffers and out parameters remain live for synchronous calls.
    unsafe {
        // GetVolumeInformation can otherwise display an insert-media dialog.
        // This worker performs one request; preserve its other inherited flags.
        use windows::Win32::System::Diagnostics::Debug::{
            GetErrorMode, SEM_FAILCRITICALERRORS, SetErrorMode, THREAD_ERROR_MODE,
        };
        SetErrorMode(THREAD_ERROR_MODE(GetErrorMode() | SEM_FAILCRITICALERRORS.0));
        let count = GetLogicalDriveStringsW(None);
        if count == 0 {
            return Err(io::Error::last_os_error().into());
        }
        let mut names = vec![0u16; count as usize + 1];
        let length = GetLogicalDriveStringsW(Some(&mut names));
        if length == 0 {
            return Err(io::Error::last_os_error().into());
        }
        if length as usize >= names.len() {
            return Err("Drive list changed during query".into());
        }
        let mut drives = vec![];
        for root in names[..length as usize]
            .split(|&c| c == 0)
            .filter(|s| !s.is_empty())
        {
            let terminated: Vec<u16> = root.iter().copied().chain([0]).collect();
            let path = PCWSTR(terminated.as_ptr());
            if ![DRIVE_FIXED, DRIVE_REMOVABLE].contains(&GetDriveTypeW(path)) {
                continue;
            }
            let (mut available, mut total) = (0, 0);
            // Match DriveInfo.IsReady and AvailableFreeSpace, including quotas.
            if GetDiskFreeSpaceExW(path, Some(&mut available), Some(&mut total), None).is_err() {
                continue;
            }
            let mut label = [0u16; 261];
            GetVolumeInformationW(path, Some(&mut label), None, None, None, None)?;
            let end = label.iter().position(|&c| c == 0).unwrap_or(label.len());
            drives.push(json!({"name":String::from_utf16_lossy(root),"label":String::from_utf16_lossy(&label[..end]),"totalBytes":total,"freeBytes":available,"usedBytes":total.checked_sub(available).ok_or("Invalid disk capacity")?}));
        }
        Ok(json!({"drives":drives}))
    }
}

fn system_volume(request: &Value) -> Result<Value, Box<dyn Error>> {
    // Validate both fields before changing either value.
    let (level, mute) = input::volume(request)?;
    let _runtime = Runtime::initialize()?;
    // SAFETY: interfaces stay on this initialized worker thread and are released
    // before the runtime guard. Use the same render/multimedia role as before.
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia)?;
        let endpoint: IAudioEndpointVolume = device.Activate(CLSCTX_ALL, None)?;
        let context = GUID::zeroed();
        if let Some(value) = level {
            endpoint.SetMasterVolumeLevelScalar(value as f32 / 100., &context)?;
        }
        if let Some(value) = mute {
            endpoint.SetMute(value, &context)?;
        }
        Ok(
            json!({"volume":(endpoint.GetMasterVolumeLevelScalar()? * 100.).round_ties_even() as u32,"muted":endpoint.GetMute()?.as_bool()}),
        )
    }
}
