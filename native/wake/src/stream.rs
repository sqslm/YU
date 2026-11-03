//! Stream handed to SAPI so it reads the microphone buffers we capture ourselves.

use std::sync::Arc;

use windows::Win32::Foundation::{E_NOTIMPL, E_OUTOFMEMORY, E_POINTER, S_FALSE, S_OK};
use windows::Win32::Media::Audio::WAVEFORMATEX;
use windows::Win32::Media::Speech::{ISpStreamFormat, ISpStreamFormat_Impl};
use windows::Win32::System::Com::{
    CoTaskMemAlloc, ISequentialStream_Impl, IStream, IStream_Impl, LOCKTYPE, STATFLAG, STATSTG,
    STGC, STGTY_STREAM, STREAM_SEEK,
};

use windows::core::{Error, GUID, HRESULT, Result, implement};

use crate::capture::{self, Shared};

/// `SPDFID_WaveFormatEx` from the speech SDK: the format id SAPI uses for raw wave
/// data in an `ISpStreamFormat` (System.Speech SAPIGuids.SPDFID_WaveFormatEx).
pub const SPDFID_WAVE_FORMAT: GUID = GUID::from_u128(0xc31adbae_527f_4ff5_a230_f62bb61ff70c);

#[implement(IStream, ISpStreamFormat)]
pub struct CaptureStream {
    shared: Arc<Shared>,
}

impl CaptureStream {
    pub fn new(shared: Arc<Shared>) -> Self {
        Self { shared }
    }
}

impl ISequentialStream_Impl for CaptureStream_Impl {
    fn Read(&self, pv: *mut core::ffi::c_void, cb: u32, pcbread: *mut u32) -> HRESULT {
        if pv.is_null() {
            return E_POINTER;
        }
        let buffer = unsafe { std::slice::from_raw_parts_mut(pv as *mut u8, cb as usize) };
        let taken = capture::read(&self.shared, buffer);
        if !pcbread.is_null() {
            unsafe { *pcbread = taken as u32 };
        }
        if taken == 0 {
            return S_FALSE;
        }
        S_OK
    }

    fn Write(&self, _pv: *const core::ffi::c_void, _cb: u32, _pcbwritten: *mut u32) -> HRESULT {
        E_NOTIMPL
    }
}

impl IStream_Impl for CaptureStream_Impl {
    fn Seek(&self, _move: i64, _origin: STREAM_SEEK, position: *mut u64) -> Result<()> {
        if !position.is_null() {
            unsafe { *position = 0 };
        }
        Ok(())
    }

    fn SetSize(&self, _size: u64) -> Result<()> {
        Ok(())
    }

    fn CopyTo(
        &self,
        _stream: windows::core::Ref<'_, IStream>,
        _cb: u64,
        _read: *mut u64,
        _written: *mut u64,
    ) -> Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn Commit(&self, _flags: &STGC) -> Result<()> {
        Ok(())
    }

    fn Revert(&self) -> Result<()> {
        Ok(())
    }

    fn LockRegion(&self, _offset: u64, _cb: u64, _kind: &LOCKTYPE) -> Result<()> {
        Ok(())
    }

    fn UnlockRegion(&self, _offset: u64, _cb: u64, _kind: u32) -> Result<()> {
        Ok(())
    }

    fn Stat(&self, stat: *mut STATSTG, _flags: &STATFLAG) -> Result<()> {
        // SAPI asks for the size while wiring the input up; a live stream has no
        // length, so report the same placeholder the PowerShell host uses.
        if !stat.is_null() {
            unsafe {
                let stat = &mut *stat;
                stat.r#type = STGTY_STREAM.0 as u32;
                stat.cbSize = 32_000;
            }
        }
        Ok(())
    }

    fn Clone(&self) -> Result<IStream> {
        Err(E_NOTIMPL.into())
    }
}

impl ISpStreamFormat_Impl for CaptureStream_Impl {
    fn GetFormat(&self, guid: *const GUID) -> Result<*mut WAVEFORMATEX> {
        if !guid.is_null() {
            unsafe { std::ptr::write(guid as *mut GUID, SPDFID_WAVE_FORMAT) };
        }
        let memory = unsafe { CoTaskMemAlloc(size_of::<WAVEFORMATEX>()) } as *mut WAVEFORMATEX;
        if memory.is_null() {
            return Err(Error::from(E_OUTOFMEMORY));
        }
        unsafe { std::ptr::write(memory, capture::format()) };
        Ok(memory)
    }
}
