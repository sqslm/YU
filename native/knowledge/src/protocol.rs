//! Fixed JSON-Lines wire contract shared with the Electron host.
//!
//! Every frame is one UTF-8 JSON object on one line. The contract is version 1
//! and is mirrored by `src/shared/knowledge.ts`; both sides are pinned by the
//! same fixture, so a field rename must change both files.

use std::io::{self, BufRead, Write};

use serde_json::{Value, json};

pub const VERSION: u32 = 1;

/// Hard ceiling for a single frame, newline excluded.
pub const MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_ID_CHARS: usize = 128;
pub const MAX_TITLE_CHARS: usize = 200;
pub const MAX_SUMMARY_CHARS: usize = 2_000;
pub const MAX_BODY_CHARS: usize = 200_000;
pub const MAX_QUERY_CHARS: usize = 200;
pub const MAX_TOPICS: usize = 32;
pub const MAX_TOPIC_CHARS: usize = 100;
pub const DEFAULT_PAGE: u32 = 30;
pub const MAX_PAGE: u32 = 100;

/// Byte budget for the items of one page. A legal page must never grow past the
/// frame limit, so a list keeps whole items while they fit in this budget and
/// reports the rest through `nextOffset`.
pub const RESULT_BUDGET_BYTES: usize = 1024 * 1024;

/// Deadline for a request that never waits on a model callback.
pub const OP_TIMEOUT_MS: u64 = 15_000;
/// Deadline for a request that may wait on a model callback.
pub const MODEL_TIMEOUT_MS: u64 = 120_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Code {
    InvalidRequest,
    UnsupportedVersion,
    UnknownMethod,
    InvalidParams,
    TooLarge,
    NotFound,
    ProtectedItem,
    Storage,
    StorageSchemaNewer,
    Cancelled,
    Timeout,
    ModelUnavailable,
    Internal,
}

impl Code {
    pub fn as_str(self) -> &'static str {
        match self {
            Code::InvalidRequest => "invalid_request",
            Code::UnsupportedVersion => "unsupported_version",
            Code::UnknownMethod => "unknown_method",
            Code::InvalidParams => "invalid_params",
            Code::TooLarge => "too_large",
            Code::NotFound => "not_found",
            Code::ProtectedItem => "protected_item",
            Code::Storage => "storage_error",
            Code::StorageSchemaNewer => "storage_schema_newer",
            Code::Cancelled => "cancelled",
            Code::Timeout => "timeout",
            Code::ModelUnavailable => "model_unavailable",
            Code::Internal => "internal",
        }
    }
}

/// The whole set of caller-visible failures; `code` is part of the contract,
/// `message` is a short diagnostic that never contains stored content.
#[derive(Debug, Clone)]
pub struct ApiError {
    pub code: Code,
    pub message: String,
}

impl ApiError {
    pub fn new(code: Code, message: impl Into<String>) -> ApiError {
        ApiError {
            code,
            message: message.into(),
        }
    }

    pub fn invalid(message: impl Into<String>) -> ApiError {
        ApiError::new(Code::InvalidParams, message)
    }

    pub fn not_found(message: impl Into<String>) -> ApiError {
        ApiError::new(Code::NotFound, message)
    }

