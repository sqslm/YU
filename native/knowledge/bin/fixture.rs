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
        "favorite": false,
        "edited": false,
        "createdAt": 1,
        "updatedAt": 1
    })
}

/// Reads one string parameter, falling back to a synthetic value.
fn param(params: &Value, key: &str, fallback: &str) -> String {
    params
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .to_string()
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
                                    "schema": { "knowledge": yu_knowledge::store::KNOWLEDGE_SCHEMA, "profile": yu_knowledge::store::PROFILE_SCHEMA },
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
                            "card.merge" => {
                                let keep = param(&request.params, "keepId", "fixture-keep");
                                let merge = param(&request.params, "mergeId", "fixture-merge");
                                protocol::result_frame(
                                    &request.id,
                                    &json!({
                                        "card": {
                                            "id": keep,
                                            "kind": "concept",
                                            "title": "合并后的卡片",
                                            "summary": "",
                                            "body": "合并正文",
                                            "topics": ["rust"],
                                            "aliases": [],
                                            "sourceIds": ["s1"],
                                            "favorite": true,
                                            "edited": true,
                                            "revision": 3,
                                            "createdAt": 1,
                                            "updatedAt": 2
                                        },
                                        "removedId": merge,
                                        "sources": 1,
                                        "relations": 1,
                                        "bodySource": "request",
                                        "preview": "合并正文"
                                    }),
                                )
                            }
                            "card.export" => {
                                let id = param(&request.params, "id", "fixture-card");
                                protocol::result_frame(
                                    &request.id,
                                    &json!({
                                        "id": id,
                                        "filename": "夹具闭环答案.md",
                                        "markdown": "# 夹具闭环答案\n\n- 类型：concept\n"
                                    }),
                                )
                            }
                            "card.revisions" => {
                                let id = param(&request.params, "id", "fixture-card");
                                protocol::result_frame(
                                    &request.id,
                                    &json!({
                                        "id": id,
                                        "revisions": [
                                            {
                                                "revision": 2,
                                                "title": "夹具闭环答案",
                                                "summary": "",
                                                "body": "夹具正文",
                                                "topics": ["rust"],
                                                "edited": false,
                                                "createdAt": 1
                                            },
                                            {
                                                "revision": 1,
                                                "title": "夹具闭环答案",
                                                "summary": "",
                                                "body": "夹具正文",
                                                "topics": ["rust"],
                                                "edited": false,
                                                "createdAt": 1
                                            }
                                        ]
                                    }),
                                )
                            }
                            // The record a note produced, by the identity the detail
                            // view already holds: one card, no database needed.
                            "card.by_source" => {
                                protocol::result_frame(&request.id, &page("夹具来源卡片"))
                            }
                            "card.impact" => {
                                let id = param(&request.params, "sourceId", "fixture-source");
                                let origin = param(&request.params, "originRef", "fixture-note");
                                protocol::result_frame(
                                    &request.id,
                                    &json!({
                                        "sourceId": id,
                                        "version": "v1",
                                        "record": { "channel": "note", "originRef": origin },
                                        "sources": [{ "id": id, "version": "v1" }],
                                        "cards": 2,
                                        "single": 1,
                                        "multi": 1,
                                        "items": [{
                                            "id": "fixture-card",
                                            "title": "夹具来源卡片",
                                            "kind": "concept",
                                            "sources": 1,
                                            "single": true
                                        }],
                                        "more": true,
                                        "incomplete": false,
                                        "ticket": "fixture-ticket"
                                    }),
                                )
                            }
                            "card.purge" => {
                                // The confirmed form nests the rows under `confirm`; the
                                // older form hands them over directly.
                                let list = request
                                    .params
                                    .get("confirm")
                                    .and_then(|confirm| confirm.get("sources"))
                                    .or_else(|| request.params.get("sources"));
                                let removed: Vec<Value> = list
                                    .and_then(Value::as_array)
                                    .map(|entries| {
                                        entries
                                            .iter()
                                            .filter_map(|entry| entry.get("id").cloned())
                                            .collect()
                                    })
                                    .unwrap_or_default();
                                protocol::result_frame(
                                    &request.id,
                                    &json!({
                                        "removed": removed,
                                        "kept": Vec::<String>::new(),
                                        "skipped": Vec::<String>::new(),
                                        "ticket": "fixture-ticket"
                                    }),
                                )
                            }
                            "source.find" => {
                                let origin = param(&request.params, "originRef", "fixture-note");
                                protocol::result_frame(
                                    &request.id,
                                    &json!({
                                        "sources": [{
                                            "id": "fixture-source",
                                            "kind": "note",
                                            "channel": "note",
                                            "state": "active",
                                            "version": "v1",
                                            "title": "夹具随记",
                                            "originRef": origin,
                                            "size": 12
                                        }],
                                        "record": { "channel": "note", "originRef": origin },
                                        "incomplete": false
                                    }),
                                )
                            }
                            "topic.list" => protocol::result_frame(
                                &request.id,
                                &json!({
                                    "topics": [
                                        { "topic": "rust", "count": 2 },
                                        { "topic": "sqlite", "count": 1 }
                                    ],
                                    "total": 2
                                }),
                            ),
                            "relation.add" => {
                                let from = param(&request.params, "fromId", "fixture-from");
                                let to = param(&request.params, "toId", "fixture-to");
                                let kind = param(&request.params, "kind", "contains");
                                let evidence = param(&request.params, "evidence", "");
                                protocol::result_frame(
                                    &request.id,
                                    &json!({
                                        "id": "rel_1",
                                        "fromId": from,
                                        "toId": to,
                                        "kind": kind,
                                        "origin": "manual",
                                        "evidence": evidence,
                                        "sourceId": Value::Null,
                                        "segment": Value::Null,
                                        "createdAt": 1
                                    }),
                                )
                            }
                            "relation.remove" => {
                                protocol::result_frame(&request.id, &json!({ "removed": true }))
                            }
                            "relation.list" => protocol::result_frame(
                                &request.id,
                                &json!({
                                    "items": [{
                                        "id": "rel_1",
                                        "fromId": "c1",
                                        "toId": "c2",
                                        "kind": "contains",
                                        "origin": "manual",
                                        "evidence": "",
                                        "sourceId": Value::Null,
                                        "segment": Value::Null,
                                        "createdAt": 1,
                                        "card": { "id": "c2", "title": "夹具邻居", "kind": "concept" },
                                        "direction": "out"
                                    }],
                                    "total": 1
                                }),
                            ),
                            // The panel needs no database to exercise its retry path:
                            // one failed group is enough to name an id.
                            "queue.status" => protocol::result_frame(
                                &request.id,
                                &json!({
                                    "counts": { "failed": 1, "ready": 1 },
                                    "total": 2,
                                    "paused": false,
                                    "pausedReasons": { "manual": false, "game": false },
                                    "channels": { "note": true, "chat": true, "reading": true },
                                    "windowMs": 60000,
                                    "groups": [{
                                        "id": "grp_1",
                                        "channel": "note",
                                        "state": "failed",
                                        "title": "夹具任务",
                                        "items": 1,
                                        "updatedAt": 2
                                    }]
                                }),
                            ),
                            "queue.extract" => {
                                let _source = param(&request.params, "sourceId", "fixture-source");
                                protocol::result_frame(
                                    &request.id,
                                    &json!({ "queued": 1, "groupId": "grp_1", "state": "stabilizing" }),
                                )
                            }
                            "graph.query" => protocol::result_frame(
                                &request.id,
                                &json!({
                                    "nodes": [{
                                        "id": "c1",
                                        "title": "夹具节点",
                                        "kind": "concept",
                                        "topics": ["rust"],
                                        "favorite": true
                                    }],
                                    "edges": [],
                                    "total": 1,
                                    "shown": 1,
                                    "truncated": false,
                                    "limitedBy": Value::Null,
                                    "focused": false,
                                    "expanded": 0
                                }),
                            ),
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
