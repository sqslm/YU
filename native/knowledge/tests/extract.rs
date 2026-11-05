//! Stage 3 extraction driven through the real helper over a real pipe.
//!
//! The helper is the production binary; the only thing faked is the model, which
//! answers the `model.request` frames the helper writes — exactly what the
//! Electron host does with a provider client. The main process is faked too: the
//! test reads the character ranges `extract.next` asks for out of its own copy of
//! the body, which is what keeps the pipe bounded.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{Value, json};

use yu_knowledge::util::sha256_hex;

struct Root(PathBuf);

impl Root {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "yu-knowledge-extract-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("root");
        Self(path)
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

/// A scripted model: it answers every `model.request` frame with the next canned
/// answer and records the prompts it was shown.
struct Helper {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    answers: Vec<String>,
    prompts: Vec<String>,
    counter: u64,
    version: String,
    source_id: String,
    fingerprint: String,
    card_id: String,
}

impl Helper {
    fn start(root: &Path, answers: Vec<String>) -> Self {
        Self::start_with(root, answers, true)
    }

    fn start_with(root: &Path, answers: Vec<String>, enabled: bool) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_yu-knowledge"))
            .arg("--root")
            .arg(root)
            .env("YU_KNOWLEDGE_STABLE_MS", "0")
            .env("YU_KNOWLEDGE_IDLE_MS", "60000")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("helper starts");
        let stdin = child.stdin.take().expect("stdin");
        let stdout = BufReader::new(child.stdout.take().expect("stdout"));
        let mut helper = Self {
            child,
            stdin,
            stdout,
            answers,
            prompts: Vec::new(),
            counter: 0,
            version: String::new(),
            source_id: String::new(),
            fingerprint: String::new(),
            card_id: String::new(),
        };
        let ready = helper.recv();
        assert_eq!(ready["type"], "ready", "helper must report ready: {ready}");
        if enabled {
            helper.ok("cfg", "collect.configure", json!({"enabled": true}));
        }
        helper
    }

    fn send(&mut self, frame: Value) {
        let line = serde_json::to_string(&frame).expect("frame");
        writeln!(self.stdin, "{line}").expect("write");
        self.stdin.flush().expect("flush");
    }

    fn answer_model(&mut self, frame: &Value) {
        let prompt = frame["messages"][1]["content"]
            .as_str()
            .unwrap_or("")
            .to_string();
        self.prompts.push(prompt);
        let answer = self
            .answers
            .remove(0)
            .replace("\"src/1\"", &format!("\"{}\"", self.source_id))
            .replace("\"src/2\"", &format!("\"{}\"", self.source_id))
            .replace("\"CARD/1\"", &format!("\"{}\"", self.card_id));
        let id = frame["id"].as_str().expect("model id").to_string();
        self.send(json!({"v": 1, "type": "model.result", "id": id, "ok": true, "text": answer}));
    }

    fn read(&mut self) -> Value {
        let mut line = String::new();
        let read = self.stdout.read_line(&mut line).expect("read");
        assert!(read > 0, "helper closed the pipe");
        serde_json::from_str(&line).expect("json")
    }

    fn recv(&mut self) -> Value {
        loop {
            let frame = self.read();
            if frame["type"] == "model.request" {
                self.answer_model(&frame);
                continue;
            }
            if frame["type"] == "changed" {
                continue;
            }
            return frame;
        }
    }

    /// Reads until the next model request, without answering it.
    fn recv_model(&mut self) -> Value {
        loop {
            let frame = self.read();
            if frame["type"] == "model.request" {
                return frame;
            }
            assert_ne!(frame["type"], "result", "unexpected result: {frame}");
        }
    }

    fn call(&mut self, id: &str, method: &str, params: Value) -> Value {
        self.send(json!({"v": 1, "type": "request", "id": id, "method": method, "params": params}));
        self.recv()
    }

    fn ok(&mut self, id: &str, method: &str, params: Value) -> Value {
        let answer = self.call(id, method, params);
        assert_eq!(answer["ok"], true, "{method} failed: {answer}");
        answer["result"].clone()
    }

    fn next_id(&mut self) -> String {
        self.counter += 1;
        format!("r{}", self.counter)
    }

    fn publish(&mut self, group: &str, text: &str) -> Value {
        let id = self.next_id();
        let result = self.ok(
            &id,
            "source.publish",
            json!({
                "channel": "note",
                "kind": "note",
                "originRef": group,
                "groupKey": group,
                "title": group,
                "scope": "notes",
                "text": text,
                "at": 1_700_000_000_000i64,
            }),
        );
        self.version = result["version"].as_str().expect("version").to_string();
        self.source_id = result["sourceId"].as_str().expect("sourceId").to_string();
        self.fingerprint = result["fingerprint"]
            .as_str()
            .expect("fingerprint")
            .to_string();
        result
    }

