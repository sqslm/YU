//! Stage-2 checks against the real helper: multi-channel input, the settling
//! window, dedupe, exclusions, pause and the one-off history job.
//!
//! Everything here runs over real pipes and real SQLite files; the only
//! shortcut is `YU_KNOWLEDGE_STABLE_MS`, which shortens the window the product
//! waits by default.

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
            "yu-knowledge-stage2-{tag}-{}-{nanos}",
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
    fn start(root: &Path, stable_ms: u64) -> Helper {
        let mut command = Command::new(env!("CARGO_BIN_EXE_yu-knowledge"));
        command
            .arg("--root")
            .arg(root)
            .env("YU_KNOWLEDGE_STABLE_MS", stable_ms.to_string())
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

    fn recv(&mut self) -> Value {
        let mut line = String::new();
        let read = self.out.read_line(&mut line).unwrap();
        assert!(read > 0, "the helper closed its stdout");
        serde_json::from_str(line.trim_end()).unwrap()
    }

    fn call(&mut self, id: &str, method: &str, params: Value) -> Value {
        let frame =
            json!({ "v": 1, "type": "request", "id": id, "method": method, "params": params });
        let mut line = serde_json::to_vec(&frame).unwrap();
        line.push(b'\n');
        let stdin = self.stdin.as_mut().unwrap();
        stdin.write_all(&line).unwrap();
        stdin.flush().unwrap();
        loop {
            let frame = self.recv();
            if frame["type"] == "result" && frame["id"] == id {
                return frame;
            }
        }
    }

    fn ok(&mut self, id: &str, method: &str, params: Value) -> Value {
        let frame = self.call(id, method, params);
        assert_eq!(frame["ok"], true, "{method} failed: {frame}");
        frame["result"].clone()
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

fn publish(channel: &str, kind: &str, origin: &str, group: &str, text: &str, at: i64) -> Value {
    json!({
        "channel": channel,
        "kind": kind,
        "originRef": origin,
        "groupKey": group,
        "title": format!("{group} 标题"),
        "scope": "合成范围",
        "text": text,
        "at": at
    })
}

fn task_of(helper: &mut Helper, id: &str, group: &str) -> Option<Value> {
    let page = helper.ok(id, "queue.list", json!({ "limit": 100 }));
    page["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["groupKey"] == group)
        .cloned()
}

#[test]
fn a_saved_note_becomes_ready_after_the_settling_window() {
    let root = Root::new("window");
    let mut helper = Helper::start(&root, 250);
    let saved = helper.ok(
        "r1",
        "source.publish",
        publish(
            "note",
            "note",
            "note-1:v1",
            "note-1",
            "第一版随记正文",
            now_ms(),
        ),
    );
    assert_eq!(saved["state"], "stabilizing");
    assert_eq!(saved["duplicate"], false);
    assert!(saved["sourceId"].as_str().unwrap().starts_with("src_"));

    let task = task_of(&mut helper, "r2", "note-1").expect("queued");
    assert_eq!(task["state"], "stabilizing");
    assert_eq!(task["channel"], "note");
    assert_eq!(task["items"][0]["originRef"], "note-1:v1");
    assert_eq!(
        task["items"][0]["size"],
        "第一版随记正文".chars().count() as i64
    );

    std::thread::sleep(std::time::Duration::from_millis(320));
    let task = task_of(&mut helper, "r3", "note-1").expect("queued");
    assert_eq!(
        task["state"], "ready",
        "a settled task reads as ready: {task}"
    );
    assert_eq!(task["items"].as_array().unwrap().len(), 1);
}

#[test]
fn republishing_the_same_text_creates_no_second_task() {
    let root = Root::new("dedupe");
    let mut helper = Helper::start(&root, 0);
    let at = now_ms();
    let text = "重复发布的同一段正文";
    let first = helper.ok(
        "r1",
        "source.publish",
        publish("note", "note", "n1", "n1", text, at),
    );
    let second = helper.ok(
        "r2",
        "source.publish",
        publish("note", "note", "n1", "n1", text, at + 10),
    );
    assert_eq!(first["duplicate"], false);
    assert_eq!(second["duplicate"], true);
    assert_eq!(first["sourceId"], second["sourceId"]);
    assert_eq!(first["groupId"], second["groupId"]);
    let status = helper.ok("r3", "queue.status", json!({}));
    assert_eq!(status["total"], 1);
    assert_eq!(status["counts"]["ready"], 1);
}

#[test]
fn a_metadata_only_change_does_not_restart_the_window() {
    let root = Root::new("metadata");
    let mut helper = Helper::start(&root, 200);
    let at = now_ms();
    let text = "同一段正文，只有标题和时间变了";
    helper.ok(
        "r1",
        "source.publish",
        publish("note", "note", "n2", "n2", text, at),
    );
    std::thread::sleep(std::time::Duration::from_millis(260));
    assert_eq!(task_of(&mut helper, "r2", "n2").unwrap()["state"], "ready");

    let again = helper.ok(
        "r3",
        "source.publish",
        publish("note", "note", "n2", "n2", text, at + 5_000),
    );
    assert_eq!(again["duplicate"], true);
    assert_eq!(
        task_of(&mut helper, "r4", "n2").unwrap()["state"],
        "ready",
        "a title or time change must not re-open the window"
    );
}

#[test]
fn every_question_in_one_thread_stays_its_own_item() {
    let root = Root::new("chat");
    let mut helper = Helper::start(&root, 0);
    let at = now_ms();
    helper.ok(
        "r1",
        "source.publish",
        publish(
            "chat",
            "chat",
            "thread-1:m1:m2",
            "thread-1",
            "第一段问答",
            at,
        ),
    );
    helper.ok(
        "r2",
        "source.publish",
        publish(
            "chat",
            "chat",
            "thread-1:m3:m4",
            "thread-1",
            "第二段问答",
            at + 1,
        ),
    );
    let task = task_of(&mut helper, "r3", "thread-1").expect("queued");
    let items = task["items"].as_array().unwrap();
    assert_eq!(items.len(), 2, "one item per question: {task}");
    assert_eq!(items[0]["ordinal"], 0);
    assert_eq!(items[1]["ordinal"], 1);
    assert_eq!(items[0]["originRef"], "thread-1:m1:m2");
}

#[test]
fn an_excluded_source_is_skipped_and_can_be_allowed_again() {
    let root = Root::new("exclude");
    let mut helper = Helper::start(&root, 0);
    helper.ok(
        "r1",
        "exclude.add",
        json!({ "kind": "note", "key": "n3", "reason": "用户排除" }),
    );
    let frame = helper.call(
        "r2",
        "source.publish",
        publish("note", "note", "n3", "n3", "被排除的正文", now_ms()),
    );
    assert_eq!(frame["ok"], false);
    assert_eq!(frame["error"]["code"], "excluded");

    helper.ok(
        "r3",
        "exclude.remove",
        json!({ "kind": "note", "key": "n3" }),
    );
    let saved = helper.ok(
        "r4",
        "source.publish",
        publish("note", "note", "n3", "n3", "被排除的正文", now_ms()),
    );
    assert_eq!(saved["state"], "stabilizing");
    assert_eq!(
        helper
            .ok("r5", "exclude.list", json!({}))
            .as_array()
            .unwrap()
            .len(),
        0
    );
}

#[test]
fn a_disabled_channel_refuses_new_sources() {
    let root = Root::new("channel");
    let mut helper = Helper::start(&root, 0);
    helper.ok("r1", "collect.configure", json!({ "chat": false }));
    let frame = helper.call(
        "r2",
        "source.publish",
        publish(
            "chat",
            "chat",
            "t9:m1:m2",
            "t9",
            "关闭渠道后的问答",
            now_ms(),
        ),
    );
    assert_eq!(frame["error"]["code"], "channel_disabled");
    helper.ok("r3", "collect.configure", json!({ "chat": true }));
    let saved = helper.ok(
        "r4",
        "source.publish",
        publish(
            "chat",
            "chat",
            "t9:m1:m2",
            "t9",
            "关闭渠道后的问答",
            now_ms(),
        ),
    );
    assert_eq!(saved["state"], "stabilizing");
}

#[test]
fn manual_and_game_pauses_stay_independent() {
    let root = Root::new("pause");
    let mut helper = Helper::start(&root, 0);
    helper.ok(
        "r1",
        "queue.pause",
        json!({ "reason": "manual", "paused": true }),
    );
    helper.ok(
        "r2",
        "queue.pause",
        json!({ "reason": "game", "paused": true }),
    );
    let state = helper.ok(
        "r3",
        "queue.pause",
        json!({ "reason": "game", "paused": false }),
    );
    assert_eq!(
        state["pausedManual"], true,
        "a manual pause survives game mode: {state}"
    );
    assert_eq!(state["pausedGame"], false);
    let status = helper.ok("r4", "queue.status", json!({}));
    assert_eq!(status["paused"], true);
    assert_eq!(status["pausedReasons"]["manual"], true);
}

#[test]
fn cancel_and_retry_follow_the_declared_states() {
    let root = Root::new("states");
    let mut helper = Helper::start(&root, 0);
    let saved = helper.ok(
        "r1",
        "source.publish",
        publish("note", "note", "n5", "n5", "可重试的正文", now_ms()),
    );
    let group = saved["groupId"].as_str().unwrap().to_string();
    assert_eq!(
        helper.ok("r2", "queue.cancel", json!({ "groupId": group }))["state"],
        "cancelled"
    );
    let frame = helper.call("r3", "queue.retry", json!({ "groupId": group }));
    assert_eq!(
        frame["ok"], false,
        "a cancelled task is not retryable: {frame}"
    );

    let saved = helper.ok(
        "r4",
        "source.publish",
        publish("note", "note", "n6", "n6", "另一段正文", now_ms()),
    );
    let group = saved["groupId"].as_str().unwrap().to_string();
    helper.ok(
        "r5",
        "queue.needs_reread",
        json!({ "groupId": group, "reason": "暂存逐出" }),
    );
    assert_eq!(
        helper.ok("r6", "queue.retry", json!({ "groupId": group }))["state"],
        "stabilizing"
    );
    assert_eq!(task_of(&mut helper, "r7", "n6").unwrap()["attempts"], 1);
}

#[test]
fn invalidating_a_group_drops_its_pending_work_and_its_sources() {
    let root = Root::new("invalidate");
    let mut helper = Helper::start(&root, 0);
    let saved = helper.ok(
        "r1",
        "source.publish",
        publish("note", "note", "n7", "n7", "随后被删除的正文", now_ms()),
    );
    let group = saved["groupId"].as_str().unwrap().to_string();
    let source = saved["sourceId"].as_str().unwrap().to_string();
    helper.ok(
        "r2",
        "queue.invalidate",
        json!({ "groupId": group, "reason": "note deleted" }),
    );
    let row = helper.ok("r3", "source.get", json!({ "id": source }));
    assert_eq!(row["state"], "invalid");
    assert_eq!(row["invalidReason"], "note deleted");
    assert_eq!(
        task_of(&mut helper, "r4", "n7").unwrap()["state"],
        "cancelled"
    );
}

#[test]
fn history_runs_one_batch_at_a_time_per_scope() {
    let root = Root::new("history");
    let mut helper = Helper::start(&root, 0);
    let begun = helper.ok(
        "r1",
        "history.begin",
        json!({ "notes": true, "chat": true }),
    );
    let job = begun["job"]["id"].as_str().unwrap().to_string();
    assert_eq!(begun["resumed"], false);

    let again = helper.ok(
        "r2",
        "history.begin",
        json!({ "notes": true, "chat": true }),
    );
    assert_eq!(
        again["job"]["id"], job,
        "a second start must not begin a second scan"
    );
    assert_eq!(again["resumed"], true);

    let at = now_ms();
    let stepped = helper.ok(
        "r3",
        "history.step",
        json!({
            "jobId": job,
            "kind": "note",
            "cursor": "note-2",
            "rows": [
                publish("note", "note", "h1", "h1", "历史随记一", at),
                publish("note", "note", "h2", "h2", "历史随记二", at)
            ],
            "done": true
        }),
    );
    assert_eq!(stepped["job"]["scanned"], 2);
    assert_eq!(stepped["job"]["ready"], 2);
    assert_eq!(stepped["job"]["noteCursor"], "note-2");
    assert_eq!(stepped["done"], false, "the chat scope is still open");

    assert_eq!(
        helper.ok("r4", "history.pause", json!({ "jobId": job }))["job"]["state"],
        "paused"
    );
    let blocked = helper.call(
        "r5",
        "history.step",
        json!({ "jobId": job, "kind": "chat", "rows": [], "done": false }),
    );
    assert_eq!(
        blocked["ok"], false,
        "a paused job does not advance: {blocked}"
    );
    assert_eq!(
        helper.ok("r6", "history.resume", json!({ "jobId": job }))["job"]["state"],
        "running"
    );

    let finished = helper.ok(
        "r7",
        "history.step",
        json!({
            "jobId": job,
            "kind": "chat",
            "cursor": "thread-9",
            "rows": [publish("chat", "chat", "thread-8:m1:m2", "thread-8", "历史问答", at)],
            "done": true
        }),
    );
    assert_eq!(finished["done"], true);
    assert_eq!(finished["job"]["state"], "completed");
    assert_eq!(
        helper.ok("r8", "history.latest", json!({}))["job"]["id"],
        job
    );
}