    pub fn storage(message: impl Into<String>) -> ApiError {
        ApiError::new(Code::Storage, message)
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

pub struct Request {
    pub id: String,
    pub method: String,
    pub params: Value,
}

pub struct ModelReply {
    pub id: String,
    pub ok: bool,
    pub text: String,
    pub error: Option<ApiError>,
}

pub enum Incoming {
    Request(Request),
    Cancel(String),
    Model(ModelReply),
    Ignored,
}

#[derive(Debug)]
pub struct ParseFailure {
    pub id: String,
    pub code: Code,
    pub message: String,
}

fn failure(id: &str, code: Code, message: impl Into<String>) -> ParseFailure {
    ParseFailure {
        id: id.to_string(),
        code,
        message: message.into(),
    }
}

/// Parses one frame. A malformed frame never panics and never desynchronises
/// the stream: the caller answers with an error result and keeps reading.
pub fn parse_incoming(bytes: &[u8]) -> Result<Incoming, ParseFailure> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| failure("", Code::InvalidRequest, "frame is not valid UTF-8"))?;
    let trimmed = text.trim_start_matches('\u{feff}').trim();
    if trimmed.is_empty() {
        return Ok(Incoming::Ignored);
    }
    let value: Value = serde_json::from_str(trimmed).map_err(|error| {
        failure(
            "",
            Code::InvalidRequest,
            format!("frame is not JSON: {error}"),
        )
    })?;
    let Some(object) = value.as_object() else {
        return Err(failure(
            "",
            Code::InvalidRequest,
            "frame is not a JSON object",
        ));
    };
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if id.chars().count() > MAX_ID_CHARS {
        return Err(failure(
            "",
            Code::InvalidRequest,
            format!("id exceeds {MAX_ID_CHARS} characters"),
        ));
    }
    let version = object.get("v").and_then(Value::as_u64).unwrap_or(0);
    if version != u64::from(VERSION) {
        return Err(failure(
            &id,
            Code::UnsupportedVersion,
            format!("unsupported protocol version: expected {VERSION}"),
        ));
    }
    match object.get("type").and_then(Value::as_str) {
        Some("request") => {
            let method = object
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if method.is_empty() {
                return Err(failure(
                    &id,
                    Code::InvalidRequest,
                    "request is missing method",
                ));
            }
            if method.chars().count() > 64 {
                return Err(failure(
                    &id,
                    Code::InvalidRequest,
                    "method name is too long",
                ));
            }
            let params = object.get("params").cloned().unwrap_or(Value::Null);
            Ok(Incoming::Request(Request { id, method, params }))
        }
        Some("cancel") => {
            if id.is_empty() {
                return Err(failure("", Code::InvalidRequest, "cancel is missing id"));
            }
            Ok(Incoming::Cancel(id))
        }
        Some("model.result") => {
            let ok = object.get("ok").and_then(Value::as_bool).unwrap_or(false);
            let text = object
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let error = object.get("error").and_then(Value::as_object).map(|body| {
                let code = body
                    .get("code")
                    .and_then(Value::as_str)
                    .unwrap_or("internal");
                let message = body
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                ApiError::new(code_from_wire(code), message)
            });
            Ok(Incoming::Model(ModelReply {
                id,
                ok,
                text,
                error,
            }))
        }
        // Forward compatibility: an unknown frame kind is ignored, never echoed.
        Some(_) => Ok(Incoming::Ignored),
        None => Err(failure(&id, Code::InvalidRequest, "frame is missing type")),
    }
}

/// Maps a host-side error code back onto the shared enum; unknown values
/// degrade to `internal` so a newer host cannot crash an older helper.
pub fn code_from_wire(code: &str) -> Code {
    match code {
        "invalid_request" => Code::InvalidRequest,
        "unsupported_version" => Code::UnsupportedVersion,
        "unknown_method" => Code::UnknownMethod,
        "invalid_params" => Code::InvalidParams,
        "too_large" => Code::TooLarge,
        "not_found" => Code::NotFound,
        "protected_item" => Code::ProtectedItem,
        "storage_error" => Code::Storage,
        "storage_schema_newer" => Code::StorageSchemaNewer,
        "cancelled" => Code::Cancelled,
        "timeout" => Code::Timeout,
        "model_unavailable" => Code::ModelUnavailable,
        _ => Code::Internal,
    }
}

pub enum Frame {
    Eof,
    Line(Vec<u8>),
    /// One over-long line was drained; the reader can continue with the next.
    TooLarge,
}

