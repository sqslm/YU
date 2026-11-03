//! Live microphone capture feeding the SAPI recogniser.
//!
//! `SpMMAudioIn::SetDeviceId` rejects every real waveIn index on this machine
//! (`0x80045002`), so the helper opens the device itself and hands the recogniser a
//! blocking stream. Nothing is written to disk.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use windows::Win32::Media::Audio::{
    CALLBACK_NULL, HWAVEIN, WAVE_FORMAT_PCM, WAVEFORMATEX, WAVEHDR, WAVEINCAPSW, waveInAddBuffer,
    waveInClose, waveInGetDevCapsW, waveInMessage, waveInOpen, waveInPrepareHeader, waveInReset,
    waveInStart, waveInStop, waveInUnprepareHeader,
};

pub use windows::Win32::Media::Audio::WAVE_MAPPER;

pub const SAMPLE_RATE: u32 = 16_000;
pub const BYTES_PER_MS: f64 = 32.0;
const CHUNK: usize = 6_400;
const CHUNKS: usize = 4;
const QUEUE_LIMIT: usize = 160_000;
const FRAME: usize = 2;

/// Captured bytes plus the level of the newest chunk.
pub struct Shared {
    queue: Mutex<VecDeque<u8>>,
    signal: Condvar,
    level: AtomicU32,
    closed: AtomicBool,
    /// Bytes handed to the consumer, so the position keeps growing instead of
    /// shrinking with the backlog.
    delivered: AtomicU64,
    /// Bytes dropped because the consumer fell behind; whole frames only.
    dropped: AtomicU64,
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
            delivered: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
        }
    }

    fn push(&self, chunk: &[u8]) {
        let mut queue = self.queue.lock().expect("capture queue");
        let mut dropped = 0usize;
        while queue.len() + chunk.len() > QUEUE_LIMIT && queue.len() >= FRAME {
            queue.drain(..FRAME);
            dropped += FRAME;
        }
        queue.extend(chunk.iter().copied());
        if dropped > 0 {
            self.dropped.fetch_add(dropped as u64, Ordering::Relaxed);
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

    pub fn is_finished(&self) -> bool {
        self.closed.load(Ordering::Relaxed)
            && self
                .queue
                .lock()
                .map(|queue| queue.is_empty())
                .unwrap_or(true)
    }

    /// Audio position in milliseconds: bytes already handed to the recogniser.
    pub fn position_ms(&self) -> f64 {
        self.delivered.load(Ordering::Relaxed) as f64 / BYTES_PER_MS
    }

    /// Whole frames discarded on overflow; a jump here is a gap in the timeline.
    pub fn dropped_bytes(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
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

/// Read used by the stream handed to SAPI.
///
/// It drains whatever is queued, waits for more only while the request is not yet
/// filled, returns immediately for an empty request, and reports end of stream by a
/// short read once capture is closed. A request larger than the queue limit therefore
/// completes instead of deadlocking.
pub fn read(shared: &Shared, destination: &mut [u8]) -> usize {
    if destination.is_empty() {
        return 0;
    }
    let mut filled = 0usize;
    let mut queue = shared.queue.lock().expect("capture queue");
    while filled < destination.len() {
        while filled < destination.len() {
            let Some(byte) = queue.pop_front() else {
                break;
            };
            destination[filled] = byte;
            filled += 1;
        }
        if filled == destination.len() || shared.closed.load(Ordering::Relaxed) {
            break;
        }
        let (next, _) = shared
            .signal
            .wait_timeout(queue, Duration::from_millis(50))
            .expect("capture wait");
        queue = next;
    }
    drop(queue);
    shared.delivered.fetch_add(filled as u64, Ordering::Relaxed);
    filled
}

/// Owns the waveIn handle and its buffers until it is closed or dropped.
pub struct Capture {
    shared: Arc<Shared>,
    handle: HWAVEIN,
    // Boxed headers: the reader thread keeps their addresses while waveIn owns them,
    // so they must not move when the vector is reallocated.
    #[allow(clippy::vec_box)]
    headers: Vec<Box<WAVEHDR>>,
    buffers: Vec<Box<[u8]>>,
    reader: Option<JoinHandle<()>>,
    prepared: usize,
    started: bool,
    released: bool,
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
        let headers: Vec<Box<WAVEHDR>> = buffers
            .iter_mut()
            .map(|buffer| {
                Box::new(WAVEHDR {
                    lpData: windows::core::PSTR(buffer.as_mut_ptr()),
                    dwBufferLength: CHUNK as u32,
                    ..Default::default()
                })
            })
            .collect();
        let mut capture = Self {
            shared,
            handle,
            headers,
            buffers,
            reader: None,
            prepared: 0,
            started: false,
            released: false,
        };
        // Prepare and queue one buffer at a time so a failure can unwind exactly what
        // was handed to the driver.
        let count = capture.headers.len();
        for index in 0..count {
            let prepared = {
                let header = capture.headers[index].as_mut();
                unsafe { waveInPrepareHeader(capture.handle, header, size_of::<WAVEHDR>() as u32) }
            };
            if prepared != 0 {
                return Err(capture.abandon(prepared));
            }
            capture.prepared = index + 1;
            let queued = {
                let header = capture.headers[index].as_mut();
                unsafe { waveInAddBuffer(capture.handle, header, size_of::<WAVEHDR>() as u32) }
            };
            if queued != 0 {
                return Err(capture.abandon(queued));
            }
        }
        let addresses: Vec<usize> = capture
            .headers
            .iter_mut()
            .map(|header| header.as_mut() as *mut WAVEHDR as usize)
            .collect();
        let raw = capture.handle.0 as usize;
        let started = unsafe { waveInStart(capture.handle) };
        if started != 0 {
            return Err(capture.abandon(started));
        }
        capture.started = true;
        let shared = Arc::clone(&capture.shared);
        capture.reader = Some(std::thread::spawn(move || {
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
        }));
        Ok(capture)
    }

    /// Releases a partially built capture and returns the waveIn error code.
    fn abandon(mut self, code: u32) -> u32 {
        self.stop();
        code
    }

    pub fn shared(&self) -> Arc<Shared> {
        Arc::clone(&self.shared)
    }

    /// Stops capture, waits for the reader, and releases every waveIn resource.
    /// Safe to call twice: the drop below runs the same path.
    pub fn close(mut self) {
        self.stop();
    }

    fn stop(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        self.shared.close();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
        if self.handle.0.is_null() {
            return;
        }
        unsafe {
            if self.started {
                waveInStop(self.handle);
            }
            waveInReset(self.handle);
            // Only buffers the driver has handed back may be unprepared; after Reset
            // every queued header is done.
            for header in self.headers.iter_mut().take(self.prepared) {
                waveInUnprepareHeader(self.handle, header.as_mut(), size_of::<WAVEHDR>() as u32);
            }
            waveInClose(self.handle);
        }
        self.headers.clear();
        self.buffers.clear();
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop();
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

/// `DRVM_MAPPER_PREFERRED_GET` from mmsystem.h.
const DRVM_MAPPER_PREFERRED_GET: u32 = 0x2015;

/// Resolves `WAVE_MAPPER` to the device Windows currently prefers, so the host can
/// report the input it actually listens to.
pub fn preferred_device(device: u32) -> u32 {
    if device != WAVE_MAPPER {
        return device;
    }
    let mut preferred: u32 = 0;
    let mut instance: u32 = 0;
    let result = unsafe {
        waveInMessage(
            Some(HWAVEIN(WAVE_MAPPER as *mut _)),
            DRVM_MAPPER_PREFERRED_GET,
            Some(std::ptr::addr_of_mut!(preferred) as usize),
            Some(std::ptr::addr_of_mut!(instance) as usize),
        )
    };
    if result == 0 { preferred } else { device }
}

/// `WAVE_MAPPER` for the default device, otherwise the given index.
pub fn map_device(index: i32) -> u32 {
    if index < 0 || index as u32 == WAVE_MAPPER {
        WAVE_MAPPER
    } else {
        index as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shared_with(bytes: &[u8]) -> Arc<Shared> {
        let shared = Arc::new(Shared::new());
        shared.push(bytes);
        shared
    }

    #[test]
    fn zero_length_read_returns_immediately() {
        let shared = Arc::new(Shared::new());
        let mut empty = [0u8; 0];
        assert_eq!(read(&shared, &mut empty), 0);
        assert_eq!(shared.position_ms(), 0.0);
    }

    #[test]
    fn read_larger_than_the_queue_limit_completes() {
        let shared = Arc::new(Shared::new());
        // 200 000 bytes is above QUEUE_LIMIT: queueing a second chunk drops whole
        // frames, but a single request still has to be satisfied as data arrives.
        let chunk = vec![7u8; 150_000];
        shared.push(&chunk);
        let mut destination = vec![0u8; 300_000];
        let handle = {
            let shared = Arc::clone(&shared);
            std::thread::spawn(move || read(&shared, &mut destination))
        };
        for _ in 0..40 {
            if shared.dropped_bytes() > 0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
            shared.push(&vec![7u8; 20_000]);
        }
        shared.close();
        let taken = handle.join().expect("read thread");
        assert!(taken > 150_000, "read only produced {taken} bytes");
    }

    #[test]
    fn position_survives_a_closed_and_drained_queue() {
        let shared = shared_with(&vec![1u8; 32_000]);
        let mut destination = vec![0u8; 32_000];
        assert_eq!(read(&shared, &mut destination), 32_000);
        assert!((shared.position_ms() - 1000.0).abs() < 0.001);
        shared.close();
        let mut more = vec![0u8; 64];
        assert_eq!(read(&shared, &mut more), 0);
        assert!((shared.position_ms() - 1000.0).abs() < 0.001);
    }

    #[test]
    fn overflow_drops_whole_frames() {
        let shared = Arc::new(Shared::new());
        shared.push(&vec![3u8; QUEUE_LIMIT]);
        shared.push(&vec![4u8; 4_000]);
        assert_eq!(shared.dropped_bytes() % FRAME as u64, 0);
        assert!(shared.dropped_bytes() > 0);
    }
}
