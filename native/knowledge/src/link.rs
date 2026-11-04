//! Model callbacks.
//!
//! The helper never talks to a provider. A request that needs a model sends a
//! `model.request` frame on its own outbound stream and waits for the host to
//! answer with `model.result`; the host owns credentials, provider selection and
//! everything else about the call. Nothing in phase 1 issues such a request —
//! the bridge exists so the transport, cancellation and timeouts are real and
//! tested before a stage needs them.

use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::protocol::{self, ApiError, ApiResult, Code, ModelReply};
use crate::util::ensure_not_cancelled;

/// Longest wait for one model answer.
pub const DEFAULT_CALLBACK_TIMEOUT: Duration = Duration::from_millis(protocol::MODEL_TIMEOUT_MS);

pub struct ModelRequest<'a> {
    pub parent_id: &'a str,
    pub profile_id: &'a str,
    pub effort: &'a str,
    pub messages: &'a Value,
    pub max_tokens: Option<u32>,
}

type Waiter = mpsc::Sender<ApiResult<String>>;

pub struct Link {
    out: Mutex<Box<dyn Write + Send>>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<String, Waiter>>,
}

impl Link {
    pub fn new(out: Box<dyn Write + Send>) -> Arc<Link> {
        Arc::new(Link {
            out: Mutex::new(out),
            next_id: AtomicU64::new(0),
            pending: Mutex::new(HashMap::new()),
        })
    }

    /// Writes one frame. The mutex makes a frame atomic against every other
    /// writer, so concurrent requests never interleave inside a line.
    pub fn write(&self, frame: &Value) -> ApiResult<()> {
        self.write_line(&protocol::frame_line(frame).map_err(|error| {
            ApiError::new(Code::Internal, format!("cannot encode a frame: {error}"))
        })?)
    }

    /// Writes one already-encoded frame, so a caller can measure the exact bytes
    /// it is about to send.
    pub fn write_line(&self, line: &str) -> ApiResult<()> {
        let mut out = self
            .out
            .lock()
            .map_err(|_| ApiError::new(Code::Internal, "the stdout writer was poisoned"))?;
        out.write_all(line.as_bytes())
            .and_then(|()| out.write_all(b"\n"))
            .and_then(|()| out.flush())
            .map_err(|error| {
                ApiError::new(Code::Internal, format!("cannot write to stdout: {error}"))
            })
    }

    fn take(&self, id: &str) -> Option<Waiter> {
        self.pending.lock().ok().and_then(|mut map| map.remove(id))
    }

    /// Sends `model.request` and blocks until the host answers, the deadline
    /// passes, or the request is cancelled.
    pub fn request_model(&self, request: ModelRequest<'_>) -> ApiResult<String> {
        let id = format!("m{}", self.next_id.fetch_add(1, Ordering::SeqCst) + 1);
        let (sender, receiver) = mpsc::channel();
        self.pending
            .lock()
            .map_err(|_| ApiError::new(Code::Internal, "the pending table was poisoned"))?
            .insert(id.clone(), sender);
        let frame = protocol::model_request_frame(
            &id,
            request.parent_id,
            request.profile_id,
            request.effort,
            request.messages,
            request.max_tokens,
        );
        if let Err(error) = self.write(&frame) {
            self.take(&id);
            return Err(error);
        }
        let deadline = Instant::now() + DEFAULT_CALLBACK_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                self.take(&id);
                return Err(ApiError::new(Code::Timeout, "the model callback timed out"));
            }
            match receiver.recv_timeout(remaining.min(Duration::from_millis(100))) {
                Ok(answer) => return answer,
                Err(RecvTimeoutError::Timeout) => {
                    if let Err(error) = ensure_not_cancelled() {
                        self.take(&id);
                        return Err(error);
                    }
                }
                Err(RecvTimeoutError::Disconnected) => {
                    self.take(&id);
                    return Err(ApiError::new(
                        Code::ModelUnavailable,
                        "the model bridge closed",
                    ));
                }
            }
        }
    }

    /// Settles one waiting caller. A result for an unknown or already timed-out
    /// id is dropped, so a late frame never settles a newer request.
    pub fn resolve(&self, reply: ModelReply) {
        let Some(waiter) = self.take(&reply.id) else {
            return;
        };
        let answer = if reply.ok {
            Ok(reply.text)
        } else {
            Err(reply
                .error
                .unwrap_or_else(|| ApiError::new(Code::ModelUnavailable, "the model call failed")))
        };
        let _ = waiter.send(answer);
    }

    /// Releases every waiting caller when the helper is going away.
    pub fn fail_all(&self, error: ApiError) {
        let Ok(mut map) = self.pending.lock() else {
            return;
        };
        for (_, waiter) in map.drain() {
            let _ = waiter.send(Err(error.clone()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone)]
    struct Sink(Arc<Mutex<Vec<u8>>>);

    impl Write for Sink {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(data);
            Ok(data.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn link() -> (Arc<Link>, Sink) {
        let sink = Sink(Arc::new(Mutex::new(Vec::new())));
        (Link::new(Box::new(sink.clone())), sink)
    }

    #[test]
    fn model_request_writes_a_frame_the_host_can_answer() {
        let (link, sink) = link();
        let messages = serde_json::json!([{ "role": "user", "content": "hello" }]);
        let worker = {
            let link = link.clone();
            std::thread::spawn(move || {
                link.request_model(ModelRequest {
                    parent_id: "r1",
                    profile_id: "p1",
                    effort: "high",
                    messages: &messages,
                    max_tokens: Some(64),
                })
            })
        };
        // The worker writes m1 and waits; answer it from this thread.
        for _ in 0..200 {
            if !sink.0.lock().unwrap().is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let written = String::from_utf8(sink.0.lock().unwrap().clone()).unwrap();
        let line: Value = serde_json::from_str(written.trim()).unwrap();
        assert_eq!(line["type"], "model.request");
        assert_eq!(line["parentId"], "r1");
        assert_eq!(line["effort"], "high");
        assert_eq!(line["maxTokens"], 64);
        let id = line["id"].as_str().unwrap().to_string();
        link.resolve(ModelReply {
            id,
            ok: true,
            text: "答".into(),
            error: None,
        });
        assert_eq!(worker.join().unwrap().unwrap(), "答");
    }

    #[test]
    fn a_late_or_unknown_result_settles_nothing() {
        let (link, _sink) = link();
        link.resolve(ModelReply {
            id: "m99".into(),
            ok: true,
            text: "gone".into(),
            error: None,
        });
        assert!(link.pending.lock().unwrap().is_empty());
    }

    #[test]
    fn shutdown_releases_waiters() {
        let (link, _sink) = link();
        let (sender, receiver) = mpsc::channel();
        link.pending.lock().unwrap().insert("m1".into(), sender);
        link.fail_all(ApiError::new(Code::ModelUnavailable, "helper stopping"));
        let answer = receiver.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(answer.is_err());
    }
}