/// Reads one newline-delimited frame, capping the buffer at `MAX_FRAME_BYTES`.
/// A multi-byte character split across reads is reassembled here, so quoting
/// and UTF-8 boundaries never depend on how the host chunks its writes.
pub fn read_frame<R: BufRead>(reader: &mut R) -> io::Result<Frame> {
    let mut line: Vec<u8> = Vec::new();
    let mut overflow = false;
    loop {
        let consumed;
        let mut newline = false;
        {
            let chunk = reader.fill_buf()?;
            if chunk.is_empty() {
                return Ok(if overflow {
                    Frame::TooLarge
                } else if line.is_empty() {
                    Frame::Eof
                } else {
                    Frame::Line(line)
                });
            }
            match chunk.iter().position(|byte| *byte == b'\n') {
                Some(position) => {
                    consumed = position + 1;
                    newline = true;
                    if !overflow {
                        if line.len() + position > MAX_FRAME_BYTES {
                            overflow = true;
                            line.clear();
                        } else {
                            line.extend_from_slice(&chunk[..position]);
                        }
                    }
                }
                None => {
                    consumed = chunk.len();
                    if !overflow {
                        if line.len() + chunk.len() > MAX_FRAME_BYTES {
                            overflow = true;
                            line.clear();
                        } else {
                            line.extend_from_slice(chunk);
                        }
                    }
                }
            }
        }
        reader.consume(consumed);
        if newline {
            if overflow {
                return Ok(Frame::TooLarge);
            }
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return Ok(Frame::Line(line));
        }
    }
}

pub fn write_frame(out: &mut dyn Write, frame: &Value) -> io::Result<()> {
    let mut bytes = frame_line(frame)?.into_bytes();
    bytes.push(b'\n');
    out.write_all(&bytes)?;
    out.flush()
}

