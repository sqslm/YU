//! Live microphone capture feeding the SAPI recogniser.
//!
//! SAPI's own `SpMMAudioIn` object only accepts `WAVE_MAPPER` here and rejects an
//! explicit device with `SPERR_ALREADY_INITIALIZED`, so the helper opens the waveIn
//! device itself and hands the recogniser a blocking stream. This is the same
//! arrangement the PowerShell host uses. Nothing is written to disk.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use windows::Win32::Media::Audio::{
    CALLBACK_NULL, HWAVEIN, WAVE_FORMAT_PCM, WAVEFORMATEX, WAVEHDR, WAVEINCAPSW, waveInAddBuffer,
    waveInClose, waveInGetDevCapsW, waveInOpen, waveInPrepareHeader, waveInReset, waveInStart,
    waveInStop, waveInUnprepareHeader,
};

pub use windows::Win32::Media::Audio::WAVE_MAPPER;

pub const SAMPLE_RATE: u32 = 16_000;
pub const BYTES_PER_MS: f64 = 32.0;
const CHUNK: usize = 6_400;
const CHUNKS: usize = 4;
const QUEUE_LIMIT: usize = 160_000;

/// Captured bytes plus the level of the newest chunk.
pub struct Shared {
    queue: Mutex<VecDeque<u8>>,
    signal: Condvar,
    level: AtomicU32,
    closed: AtomicBool,
}

impl Shared {
    pub fn new_for_test() -> Self {
        Self::new()
    }

    fn new() -> Self {
        Self {
            queue: Mutex::new(VecDeque::new()),
            signal: Condvar::new(),
            level: AtomicU32::new(0),
            closed: AtomicBool::new(false),
        }
    }

    fn push(&self, chunk: &[u8]) {
        let mut queue = self.queue.lock().expect("capture queue");
        for byte in chunk {
            if queue.len() < QUEUE_LIMIT {
                queue.push_back(*byte);
            }
        }
        self.level.store(level_of(chunk), Ordering::Relaxed);
        drop(queue);
        self.signal.notify_all();
    }

    /// Level of the most recent chunk, 0-100.
    pub fn level(&self) -> Option<u32> {
        if self.closed.load(Ordering::Relaxed) {
            return None;
        }
        Some(self.level.load(Ordering::Relaxed))
    }

    /// Milliseconds of audio captured so far.
    pub fn is_finished(&self) -> bool {
        self.closed.load(Ordering::Relaxed)
            && self
                .queue
                .lock()
                .map(|queue| queue.is_empty())
                .unwrap_or(true)
    }

    pub fn position_ms(&self) -> f64 {
        let queue = self.queue.lock().expect("capture queue");
        queue.len() as f64 / BYTES_PER_MS
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
        self.signal.notify_all();
    }
}

/// Format the recogniser and the capture device agree on.
pub fn format() -> WAVEFORMATEX {
    WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_PCM as u16,
        nChannels: 1,
        nSamplesPerSec: SAMPLE_RATE,
        nAvgBytesPerSec: SAMPLE_RATE * 2,
        nBlockAlign: 2,
        wBitsPerSample: 16,
        cbSize: 0,
    }
}

/// Root mean square of the chunk scaled into the 0-100 range the host expects.
fn level_of(chunk: &[u8]) -> u32 {
    let samples = chunk.len() / 2;
    if samples == 0 {
        return 0;
    }
    let mut sum = 0f64;
    for index in 0..samples {
        let low = f64::from(chunk[index * 2]);
        let high = f64::from(chunk[index * 2 + 1] as i8) * 256.0;
        let sample = (high + low) / 32_768.0;
        sum += sample * sample;
    }
    let rms = (sum / samples as f64).sqrt();
    (rms * 400.0).round().min(100.0) as u32
}

/// Blocking read used by the stream handed to SAPI: it only returns once bytes are
/// available or capture is closed, so a quiet room never looks like end of stream.
pub fn read(shared: &Shared, destination: &mut [u8]) -> usize {
    let mut queue = shared.queue.lock().expect("capture queue");
    while queue.is_empty() && !shared.closed.load(Ordering::Relaxed) {
        queue = shared
            .signal
            .wait_timeout(queue, Duration::from_millis(200))
            .expect("capture wait")
            .0;
    }
    // SAPI treats a short read as end of stream, so fill the whole request.
    while queue.len() < destination.len() && !shared.closed.load(Ordering::Relaxed) {
        queue = shared
            .signal
            .wait_timeout(queue, Duration::from_millis(200))
            .expect("capture wait")
            .0;
    }
    let taken = destination.len().min(queue.len());
    for slot in destination.iter_mut().take(taken) {
        *slot = queue.pop_front().expect("queued byte");
    }
    taken
}

/// Owns the waveIn handle and its buffers until it is closed.
pub struct Capture {
    shared: Arc<Shared>,
    handle: usize,
    // Boxed headers: the reader thread keeps their addresses while waveIn owns them,
    // so they must not move when the vector is reallocated.
    #[allow(clippy::vec_box)]
    headers: Vec<Box<WAVEHDR>>,
    buffers: Vec<Box<[u8]>>,
    reader: Option<JoinHandle<()>>,
}

