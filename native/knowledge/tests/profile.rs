//! Stage-4 checks against the real helper: the independent profile switch, the
//! idempotent usage counters, the bounded queue of the user's own sentences, the
//! learning transaction, the barriered clear and the readable context.
//!
//! Everything runs over real pipes and real SQLite files. The only shortcut is
//! `YU_PROFILE_LEARN_MS`, which shortens the merge window the product waits by.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{Value, json};

struct Root(std::path::PathBuf);

impl Root {
    fn new(tag: &str) -> Root {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "yu-knowledge-stage4-{tag}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).unwrap();
        Root(path)
    }
}

impl std::ops::Deref for Root {
    type Target = Path;

    fn deref(&self) -> &Path {
        &self.0
    }
}

impl Drop for Root {
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
    fn spawn(root: &Path) -> Helper {
        let mut command = Command::new(env!("CARGO_BIN_EXE_yu-knowledge"));
        command
            .arg("--root")
            .arg(root)
            .env("YU_PROFILE_LEARN_MS", "0")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().unwrap();
        let stdin = child.stdin.take();
        let out = BufReader::new(child.stdout.take().unwrap());
        let mut helper = Helper { child, stdin, out };
        let ready = helper.recv();
        assert_eq!(ready["type"], "ready", "{ready}");
        helper
    }

    /// A helper with the switches the shipped defaults leave off turned on.
    fn start(root: &Path) -> Helper {
        let mut helper = Helper::spawn(root);
        helper.ok(
            "cfg",
            "profile.configure",
            json!({ "enabled": true, "usage": true, "chat": true }),
        );
        helper
    }

    fn recv(&mut self) -> Value {
        let mut line = String::new();
        let read = self.out.read_line(&mut line).unwrap();
        assert!(read > 0, "the helper closed its stdout");
        serde_json::from_str(line.trim_end()).unwrap()
    }

    fn write(&mut self, frame: Value) {
        let mut line = serde_json::to_vec(&frame).unwrap();
        line.push(b'\n');
        let stdin = self.stdin.as_mut().unwrap();
        stdin.write_all(&line).unwrap();
        stdin.flush().unwrap();
    }

    fn send(&mut self, id: &str, method: &str, params: Value) {
        self.write(
            json!({ "v": 1, "type": "request", "id": id, "method": method, "params": params }),
        );
    }

    fn answer(&mut self, id: &str) -> Value {
        loop {
            let frame = self.recv();
            if frame["type"] == "result" && frame["id"] == id {
                return frame;
            }
        }
    }

    fn call(&mut self, id: &str, method: &str, params: Value) -> Value {
        self.send(id, method, params);
        self.answer(id)
    }

    fn ok(&mut self, id: &str, method: &str, params: Value) -> Value {
        let frame = self.call(id, method, params);
        assert_eq!(frame["ok"], true, "{method} failed: {frame}");
        frame["result"].clone()
    }

    /// Waits for the model request the helper issues while learning.
    fn recv_model(&mut self) -> Value {
        loop {
            let frame = self.recv();
            if frame["type"] == "model.request" {
                return frame;
            }
        }
    }

    fn answer_model(&mut self, id: &str, text: &str) {
        self.write(json!({ "v": 1, "type": "model.result", "id": id, "ok": true, "text": text }));
    }