/// One frame as the exact text that goes on the wire, so a writer can check the
/// real byte length before committing to the line.
pub fn frame_line(frame: &Value) -> io::Result<String> {
    serde_json::to_string(frame).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

/// Keeps whole items while their serialized size stays inside the byte budget,
/// so one legal page can never exceed the frame limit. `total` is the row count
/// of the query, so a caller that stops early still learns there is more; the
/// first item is always kept so a page always makes progress.
pub fn fit_page<T: serde::Serialize>(
    items: Vec<T>,
    total: i64,
    offset: u32,
) -> (Vec<T>, bool, Option<u32>) {
    let mut kept = Vec::new();
    let mut bytes = 0usize;
    let mut stopped = false;
    for item in items {
        let size = serde_json::to_vec(&item)
            .map(|value| value.len())
            .unwrap_or(MAX_FRAME_BYTES);
        if !kept.is_empty() && bytes + size + 1 > RESULT_BUDGET_BYTES {
            stopped = true;
            break;
        }
        bytes += size + 1;
        kept.push(item);
    }
    let end = offset + u32::try_from(kept.len()).unwrap_or(u32::MAX);
    let more = stopped || i64::from(end) < total;
    let next = if more { Some(end) } else { None };
    (kept, more, next)
}

pub fn ready_frame(fts5: bool, trigram: bool) -> Value {
    json!({ "v": VERSION, "type": "ready", "schema": crate::store::KNOWLEDGE_SCHEMA, "fts5": fts5, "trigram": trigram })
}

pub fn result_frame(id: &str, result: &Value) -> Value {
    json!({ "v": VERSION, "type": "result", "id": id, "ok": true, "result": result })
}

pub fn error_frame(id: &str, error: &ApiError) -> Value {
    json!({
        "v": VERSION,
        "type": "result",
        "id": id,
        "ok": false,
        "error": { "code": error.code.as_str(), "message": error.message }
    })
}

pub fn changed_frame(scope: &str) -> Value {
    json!({ "v": VERSION, "type": "changed", "scope": scope })
}

pub fn model_request_frame(
    id: &str,
    parent_id: &str,
    profile_id: &str,
    effort: &str,
    messages: &Value,
    max_tokens: Option<u32>,
) -> Value {
    json!({
        "v": VERSION,
        "type": "model.request",
        "id": id,
        "parentId": parent_id,
        "profileId": profile_id,
        "effort": effort,
        "messages": messages,
        "maxTokens": max_tokens,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufReader;

    #[allow(dead_code)]
    fn frames(input: &[u8]) -> Vec<Frame> {
        let mut reader = BufReader::new(input);
        let mut out = Vec::new();
        loop {
            match read_frame(&mut reader).expect("read") {
                Frame::Eof => break,
                other => out.push(other),
            }
        }
        out
    }

    #[test]
    fn parses_request_and_keeps_params_verbatim() {
        let frame =
            br#"{"v":1,"type":"request","id":"r1","method":"status","params":{"x":"100%_a"}}"#;
        match parse_incoming(frame).expect("parse") {
            Incoming::Request(request) => {
                assert_eq!(request.id, "r1");
                assert_eq!(request.method, "status");
                assert_eq!(request.params["x"], "100%_a");
            }
            _ => panic!("expected request"),
        }
    }

    #[test]
    fn rejects_other_protocol_versions_with_the_request_id() {
        let failure =
            match parse_incoming(br#"{"v":2,"type":"request","id":"r9","method":"status"}"#) {
                Err(failure) => failure,
                Ok(_) => panic!("expected failure"),
            };
        assert_eq!(failure.code, Code::UnsupportedVersion);
        assert_eq!(failure.id, "r9");
    }

    #[test]
    fn malformed_frames_report_an_error_without_eating_the_next_one() {
        let input = b"{not json}\n{\"v\":1,\"type\":\"cancel\",\"id\":\"r1\"}\n";
        let mut reader = BufReader::new(&input[..]);
        let Frame::Line(first) = read_frame(&mut reader).expect("first") else {
            panic!("line")
        };
        assert!(parse_incoming(&first).is_err());
        let Frame::Line(second) = read_frame(&mut reader).expect("second") else {
            panic!("line")
        };
        match parse_incoming(&second).expect("second parses") {
            Incoming::Cancel(id) => assert_eq!(id, "r1"),
            _ => panic!("expected cancel"),
        }
    }

    #[test]
    fn reassembles_a_frame_split_at_arbitrary_offsets() {
        let frame = "{\"v\":1,\"type\":\"request\",\"id\":\"r1\",\"method\":\"card.search\",\"params\":{\"query\":\"知识图谱🔍\"}}";
        let raw = frame.as_bytes();
        // A small read capacity forces the multi-byte characters to straddle
        // buffer boundaries; the frame must still arrive intact.
        for capacity in [1usize, 2, 3, 5, 16] {
            let mut input = raw.to_vec();
            input.push(b'\n');
            let mut reader = BufReader::with_capacity(capacity, &input[..]);
            let Frame::Line(line) = read_frame(&mut reader).expect("frame") else {
                panic!("line")
            };
            match parse_incoming(&line).expect("parse") {
                Incoming::Request(request) => assert_eq!(request.params["query"], "知识图谱🔍"),
                _ => panic!("expected request"),
            }
        }
    }

    #[test]
    fn a_page_keeps_whole_items_inside_the_byte_budget() {
        let items = vec![
            "x".repeat(400_000),
            "y".repeat(400_000),
            "z".repeat(400_000),
        ];
        let (kept, more, next) = fit_page(items, 3, 0);
        assert_eq!(
            kept.len(),
            2,
            "two items fit, the third would exceed the budget"
        );
        assert!(more);
        assert_eq!(next, Some(2));
        let (kept, more, next) = fit_page(vec!["q".repeat(16)], 1, 0);
        assert_eq!(kept.len(), 1);
        assert!(!more);
        assert_eq!(next, None);
        // The first item is always kept, so even an oversized one still makes
        // progress instead of returning an empty page with the same offset.
        let (kept, more, next) = fit_page(vec!["z".repeat(RESULT_BUDGET_BYTES + 16)], 1, 7);
        assert_eq!(kept.len(), 1);
        assert!(!more);
        assert_eq!(next, None);
    }

    #[test]
    fn oversized_frames_are_flagged_and_the_stream_continues() {
        let mut input = vec![b'a'; MAX_FRAME_BYTES + 16];
        input.push(b'\n');
        input.extend_from_slice(b"{\"v\":1,\"type\":\"cancel\",\"id\":\"r2\"}\n");
        let mut reader = BufReader::with_capacity(4096, &input[..]);
        assert!(matches!(
            read_frame(&mut reader).expect("frame"),
            Frame::TooLarge
        ));
        let Frame::Line(line) = read_frame(&mut reader).expect("frame") else {
            panic!("line")
        };
        match parse_incoming(&line).expect("parse") {
            Incoming::Cancel(id) => assert_eq!(id, "r2"),
            _ => panic!("expected cancel"),
        }
    }
}
