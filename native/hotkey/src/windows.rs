use crate::{
    engine::{Engine, physical_vk},
    now,
};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    io::{self, BufRead, Write},
    ptr::{null, null_mut},
    sync::mpsc,
    thread,
};
use windows_sys::Win32::{
    Foundation::WAIT_FAILED,
    System::{
        LibraryLoader::GetModuleHandleW,
        StationsAndDesktops::{CloseDesktop, DESKTOP_READOBJECTS, OpenInputDesktop},
        Threading::GetCurrentThreadId,
    },
    UI::{
        Input::KeyboardAndMouse::{
            GetAsyncKeyState, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
            SendInput,
        },
        WindowsAndMessaging::*,
    },
};

const OWN_INPUT: usize = 0x5955484b;
thread_local! {
    // Only the hook/message-pump thread touches this state. No mutable global or
    // lock is held across a system callback, pipe write or injected key release.
    static ENGINE: RefCell<Engine> = RefCell::new(Engine::default());
    static ALLOW_INJECTED: bool = std::env::var("TYPELESS_ALLOW_INJECTED").as_deref() == Ok("1");
}

fn desktop_available() -> bool {
    // SAFETY: no borrowed pointers; close the desktop on every successful open.
    unsafe {
        let desktop = OpenInputDesktop(0, 0, DESKTOP_READOBJECTS);
        if desktop.is_null() {
            return false;
        }
        CloseDesktop(desktop);
        true
    }
}

unsafe extern "system" fn keyboard(code: i32, message: usize, param: isize) -> isize {
    // SAFETY: Windows supplies a valid KBDLLHOOKSTRUCT for these hook messages;
    // negative codes must be forwarded without dereferencing lParam.
    unsafe {
        if code < 0
            || ![WM_KEYDOWN, WM_SYSKEYDOWN, WM_KEYUP, WM_SYSKEYUP].contains(&(message as u32))
        {
            return CallNextHookEx(null_mut(), code, message, param);
        }
        let key = &*(param as *const KBDLLHOOKSTRUCT);
        if key.dwExtraInfo == OWN_INPUT
            || (key.flags & LLKHF_INJECTED != 0 && !ALLOW_INJECTED.with(|v| *v))
        {
            return CallNextHookEx(null_mut(), code, message, param);
        }
        let down = message as u32 == WM_KEYDOWN || message as u32 == WM_SYSKEYDOWN;
        let vk = physical_vk(key.vkCode, key.scanCode, key.flags);
        let eaten =
            ENGINE.with(|engine| engine.borrow_mut().key(vk, down, now(), desktop_available));
        if eaten {
            1
        } else {
            CallNextHookEx(null_mut(), code, message, param)
        }
    }
}

fn release(vk: u32) {
    let input = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk as u16,
                wScan: 0,
                dwFlags: KEYEVENTF_KEYUP,
                time: 0,
                dwExtraInfo: OWN_INPUT,
            },
        },
    };
    // SAFETY: INPUT has the Windows ABI layout. The tag excludes reentrant input
    // from this helper, including when tests opt in to other injected events.
    unsafe {
        SendInput(1, &input, std::mem::size_of::<INPUT>() as i32);
    }
}

pub fn run() -> Result<(), String> {
    // SAFETY: the hook and its message queue remain on this thread until unhook.
    unsafe {
        let mut message = MSG::default();
        PeekMessageW(&mut message, null_mut(), 0, 0, PM_NOREMOVE); // create thread queue before reader starts
        let thread_id = GetCurrentThreadId();
        let (input_tx, input_rx) = mpsc::channel::<Result<Value, String>>();
        thread::spawn(move || {
            for line in io::stdin().lock().lines() {
                let command = line
                    .map_err(|e| e.to_string())
                    .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()));
                if input_tx.send(command).is_err() {
                    return;
                }
                if PostThreadMessageW(thread_id, WM_APP, 0, 0) == 0 {
                    return;
                }
            }
            // Inherited pipe closes on parent exit/crash; never leave an orphan hook.
            let _ = input_tx.send(Ok(json!({"type":"shutdown"})));
            PostThreadMessageW(thread_id, WM_APP, 0, 0);
        });
        let (output_tx, output_rx) = mpsc::channel::<Value>();
        thread::spawn(move || {
            let mut output = io::stdout().lock();
            for event in output_rx {
                if serde_json::to_writer(&mut output, &event).is_err()
                    || output.write_all(b"\n").is_err()
                    || output.flush().is_err()
                {
                    PostThreadMessageW(thread_id, WM_QUIT, 0, 0);
                    return;
                }
            }
        });
        let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard), GetModuleHandleW(null()), 0);
        if hook.is_null() {
            return Err(format!("SetWindowsHookExW: {}", io::Error::last_os_error()));
        }
        let _ = output_tx.send(json!({"type":"ready"}));
        let result = (|| {
            loop {
                while PeekMessageW(&mut message, null_mut(), 0, 0, PM_REMOVE) != 0 {
                    if message.message == WM_QUIT {
                        return Ok(());
                    }
                    TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
                for command in input_rx.try_iter() {
                    let command = command?;
                    if command["type"] == "shutdown" {
                        return Ok(());
                    }
                    ENGINE.with(|engine| engine.borrow_mut().command(&command, now()))?;
                }
                // GetAsyncKeyState must run AFTER the low-level callback returns:
                // the OS has not updated it inside LowLevelKeyboardProc.
                let keys = ENGINE.with(|engine| engine.borrow().pressed_keys());
                if !keys.is_empty() {
                    let held = keys
                        .into_iter()
                        .filter(|vk| GetAsyncKeyState(*vk as i32) as u16 & 0x8000 != 0)
                        .collect();
                    ENGINE.with(|engine| {
                        engine
                            .borrow_mut()
                            .reconcile(now(), &held, desktop_available)
                    });
                }
                let (events, releases, wait) = ENGINE.with(|engine| {
                    let mut engine = engine.borrow_mut();
                    (
                        std::mem::take(&mut engine.events),
                        std::mem::take(&mut engine.releases),
                        engine.wait_ms(),
                    )
                });
                for vk in releases {
                    release(vk);
                }
                for event in events {
                    if output_tx.send(event).is_err() {
                        return Err("output pipe closed".into());
                    }
                }
                if MsgWaitForMultipleObjectsEx(0, null(), wait, QS_ALLINPUT, MWMO_INPUTAVAILABLE)
                    == WAIT_FAILED
                {
                    return Err(format!("message wait: {}", io::Error::last_os_error()));
                }
            }
        })();
        UnhookWindowsHookEx(hook);
        result
    }
}
