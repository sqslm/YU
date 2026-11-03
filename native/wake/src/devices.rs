// Capture devices are enumerated with the same waveIn API the PowerShell host uses, so
// the identifiers stay waveIn indices and the UI keeps showing the same names.

use windows::Win32::Media::Audio::{WAVEINCAPSW, waveInGetDevCapsW, waveInGetNumDevs};

fn wide(bytes: &[u16]) -> String {
    let end = bytes
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(bytes.len());
    String::from_utf16_lossy(&bytes[..end])
}

pub fn list() -> Vec<(String, String)> {
    let count = unsafe { waveInGetNumDevs() };
    let mut devices = Vec::new();
    for index in 0..count {
        let mut caps = WAVEINCAPSW::default();
        let status = unsafe {
            waveInGetDevCapsW(
                index as usize,
                &mut caps,
                std::mem::size_of::<WAVEINCAPSW>() as u32,
            )
        };
        if status != 0 {
            continue;
        }
        // The capabilities structure is packed, so the name is copied out of it instead
        // of borrowing the field.
        let mut units = [0u16; 32];
        unsafe {
            std::ptr::copy_nonoverlapping(
                std::ptr::addr_of!(caps.szPname).cast::<u16>(),
                units.as_mut_ptr(),
                units.len(),
            );
        }
        let name = wide(&units);
        if name.is_empty() {
            continue;
        }
        devices.push((index.to_string(), name));
    }
    devices
}
