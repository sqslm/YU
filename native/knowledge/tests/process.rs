//! End-to-end checks against the real `yu-knowledge` executable: real pipes,
//! real SQLite files, real UTF-8 framing and a real process lifetime.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{Value, json};

fn temp_root(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root =
        std::env::temp_dir().join(format!("yu-knowledge-{tag}-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    root
}

struct Helper {
    child: Child,
    stdin: Option<ChildStdin>,
    out: BufReader<ChildStdout>,
}

impl Helper {
    fn start(root: &Path, idle_ms: Option<u64>) -> Helper {
        let mut command = Command::new(env!("CARGO_BIN_EXE_yu-knowledge"));
        command
            .arg("--root")
            .arg(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(idle) = idle_ms {
            command.env("YU_KNOWLEDGE_IDLE_MS", idle.to_string());
        }
        let mut child = command.spawn().unwrap();
        let stdin = child.stdin.take();
        let out = BufReader::new(child.stdout.take().unwrap());
        let mut helper = Helper { child, stdin, out };
        let ready = helper.recv();
        assert_eq!(ready["v"], 1, "ready frame: {ready}");
        assert_eq!(ready["type"], "ready");
        helper
    }

    fn write_raw(&mut self, bytes: &[u8]) {
        let stdin = self.stdin.as_mut().expect("stdin");
        stdin.write_all(bytes).unwrap();
        stdin.flush().unwrap();
    }

    fn send(&mut self, frame: &Value) {
        let mut line = serde_json::to_vec(frame).unwrap();
        line.push(b'\n');
        self.write_raw(&line);
    }

    fn recv(&mut self) -> Value {
        let mut line = String::new();
        let read = self.out.read_line(&mut line).unwrap();
        assert!(read > 0, "the helper closed its stdout");
        serde_json::from_str(line.trim_end()).unwrap_or_else(|error| panic!("{error}: {line}"))
    }

    /// Skips `changed` notifications, which are not results.
    fn result(&mut self) -> Value {
        loop {
            let frame = self.recv();
            if frame["type"] == "result" {
                return frame;
            }
        }
    }

    /// Frames for other requests may arrive first when requests run in
    /// parallel, so a call scans until it finds its own id.
    fn call(&mut self, id: &str, method: &str, params: Value) -> Value {
        self.send(
            &json!({ "v": 1, "type": "request", "id": id, "method": method, "params": params }),
        );
        loop {
            let frame = self.result();
            if frame["id"] == id {
                return frame;
            }
        }
    }

    fn ok(&mut self, id: &str, method: &str, params: Value) -> Value {
        let frame = self.call(id, method, params);
        assert_eq!(frame["ok"], true, "{method} failed: {frame}");
        frame["result"].clone()
    }

    fn close_stdin(&mut self) {
        self.stdin.take();
    }

    fn wait(&mut self) -> std::process::ExitStatus {
        self.child.wait().unwrap()
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn card_params(title: &str, body: &str) -> Value {
    json!({ "kind": "concept", "title": title, "summary": "", "body": body, "topics": ["测试"], "aliases": [] })
}

#[test]
fn ready_then_status_touches_no_storage_until_data_is_requested() {
    let root = temp_root("lazy");
    let mut helper = Helper::start(&root, None);
    let status = helper.ok("s1", "status", json!({}));
    assert_eq!(status["version"], 1);
    assert_eq!(status["opened"], false);
    assert_eq!(status["fts5"], true, "bundled SQLite must provide FTS5");
    assert_eq!(
        status["trigram"], true,
        "bundled SQLite must provide the trigram tokenizer"
    );
    assert!(
        !root.join("data").exists(),
        "status must not create the data root"
    );

    let source = helper.ok(
        "s2",
        "source.save",
        json!({ "kind": "web", "originRef": "https://example.com/a?q=1&lang=zh", "locator": "https://example.com/a?q=1&lang=zh", "title": "例子", "version": "1", "scope": "whole page", "text": "知识图谱的基础" }),
    );
    assert_eq!(source["kind"], "web");
    assert_eq!(source["state"], "active");
    assert_eq!(source["size"], 7);
    assert!(
        root.join("data")
            .join("knowledge")
            .join("knowledge.db")
            .exists()
    );
    let reopened = helper.ok("s3", "status", json!({}));
    assert_eq!(reopened["opened"], true);
    helper.ok("s4", "shutdown", json!({}));
    assert!(helper.wait().success());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn sources_cards_search_and_profile_rules_survive_a_restart() {
    let root = temp_root("flow");
    let card_id;
    let source_id;
    {
        let mut helper = Helper::start(&root, None);
        source_id = helper
            .ok(
                "a1",
                "source.save",
                json!({ "kind": "note", "originRef": "note:42", "locator": "随记 #42", "title": "随记", "version": "3", "scope": "whole note", "text": "今天研究了知识库的检索粒度" }),
            )["id"]
            .as_str()
            .unwrap()
            .to_string();
        let card = helper.ok(
            "a2",
            "card.save",
            json!({ "kind": "method", "title": "检索粒度", "summary": "先按标题检索", "body": "知识图谱检索应当先命中标题与别名，再落到正文。", "topics": ["检索", "知识库"], "aliases": ["检索粒度"], "sourceIds": [source_id] }),
        );
        card_id = card["id"].as_str().unwrap().to_string();
        assert_eq!(card["sourceIds"][0], source_id);
        assert_eq!(card["edited"], false);

        // Two Chinese characters take the literal branch; the long phrase takes FTS.
        let short = helper.ok("a3", "card.search", json!({ "query": "检索" }));
        assert_eq!(short["total"], 1, "{short}");
        let long = helper.ok("a4", "card.search", json!({ "query": "知识图谱" }));
        assert_eq!(long["total"], 1, "{long}");
        let miss = helper.ok("a5", "card.search", json!({ "query": "图谱知识" }));
        assert_eq!(
            miss["total"], 0,
            "a literal query must not match out of order: {miss}"
        );
        let body_only = helper.ok("a6", "card.search", json!({ "query": "别名" }));
        assert_eq!(body_only["total"], 1);

        // Invalidating the source keeps the card.
        let invalid = helper.ok(
            "a7",
            "source.invalidate",
            json!({ "id": source_id, "reason": "the page changed" }),
        );
        assert_eq!(invalid["state"], "invalid");
        let kept = helper.ok("a8", "card.get", json!({ "id": card_id }));
        assert_eq!(kept["title"], "检索粒度");

        let updated = helper.ok(
            "a9",
            "card.update",
            json!({ "id": card_id, "title": "检索粒度（改）" }),
        );
        assert_eq!(updated["edited"], true);
        assert_eq!(updated["title"], "检索粒度（改）");

        let item = helper.ok(
            "a10",
            "profile.save",
            json!({ "dimension": "偏好", "value": "简洁回答", "category": "explicit", "evidence": [{ "sourceKind": "note", "sourceId": source_id, "originRef": "note:42" }] }),
        );
        let item_id = item["id"].as_str().unwrap().to_string();
        helper.ok(
            "a11",
            "profile.update",
            json!({ "id": item_id, "pinned": true }),
        );
        let refused = helper.call(
            "a12",
            "profile.save",
            json!({ "dimension": "偏好", "value": "简洁回答", "category": "inferred", "origin": "auto" }),
        );
        assert_eq!(refused["ok"], false);
        assert_eq!(refused["error"]["code"], "protected_item");
        let manual = helper.ok(
            "a13",
            "profile.save",
            json!({ "dimension": "偏好", "value": "简洁回答", "category": "explicit" }),
        );
        assert_eq!(
            manual["pinned"], true,
            "a manual write must not clear the pin"
        );
        let removed = helper.ok("a14", "profile.delete", json!({ "id": item_id }));
        assert_eq!(removed["removed"], true);
        let rebuilt = helper.call(
            "a15",
            "profile.save",
            json!({ "dimension": "偏好", "value": "简洁回答", "category": "inferred", "origin": "auto" }),
        );
        assert_eq!(
            rebuilt["ok"], false,
            "a deleted item must not be rebuilt automatically"
        );

        helper.ok("a16", "shutdown", json!({}));
        assert!(helper.wait().success());
    }
    // A new process sees the same data.
    {
        let mut helper = Helper::start(&root, None);
        let card = helper.ok("b1", "card.get", json!({ "id": card_id }));
        assert_eq!(card["title"], "检索粒度（改）");
        let page = helper.ok("b2", "card.list", json!({ "limit": 10 }));
        assert_eq!(page["total"], 1);
        let profile = helper.ok("b3", "profile.list", json!({}));
        assert_eq!(profile["total"], 0, "the deleted item stays deleted");
        assert!(
            helper.call("b4", "card.get", json!({ "id": "missing" }))["error"]["code"]
                == "not_found"
        );
        helper.close_stdin();
        assert!(helper.wait().success());
    }
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn parallel_requests_split_frames_and_recover_from_garbage() {
    let root = temp_root("frames");
    let mut helper = Helper::start(&root, None);
    // Three requests in one write, plus a multi-byte character split across two writes.
    let mut batch = Vec::new();
    for id in ["p1", "p2", "p3"] {
        batch.extend(
            serde_json::to_vec(
                &json!({ "v": 1, "type": "request", "id": id, "method": "status", "params": {} }),
            )
            .unwrap(),
        );
        batch.push(b'\n');
    }
    helper.write_raw(&batch);
    let mut seen = Vec::new();
    while seen.len() < 3 {
        seen.push(helper.recv()["id"].as_str().unwrap().to_string());
    }
    seen.sort();
    assert_eq!(seen, vec!["p1", "p2", "p3"]);

    let frame = json!({ "v": 1, "type": "request", "id": "u1", "method": "card.save", "params": { "kind": "concept", "title": "中文标题", "body": "正文", "topics": [], "aliases": [], "summary": "" } });
    let mut bytes = serde_json::to_vec(&frame).unwrap();
    bytes.push(b'\n');
    let cut = bytes.len() / 2;
    helper.write_raw(&bytes[..cut]);
    std::thread::sleep(std::time::Duration::from_millis(30));
    helper.write_raw(&bytes[cut..]);
    let saved = helper.result();
    assert_eq!(saved["id"], "u1", "{saved}");

    helper.write_raw(b"{not json}\n");
    let broken = helper.result();
    assert_eq!(broken["ok"], false);
    assert_eq!(broken["error"]["code"], "invalid_request");

    let after = helper.ok("u2", "status", json!({}));
    assert_eq!(after["opened"], true);

    // A cancelled id that already answered must not resend anything.
    helper.send(&json!({ "v": 1, "type": "cancel", "id": "u2" }));
    let next = helper.ok("u3", "card.list", json!({}));
    assert_eq!(next["total"], 1);

    // An oversized frame is refused and the stream keeps working.
    let big = vec![b'x'; 2 * 1024 * 1024 + 8];
    let mut line =
        b"{\"v\":1,\"type\":\"request\",\"id\":\"big\",\"method\":\"status\",\"params\":{\"x\":\""
            .to_vec();
    line.extend_from_slice(&big);
    line.extend_from_slice(b"\"}}\n");
    helper.write_raw(&line);
    let refused = helper.result();
    assert_eq!(refused["error"]["code"], "too_large", "{refused}");
    let alive = helper.ok("u4", "status", json!({}));
    assert_eq!(alive["version"], 1);

    let unknown = helper.call("u5", "sql.select", json!({}));
    assert_eq!(unknown["error"]["code"], "unknown_method");
    let wrong_version = helper.call("u6", "status", json!({}));
    assert_eq!(wrong_version["ok"], true);

    helper
        .send(&json!({ "v": 2, "type": "request", "id": "u7", "method": "status", "params": {} }));
    let rejected = helper.result();
    assert_eq!(rejected["error"]["code"], "unsupported_version");

    helper.close_stdin();
    assert!(
        helper.wait().success(),
        "the helper exits cleanly on parent EOF"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn the_helper_leaves_when_idle() {
    let root = temp_root("idle");
    let mut helper = Helper::start(&root, Some(400));
    let status = helper.ok("i1", "status", json!({}));
    assert_eq!(status["version"], 1);
    let started = std::time::Instant::now();
    let code = helper.wait();
    assert!(code.success(), "idle exit is a clean shutdown: {code:?}");
    assert!(
        started.elapsed() < std::time::Duration::from_secs(6),
        "idle exit took {:?}",
        started.elapsed()
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_parent_that_disappears_takes_the_helper_with_it() {
    let root = temp_root("orphan");
    let mut helper = Helper::start(&root, None);
    helper.ok(
        "o1",
        "card.save",
        card_params("孤儿进程", "父进程退出后不应残留"),
    );
    let pid = helper.child.id();
    helper.close_stdin();
    let status = helper.wait();
    assert!(status.success());
    let alive = Command::new("cmd")
        .args(["/C", &format!("tasklist /FI \"PID eq {pid}\" /NH")])
        .output()
        .unwrap();
    let listing = String::from_utf8_lossy(&alive.stdout);
    assert!(
        !listing.contains(&pid.to_string()),
        "the helper is still running: {listing}"
    );
    let _ = std::fs::remove_dir_all(&root);
}
