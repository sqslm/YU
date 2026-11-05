//! `yu-knowledge` — the knowledge and profile helper.
//!
//! One process per application run, started on demand by the main process, over
//! inherited stdin/stdout. This module owns the frame loop: it reads requests,
//! runs each one on its own thread, and writes results back through a single
//! shared writer so frames never interleave.

pub mod cards;
pub mod extract;
pub mod history;
pub mod link;
pub mod profile;
pub mod profile_learning;
pub mod protocol;
pub mod queue;
pub mod relations;
pub mod service;
pub mod sources;
pub mod store;
pub mod suggestions;
pub mod util;

use std::collections::HashMap;
use std::io::{self, BufReader};
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::link::Link;
use crate::protocol::{ApiError, Code, Frame, Incoming};
use crate::service::Service;
use crate::util::{CancelToken, now_ms};

/// Exit after this long without a request, a model callback or a shutdown.
pub const DEFAULT_IDLE_MS: u64 = 120_000;

pub fn idle_timeout() -> Duration {
    let millis = std::env::var("YU_KNOWLEDGE_IDLE_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(DEFAULT_IDLE_MS);
    Duration::from_millis(millis.max(100))
}

/// `--root <dir>` is bound once at startup; nothing on the wire can move it.
pub fn root_from_args<I: IntoIterator<Item = String>>(args: I) -> Result<PathBuf, String> {
    let mut root: Option<PathBuf> = None;
    let mut last = String::new();
    for arg in args {
        if last == "--root" {
            root = Some(PathBuf::from(arg.trim_matches('"')));
            last.clear();
            continue;
        }
        last = arg;
    }
    root.ok_or_else(|| "missing --root <directory>".to_string())
}

pub fn run() -> i32 {
    let root = match root_from_args(std::env::args().skip(1)) {
        Ok(root) => root,
        Err(message) => {
            eprintln!("yu-knowledge: {message}");
            return 2;
        }
    };
    let (fts5, trigram) = store::probe_capabilities();
    let link = Link::new(Box::new(io::stdout()));
    if link.write(&protocol::ready_frame(fts5, trigram)).is_err() {
        return 1;
    }
    let service = Service::new(root, fts5, trigram);
    let inflight = Arc::new(AtomicUsize::new(0));
    let last = Arc::new(AtomicI64::new(now_ms()));
    let pending: Arc<Mutex<HashMap<String, CancelToken>>> = Arc::new(Mutex::new(HashMap::new()));

    {
        let (link, inflight, last) = (link.clone(), inflight.clone(), last.clone());
        let timeout = idle_timeout().as_millis() as i64;
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_millis(250));
                if inflight.load(Ordering::SeqCst) > 0 {
                    continue;
                }
                if now_ms() - last.load(Ordering::SeqCst) < timeout {
                    continue;
                }
                link.fail_all(ApiError::new(
                    Code::Internal,
                    "the helper idle timeout was reached",
                ));
                std::process::exit(0);
            }
        });
    }

    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    while let Ok(frame) = protocol::read_frame(&mut reader) {
        match frame {
            Frame::Eof => break,
            Frame::TooLarge => {
                last.store(now_ms(), Ordering::SeqCst);
                let error = ApiError::new(Code::TooLarge, "the frame exceeds 2 MiB");
                let _ = link.write(&protocol::error_frame("", &error));
            }
            Frame::Line(line) => {
                last.store(now_ms(), Ordering::SeqCst);
                match protocol::parse_incoming(&line) {
                    Err(failure) => {
                        let error = ApiError::new(failure.code, failure.message);
                        let _ = link.write(&protocol::error_frame(&failure.id, &error));
                    }
                    Ok(Incoming::Ignored) => {}
                    Ok(Incoming::Cancel(id)) => {
                        let token = pending.lock().ok().and_then(|map| map.get(&id).cloned());
                        if let Some(token) = token {
                            token.cancel();
                        }
                    }
                    Ok(Incoming::Model(reply)) => link.resolve(reply),
                    Ok(Incoming::Request(request)) => {
                        let token = CancelToken::new();
                        if let Ok(mut map) = pending.lock() {
                            map.insert(request.id.clone(), token.clone());
                        }
                        inflight.fetch_add(1, Ordering::SeqCst);
                        let (worker_link, worker_service) = (link.clone(), service.clone());
                        let (worker_inflight, worker_last) = (inflight.clone(), last.clone());
                        let worker_pending = pending.clone();
                        std::thread::spawn(move || {
                            util::enter_cancel(token.clone());
                            let outcome = worker_service.dispatch(
                                &request.method,
                                request.params,
                                &worker_link,
                                &request.id,
                            );
                            let answer = match &outcome {
                                Ok(outcome) => protocol::result_frame(&request.id, &outcome.result),
                                Err(error) => protocol::error_frame(&request.id, error),
                            };
                            let shutdown = outcome.map(|outcome| outcome.shutdown).unwrap_or(false);
                            let scope = outcome_scope(&request.method);
                            let _ = write_answer(&worker_link, &request.id, &answer);
                            if let Some(scope) = scope {
                                let _ = worker_link.write(&protocol::changed_frame(scope));
                            }
                            if let Ok(mut map) = worker_pending.lock() {
                                map.remove(&request.id);
                            }
                            worker_inflight.fetch_sub(1, Ordering::SeqCst);
                            worker_last.store(now_ms(), Ordering::SeqCst);
                            if shutdown {
                                worker_link.fail_all(ApiError::new(
                                    Code::Internal,
                                    "the helper is stopping",
                                ));
                                std::process::exit(0);
                            }
                        });
                    }
                }
            }
        }
    }
    link.fail_all(ApiError::new(Code::Internal, "the host closed the pipe"));
    0
}

