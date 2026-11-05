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

    /// Ends the process without a shutdown frame, like a real crash.
    fn crash(&mut self) {
        self.stdin.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
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

/// One full learning round: claim, wait for the model, answer, read the result.
fn run_learn(helper: &mut Helper, next_id: &str, run_id: &str, answer: Value) -> Value {
    let next = helper.ok(next_id, "profile.learn.next", json!({}));
    let claim = next["batch"]["claim"].as_str().unwrap().to_string();
    helper.send(
        run_id,
        "profile.learn.run",
        json!({ "claim": claim, "profileId": "fixture-profile", "effort": "high" }),
    );
    let request = helper.recv_model();
    let model_id = request["id"].as_str().unwrap().to_string();
    helper.answer_model(&model_id, &answer.to_string());
    helper.answer(run_id)
}

fn one_item(value: &str, category: &str, quote: &str) -> Value {
    json!({
        "items": [{
            "dimension": if category == "inferred" { "focus" } else { "depth" },
            "category": category,
            "value": value,
            "evidence": [{ "quote": quote }]
        }]
    })
}

#[test]
fn a_hand_written_value_is_a_correction_and_beats_a_late_answer() {
    let root = Root::new("corrected");
    let mut helper = Helper::start(&root);
    let text = "我希望回答先给结论。";
    helper.ok(
        "q1",
        "profile.evidence",
        json!({ "items": [evidence("chat", "t1", "v1", text)] }),
    );
    let result = run_learn(
        &mut helper,
        "n1",
        "r1",
        one_item("先给结论", "explicit", "先给结论"),
    );
    assert_eq!(result["ok"], true, "{result}");
    let id = result["result"]["written"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();

    // The user edits the text by hand and does not flag it: it is still a correction.
    let edited = helper.ok(
        "u1",
        "profile.update",
        json!({ "id": id, "value": "先给结论，再给一行动步骤" }),
    );
    assert_eq!(edited["corrected"], true, "{edited}");
    assert_eq!(edited["value"], "先给结论，再给一行动步骤");

    // A later turn offers the old wording again and the model repeats it.
    helper.ok(
        "q2",
        "profile.evidence",
        json!({ "items": [evidence("chat", "t2", "v1", "还是先给结论吧。")] }),
    );
    let result = run_learn(
        &mut helper,
        "n2",
        "r2",
        one_item("先给结论", "explicit", "先给结论"),
    );
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!(result["result"]["written"].as_array().unwrap().len(), 0);
    assert_eq!(result["result"]["skipped"], json!(1));

    let page = helper.ok("p1", "profile.list", json!({}));
    let items = page["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["value"], "先给结论，再给一行动步骤");
}

#[test]
fn two_interests_coexist_and_an_invented_slot_is_refused() {
    let root = Root::new("slots");
    let mut helper = Helper::start(&root);
    helper.ok(
        "q1",
        "profile.evidence",
        json!({ "items": [evidence("chat", "t1", "v1", "我最近在看 Rust 还有摄影。")] }),
    );
    let answer = json!({
        "items": [
            { "dimension": "focus", "category": "inferred", "value": "Rust",
              "evidence": [{ "quote": "Rust" }] },
            { "dimension": "focus", "category": "inferred", "value": "摄影",
              "evidence": [{ "quote": "摄影" }] }
        ]
    });
    let result = run_learn(&mut helper, "n1", "r1", answer);
    assert_eq!(result["ok"], true, "{result}");
    let written = result["result"]["written"].as_array().unwrap();
    assert_eq!(written.len(), 2, "{result}");
    assert_ne!(written[0]["id"], written[1]["id"]);

    let page = helper.ok("p1", "profile.list", json!({}));
    let items = page["items"].as_array().unwrap();
    let slots: Vec<&str> = items
        .iter()
        .map(|item| item["slot"].as_str().unwrap())
        .collect();
    assert_eq!(slots.len(), 2);
    assert_ne!(slots[0], slots[1], "two interests must not share one slot");

    // An identity the batch never offered is not a slot the answer may use.
    helper.ok(
        "q2",
        "profile.evidence",
        json!({ "items": [evidence("chat", "t2", "v1", "我的兴趣又多了一个。")] }),
    );
    let next = helper.ok("n2", "profile.learn.next", json!({}));
    let claim = next["batch"]["claim"].as_str().unwrap().to_string();
    helper.send(
        "r2",
        "profile.learn.run",
        json!({ "claim": claim, "profileId": "fixture-profile", "effort": "high" }),
    );
    let request = helper.recv_model();
    let model_id = request["id"].as_str().unwrap().to_string();
    helper.answer_model(
        &model_id,
        &json!({
            "items": [{
                "slot": "focus:made-up",
                "dimension": "focus",
                "category": "inferred",
                "value": "另一个兴趣",
                "evidence": [{ "quote": "兴趣" }]
            }]
        })
        .to_string(),
    );
    let refused = helper.answer("r2");
    assert_eq!(refused["ok"], false, "{refused}");
    assert_eq!(refused["error"]["code"], "invalid_output");
    let after = helper.ok("p2", "profile.list", json!({}));
    assert_eq!(after["items"].as_array().unwrap().len(), 2);
}

#[test]
fn a_batch_that_does_not_fit_is_refused_and_nothing_is_dropped() {
    let root = Root::new("capacity");
    let mut helper = Helper::start(&root);
    let mut items = Vec::new();
    for index in 0..200 {
        items.push(evidence(
            "chat",
            &format!("t{index}"),
            "v1",
            "一行很短的证据文本。",
        ));
    }
    helper.ok("q1", "profile.evidence", json!({ "items": items }));
    let status = helper.ok("s1", "profile.status", json!({}));
    assert_eq!(status["pending"], json!(200), "{status}");

    let overflow = helper.ok(
        "q2",
        "profile.evidence",
        json!({ "items": [evidence("chat", "t200", "v1", "第 201 条证据")] }),
    );
    assert_eq!(overflow["queued"], json!(0), "{overflow}");
    assert_eq!(overflow["reason"], json!("capacity"));
    let status = helper.ok("s2", "profile.status", json!({}));
    assert_eq!(status["pending"], json!(200), "nothing waiting was dropped");

    // Everything waiting is learned in one round; only light markers stay behind.
    let result = run_learn(&mut helper, "n1", "r1", json!({ "items": [] }));
    assert_eq!(result["ok"], true, "{result}");
    let status = helper.ok("s3", "profile.status", json!({}));
    assert_eq!(status["pending"], json!(0));

    // Room is measured against the work, so the next piece is accepted.
    let again = helper.ok(
        "q3",
        "profile.evidence",
        json!({ "items": [evidence("chat", "t201", "v1", "第 201 条证据")] }),
    );
    assert_eq!(again["queued"], json!(1), "{again}");
}

#[test]
fn a_cleared_or_retracted_turn_cannot_be_replayed() {
    let root = Root::new("replay");
    let mut helper = Helper::start(&root);
    let text = "我希望回答先给结论。";
    helper.ok(
        "q1",
        "profile.evidence",
        json!({ "items": [evidence("chat", "t1", "v1", text)] }),
    );
    helper.ok("c1", "profile.clear", json!({}));
    let replay = helper.ok(
        "q2",
        "profile.evidence",
        json!({ "items": [evidence("chat", "t1", "v1", text)] }),
    );
    assert_eq!(replay["queued"], json!(0), "{replay}");
    let status = helper.ok("s1", "profile.status", json!({}));
    assert_eq!(status["pending"], json!(0));

    helper.ok(
        "q3",
        "profile.evidence",
        json!({ "items": [evidence("chat", "t2", "v1", "另一段要撤回的话。")] }),
    );
    helper.ok(
        "r1",
        "profile.retract",
        json!({ "sourceKind": "chat", "sourceId": "t2", "reason": "用户删除了这段对话" }),
    );
    let replay = helper.ok(
        "q4",
        "profile.evidence",
        json!({ "items": [evidence("chat", "t2", "v1", "另一段要撤回的话。")] }),
    );
    assert_eq!(replay["queued"], json!(0), "{replay}");
    let result = run_learn_or_empty(&mut helper);
    assert_eq!(result["pending"], json!(0));
}

/// A round that may have nothing to learn, returning the status instead.
fn run_learn_or_empty(helper: &mut Helper) -> Value {
    let next = helper.ok("n9", "profile.learn.next", json!({}));
    assert!(next["batch"].is_null(), "{next}");
    helper.ok("s9", "profile.status", json!({}))
}

#[test]
fn an_old_observation_is_not_recent_but_a_stable_preference_stays() {
    let root = Root::new("window");
    let mut helper = Helper::start(&root);
    let old = now_ms() - 31 * 86_400_000;
    let mut focus = evidence("chat", "t1", "v1", "我最近在关注性能优化。");
    focus["at"] = json!(old);
    let mut depth = evidence("chat", "t2", "v1", "回答请尽量简短。");
    depth["at"] = json!(old);
    helper.ok("q1", "profile.evidence", json!({ "items": [focus, depth] }));
    let answer = json!({
        "items": [
            { "dimension": "focus", "category": "inferred", "value": "性能优化",
              "evidence": [{ "quote": "性能优化" }] },
            { "dimension": "depth", "category": "explicit", "value": "回答请尽量简短",
              "evidence": [{ "quote": "回答请尽量简短" }] }
        ]
    });
    let result = run_learn(&mut helper, "n1", "r1", answer);
    assert_eq!(result["ok"], true, "{result}");

    let context = helper.ok("c1", "profile.context", json!({}));
    let text = context["text"].as_str().unwrap().to_string();
    assert!(text.contains("回答请尽量简短"), "{text}");
    assert!(!text.contains("性能优化"), "{text}");

    // Usage is readable by category, without any of the user's own text.
    helper.ok(
        "e1",
        "profile.event",
        json!({ "opId": "chat:t1:a1", "feature": "chat" }),
    );
    let context = helper.ok("c2", "profile.context", json!({}));
    let text = context["text"].as_str().unwrap().to_string();
    assert!(text.contains("近期常用：chat"), "{text}");
}

#[test]
fn a_pause_freezes_counting_and_queueing_until_it_resumes() {
    let root = Root::new("pause");
    let mut helper = Helper::start(&root);
    helper.ok(
        "p1",
        "profile.pause",
        json!({ "paused": true, "reason": "manual" }),
    );
    let event = helper.ok(
        "e1",
        "profile.event",
        json!({ "opId": "note:n1", "feature": "note" }),
    );
    assert_eq!(event["counted"], false, "{event}");
    let queued = helper.ok(
        "q1",
        "profile.evidence",
        json!({ "items": [evidence("chat", "t1", "v1", "暂停期间的证据。")] }),
    );
    assert_eq!(queued["queued"], json!(0), "{queued}");
    let status = helper.ok("s1", "profile.status", json!({}));
    assert_eq!(status["usageTotal"], json!(0));

    helper.ok(
        "p2",
        "profile.pause",
        json!({ "paused": false, "reason": "manual" }),
    );
    let queued = helper.ok(
        "q2",
        "profile.evidence",
        json!({ "items": [evidence("chat", "t1", "v1", "暂停期间的证据。")] }),
    );
    assert_eq!(queued["queued"], json!(1), "{queued}");
    let event = helper.ok(
        "e2",
        "profile.event",
        json!({ "opId": "note:n2", "feature": "note" }),
    );
    assert_eq!(event["counted"], true, "{event}");
}

#[test]
fn a_real_failure_is_retried_only_through_the_production_entry() {
    let root = Root::new("retry");
    let mut helper = Helper::start(&root);
    helper.ok(
        "q1",
        "profile.evidence",
        json!({ "items": [evidence("chat", "t1", "v1", "我更习惯晚上写代码。")] }),
    );
    let next = helper.ok("n1", "profile.learn.next", json!({}));
    let claim = next["batch"]["claim"].as_str().unwrap().to_string();
    helper.send(
        "r1",
        "profile.learn.run",
        json!({ "claim": claim.clone(), "profileId": "fixture-profile", "effort": "high" }),
    );
    let request = helper.recv_model();
    let model_id = request["id"].as_str().unwrap().to_string();
    helper.fail_model(&model_id, "internal");
    let failed = helper.answer("r1");
    assert_eq!(failed["ok"], false, "{failed}");
    helper.ok(
        "f1",
        "profile.learn.fail",
        json!({ "claim": claim, "code": "internal", "reason": "合成的模型失败" }),
    );
    let status = helper.ok("s1", "profile.status", json!({}));
    assert_eq!(status["pending"], json!(0));
    // The stuck work is visible, with its reason, without reading the queue.
    assert_eq!(status["failed"], json!(1), "{status}");
    assert_eq!(
        status["failedItems"][0]["reason"],
        json!("合成的模型失败"),
        "{status}"
    );
    assert_eq!(status["failedItems"][0]["chars"], json!(10), "{status}");

    let retried = helper.ok("t1", "profile.retry", json!({}));
    assert_eq!(retried["retried"], json!(1), "{retried}");
    let status = helper.ok("s2", "profile.status", json!({}));
    assert_eq!(status["pending"], json!(1));
    assert_eq!(status["failed"], json!(0));
    assert_eq!(status["failedItems"], json!([]));
    let result = run_learn(
        &mut helper,
        "n2",
        "r2",
        one_item("晚上写代码", "inferred", "晚上写代码"),
    );
    assert_eq!(result["ok"], true, "{result}");
}

#[test]
fn a_removed_preference_is_named_to_the_model_and_refused_when_it_returns() {
    let root = Root::new("removed");
    let mut helper = Helper::start(&root);
    helper.ok(
        "q1",
        "profile.evidence",
        json!({ "items": [evidence("chat", "t1", "v1", "回答尽量简短。")] }),
    );
    let learned = run_learn(
        &mut helper,
        "n1",
        "r1",
        one_item("回答尽量简短", "explicit", "回答尽量简短"),
    );
    let id = learned["result"]["written"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    helper.ok("d1", "profile.delete", json!({ "id": id }));

    helper.ok(
        "q2",
        "profile.evidence",
        json!({ "items": [evidence("chat", "t2", "v1", "还是简短点更好。")] }),
    );
    let next = helper.ok("n2", "profile.learn.next", json!({}));
    let claim = next["batch"]["claim"].as_str().unwrap().to_string();
    helper.send(
        "r2",
        "profile.learn.run",
        json!({ "claim": claim, "profileId": "fixture-profile", "effort": "high" }),
    );
    let request = helper.recv_model();
    let prompt = request["messages"].to_string();
    // The model is told what the user removed, so it can stay away from it.
    assert!(prompt.contains("回答尽量简短"), "{prompt}");
    let model_id = request["id"].as_str().unwrap().to_string();
    helper.answer_model(
        &model_id,
        &one_item("回答尽量简短", "explicit", "简短").to_string(),
    );
    let run = helper.answer("r2");
    assert_eq!(
        run["result"]["written"].as_array().map(|rows| rows.len()),
        Some(0),
        "{run}"
    );
    let context = helper.ok("c1", "profile.context", json!({}));
    assert!(
        !context["text"]
            .as_str()
            .unwrap_or("")
            .contains("回答尽量简短")
    );
}

#[test]
fn an_interrupted_batch_becomes_retryable_after_a_real_crash() {
    let root = Root::new("crash");
    let mut helper = Helper::start(&root);
    helper.ok(
        "q1",
        "profile.evidence",
        json!({ "items": [evidence("chat", "t1", "v1", "我更习惯晚上写代码。")] }),
    );
    let next = helper.ok("n1", "profile.learn.next", json!({}));
    assert!(next["batch"]["claim"].is_string(), "{next}");
    // The process dies with the batch still claimed as working.
    helper.crash();

    let mut again = Helper::start(&root);
    let status = again.ok("s1", "profile.status", json!({}));
    assert_eq!(status["pending"], json!(0), "{status}");
    assert_eq!(status["failed"], json!(1), "{status}");
    assert_eq!(
        status["failedItems"][0]["reason"],
        json!("助手中断，需重试"),
        "{status}"
    );
    let retried = again.ok("t1", "profile.retry", json!({}));
    assert_eq!(retried["retried"], json!(1), "{retried}");
    let status = again.ok("s2", "profile.status", json!({}));
    assert_eq!(status["pending"], json!(1), "{status}");
    assert_eq!(status["failed"], json!(0), "{status}");
    let result = run_learn(
        &mut again,
        "n2",
        "r2",
        one_item("晚上写代码", "inferred", "晚上写代码"),
    );
    assert_eq!(result["ok"], true, "{result}");
}