    /// Builds the `extract.run` items for a claimed group from the test's own copy
    /// of the bodies, exactly as the main process does.
    fn items(group: &Value, bodies: &[(String, String, String)]) -> (Value, usize) {
        let mut items = Vec::new();
        let mut bytes = 0;
        for item in group["items"].as_array().expect("items") {
            let source_id = item["sourceId"].as_str().expect("sourceId");
            let (_, fingerprint, text) = bodies
                .iter()
                .find(|(id, _, _)| id == source_id)
                .expect("body for the planned source");
            let chars: Vec<char> = text.chars().collect();
            let start = item["start"].as_u64().expect("start") as usize;
            let end = item["end"].as_u64().expect("end") as usize;
            let slice: String = chars[start..end].iter().collect();
            bytes += slice.len();
            items.push(json!({
                "sourceId": source_id,
                "version": item["version"],
                "fingerprint": fingerprint,
                "segment": item["segment"],
                "start": item["start"],
                "end": item["end"],
                "text": slice,
            }));
        }
        (Value::Array(items), bytes)
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn drafts_answer(cards: Value) -> String {
    json!({"cards": cards, "reason": "ok"}).to_string()
}

fn card(title: &str, body: &str, source: &str) -> Value {
    json!({
        "kind": "concept",
        "title": title,
        "summary": format!("{title}的摘要"),
        "body": body,
        "topics": ["知识"],
        "aliases": [],
        "sources": [{"sourceId": source, "segment": 0}],
        "reason": "可复用",
    })
}

const BODY: &str =
    "这张卡片说明了知识提炼的结论、适用条件与关键机制，并标出哪些内容是待验证的推断。";

/// Publishes one note, claims it and runs the single batch.
fn extract_one(helper: &mut Helper, group: &str, text: &str, id_prefix: &str) -> Value {
    let published = helper.publish(group, text);
    let fingerprint = published["fingerprint"]
        .as_str()
        .expect("fingerprint")
        .to_string();
    let next = helper.ok(&format!("{id_prefix}-next"), "extract.next", json!({}));
    let claimed = next["group"].clone();
    let (items, _) = Helper::items(
        &claimed,
        &[(helper.source_id.clone(), fingerprint, text.to_string())],
    );
    helper.ok(
        &format!("{id_prefix}-run"),
        "extract.run",
        json!({
            "groupId": claimed["groupId"],
            "claim": claimed["claim"],
            "items": items,
        }),
    )
}

#[test]
fn a_stable_source_is_extracted_into_a_card() {
    let root = Root::new("happy");
    let mut helper = Helper::start(
        &root,
        vec![drafts_answer(json!([card("知识提炼", BODY, "src/1")]))],
    );
    let outcome = extract_one(&mut helper, "note-a", "这是一段等待提炼的正文。", "n");
    assert_eq!(outcome["state"], "completed", "{outcome}");
    assert_eq!(outcome["cards"].as_array().expect("cards").len(), 1);
    assert_eq!(outcome["remaining"], false);
    assert!(helper.prompts[0].contains("这是一段等待提炼的正文。"));

    let listed = helper.ok("l1", "card.list", json!({}));
    assert_eq!(listed["total"], 1, "{listed}");
    let card_id = listed["items"][0]["id"].as_str().expect("card").to_string();
    let full = helper.ok("l2", "card.get", json!({"id": card_id}));
    assert_eq!(full["body"], BODY);
    assert_eq!(full["sourceIds"], json!([helper.source_id]));
    let queue = helper.ok("l3", "queue.status", json!({}));
    assert_eq!(queue["counts"]["completed"], 1, "{queue}");
}

#[test]
fn the_same_body_twice_only_adds_a_source() {
    let root = Root::new("dedupe");
    let mut helper = Helper::start(
        &root,
        vec![
            drafts_answer(json!([card("知识提炼", BODY, "src/1")])),
            drafts_answer(json!([card("知识提炼", BODY, "src/2")])),
        ],
    );
    let first = extract_one(
        &mut helper,
        "note-a",
        "第一段正文，内容足够长以便提炼。",
        "a",
    );
    assert_eq!(first["cards"][0]["action"], "new");
    let second = extract_one(&mut helper, "note-b", "第二段正文，内容同样足够长。", "b");
    assert_eq!(second["cards"][0]["action"], "reference", "{second}");
    let listed = helper.ok("l1", "card.list", json!({}));
    assert_eq!(
        listed["total"], 1,
        "exact match must not create a card: {listed}"
    );
    let card_id = listed["items"][0]["id"].as_str().expect("card").to_string();
    let full = helper.ok("l2", "card.get", json!({"id": card_id}));
    assert_eq!(full["sourceIds"].as_array().expect("sources").len(), 2);
}

#[test]
fn an_explicit_empty_answer_completes_without_a_card() {
    let root = Root::new("empty");
    let mut helper = Helper::start(&root, vec![drafts_answer(json!([]))]);
    let outcome = extract_one(&mut helper, "note-a", "谢谢，收到。", "e");
    assert_eq!(outcome["state"], "completed");
    assert_eq!(outcome["noKnowledge"], true);
    assert_eq!(outcome["cards"].as_array().expect("cards").len(), 0);
    let listed = helper.ok("l1", "card.list", json!({}));
    assert_eq!(listed["total"], 0);
}

#[test]
fn a_missing_cards_field_is_invalid_output_and_writes_nothing() {
    let root = Root::new("missing-cards");
    let mut helper = Helper::start(&root, vec![json!({"reason": "ok"}).to_string()]);
    let published = helper.publish("note-a", "一段足够长的正文，用来验证输出校验。");
    let fingerprint = published["fingerprint"]
        .as_str()
        .expect("fingerprint")
        .to_string();
    let next = helper.ok("n1", "extract.next", json!({}));
    let group = next["group"].clone();
    let (items, _) = Helper::items(
        &group,
        &[(
            helper.source_id.clone(),
            fingerprint,
            "一段足够长的正文，用来验证输出校验。".into(),
        )],
    );
    let failed = helper.call(
        "n2",
        "extract.run",
        json!({"groupId": group["groupId"], "claim": group["claim"], "items": items}),
    );
    assert_eq!(failed["ok"], false, "{failed}");
    assert_eq!(failed["error"]["code"], "invalid_output", "{failed}");
    let listed = helper.ok("n3", "card.list", json!({}));
    assert_eq!(listed["total"], 0, "nothing may be written: {listed}");
}

#[test]
fn a_segment_that_was_not_in_the_batch_is_refused() {
    let root = Root::new("segment");
    let mut helper = Helper::start(&root, vec![]);
    let published = helper.publish("note-a", "短正文，只提供一个分段。");
    let fingerprint = published["fingerprint"]
        .as_str()
        .expect("fingerprint")
        .to_string();
    let next = helper.ok("n1", "extract.next", json!({}));
    let group = next["group"].clone();
    let refused = helper.call(
        "n2",
        "extract.run",
        json!({
            "groupId": group["groupId"],
            "claim": group["claim"],
            "items": [{
                "sourceId": helper.source_id,
                "version": helper.version,
                "fingerprint": fingerprint,
                "segment": 999,
                "start": 0,
                "end": 1,
                "text": "短",
            }],
        }),
    );
    assert_eq!(refused["ok"], false, "{refused}");
    assert_eq!(refused["error"]["code"], "invalid_params", "{refused}");
}

#[test]
fn a_changed_fingerprint_is_refused() {
    let root = Root::new("changed");
    let mut helper = Helper::start(&root, vec![]);
    helper.publish("note-a", "原始正文。");
    let next = helper.ok("n1", "extract.next", json!({}));
    let group = next["group"].clone();
    let refused = helper.call(
        "n2",
        "extract.run",
        json!({
            "groupId": group["groupId"],
            "claim": group["claim"],
            "items": [{
                "sourceId": helper.source_id,
                "version": helper.version,
                "fingerprint": sha256_hex("伪造的正文"),
                "segment": 0,
                "start": 0,
                "end": "原始正文。".chars().count(),
                "text": "原始正文。",
            }],
        }),
    );
    assert_eq!(refused["ok"], false, "{refused}");
    assert_eq!(refused["error"]["code"], "source_changed", "{refused}");
}

#[test]
fn a_long_source_is_read_in_bounded_batches() {
    let root = Root::new("long");
    let text: String = format!("1{}", "知".repeat(199_999));
    let mut helper = Helper::start(
        &root,
        vec![drafts_answer(json!([])), drafts_answer(json!([]))],
    );
    let published = helper.publish("note-long", &text);
    let fingerprint = published["fingerprint"]
        .as_str()
        .expect("fingerprint")
        .to_string();
    let body = (helper.source_id.clone(), fingerprint, text.clone());

    let first = helper.ok("n1", "extract.next", json!({}));
    let group = first["group"].clone();
    let planned = group["items"].as_array().expect("items");
    assert_eq!(planned.len(), 1, "one bounded slice per batch: {group}");
    let chars: usize = planned
        .iter()
        .map(|item| (item["end"].as_u64().unwrap() - item["start"].as_u64().unwrap()) as usize)
        .sum();
    assert!(chars <= 12_000, "batch stays inside the budget: {chars}");
    let (items, bytes) = Helper::items(&group, std::slice::from_ref(&body));
    assert!(
        bytes <= 48_000,
        "the pipe carries characters, not the whole source"
    );
    let outcome = helper.ok(
        "n2",
        "extract.run",
        json!({"groupId": group["groupId"], "claim": group["claim"], "items": items}),
    );
    assert_eq!(outcome["state"], "ready", "{outcome}");
    assert_eq!(outcome["remaining"], true, "{outcome}");

    let again = helper.ok("n3", "extract.next", json!({}));
    let planned = again["group"]["items"].as_array().expect("items");
    assert_eq!(
        planned[0]["segment"], 1,
        "the next batch starts at segment 1"
    );
}

#[test]
fn merge_keeps_what_the_card_already_said() {
    let root = Root::new("merge");
    let mut helper = Helper::start(
        &root,
        vec![
            drafts_answer(json!([])),
            drafts_answer(json!([card("知识提炼", &format!("{BODY}补充细节 B：批量合并时保留既有结论。"), "src/1")])),
            json!({"decisions":[{"index":0,"action":"merge","targetCardId":"CARD/1","reason":"补充细节"}]})
                .to_string(),
        ],
    );
    // A first note is drained without producing knowledge, so the only card in the
    // store is the one the user wrote by hand below.
    let first = extract_one(
        &mut helper,
        "note-a",
        "第一段正文，内容足够长以便提炼。",
        "seed",
    );
    assert_eq!(first["cards"].as_array().expect("cards").len(), 0);
    let seed_source = helper.source_id.clone();
    let existing = format!("{BODY}条件 A：仅在离线时成立。细节 A：使用本地库。");
    let saved = helper.ok(
        "s1",
        "card.save",
        json!({
            "kind": "concept",
            "title": "知识提炼",
            "summary": "摘要",
            "body": existing,
            "topics": ["知识"],
            "aliases": [],
            "sourceIds": [seed_source],
        }),
    );
    helper.card_id = saved["id"].as_str().expect("card id").to_string();
    let outcome = extract_one(
        &mut helper,
        "note-b",
        "第二段正文，内容足够长，用于合并。",
        "m",
    );
    assert_eq!(outcome["cards"][0]["action"], "merge", "{outcome}");
    let full = helper.ok("m2", "card.get", json!({"id": helper.card_id.clone()}));
    let body = full["body"].as_str().expect("body");
    assert!(
        body.contains("条件 A"),
        "old knowledge must survive: {body}"
    );
    assert!(body.contains("细节 B"), "new detail must land: {body}");
    assert_eq!(full["revision"], 2);
    let connection =
        rusqlite::Connection::open(root.join("data").join("knowledge").join("knowledge.db"))
            .expect("open knowledge db");
    let snapshots: i64 = connection
        .query_row(
            "SELECT count(*) FROM card_history WHERE card_id = ?1",
            [helper.card_id.clone()],
            |row| row.get(0),
        )
        .expect("history rows");
    assert_eq!(snapshots, 1, "the previous revision is kept");
}

#[test]
fn one_batch_makes_one_extraction_and_one_comparison_call() {
    let root = Root::new("budget");
    let mut helper = Helper::start(
        &root,
        vec![
            drafts_answer(json!([])),
            drafts_answer(json!([
                card("知识提炼", &format!("{BODY}第一种说法。"), "src/1"),
                card("知识提炼", &format!("{BODY}第二种说法。"), "src/1"),
                card("知识提炼", &format!("{BODY}第三种说法。"), "src/1"),
            ])),
            json!({"decisions":[
                {"index":0,"action":"propose","targetCardId":"CARD/1","reason":"冲突"},
                {"index":1,"action":"propose","targetCardId":"CARD/1","reason":"冲突"},
                {"index":2,"action":"propose","targetCardId":"CARD/1","reason":"冲突"}
            ]})
            .to_string(),
        ],
    );
    helper.publish("seed", "种子正文，内容足够长以便提炼。");
    let seeded = helper.ok("n1", "extract.next", json!({}));
    let group = seeded["group"].clone();
    let (items, _) = Helper::items(
        &group,
        &[(
            helper.source_id.clone(),
            helper.fingerprint.clone(),
            "种子正文，内容足够长以便提炼。".to_string(),
        )],
    );
    helper.ok(
        "n2",
        "extract.run",
        json!({"groupId": group["groupId"], "claim": group["claim"], "items": items}),
    );
    let saved = helper.ok(
        "n3",
        "card.save",
        json!({
            "kind": "concept",
            "title": "知识提炼",
            "summary": "摘要",
            "body": BODY,
            "topics": ["知识"],
            "aliases": [],
            "sourceIds": [helper.source_id.clone()],
        }),
    );
    helper.card_id = saved["id"].as_str().expect("card").to_string();

    let published = helper.publish("note-c", "第三段正文，内容足够长以便提炼。");
    let fingerprint = published["fingerprint"]
        .as_str()
        .expect("fingerprint")
        .to_string();
    let next = helper.ok("n4", "extract.next", json!({}));
    let group = next["group"].clone();
    let (items, _) = Helper::items(
        &group,
        &[(
            helper.source_id.clone(),
            fingerprint,
            "第三段正文，内容足够长以便提炼。".to_string(),
        )],
    );
    let before = helper.prompts.len();
    let outcome = helper.ok(
        "n5",
        "extract.run",
        json!({"groupId": group["groupId"], "claim": group["claim"], "items": items}),
    );
    let calls = helper.prompts.len() - before;
    assert_eq!(calls, 2, "one extraction plus one comparison: {outcome}");
    assert_eq!(outcome["proposals"].as_array().expect("proposals").len(), 3);
}

#[test]
fn pausing_while_the_model_answers_blocks_the_write() {
    let root = Root::new("pause");
    let mut helper = Helper::start(
        &root,
        vec![drafts_answer(json!([card("知识提炼", BODY, "src/1")]))],
    );
    let published = helper.publish("note-a", "一段等待提炼的正文，内容足够长。");
    let fingerprint = published["fingerprint"]
        .as_str()
        .expect("fingerprint")
        .to_string();
    let next = helper.ok("n1", "extract.next", json!({}));
    let group = next["group"].clone();
    let (items, _) = Helper::items(
        &group,
        &[(
            helper.source_id.clone(),
            fingerprint,
            "一段等待提炼的正文，内容足够长。".to_string(),
        )],
    );
    helper.send(json!({
        "v": 1, "type": "request", "id": "n2", "method": "extract.run",
        "params": {"groupId": group["groupId"], "claim": group["claim"], "items": items},
    }));
    let model = helper.recv_model();
    // The pause lands while the model is still answering.
    helper.ok(
        "p1",
        "queue.pause",
        json!({"reason": "manual", "paused": true}),
    );
    helper.answer_model(&model);
    let outcome = helper.recv();
    assert_eq!(outcome["ok"], false, "{outcome}");
    assert_eq!(outcome["error"]["code"], "cancelled", "{outcome}");
    let listed = helper.ok("p2", "card.list", json!({}));
    assert_eq!(
        listed["total"], 0,
        "a paused batch must not write: {listed}"
    );
    helper.ok(
        "p3",
        "queue.pause",
        json!({"reason": "manual", "paused": false}),
    );
    let queue = helper.ok("p4", "queue.status", json!({}));
    let ready = queue["counts"]["ready"].as_i64().unwrap_or(0);
    let working = queue["counts"]["working"].as_i64().unwrap_or(0);
    assert_eq!(
        ready + working,
        1,
        "the task waits for a later run: {queue}"
    );
}

#[test]
fn a_killed_helper_leaves_a_retryable_task() {
    let root = Root::new("interrupted");
    let mut helper = Helper::start(
        &root,
        vec![drafts_answer(json!([card("知识提炼", BODY, "src/1")]))],
    );
    helper.publish("note-a", "一段等待提炼的正文，内容足够长。");
    let next = helper.ok("n1", "extract.next", json!({}));
    assert_eq!(next["group"]["channel"], "note");
    drop(helper);

    let mut revived = Helper::start(
        &root,
        vec![drafts_answer(json!([card("知识提炼", BODY, "src/1")]))],
    );
    let queue = revived.ok("q1", "queue.status", json!({}));
    assert_eq!(
        queue["counts"]["failed"], 1,
        "an interrupted claim must not stay working: {queue}"
    );
    let group = queue["groups"]
        .as_array()
        .and_then(|groups| groups.first())
        .cloned();
    let _ = group;
    let retried = revived.ok(
        "q2",
        "queue.retry",
        json!({"channel": "note", "groupKey": "note-a"}),
    );
    assert!(
        matches!(
            retried["state"].as_str(),
            Some("ready") | Some("stabilizing")
        ),
        "a retried task becomes runnable again: {retried}"
    );
}