    fn fail_model(&mut self, id: &str, code: &str) {
        self.write(json!({
            "v": 1,
            "type": "model.result",
            "id": id,
            "ok": false,
            "error": { "code": code, "message": "合成的失败" }
        }));
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn evidence(kind: &str, id: &str, version: &str, text: &str) -> Value {
    json!({
        "sourceKind": kind,
        "sourceId": id,
        "version": version,
        "originRef": format!("{id}:{version}"),
        "locator": "合成来源",
        "text": text
    })
}

#[test]
fn nothing_is_collected_until_the_profile_switch_is_on() {
    let root = Root::new("off");
    let mut helper = Helper::spawn(&root);
    let status = helper.ok("s1", "profile.status", json!({}));
    assert_eq!(status["enabled"], false);
    assert_eq!(status["usageTotal"], 0);

    let counted = helper.ok(
        "e1",
        "profile.event",
        json!({ "opId": "op-1", "feature": "chat" }),
    );
    assert_eq!(counted["counted"], false);

    let queued = helper.ok(
        "q1",
        "profile.evidence",
        json!({ "items": [evidence("chat", "t1", "v1", "我想把语音输入练熟")] }),
    );
    assert_eq!(queued["queued"], 0);

    let next = helper.ok("n1", "profile.learn.next", json!({}));
    assert_eq!(next["batch"], Value::Null);
}

#[test]
fn a_repeated_operation_is_counted_once() {
    let root = Root::new("usage");
    let mut helper = Helper::start(&root);
    let first = helper.ok(
        "e1",
        "profile.event",
        json!({ "opId": "op-1", "feature": "chat", "at": now_ms() }),
    );
    assert_eq!(first["counted"], true);
    let again = helper.ok(
        "e2",
        "profile.event",
        json!({ "opId": "op-1", "feature": "chat", "at": now_ms() }),
    );
    assert_eq!(again["counted"], false);

    let status = helper.ok("s1", "profile.status", json!({}));
    assert_eq!(status["usageTotal"], 1);
}

#[test]
fn evidence_needs_the_chat_switch_and_is_not_duplicated() {
    let root = Root::new("evidence");
    let mut helper = Helper::spawn(&root);
    helper.ok(
        "cfg",
        "profile.configure",
        json!({ "enabled": true, "chat": false }),
    );
    let refused = helper.ok(
        "q1",
        "profile.evidence",
        json!({ "items": [evidence("chat", "t1", "v1", "我更喜欢先看结论")] }),
    );
    assert_eq!(refused["queued"], 0);

    helper.ok("cfg2", "profile.configure", json!({ "chat": true }));
    let queued = helper.ok(
        "q2",
        "profile.evidence",
        json!({ "items": [evidence("chat", "t1", "v1", "我更喜欢先看结论")] }),
    );
    assert_eq!(queued["queued"], 1);
    let again = helper.ok(
        "q3",
        "profile.evidence",
        json!({ "items": [evidence("chat", "t1", "v1", "我更喜欢先看结论")] }),
    );
    assert_eq!(again["queued"], 0);
}

#[test]
fn learning_writes_a_traceable_item_and_clears_the_queue() {
    let root = Root::new("learn");
    let mut helper = Helper::start(&root);
    let text = "我平时用语音写代码笔记，希望回答先给结论再展开细节。";
    helper.ok(
        "q1",
        "profile.evidence",
        json!({ "items": [evidence("chat", "t1", "v1", text)] }),
    );
    let next = helper.ok("n1", "profile.learn.next", json!({}));
    assert_eq!(next["enabled"], true);
    let claim = next["batch"]["claim"].as_str().unwrap().to_string();
    assert_eq!(next["batch"]["items"].as_array().unwrap().len(), 1);

    helper.send(
        "r1",
        "profile.learn.run",
        json!({ "claim": claim, "profileId": "fixture-profile", "effort": "high" }),
    );
    let request = helper.recv_model();
    let model_id = request["id"].as_str().unwrap().to_string();
    assert!(
        request["messages"][1]["content"]
            .as_str()
            .unwrap()
            .contains("先给结论")
    );
    helper.answer_model(
        &model_id,
        &json!({
            "items": [{
                "dimension": "depth",
                "category": "explicit",
                "value": "希望回答先给结论再展开细节",
                "evidence": [{ "quote": "希望回答先给结论再展开细节" }]
            }]
        })
        .to_string(),
    );
    let result = helper.answer("r1");
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!(result["result"]["written"].as_array().unwrap().len(), 1);

    let page = helper.ok("p1", "profile.list", json!({ "limit": 10 }));
    let items = page["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["origin"], "auto");
    assert_eq!(items[0]["category"], "explicit");
    assert!(items[0]["slot"].as_str().unwrap().contains("depth"));
    assert_eq!(
        items[0]["evidence"][0]["locator"],
        json!("希望回答先给结论再展开细节")
    );

    let status = helper.ok("s1", "profile.status", json!({}));
    assert_eq!(status["pending"], 0);
    let context = helper.ok("c1", "profile.context", json!({}));
    assert!(context["text"].as_str().unwrap().contains("先给结论"));
}

#[test]
fn a_quote_that_is_not_in_the_input_is_refused() {
    let root = Root::new("quote");
    let mut helper = Helper::start(&root);
    let text = "我最近在整理一个语音输入的插件。";
    helper.ok(
        "q1",
        "profile.evidence",
        json!({ "items": [evidence("chat", "t1", "v1", text)] }),
    );
    let next = helper.ok("n1", "profile.learn.next", json!({}));
    let claim = next["batch"]["claim"].as_str().unwrap().to_string();
    helper.send(
        "r1",
        "profile.learn.run",
        json!({ "claim": claim, "profileId": "p" }),
    );
    let model_id = helper.recv_model()["id"].as_str().unwrap().to_string();
    helper.answer_model(
        &model_id,
        &json!({
            "items": [{
                "dimension": "project",
                "category": "observed",
                "value": "在做语音输入插件",
                "evidence": [{ "quote": "我是一名医生" }]
            }]
        })
        .to_string(),
    );
    let result = helper.answer("r1");
    assert_eq!(result["ok"], false, "{result}");
    assert_eq!(result["error"]["code"], "invalid_output");

    let failed = helper.ok(
        "f1",
        "profile.learn.fail",
        json!({ "claim": claim, "code": "invalid_output", "reason": "引文不在输入里" }),
    );
    assert_eq!(failed["released"], 1);
    let page = helper.ok("p1", "profile.list", json!({}));
    assert_eq!(page["items"].as_array().unwrap().len(), 0);
}

#[test]
fn a_pinned_item_survives_an_automatic_restatement() {
    let root = Root::new("pinned");
    let mut helper = Helper::start(&root);
    let saved = helper.ok(
        "m1",
        "profile.save",
        json!({
            "dimension": "depth",
            "value": "回答要短",
            "category": "explicit",
            "pinned": true,
            "origin": "manual"
        }),
    );
    assert_eq!(saved["pinned"], true);
    let text = "以后回答请尽量简短一些。";
    helper.ok(
        "q1",
        "profile.evidence",
        json!({ "items": [evidence("chat", "t1", "v1", text)] }),
    );
    let next = helper.ok("n1", "profile.learn.next", json!({}));
    let claim = next["batch"]["claim"].as_str().unwrap().to_string();
    helper.send(
        "r1",
        "profile.learn.run",
        json!({ "claim": claim, "profileId": "p" }),
    );
    let model_id = helper.recv_model()["id"].as_str().unwrap().to_string();
    helper.answer_model(
        &model_id,
        &json!({
            "items": [{
                "dimension": "depth",
                "slot": saved["slot"],
                "category": "explicit",
                "value": "回答要短，先给结论",
                "evidence": [{ "quote": "回答请尽量简短一些" }]
            }]
        })
        .to_string(),
    );
    let result = helper.answer("r1");
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!(result["result"]["skipped"], 1);

    let page = helper.ok("p1", "profile.list", json!({}));
    let items = page["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["value"], "回答要短");
    assert_eq!(items[0]["pinned"], true);
}

#[test]
fn clearing_raises_a_barrier_and_drops_everything_this_module_owns() {
    let root = Root::new("clear");
    let mut helper = Helper::start(&root);
    helper.ok(
        "m1",
        "profile.save",
        json!({ "dimension": "goal", "value": "把笔记整理干净", "category": "explicit" }),
    );
    helper.ok(
        "q1",
        "profile.evidence",
        json!({ "items": [evidence("chat", "t9", "v1", "我想先把笔记整理干净。")] }),
    );
    let cleared = helper.ok("c1", "profile.clear", json!({}));
    assert_eq!(cleared["cleared"], true);
    assert_eq!(cleared["items"], 1);
    assert!(cleared["epoch"].as_i64().unwrap() >= 1);

    let status = helper.ok("s1", "profile.status", json!({}));
    assert_eq!(status["items"], 0);
    assert_eq!(status["pending"], 0);
    assert_eq!(status["usageTotal"], 0);
    let context = helper.ok("c2", "profile.context", json!({}));
    assert_eq!(context["text"], "");
}

#[test]
fn retracting_a_source_drops_its_pending_text() {
    let root = Root::new("retract");
    let mut helper = Helper::start(&root);
    helper.ok(
        "q1",
        "profile.evidence",
        json!({ "items": [evidence("chat", "t5", "v1", "这个话题先不聊了。")] }),
    );
    let retracted = helper.ok(
        "r1",
        "profile.retract",
        json!({ "sourceKind": "chat", "sourceId": "t5", "reason": "thread deleted" }),
    );
    assert_eq!(retracted["dropped"], 1);
    let status = helper.ok("s1", "profile.status", json!({}));
    assert_eq!(status["pending"], 0);
}

#[test]
fn a_schema_one_profile_database_keeps_its_manual_items() {
    let root = Root::new("migrate");
    let dir = root.join("data").join("profile");
    std::fs::create_dir_all(&dir).unwrap();
    {
        let connection = rusqlite::Connection::open(dir.join("profile.db")).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE profile_items (
                   id TEXT PRIMARY KEY, dimension TEXT NOT NULL, value TEXT NOT NULL,
                   category TEXT NOT NULL CHECK (category IN ('explicit','observed','inferred')),
                   origin TEXT NOT NULL CHECK (origin IN ('manual','auto')),
                   pinned INTEGER NOT NULL DEFAULT 0, corrected INTEGER NOT NULL DEFAULT 0,
                   created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                   UNIQUE (dimension, value));
                 CREATE INDEX profile_items_updated ON profile_items (updated_at DESC);
                 CREATE TABLE profile_evidence (
                   item_id TEXT NOT NULL REFERENCES profile_items(id) ON DELETE CASCADE,
                   source_kind TEXT NOT NULL, source_id TEXT NOT NULL,
                   origin_ref TEXT NOT NULL DEFAULT '', locator TEXT NOT NULL DEFAULT '',
                   created_at INTEGER NOT NULL,
                   PRIMARY KEY (item_id, source_kind, source_id));
                 CREATE TABLE exclusions (
                   kind TEXT NOT NULL, key TEXT NOT NULL,
                   reason TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
                   PRIMARY KEY (kind, key));
                 INSERT INTO profile_items
                   (id, dimension, value, category, origin, pinned, corrected, created_at, updated_at)
                   VALUES ('prof_old', 'depth', '先给结论', 'explicit', 'manual', 1, 0, 1, 1);
                 PRAGMA user_version = 1;",
            )
            .unwrap();
    }
    let mut helper = Helper::start(&root);
    let page = helper.ok("p1", "profile.list", json!({}));
    let items = page["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["value"], "先给结论");
    assert_eq!(items[0]["pinned"], true);
    assert_eq!(items[0]["slot"], "depth");
    let context = helper.ok("c1", "profile.context", json!({}));
    assert!(context["text"].as_str().unwrap().contains("先给结论"));
}

#[test]
fn the_context_is_bounded_and_lists_protected_items_first() {
    let root = Root::new("context");
    let mut helper = Helper::start(&root);
    helper.ok(
        "m1",
        "profile.save",
        json!({
            "dimension": "goal",
            "value": "把知识库整理成可检索的笔记",
            "category": "explicit",
            "pinned": true
        }),
    );
    for index in 0..40 {
        helper.ok(
            &format!("m{}", index + 2),
            "profile.save",
            json!({
                "dimension": "focus",
                "value": format!("关注点 {index} 的一段描述文字"),
                "category": "inferred"
            }),
        );
    }
    let context = helper.ok("c1", "profile.context", json!({}));
    let text = context["text"].as_str().unwrap();
    assert!(
        text.chars().count() <= 2_000,
        "context is {} chars",
        text.chars().count()
    );
    assert!(text.starts_with("- 把知识库整理成可检索的笔记"));
    assert!(context["items"].as_array().unwrap().len() < 41);
}

#[test]
fn a_model_failure_releases_the_batch_as_a_retryable_failure() {
    let root = Root::new("modelfail");
    let mut helper = Helper::start(&root);
    helper.ok(
        "q1",
        "profile.evidence",
        json!({ "items": [evidence("chat", "t7", "v1", "我更习惯晚上写代码。")] }),
    );
    let next = helper.ok("n1", "profile.learn.next", json!({}));
    let claim = next["batch"]["claim"].as_str().unwrap().to_string();
    helper.send(
        "r1",
        "profile.learn.run",
        json!({ "claim": claim, "profileId": "p" }),
    );
    let model_id = helper.recv_model()["id"].as_str().unwrap().to_string();
    helper.fail_model(&model_id, "model_unavailable");
    let result = helper.answer("r1");
    assert_eq!(result["ok"], false, "{result}");
    assert_eq!(result["error"]["code"], "model_unavailable");

    let released = helper.ok(
        "f1",
        "profile.learn.fail",
        json!({ "claim": claim, "code": "model_unavailable", "reason": "供应商失败" }),
    );
    assert_eq!(released["released"], 1);
    let status = helper.ok("s1", "profile.status", json!({}));
    assert_eq!(status["items"], 0);
}