impl Capture {
    /// Opens `device`: a waveIn index, or `WAVE_MAPPER` for the default device.
    pub fn open(device: u32) -> Result<Self, u32> {
        let format = format();
        let mut handle = HWAVEIN::default();
        let opened = unsafe {
            waveInOpen(
                Some(&mut handle),
                device,
                &format,
                None,
                None,
                CALLBACK_NULL,
            )
        };
        if opened != 0 {
            return Err(opened);
        }
        let shared = Arc::new(Shared::new());
        let mut buffers: Vec<Box<[u8]>> = (0..CHUNKS)
            .map(|_| vec![0u8; CHUNK].into_boxed_slice())
            .collect();
        let mut headers: Vec<Box<WAVEHDR>> = buffers
            .iter_mut()
            .map(|buffer| {
                Box::new(WAVEHDR {
                    lpData: windows::core::PSTR(buffer.as_mut_ptr()),
                    dwBufferLength: CHUNK as u32,
                    ..Default::default()
                })
            })
            .collect();
        for header in headers.iter_mut() {
            unsafe {
                waveInPrepareHeader(handle, header.as_mut(), size_of::<WAVEHDR>() as u32);
                waveInAddBuffer(handle, header.as_mut(), size_of::<WAVEHDR>() as u32);
            }
        }
        // The boxes stay alive in `Capture`, so the reader thread can keep using
        // their addresses without borrowing the owner.
        let addresses: Vec<usize> = headers
            .iter_mut()
            .map(|header| header.as_mut() as *mut WAVEHDR as usize)
            .collect();
        let raw = handle.0 as usize;
        unsafe { waveInStart(handle) };
        let reader = {
            let shared = Arc::clone(&shared);
            std::thread::spawn(move || {
                let handle = HWAVEIN(raw as *mut _);
                while !shared.closed.load(Ordering::Relaxed) {
                    let mut handled = false;
                    for address in &addresses {
                        let header = unsafe { &mut *(*address as *mut WAVEHDR) };
                        if header.dwFlags & 0x1 == 0 {
                            continue;
                        }
                        let filled = header.dwBytesRecorded as usize;
                        if filled > 0 {
                            let data = unsafe {
                                std::slice::from_raw_parts(header.lpData.0 as *const u8, filled)
                            };
                            shared.push(data);
                        }
                        header.dwFlags = 0;
                        header.dwBytesRecorded = 0;
                        unsafe {
                            waveInAddBuffer(handle, header, size_of::<WAVEHDR>() as u32);
                        }
                        handled = true;
                    }
                    if !handled {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                }
            })
        };
        Ok(Self {
            shared,
            handle: raw,
            headers,
            buffers,
            reader: Some(reader),
        })
    }

    pub fn shared(&self) -> Arc<Shared> {
        Arc::clone(&self.shared)
    }

    /// Stops capture, waits for the reader, and releases every waveIn resource.
    pub fn close(mut self) {
        self.shared.close();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
        let handle = HWAVEIN(self.handle as *mut _);
        unsafe {
            waveInStop(handle);
            waveInReset(handle);
            for header in self.headers.iter_mut() {
                waveInUnprepareHeader(handle, header.as_mut(), size_of::<WAVEHDR>() as u32);
            }
            waveInClose(handle);
        }
        self.buffers.clear();
    }
}

/// Test harness: feeds a wave file through the same stream SAPI reads from a live
/// device, so the capture path is exercised without recording anyone.
pub fn feed(shared: &Arc<Shared>, path: &str) -> std::io::Result<()> {
    let bytes = std::fs::read(path)?;
    let audio = if bytes.len() > 44 && &bytes[..4] == b"RIFF" {
        bytes[44..].to_vec()
    } else {
        bytes
    };
    let shared = Arc::clone(shared);
    std::thread::spawn(move || {
        for chunk in audio.chunks(CHUNK) {
            if shared.closed.load(Ordering::Relaxed) {
                return;
            }
            shared.push(chunk);
            std::thread::sleep(Duration::from_millis(200));
        }
        shared.close();
    });
    Ok(())
}

/// Name of a waveIn device, or an empty string when the index is gone.
pub fn device_name(index: u32) -> String {
    let mut caps = WAVEINCAPSW::default();
    let result =
        unsafe { waveInGetDevCapsW(index as usize, &mut caps, size_of::<WAVEINCAPSW>() as u32) };
    if result != 0 {
        return String::new();
    }
    let name: [u16; 32] = unsafe { std::ptr::read_unaligned(std::ptr::addr_of!(caps.szPname)) };
    let end = name
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(name.len());
    String::from_utf16_lossy(&name[..end])
}

/// `WAVE_MAPPER` for the default device, otherwise the given index.
pub fn map_device(index: i32) -> u32 {
    if index < 0 || index as u32 == WAVE_MAPPER {
        WAVE_MAPPER
    } else {
        index as u32
    }
}
