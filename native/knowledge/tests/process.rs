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

/// Removes its directory when it drops. Declare it before the `Helper` so the
/// process dies first and Windows releases the database files.
struct TempRoot(PathBuf);

impl TempRoot {
    fn new(tag: &str) -> TempRoot {
        TempRoot(temp_root(tag))
    }
}

impl std::ops::Deref for TempRoot {
    type Target = Path;

    fn deref(&self) -> &Path {
        &self.0
    }
}

impl AsRef<Path> for TempRoot {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Helper {
    child: Child,
    stdin: Option<ChildStdin>,
    out: BufReader<ChildStdout>,
}

impl Helper {
    fn start(root: &Path, idle_ms: Option<u64>) -> Helper {
        Helper::start_with(root, idle_ms, None)
    }

    /// `stable_ms` shortens the settling window so a test can watch a task turn
    /// from `stabilizing` into `ready` without waiting a real minute.
    fn start_with(root: &Path, idle_ms: Option<u64>, stable_ms: Option<u64>) -> Helper {
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
        if let Some(stable) = stable_ms {
            command.env("YU_KNOWLEDGE_STABLE_MS", stable.to_string());
        }
        let mut child = command.spawn().unwrap();
        let stdin = child.stdin.take();
        let out = BufReader::new(child.stdout.take().unwrap());
        let mut helper = Helper { child, stdin, out };
        let ready = helper.recv();
        assert_eq!(ready["v"], 1, "ready frame: {ready}");
        assert_eq!(ready["type"], "ready");
        // The handshake carries the declared object, not a bare schema number:
        // src/shared/knowledge.ts types ready.schema as { knowledge, profile }.
        assert_eq!(
            ready["schema"],
            serde_json::json!({ "knowledge": 2, "profile": 1 }),
            "ready schema: {ready}"
        );
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

    /// Waits for the result of a request that was already written, skipping the
    /// results of other requests.
    fn await_id(&mut self, id: &str) -> Value {
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
    let root = TempRoot::new("lazy");
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
    let root = TempRoot::new("flow");
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
    let root = TempRoot::new("frames");
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
    let root = TempRoot::new("idle");
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
    let root = TempRoot::new("orphan");
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

fn count_rows(root: &Path, sql: &str) -> i64 {
    let db = root.join("data").join("knowledge").join("knowledge.db");
    let connection = rusqlite::Connection::open(db).unwrap();
    connection.query_row(sql, [], |row| row.get(0)).unwrap()
}

/// A second connection holds the write lock while the request is cancelled. The
/// statement may still be waiting on the lock at that moment; the commit-point
/// check must roll the write back instead of letting a cancelled request land.
#[test]
fn cancel_during_a_write_lock_rolls_the_source_save_back() {
    let root = TempRoot::new("cancel-save");
    let mut helper = Helper::start(&root, None);
    helper.ok(
        "s0",
        "source.save",
        json!({ "kind": "note", "originRef": "n1", "text": "初稿" }),
    );

    let db = root.join("data").join("knowledge").join("knowledge.db");
    let lock = rusqlite::Connection::open(&db).unwrap();
    lock.busy_timeout(std::time::Duration::from_secs(10))
        .unwrap();
    lock.execute_batch("BEGIN IMMEDIATE").unwrap();
    lock.execute("UPDATE sources SET updated_at = updated_at", [])
        .unwrap();

    helper.send(&json!({
        "v": 1, "type": "request", "id": "w1", "method": "source.save",
        "params": { "kind": "note", "originRef": "n2", "text": "第二稿" }
    }));
    std::thread::sleep(std::time::Duration::from_millis(200));
    helper.send(&json!({ "v": 1, "type": "cancel", "id": "w1" }));
    std::thread::sleep(std::time::Duration::from_millis(200));
    lock.execute_batch("ROLLBACK").unwrap();
    drop(lock);

    let frame = helper.await_id("w1");
    assert_eq!(
        frame["ok"], false,
        "a cancelled save must not report ok: {frame}"
    );
    assert_eq!(frame["error"]["code"], "cancelled");
    assert_eq!(
        count_rows(
            &root,
            "SELECT count(*) FROM sources WHERE origin_ref = 'n2'"
        ),
        0,
        "the cancelled save must not be in the database"
    );
    assert_eq!(
        count_rows(&root, "SELECT count(*) FROM sources"),
        1,
        "the pre-existing source must survive"
    );
}

#[test]
fn cancel_during_a_write_lock_rolls_the_source_invalidate_back() {
    let root = TempRoot::new("cancel-invalidate");
    let mut helper = Helper::start(&root, None);
    let source = helper.ok(
        "s0",
        "source.save",
        json!({ "kind": "web", "originRef": "https://example.invalid/a", "text": "页面正文" }),
    );
    let source_id = source["id"].as_str().unwrap().to_string();

    let db = root.join("data").join("knowledge").join("knowledge.db");
    let lock = rusqlite::Connection::open(&db).unwrap();
    lock.busy_timeout(std::time::Duration::from_secs(10))
        .unwrap();
    lock.execute_batch("BEGIN IMMEDIATE").unwrap();
    lock.execute("UPDATE sources SET updated_at = updated_at", [])
        .unwrap();

    helper.send(&json!({
        "v": 1, "type": "request", "id": "w2", "method": "source.invalidate",
        "params": { "id": source_id, "reason": "已被替换" }
    }));
    std::thread::sleep(std::time::Duration::from_millis(200));
    helper.send(&json!({ "v": 1, "type": "cancel", "id": "w2" }));
    std::thread::sleep(std::time::Duration::from_millis(200));
    lock.execute_batch("ROLLBACK").unwrap();
    drop(lock);

    let frame = helper.await_id("w2");
    assert_eq!(
        frame["ok"], false,
        "a cancelled invalidate must not report ok: {frame}"
    );
    assert_eq!(frame["error"]["code"], "cancelled");
    assert_eq!(
        count_rows(&root, "SELECT count(*) FROM sources WHERE state = 'active'"),
        1,
        "the cancelled invalidate must leave the source active"
    );
    assert_eq!(
        count_rows(
            &root,
            "SELECT count(*) FROM sources WHERE invalid_reason IS NOT NULL"
        ),
        0
    );
}

/// A cancel that arrives after the result was already written changes nothing and
/// must not pretend it rolled something back.
#[test]
fn cancel_after_the_commit_changes_nothing() {
    let root = TempRoot::new("cancel-late");
    let mut helper = Helper::start(&root, None);
    helper.ok(
        "s1",
        "source.save",
        json!({ "kind": "chat", "originRef": "m1", "text": "已提交" }),
    );
    helper.send(&json!({ "v": 1, "type": "cancel", "id": "s1" }));
    std::thread::sleep(std::time::Duration::from_millis(100));
    assert_eq!(
        count_rows(&root, "SELECT count(*) FROM sources"),
        1,
        "a late cancel must not remove a committed row"
    );
    let status = helper.ok("s2", "status", json!({}));
    assert_eq!(status["version"], 1);
}

#[test]
fn the_source_text_limit_is_measured_in_characters_and_not_truncated() {
    let root = TempRoot::new("text-limit");
    let mut helper = Helper::start(&root, None);
    let exact = "知".repeat(200_000);
    let saved = helper.ok(
        "t1",
        "source.save",
        json!({ "kind": "note", "originRef": "n-exact", "text": exact }),
    );
    assert_eq!(saved["size"], 200_000);
    let over = format!("{}🌸", "知".repeat(200_000));
    let frame = helper.call(
        "t2",
        "source.save",
        json!({ "kind": "note", "originRef": "n-over", "text": over }),
    );
    assert_eq!(
        frame["ok"], false,
        "200,001 characters must be rejected: {frame}"
    );
    assert_eq!(frame["error"]["code"], "too_large");
    assert_eq!(
        count_rows(&root, "SELECT count(*) FROM sources"),
        1,
        "the rejected source must not be stored"
    );
}

#[test]
fn a_full_page_of_maximum_cards_lists_summaries_without_bodies() {
    let root = TempRoot::new("big-page");
    let mut helper = Helper::start(&root, None);
    let body = "a".repeat(200_000);
    for index in 0..11 {
        let frame = helper.call(
            &format!("c{index}"),
            "card.save",
            card_params(&format!("上限卡片 {index}"), &body),
        );
        assert_eq!(frame["ok"], true, "card {index} must save: {frame}");
    }

    let page = helper.ok("l1", "card.list", json!({}));
    assert_eq!(page["total"], 11);
    assert_eq!(page["hasMore"], false);
    assert_eq!(page["nextOffset"], Value::Null);
    let items = page["items"].as_array().unwrap();
    assert_eq!(items.len(), 11, "the default page still lists every card");
    for item in items {
        assert!(
            item.get("body").is_none(),
            "a listing must not carry the body"
        );
        assert_eq!(item["bodyChars"], 200_000);
    }
    let first_id = items[0]["id"].as_str().unwrap().to_string();
    let detail = helper.ok("g1", "card.get", json!({ "id": first_id }));
    assert_eq!(detail["body"].as_str().unwrap().len(), 200_000);
}

#[test]
fn paging_walks_every_card_once_with_multibyte_content() {
    let root = TempRoot::new("paging");
    let mut helper = Helper::start(&root, None);
    for index in 0..5 {
        helper.ok(
            &format!("c{index}"),
            "card.save",
            json!({
                "kind": "method",
                "title": format!("图谱检索 {index}"),
                "summary": "多字节摘要 🌸",
                "body": format!("知识图谱检索的分页用例 {index} 🌸"),
                "topics": ["检索"],
                "aliases": []
            }),
        );
    }
    let mut seen: Vec<String> = Vec::new();
    let mut offset = 0;
    loop {
        let page = helper.ok(
            &format!("q{offset}"),
            "card.search",
            json!({ "query": "图谱", "offset": offset, "limit": 2 }),
        );
        assert_eq!(page["total"], 5);
        for item in page["items"].as_array().unwrap() {
            seen.push(item["id"].as_str().unwrap().to_string());
        }
        if page["hasMore"] == false {
            break;
        }
        offset = page["nextOffset"].as_u64().unwrap();
        assert!(offset > 0);
    }
    seen.sort();
    seen.dedup();
    assert_eq!(
        seen.len(),
        5,
        "every card must appear exactly once: {seen:?}"
    );
}
