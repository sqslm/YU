//! Shared helpers: ids, timestamps, digests, cancellation and length checks.

use std::cell::RefCell;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

use crate::protocol::{ApiError, ApiResult, Code};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// Cancellation flag shared between the frame reader and a request thread.
#[derive(Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> CancelToken {
        CancelToken(Arc::new(AtomicBool::new(false)))
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

thread_local! {
    /// The token of the request running on this thread; `None` outside one.
    static CURRENT_CANCEL: RefCell<Option<CancelToken>> = const { RefCell::new(None) };
}

pub fn enter_cancel(token: CancelToken) {
    CURRENT_CANCEL.with(|slot| *slot.borrow_mut() = Some(token));
}

/// Called immediately before a transaction commits: a request cancelled while
/// it was working must not land its write.
pub fn ensure_not_cancelled() -> ApiResult<()> {
    let cancelled = CURRENT_CANCEL.with(|slot| {
        slot.borrow()
            .as_ref()
            .is_some_and(CancelToken::is_cancelled)
    });
    if cancelled {
        return Err(ApiError::new(Code::Cancelled, "the request was cancelled"));
    }
    Ok(())
}

pub fn now_ms() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(elapsed) => i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX),
        Err(_) => 0,
    }
}

/// Stable, sortable-enough identifier: `prefix` + 16 hex characters of a
/// SHA-256 over process, clock and a counter. No external RNG dependency.
pub fn new_id(prefix: &str) -> String {
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let seed = format!("{}:{}:{}:{}", std::process::id(), nanos, seq, prefix);
    let digest = Sha256::digest(seed.as_bytes());
    let hex = to_hex(&digest);
    format!("{prefix}_{}", &hex[..16])
}

pub fn sha256_hex(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    hex_encode(&digest)
}

fn to_hex(bytes: &[u8]) -> String {
    hex_encode(bytes)
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from_digit(u32::from(byte >> 4), 16).unwrap_or('0'));
        out.push(char::from_digit(u32::from(byte & 0x0f), 16).unwrap_or('0'));
    }
    out
}

pub fn check_chars(field: &str, value: &str, max: usize) -> ApiResult<()> {
    let count = value.chars().count();
    if count > max {
        return Err(ApiError::new(
            Code::TooLarge,
            format!("{field} exceeds {max} characters ({count})"),
        ));
    }
    Ok(())
}

pub fn require_text(field: &str, value: &str) -> ApiResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(ApiError::new(
            Code::InvalidParams,
            format!("{field} must not be empty"),
        ));
    }
    Ok(trimmed.to_string())
}

pub fn optional_text(field: &str, value: Option<String>, max: usize) -> ApiResult<Option<String>> {
    match value {
        None => Ok(None),
        Some(text) => {
            check_chars(field, &text, max)?;
            Ok(Some(text))
        }
    }
}

pub fn page(offset: Option<u32>, limit: Option<u32>) -> (u32, u32) {
    let limit = limit
        .unwrap_or(crate::protocol::DEFAULT_PAGE)
        .clamp(1, crate::protocol::MAX_PAGE);
    (offset.unwrap_or(0), limit)
}
