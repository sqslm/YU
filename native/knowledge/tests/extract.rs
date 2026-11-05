//! Stage 3 extraction driven through the real helper over a real pipe.
//!
//! The helper is the production binary; the only thing faked is the model, which
//! answers the `model.request` frames the helper writes — exactly what the
//! Electron host does with a provider client.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{Value, json};

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

/// A scripted model: it answers every `model.request` frame with one of the
/// canned answers, in order, and records the prompts it was shown.
struct Helper {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    answers: Vec<String>,
    prompts: Vec<String>,
    counter: u64,
    /// The version the helper minted for the last published source.
    version: String,
    /// The id the helper minted, substituted into canned answers.
    source_id: String,
    /// The card id learned by the test, substituted as `CARD/1`.
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
            card_id: String::new(),
        };
        let ready = helper.recv();
        assert_eq!(ready["type"], "ready", "helper must report ready: {ready}");
        if enabled {
            helper.call("cfg", "collect.configure", json!({"enabled": true}));
        }
        helper
    }

    fn send(&mut self, frame: Value) {
        let line = serde_json::to_string(&frame).expect("frame");
        writeln!(self.stdin, "{line}").expect("write");
        self.stdin.flush().expect("flush");
    }

    fn recv(&mut self) -> Value {
        loop {
            let mut line = String::new();
            let read = self.stdout.read_line(&mut line).expect("read");
            assert!(read > 0, "helper closed the pipe");
            let frame: Value = serde_json::from_str(&line).expect("json");
            if frame["type"] == "model.request" {
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
                self.send(
                    json!({"v": 1, "type": "model.result", "id": id, "ok": true, "text": answer}),
                );
                continue;
            }
            if frame["type"] == "changed" {
                continue;
            }
            return frame;
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
        result
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

#[test]
fn a_stable_source_is_extracted_into_a_card() {
    let root = Root::new("happy");
    let mut helper = Helper::start(
        &root,
        vec![drafts_answer(json!([card("知识提炼", BODY, "src/1")]))],
    );
    let published = helper.publish("note-a", "这是一段等待提炼的正文。");
    let source_id = published["sourceId"]
        .as_str()
        .expect("source id")
        .to_string();

    let next = helper.ok("n1", "extract.next", json!({}));
    assert_eq!(next["group"]["channel"], "note", "{next}");
    let claim = next["group"]["claim"].as_str().expect("claim").to_string();
    let group_id = next["group"]["groupId"]
        .as_str()
        .expect("group")
        .to_string();
    assert_eq!(next["group"]["sources"][0]["sourceId"], source_id.as_str());

    let outcome = helper.ok(
        "n2",
        "extract.run",
        json!({
            "groupId": group_id,
            "claim": claim,
            "sources": [{"sourceId": source_id, "version": helper.version, "text": "这是一段等待提炼的正文。"}],
            "effort": "high",
        }),
    );
    assert_eq!(outcome["state"], "completed", "{outcome}");
    assert_eq!(outcome["cards"].as_array().expect("cards").len(), 1);
    assert_eq!(outcome["remaining"], false);
    assert!(helper.prompts[0].contains("这是一段等待提炼的正文。"));

    let listed = helper.ok("n3", "card.list", json!({}));
    assert_eq!(listed["total"], 1, "{listed}");
    let card_id = listed["items"][0]["id"]
        .as_str()
        .expect("card id")
        .to_string();
    let full = helper.ok("n4", "card.get", json!({"id": card_id}));
    assert_eq!(full["body"], BODY);
    assert_eq!(full["sourceIds"], json!([source_id]));

    let queue = helper.ok("n5", "queue.status", json!({}));
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
    helper.publish("note-a", "第一段正文，内容足够长以便提炼。");
    let first = helper.ok("n1", "extract.next", json!({}));
    let outcome = helper.ok(
        "n2",
        "extract.run",
        json!({
            "groupId": first["group"]["groupId"],
            "claim": first["group"]["claim"],
            "sources": [{
                "sourceId": first["group"]["sources"][0]["sourceId"],
                "version": helper.version,
                "text": "第一段正文，内容足够长以便提炼。",
            }],
        }),
    );
    assert_eq!(outcome["cards"][0]["action"], "new");

    helper.publish("note-b", "第二段正文，内容同样足够长以便提炼。");
    let second = helper.ok("n3", "extract.next", json!({}));
    let outcome = helper.ok(
        "n4",
        "extract.run",
        json!({
            "groupId": second["group"]["groupId"],
            "claim": second["group"]["claim"],
            "sources": [{
                "sourceId": second["group"]["sources"][0]["sourceId"],
                "version": helper.version,
                "text": "第二段正文，内容同样足够长以便提炼。",
            }],
        }),
    );
    assert_eq!(outcome["cards"][0]["action"], "reference", "{outcome}");
    let listed = helper.ok("n5", "card.list", json!({}));
    assert_eq!(
        listed["total"], 1,
        "an exact match must not create a second card: {listed}"
    );
    let card_id = listed["items"][0]["id"].as_str().expect("card").to_string();
    let full = helper.ok("n6", "card.get", json!({"id": card_id}));
    assert_eq!(full["sourceIds"].as_array().expect("sources").len(), 2);
}

#[test]
fn an_empty_answer_completes_without_a_card() {
    let root = Root::new("empty");
    let mut helper = Helper::start(&root, vec![drafts_answer(json!([]))]);
    helper.publish("note-a", "谢谢，收到。");
    let next = helper.ok("n1", "extract.next", json!({}));
    let outcome = helper.ok(
        "n2",
        "extract.run",
        json!({
            "groupId": next["group"]["groupId"],
            "claim": next["group"]["claim"],
            "sources": [{
                "sourceId": next["group"]["sources"][0]["sourceId"],
                "version": helper.version,
                "text": "谢谢，收到。",
            }],
        }),
    );
    assert_eq!(outcome["state"], "completed");
    assert_eq!(outcome["noKnowledge"], true);
    assert_eq!(outcome["cards"].as_array().expect("cards").len(), 0);
    let listed = helper.ok("n3", "card.list", json!({}));
    assert_eq!(listed["total"], 0);
}

#[test]
fn a_changed_source_is_refused_and_the_task_becomes_needs_reread() {
    let root = Root::new("changed");
    let mut helper = Helper::start(&root, vec![drafts_answer(json!([]))]);
    helper.publish("note-a", "原始正文。");
    let next = helper.ok("n1", "extract.next", json!({}));
    let refused = helper.call(
        "n2",
        "extract.run",
        json!({
            "groupId": next["group"]["groupId"],
            "claim": next["group"]["claim"],
            "sources": [{
                "sourceId": next["group"]["sources"][0]["sourceId"],
                "version": helper.version,
                "text": "被改过的正文。",
            }],
        }),
    );
    assert_eq!(refused["ok"], false, "{refused}");
    assert_eq!(refused["error"]["code"], "source_changed");

    let failed = helper.ok(
        "n3",
        "extract.fail",
        json!({
            "groupId": next["group"]["groupId"],
            "claim": next["group"]["claim"],
            "code": "source_changed",
            "reason": "来源正文已变化",
        }),
    );
    assert_eq!(failed["state"], "needs_reread");
    let queue = helper.ok("n4", "queue.list", json!({"state": "needs_reread"}));
    assert_eq!(queue["total"], 1, "{queue}");
    assert!(
        helper.prompts.is_empty(),
        "a stale source must not reach the model"
    );
}

#[test]
fn a_failed_model_call_releases_the_claim_and_leaves_no_card() {
    let root = Root::new("failure");
    let mut helper = Helper::start(&root, vec!["这不是 JSON".to_string()]);
    helper.publish("note-a", "等待提炼的正文内容。");
    let next = helper.ok("n1", "extract.next", json!({}));
    let refused = helper.call(
        "n2",
        "extract.run",
        json!({
            "groupId": next["group"]["groupId"],
            "claim": next["group"]["claim"],
            "sources": [{
                "sourceId": next["group"]["sources"][0]["sourceId"],
                "version": helper.version,
                "text": "等待提炼的正文内容。",
            }],
        }),
    );
    assert_eq!(refused["ok"], false, "{refused}");
    assert_eq!(refused["error"]["code"], "invalid_output");
    helper.ok(
        "n3",
        "extract.fail",
        json!({
            "groupId": next["group"]["groupId"],
            "claim": next["group"]["claim"],
            "code": "invalid_output",
        }),
    );
    let queue = helper.ok("n4", "queue.list", json!({"state": "failed"}));
    assert_eq!(queue["total"], 1, "{queue}");
    let listed = helper.ok("n5", "card.list", json!({}));
    assert_eq!(listed["total"], 0);
}

#[test]
fn a_long_source_is_split_and_every_segment_is_processed_once() {
    let root = Root::new("segments");
    // 30 000 characters need three segments of 12 000 with a 500-character overlap.
    let body: String = "知识".to_string().repeat(15_000);
    let mut helper = Helper::start(
        &root,
        vec![
            drafts_answer(json!([card("第一段", BODY, "src/1")])),
            drafts_answer(json!([])),
            drafts_answer(json!([])),
        ],
    );
    helper.publish("note-long", &body);
    let mut runs = 0;
    let mut saw_remaining = false;

    loop {
        let id = helper.next_id();
        let next = helper.ok(&id, "extract.next", json!({}));
        let group = next["group"].clone();
        if group.is_null() {
            break;
        }
        let group_id = group["groupId"].as_str().expect("group").to_string();
        let source_id = group["sources"][0]["sourceId"]
            .as_str()
            .expect("source")
            .to_string();
        let claim = group["claim"].as_str().expect("claim").to_string();
        let run_id = helper.next_id();
        let outcome = helper.ok(
            &run_id,
            "extract.run",
            json!({
                "groupId": group_id,
                "claim": claim,
                "sources": [{"sourceId": source_id, "version": helper.version, "text": body}],
            }),
        );
        runs += 1;
        if outcome["remaining"] == json!(true) {
            saw_remaining = true;
            assert_eq!(outcome["state"], "ready", "{outcome}");
            continue;
        }
        assert_eq!(outcome["state"], "completed");
        break;
    }
    assert_eq!(runs, 3, "30 000 characters must need three batches");
    assert!(
        saw_remaining,
        "a partially processed source must stay queued"
    );
    assert_eq!(helper.prompts.len(), 3);
    for prompt in &helper.prompts {
        assert!(
            prompt.chars().count() <= 12_500,
            "one batch carried {} characters",
            prompt.chars().count()
        );
    }
}

#[test]
fn extraction_waits_until_the_master_switch_is_on() {
    let root = Root::new("disabled");
    let mut helper = Helper::start_with(&root, Vec::new(), false);
    // With the master switch off the queue refuses sources outright, so a task
    // can never exist that extraction would have to skip.
    let refused = helper.call(
        "n0",
        "source.publish",
        json!({
            "channel": "note",
            "kind": "note",
            "originRef": "note-a",
            "groupKey": "note-a",
            "text": "关闭总开关时的正文。",
            "at": 1,
        }),
    );
    assert_eq!(refused["error"]["code"], "channel_disabled", "{refused}");
    let next = helper.ok("n1", "extract.next", json!({}));
    assert_eq!(next["enabled"], false, "{next}");
    assert_eq!(
        next["group"],
        Value::Null,
        "a disabled feature claims nothing: {next}"
    );

    helper.ok("n2", "collect.configure", json!({"enabled": true}));
    helper.publish("note-a", "打开总开关后的正文。");
    let next = helper.ok("n3", "extract.next", json!({}));
    assert_eq!(next["enabled"], true);
    assert_eq!(next["group"]["channel"], "note", "{next}");
    assert!(
        helper.prompts.is_empty(),
        "a claimed task is not a model call"
    );
}

fn merge_answer() -> String {
    json!({"decisions": [{"index": 0, "action": "merge", "targetCardId": "CARD/1", "reason": "同一结论补充细节"}]})
        .to_string()
}

/// Runs one batch and returns the outcome.
fn run_batch(helper: &mut Helper, text: &str, tag: &str) -> Value {
    let next = helper.ok(&format!("next-{tag}"), "extract.next", json!({}));
    let sources: Vec<Value> = next["group"]["sources"]
        .as_array()
        .expect("sources")
        .iter()
        .map(|source| {
            json!({
                "sourceId": source["sourceId"],
                "version": source["version"],
                "text": text,
            })
        })
        .collect();
    helper.ok(
        &format!("run-{tag}"),
        "extract.run",
        json!({
            "groupId": next["group"]["groupId"],
            "claim": next["group"]["claim"],
            "sources": sources,
            "effort": "high",
        }),
    )
}

#[test]
fn a_suggestion_is_applied_only_to_the_revision_it_was_written_for() {
    let root = Root::new("suggestions");
    let body_one =
        "第一条结论：先确认约束，再谈机制与取舍，并写明适用条件与判断依据，避免只看结论不看前提。";
    let body_two =
        "第二条结论：先确认约束，再谈机制与取舍，并写明适用条件与反例，同一结论补充细节与依据。";
    let body_three =
        "第三条结论：先确认约束，再谈机制与取舍，并写明适用条件、反例与待验证项，附上判断与推导。";
    let body_four = "第四条结论：先确认约束，再谈机制与取舍，并写明适用条件、反例与待验证项，附判断依据与失败案例。";
    let mut helper = Helper::start(
        &root,
        vec![
            drafts_answer(json!([card("知识提炼", body_one, "src/1")])),
            drafts_answer(json!([card("知识提炼", body_two, "src/2")])),
            merge_answer(),
            drafts_answer(json!([card("知识提炼", body_three, "src/1")])),
            merge_answer(),
            drafts_answer(json!([card("知识提炼", body_four, "src/2")])),
            merge_answer(),
            drafts_answer(json!([card("知识提炼", body_four, "src/1")])),
            merge_answer(),
        ],
    );

    helper.publish("note-a", "第一段正文，内容足够长以便提炼出卡片。");
    let created = run_batch(&mut helper, "第一段正文，内容足够长以便提炼出卡片。", "a");
    assert_eq!(created["cards"].as_array().expect("cards").len(), 1);
    let listed = helper.ok("l1", "card.list", json!({}));
    let card_id = listed["items"][0]["id"]
        .as_str()
        .expect("card id")
        .to_string();
    helper.card_id = card_id.clone();

    // A person edits the card; from now on merges may only be proposed.
    helper.ok(
        "u1",
        "card.update",
        json!({"id": card_id, "title": "知识提炼（人工）", "summary": "人工编辑后的摘要"}),
    );

    helper.publish("note-b", "第二段正文，补充同一结论的细节。");
    let merged = run_batch(&mut helper, "第二段正文，补充同一结论的细节。", "b");
    assert_eq!(
        merged["proposals"].as_array().expect("proposals").len(),
        1,
        "{merged}"
    );
    let open = helper.ok("s1", "suggestion.list", json!({"state": "open"}));
    assert_eq!(open["total"], 1, "{open}");
    let suggestion = open["items"][0]["id"]
        .as_str()
        .expect("suggestion")
        .to_string();
    assert_eq!(open["items"][0]["targetCardId"], card_id.as_str());
    assert_eq!(open["items"][0]["draft"]["body"], body_two);

    // The card moves on, so the open suggestion is stale.
    helper.ok(
        "u2",
        "card.update",
        json!({"id": card_id, "summary": "再次人工修改"}),
    );
    let stale = helper.call("s2", "suggestion.accept", json!({"id": suggestion}));
    assert_eq!(stale["ok"], false, "{stale}");
    assert_eq!(stale["error"]["code"], "source_changed", "{stale}");
    let closed = helper.ok("s2b", "suggestion.list", json!({"state": "rejected"}));
    assert_eq!(
        closed["total"], 1,
        "a stale proposal is closed, not left open: {closed}"
    );

    // A suggestion written against the current revision still applies.
    helper.publish("note-c", "第三段正文，补充同一结论的更多细节。");
    let second = run_batch(&mut helper, "第三段正文，补充同一结论的更多细节。", "c");
    assert_eq!(
        second["proposals"].as_array().expect("proposals").len(),
        1,
        "{second}"
    );
    let open = helper.ok("s3", "suggestion.list", json!({"state": "open"}));
    let suggestion = open["items"][0]["id"]
        .as_str()
        .expect("suggestion")
        .to_string();
    let accepted = helper.ok("s4", "suggestion.accept", json!({"id": suggestion}));
    assert_eq!(accepted["state"], "accepted", "{accepted}");
    let full = helper.ok("l2", "card.get", json!({"id": card_id}));
    assert_eq!(full["body"], body_three);
    assert_eq!(full["revision"], 4, "{full}");
    // Only the accepted proposal attaches its source; the merge that was proposed
    // instead of applied never did.
    assert_eq!(
        full["sourceIds"].as_array().expect("sources").len(),
        2,
        "{full}"
    );

    // A rejected proposal does not come back with the next batch.
    helper.publish("note-d", "第四段正文，应当只形成一条建议。");
    let third = run_batch(&mut helper, "第四段正文，应当只形成一条建议。", "d");
    assert_eq!(
        third["proposals"].as_array().expect("proposals").len(),
        1,
        "{third}"
    );
    let open = helper.ok("s5", "suggestion.list", json!({"state": "open"}));
    let suggestion = open["items"][0]["id"]
        .as_str()
        .expect("suggestion")
        .to_string();
    helper.ok("s6", "suggestion.reject", json!({"id": suggestion}));

    helper.publish("note-e", "第五段正文，与上一条建议完全相同。");
    let fourth = run_batch(&mut helper, "第五段正文，与上一条建议完全相同。", "e");
    assert_eq!(
        fourth["proposals"].as_array().expect("proposals").len(),
        0,
        "a rejected draft must not be proposed again: {fourth}"
    );
    let all = helper.ok("s7", "suggestion.list", json!({}));
    assert_eq!(all["total"], 3, "{all}");
}