/// Writes one result, replacing an oversized answer with a bounded error frame so
/// a single huge response can never break the stream and strand later requests.
fn write_answer(link: &Link, id: &str, frame: &serde_json::Value) -> protocol::ApiResult<()> {
    let encode = |value: &serde_json::Value| {
        protocol::frame_line(value).map_err(|error| {
            ApiError::new(Code::Internal, format!("cannot encode a frame: {error}"))
        })
    };
    let line = encode(frame)?;
    if line.len() < protocol::MAX_FRAME_BYTES {
        return link.write_line(&line);
    }
    let error = ApiError::new(
        Code::TooLarge,
        "the response does not fit in one 2 MiB frame; request a narrower page or a shorter body",
    );
    link.write_line(&encode(&protocol::error_frame(id, &error))?)
}

fn outcome_scope(method: &str) -> Option<&'static str> {
    match method {
        "source.save" | "source.invalidate" => Some("sources"),
        "card.save" | "card.update" | "card.delete" | "card.merge" | "relation.add"
        | "relation.remove" => Some("cards"),
        "profile.save" | "profile.update" | "profile.delete" => Some("profile"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{Link, protocol, root_from_args};

    #[test]
    fn an_oversized_answer_is_replaced_with_a_bounded_error_frame() {
        struct Sink(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
        impl std::io::Write for Sink {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let sink = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let link = Link::new(Box::new(Sink(sink.clone())));
        let huge = protocol::result_frame(
            "r1",
            &serde_json::json!({ "body": "a".repeat(protocol::MAX_FRAME_BYTES) }),
        );
        super::write_answer(&link, "r1", &huge).unwrap();
        let text = String::from_utf8(sink.lock().unwrap().clone()).unwrap();
        let line = text.lines().next().expect("one frame");
        assert!(
            line.len() < protocol::MAX_FRAME_BYTES,
            "the error frame stays small"
        );
        let frame: serde_json::Value = serde_json::from_str(line).unwrap();
        assert_eq!(frame["id"], "r1");
        assert_eq!(frame["ok"], false);
        assert_eq!(frame["error"]["code"], "too_large");
    }

    #[test]
    fn root_argument_is_required_and_quotes_are_stripped() {
        assert!(root_from_args(Vec::new()).is_err());
        let root = root_from_args(["--root".to_string(), "\"C:\\tmp\\k\"".to_string()]).unwrap();
        assert_eq!(root.to_string_lossy(), "C:\\tmp\\k");
        let root = root_from_args([
            "--verbose".to_string(),
            "--root".to_string(),
            "D:\\x".to_string(),
        ])
        .unwrap();
        assert_eq!(root.to_string_lossy(), "D:\\x");
    }
}
