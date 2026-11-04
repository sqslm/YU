//! Test fixture: a real helper transport without any storage.
//!
//! It reuses the production frame reader, the production `Link` and the
//! production protocol, and it is built only with `--features fixture`, so it is
//! never packaged and never installed. Its purpose is the closed loop the unit
//! tests cannot prove: the Electron host drives a real Rust process over real
//! pipes, that process asks the host for a model answer over the real pipe, and
//! the answer comes back into the Rust code that asked for it.
//!
//! `card.search` and `card.get` are the drivers: they ask for a model answer and
//! return it as a card title, so the host needs no test-only method. The model
//! sub id stays `m1` for every call on purpose — a restarted process must not
//! accept a stale answer for a reused id.

use std::collections::HashMap;
use std::io::{self, BufReader};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use yu_knowledge::link::{Link, ModelRequest};
use yu_knowledge::protocol::{self, ApiError, Code, Frame, Incoming};
use yu_knowledge::util::{self, CancelToken};

fn messages(params: &Value) -> Value {
    match params.get("messages") {
        Some(messages @ Value::Array(_)) => messages.clone(),
        _ => json!([{ "role": "user", "content": "夹具的合成问题" }]),
    }
}

fn card(title: &str) -> Value {
    json!({
        "id": "fixture-card",
        "kind": "concept",
        "title": title,
        "summary": "",
        "topics": [],
        "aliases": [],
        "sourceIds": [],
        "bodyChars": 0,
        "edited": false,
        "createdAt": 1,
        "updatedAt": 1
    })
}

fn page(title: &str) -> Value {
    json!({
        "items": [card(title)],
        "total": 1,
        "offset": 0,
        "limit": 30,
        "hasMore": false,
        "nextOffset": Value::Null
    })
}

fn from_model(link: &Link, parent: &str, params: &Value) -> Value {
    let profile = params
        .get("profileId")
        .and_then(Value::as_str)
        .unwrap_or("fixture-profile");
    let effort = params
        .get("effort")
        .and_then(Value::as_str)
        .unwrap_or("high");
    let max_tokens = params
        .get("maxTokens")
        .and_then(Value::as_u64)
        .map(|value| value as u32);
    let body = messages(params);
    match link.request_model(ModelRequest {
        parent_id: parent,
        profile_id: profile,
        effort,
        messages: &body,
        max_tokens,
    }) {
        Ok(text) => protocol::result_frame(parent, &page(&text)),
        Err(error) => protocol::error_frame(parent, &error),
    }
}

fn main() {
    let link = Link::new(Box::new(io::stdout()));
    if link.write(&protocol::ready_frame(true, true)).is_err() {
        std::process::exit(1);
    }
    let pending: Arc<Mutex<HashMap<String, CancelToken>>> = Arc::new(Mutex::new(HashMap::new()));
    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    while let Ok(frame) = protocol::read_frame(&mut reader) {
        match frame {
            Frame::Eof => break,
            Frame::TooLarge => {
                let _ = link.write(&protocol::error_frame(
                    "",
                    &ApiError::new(Code::TooLarge, "the fixture rejects oversized frames"),
                ));
            }
            Frame::Line(line) => match protocol::parse_incoming(&line) {
                Err(failure) => {
                    let _ = link.write(&protocol::error_frame(
                        &failure.id,
                        &ApiError::new(failure.code, failure.message),
                    ));
                }
                Ok(Incoming::Ignored) => {}
                Ok(Incoming::Model(reply)) => link.resolve(reply),
                Ok(Incoming::Cancel(id)) => {
                    if let Some(token) = pending.lock().ok().and_then(|map| map.get(&id).cloned()) {
                        token.cancel();
                    }
                }
                Ok(Incoming::Request(request)) => {
                    let token = CancelToken::new();
                    if let Ok(mut map) = pending.lock() {
                        map.insert(request.id.clone(), token.clone());
                    }
                    let (worker_link, worker_pending) = (link.clone(), pending.clone());
                    std::thread::spawn(move || {
                        util::enter_cancel(token);
                        let answer = match request.method.as_str() {
                            "card.search" | "card.get" => {
                                from_model(&worker_link, &request.id, &request.params)
                            }
                            "status" => protocol::result_frame(
                                &request.id,
                                &json!({
                                    "version": 1,
                                    "schema": { "knowledge": 1, "profile": 1 },
                                    "opened": false,
                                    "fts5": true,
                                    "trigram": true
                                }),
                            ),
                            "shutdown" => {
                                let frame =
                                    protocol::result_frame(&request.id, &json!({ "ok": true }));
                                let _ = worker_link.write(&frame);
                                std::process::exit(0);
                            }
                            other => protocol::error_frame(
                                &request.id,
                                &ApiError::new(Code::UnknownMethod, format!("unknown: {other}")),
                            ),
                        };
                        let _ = worker_link.write(&answer);
                        if let Ok(mut map) = worker_pending.lock() {
                            map.remove(&request.id);
                        }
                    });
                }
            },
        }
    }
    link.fail_all(ApiError::new(Code::Internal, "the host closed the pipe"));
}
