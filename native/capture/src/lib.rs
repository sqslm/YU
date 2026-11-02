//! Screen capture that writes Windows BGRA rows into a caller-owned buffer.
//!
//! The DLL has no state: every call allocates its own GDI objects, copies the
//! requested screen rectangle and releases them before returning. The caller
//! (Koffi in the Electron main process) owns `output` and must pass exactly
//! `width * height * 4` bytes; the pointer is never stored or read after the
//! synchronous call ends.

use std::ffi::c_void;
use std::mem::size_of;

use windows::Win32::Graphics::Gdi::{
    BITMAPINFO, BITMAPINFOHEADER, BitBlt, CAPTUREBLT, CreateCompatibleBitmap, CreateCompatibleDC,
    DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, GetDIBits, HBITMAP, HDC, HGDIOBJ, ReleaseDC,
    SRCCOPY, SelectObject,
};

/// Same ceiling as the TypeScript capture path.
const MAX_PIXELS: usize = 40_000_000;
/// `SRCCOPY | CAPTUREBLT`: layered windows such as the GDI-drawn overlay are
/// included, exactly like the previous TypeScript implementation.
const ROP: u32 = SRCCOPY.0 | CAPTUREBLT.0;

const OK: i32 = 0;
const INVALID_ARGUMENT: i32 = 1;
const GET_DC_FAILED: i32 = 2;
const COMPATIBLE_DC_FAILED: i32 = 3;
const COMPATIBLE_BITMAP_FAILED: i32 = 4;
const SELECT_OBJECT_FAILED: i32 = 5;
const BITBLT_FAILED: i32 = 6;
const GET_DIBITS_FAILED: i32 = 7;

struct ScreenDc(HDC);

impl ScreenDc {
    fn acquire() -> Result<Self, i32> {
        let dc = unsafe { GetDC(None) };
        if dc.is_invalid() {
            return Err(GET_DC_FAILED);
        }
        Ok(Self(dc))
    }
}

impl Drop for ScreenDc {
    fn drop(&mut self) {
        let _ = unsafe { ReleaseDC(None, self.0) };
    }
}

struct MemoryDc(HDC);

impl MemoryDc {
    fn new(source: HDC) -> Result<Self, i32> {
        let dc = unsafe { CreateCompatibleDC(Some(source)) };
        if dc.is_invalid() {
            return Err(COMPATIBLE_DC_FAILED);
        }
        Ok(Self(dc))
    }
}

impl Drop for MemoryDc {
    fn drop(&mut self) {
        let _ = unsafe { DeleteDC(self.0) };
    }
}

struct Bitmap(HBITMAP);

impl Bitmap {
    fn new(reference: HDC, width: i32, height: i32) -> Result<Self, i32> {
        let bitmap = unsafe { CreateCompatibleBitmap(reference, width, height) };
        if bitmap.is_invalid() {
            return Err(COMPATIBLE_BITMAP_FAILED);
        }
        Ok(Self(bitmap))
    }
}

impl Drop for Bitmap {
    fn drop(&mut self) {
        // A bitmap still selected into a DC must not be deleted, so the
        // `Selection` guard is always dropped first.
        let _ = unsafe { DeleteObject(HGDIOBJ(self.0.0)) };
    }
}

/// Selects the bitmap and puts the previous object back on drop, which is what
/// lets `GetDIBits` read a bitmap that no DC references.
struct Selection {
    dc: HDC,
    previous: HGDIOBJ,
}

impl Selection {
    fn select(dc: HDC, bitmap: HBITMAP) -> Result<Self, i32> {
        let previous = unsafe { SelectObject(dc, HGDIOBJ(bitmap.0)) };
        if previous.is_invalid() {
            return Err(SELECT_OBJECT_FAILED);
        }
        Ok(Self { dc, previous })
    }
}

impl Drop for Selection {
    fn drop(&mut self) {
        let _ = unsafe { SelectObject(self.dc, self.previous) };
    }
}

/// Checks the ABI surface before any GDI call or pointer write.
fn buffer_len(width: i32, height: i32, output: *const u8, output_len: usize) -> Result<usize, i32> {
    if width < 1 || height < 1 || output.is_null() {
        return Err(INVALID_ARGUMENT);
    }
    let pixels = (width as usize)
        .checked_mul(height as usize)
        .ok_or(INVALID_ARGUMENT)?;
    if pixels > MAX_PIXELS {
        return Err(INVALID_ARGUMENT);
    }
    let bytes = pixels.checked_mul(4).ok_or(INVALID_ARGUMENT)?;
    if output_len != bytes {
        return Err(INVALID_ARGUMENT);
    }
    Ok(bytes)
}

fn capture(
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    output: *mut u8,
    output_len: usize,
) -> Result<(), i32> {
    let bytes = buffer_len(width, height, output, output_len)?;
    let screen = ScreenDc::acquire()?;
    let memory = MemoryDc::new(screen.0)?;
    let bitmap = Bitmap::new(screen.0, width, height)?;
    {
        let _selection = Selection::select(memory.0, bitmap.0)?;
        unsafe {
            BitBlt(
                memory.0,
                0,
                0,
                width,
                height,
                Some(screen.0),
                x,
                y,
                windows::Win32::Graphics::Gdi::ROP_CODE(ROP),
            )
        }
        .map_err(|_| BITBLT_FAILED)?;
    }
    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            // Negative height keeps rows top-down, matching Windows bitmaps and
            // the buffer consumers (NativeImage, ScrollCapture) expect.
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: 0, // BI_RGB
            ..Default::default()
        },
        ..Default::default()
    };
    let rows = unsafe {
        GetDIBits(
            screen.0,
            bitmap.0,
            0,
            height as u32,
            Some(output as *mut c_void),
            &mut info,
            DIB_RGB_COLORS,
        )
    };
    if rows != height {
        return Err(GET_DIBITS_FAILED);
    }
    // BI_RGB leaves alpha undefined; consumers treat the frame as opaque.
    unsafe {
        for index in (3..bytes).step_by(4) {
            *output.add(index) = 255;
        }
    }
    Ok(())
}

/// Captures the physical-pixel rectangle `(x, y, width, height)` as top-down
/// BGRA. Returns 0 on success or a stage code (1 argument, 2..7 GDI stage);
/// nothing is written to `output` before the arguments are validated.
///
/// # Safety
///
/// `output` must point to `output_len` writable bytes for the duration of the
/// call. Rust returns immediately and keeps no reference to it.
#[unsafe(no_mangle)]
pub unsafe extern "system" fn yu_capture_bgra(
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    output: *mut u8,
    output_len: usize,
) -> i32 {
    match capture(x, y, width, height, output, output_len) {
        Ok(()) => OK,
        Err(code) => code,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_dimensions_and_buffers_before_touching_memory() {
        let mut buffer = [7u8; 16];
        assert_eq!(
            unsafe { yu_capture_bgra(0, 0, 0, 2, buffer.as_mut_ptr(), 16) },
            INVALID_ARGUMENT
        );
        assert_eq!(
            unsafe { yu_capture_bgra(0, 0, 2, -1, buffer.as_mut_ptr(), 16) },
            INVALID_ARGUMENT
        );
        assert_eq!(
            unsafe { yu_capture_bgra(0, 0, 2, 2, std::ptr::null_mut(), 16) },
            INVALID_ARGUMENT
        );
        assert_eq!(
            unsafe { yu_capture_bgra(0, 0, 2, 2, buffer.as_mut_ptr(), 15) },
            INVALID_ARGUMENT
        );
        // 10_000 * 4_001 = 40_010_000 pixels, one row over the shared ceiling.
        assert_eq!(
            unsafe { yu_capture_bgra(0, 0, 10_000, 4_001, buffer.as_mut_ptr(), 16) },
            INVALID_ARGUMENT
        );
        assert_eq!(buffer, [7u8; 16]);
    }

    #[test]
    fn accepts_the_pixel_ceiling_and_odd_sizes() {
        assert_eq!(buffer_len(1, 1, std::ptr::dangling::<u8>(), 4), Ok(4));
        assert_eq!(
            buffer_len(321, 181, std::ptr::dangling::<u8>(), 321 * 181 * 4),
            Ok(321 * 181 * 4)
        );
        assert_eq!(
            buffer_len(
                10_000,
                4_000,
                std::ptr::dangling::<u8>(),
                10_000 * 4_000 * 4
            ),
            Ok(160_000_000)
        );
        assert_eq!(
            buffer_len(1, 1, std::ptr::dangling::<u8>(), 3),
            Err(INVALID_ARGUMENT)
        );
        // Negative origins are legal physical coordinates.
        assert_eq!(buffer_len(3, 3, std::ptr::dangling::<u8>(), 36), Ok(36));
    }
}
