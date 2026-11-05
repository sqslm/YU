//! Who owns a source: a conversation owns its own turns and every material it
//! read, and one material can be owned by several conversations. Deleting one
//! record must therefore drop only that record's claim, keep the shared row, and
//! keep the reading task the other conversation still waits for.
//!
//! Everything here runs over the real pipes and real SQLite files of the helper;
//! the only shortcut is `YU_KNOWLEDGE_STABLE_MS`.

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
            "yu-knowledge-owner-{tag}-{}-{nanos}",
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
    fn start(root: &Path) -> Helper {
        let mut command = Command::new(env!("CARGO_BIN_EXE_yu-knowledge"));
        command
            .arg("--root")
            .arg(root)
            .env("YU_KNOWLEDGE_STABLE_MS", "0")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().unwrap();
        let stdin = child.stdin.take();
        let out = BufReader::new(child.stdout.take().unwrap());
        let mut helper = Helper { child, stdin, out };
        let ready = helper.recv();
        assert_eq!(ready["type"], "ready", "{ready}");
        helper.ok("cfg", "collect.configure", json!({ "enabled": true }));
        helper
    }

    fn recv(&mut self) -> Value {
        let mut line = String::new();
        let read = self.out.read_line(&mut line).unwrap();
        assert!(read > 0, "the helper closed its stdout");
        serde_json::from_str(line.trim_end()).unwrap()
    }

    fn ok(&mut self, id: &str, method: &str, params: Value) -> Value {
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
                assert_eq!(frame["ok"], true, "{method} failed: {frame}");
                return frame["result"].clone();
            }
        }
    }
}

impl Helper {
    /// Ends the helper the way the app does, leaving the database on disk.
    fn stop(&mut self) {
        self.stdin = None;
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The state column of one source row, read straight from the database.
fn source_state(root: &Path, id: &str) -> String {
    let path = root.join("data").join("knowledge").join("knowledge.db");
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .query_row("SELECT state FROM sources WHERE id = ?1", [id], |row| {
            row.get::<_, String>(0)
        })
        .unwrap()
}

/// The single-valued thread pointer the queue keeps for one group, read straight
/// from the database: the listing does not expose it, and this is the column a
/// delete used to follow.
fn thread_key(root: &Path, group_key: &str) -> Option<String> {
    let path = root.join("data").join("knowledge").join("knowledge.db");
    let connection = rusqlite::Connection::open(&path).unwrap();
    let rows: Vec<(String, Option<String>)> = connection
        .prepare("SELECT group_key, thread_key FROM queue_groups ORDER BY group_key")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    let listing = format!("{rows:?}");
    assert!(!rows.is_empty(), "no groups in {}", path.display());
    rows.into_iter()
        .find(|(key, _)| key == group_key)
        .unwrap_or_else(|| panic!("no group {group_key} in {listing}"))
        .1
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

/// One finished chat turn: the thread is the group and the record.
fn turn(thread: &str, question: &str, answer: &str, at: i64) -> Value {
    json!({
        "channel": "chat",
        "kind": "chat",
        "originRef": format!("{thread}:user:ans"),
        "groupKey": thread,
        "threadKey": thread,
        "title": question,
        "scope": "主界面问答",
        "text": format!("{question}\n\n{answer}"),
        "at": at
    })
}

/// The same page read inside one conversation. Its own group is keyed by the
/// material, so two conversations share this row and its group.
fn material(origin: &str, group: &str, thread: &str, text: &str, at: i64) -> Value {
    json!({
        "channel": "reading",
        "kind": "web",
        "originRef": origin,
        "groupKey": group,
        "threadKey": thread,
        "ordinal": 0,
        "title": "材料标题",
        "scope": "主界面问答",
        "text": text,
        "at": at
    })
}

fn source_of(helper: &mut Helper, id: &str) -> Value {
    let found = helper.ok(id, "source.find", json!({ "threadId": "t-a" }));
    let rows = found["sources"].as_array().unwrap().clone();
    rows.iter()
        .find(|row| row["kind"] == "web")
        .expect("the reading material is part of the thread")
        .clone()
}

#[test]
fn one_material_read_by_two_threads_is_retired_only_by_the_last_owner() {
    let root = Root::new("shared");
    let mut helper = Helper::start(&root);
    let at = now_ms();
    let page = "https://example.test/knowledge";
    helper.ok("a1", "source.publish", turn("t-a", "问题甲", "回答甲", at));
    helper.ok(
        "a2",
        "source.publish",
        material(page, "reading:page", "t-a", "同一篇网页正文。", at),
    );
    helper.ok(
        "b1",
        "source.publish",
        turn("t-b", "问题乙", "回答乙", at + 1),
    );
    helper.ok(
        "b2",
        "source.publish",
        material(page, "reading:page", "t-b", "同一篇网页正文。", at + 1),
    );

    let page_id = source_of(&mut helper, "s0")["id"]
        .as_str()
        .unwrap()
        .to_string();

    // The preview of thread A covers what A really owns, the shared material
    // included, and says that the material is not going away with it.
    let impact = helper.ok("i1", "card.impact", json!({ "threadId": "t-a" }));
    assert_eq!(impact["sources"].as_array().unwrap().len(), 2, "{impact}");
    let shared: Vec<&str> = impact["shared"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_str().unwrap())
        .collect();
    assert_eq!(shared.len(), 1, "{impact}");

    let cancelled = helper.ok(
        "x1",
        "queue.invalidate_thread",
        json!({ "threadKey": "t-a", "reason": "thread deleted" }),
    );
    let groups: Vec<&str> = cancelled["cancelled"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_str().unwrap())
        .collect();
    assert_eq!(groups.len(), 1, "{cancelled}");
    assert_eq!(
        cancelled["detached"].as_array().unwrap().len(),
        1,
        "{cancelled}"
    );

    // Thread B still cites the page, so the row and its task survive.
    let after = helper.ok("f1", "source.find", json!({ "threadId": "t-b" }));
    let rows = after["sources"].as_array().unwrap();
    let kept = rows
        .iter()
        .find(|row| row["kind"] == "web")
        .expect("the shared material stays with the thread that still read it");
    assert_eq!(kept["state"], "active", "{after}");
    let tasks = helper.ok("q1", "queue.list", json!({ "limit": 100 }));
    let live = tasks["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["groupKey"] == "reading:page")
        .cloned()
        .expect("the reading task stays queued");
    assert_ne!(live["state"], "cancelled", "{live}");
    // The single-valued thread pointer is repaired to an owner that still exists,
    // so a later delete cannot follow it back to the conversation that has gone.
    assert_eq!(
        thread_key(&root, "reading:page").as_deref(),
        Some("t-b"),
        "the reading task keeps pointing at a live owner"
    );

    // Thread A's own turn is gone.
    let old = helper.ok("f2", "source.find", json!({ "threadId": "t-a" }));
    for row in old["sources"].as_array().unwrap() {
        assert_eq!(row["state"], "invalid", "{old}");
    }

    // The last owner going away does retire the page.
    helper.ok(
        "x2",
        "queue.invalidate_thread",
        json!({ "threadKey": "t-b", "reason": "thread deleted" }),
    );
    // With no owner left the row itself is retired, which is why it no longer
    // answers a thread lookup at all.
    let end = helper.ok("f3", "source.find", json!({ "threadId": "t-b" }));
    assert!(
        end["sources"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["kind"] != "web"),
        "{end}"
    );
    assert_eq!(source_state(&root, &page_id), "invalid");
}

#[test]
fn purging_one_record_keeps_a_shared_material_and_the_card_that_cites_it() {
    let root = Root::new("purge");
    let mut helper = Helper::start(&root);
    let at = now_ms();
    let page = "https://example.test/shared";
    helper.ok("a1", "source.publish", turn("t-a", "问题甲", "回答甲", at));
    helper.ok(
        "a2",
        "source.publish",
        material(page, "reading:shared", "t-a", "共享材料正文。", at),
    );
    helper.ok(
        "b1",
        "source.publish",
        turn("t-b", "问题乙", "回答乙", at + 1),
    );
    helper.ok(
        "b2",
        "source.publish",
        material(page, "reading:shared", "t-b", "共享材料正文。", at + 1),
    );
    let page_id = source_of(&mut helper, "s0")["id"]
        .as_str()
        .unwrap()
        .to_string();

    let card = helper.ok(
        "c1",
        "card.save",
        json!({
            "kind": "concept",
            "title": "共享材料卡片",
            "summary": "从共享材料提炼",
            "body": "卡片的正文。",
            "sourceIds": [page_id.clone()]
        }),
    );
    let card_id = card["id"].as_str().unwrap().to_string();

    // A record that only shares the material promises no deletion of the card.
    let preview = helper.ok("i1", "card.impact", json!({ "threadId": "t-a" }));
    assert_eq!(preview["cards"], 0, "{preview}");
    assert_eq!(preview["single"], 0, "{preview}");
    assert_eq!(preview["shared"].as_array().unwrap().len(), 1, "{preview}");
    assert!(
        preview["sources"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == page_id.as_str()),
        "{preview}"
    );

    let purged = helper.ok(
        "p1",
        "card.purge",
        json!({
            "threadId": "t-a",
            "cards": true,
            "confirm": { "sources": preview["sources"].clone(), "ticket": preview["ticket"].clone() }
        }),
    );
    assert_eq!(purged["removed"].as_array().unwrap().len(), 0, "{purged}");
    assert_eq!(purged["detached"].as_array().unwrap().len(), 1, "{purged}");
    let still = helper.ok("g1", "card.get", json!({ "id": card_id }));
    assert_eq!(still["id"], card_id.as_str(), "{still}");
    let after = helper.ok("f1", "source.find", json!({ "threadId": "t-b" }));
    let kept = after["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["kind"] == "web")
        .cloned()
        .unwrap();
    assert_eq!(kept["state"], "active", "{after}");

    // With the last owner gone the card loses its only source and goes with it.
    let last = helper.ok("i2", "card.impact", json!({ "threadId": "t-b" }));
    assert_eq!(last["single"], 1, "{last}");
    let purged = helper.ok(
        "p2",
        "card.purge",
        json!({
            "threadId": "t-b",
            "cards": true,
            "confirm": { "sources": last["sources"].clone(), "ticket": last["ticket"].clone() }
        }),
    );
    let removed: Vec<&str> = purged["removed"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_str().unwrap())
        .collect();
    assert_eq!(removed, vec![card_id.as_str()], "{purged}");
}

#[test]
fn a_database_written_before_ownership_is_backfilled_when_it_opens() {
    let root = Root::new("legacy");
    let at = now_ms();
    let page = "https://example.test/legacy";
    {
        let mut helper = Helper::start(&root);
        helper.ok("a1", "source.publish", turn("t-a", "问题甲", "回答甲", at));
        helper.ok(
            "a2",
            "source.publish",
            material(page, "reading:legacy", "t-a", "旧库里的材料正文。", at),
        );
        helper.ok(
            "b1",
            "source.publish",
            turn("t-b", "问题乙", "回答乙", at + 1),
        );
        helper.ok(
            "b2",
            "source.publish",
            material(page, "reading:legacy", "t-b", "旧库里的材料正文。", at + 1),
        );
        helper.stop();
    }

    // A database written before this table existed: the ownership rows are gone
    // and the schema version says so, exactly like an install that upgraded.
    let path = root.join("data").join("knowledge").join("knowledge.db");
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.execute("DROP TABLE source_records", []).unwrap();
    connection.pragma_update(None, "user_version", 8).unwrap();
    drop(connection);

    let mut helper = Helper::start(&root);
    let backfilled: i64 = {
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection
            .query_row("SELECT count(*) FROM source_records", [], |row| row.get(0))
            .unwrap()
    };
    assert!(backfilled >= 2, "the upgrade rebuilt the claims");

    // The old schema kept one thread per group, so an upgraded library knows one
    // reader of a page, not both: deleting the other thread must still leave the
    // page and the recorded reader alone.
    let cancelled = helper.ok(
        "x1",
        "queue.invalidate_thread",
        json!({ "threadKey": "t-b", "reason": "thread deleted" }),
    );
    assert_eq!(
        cancelled["cancelled"].as_array().unwrap().len(),
        1,
        "{cancelled}"
    );
    assert_eq!(
        cancelled["detached"].as_array().unwrap().len(),
        0,
        "{cancelled}"
    );
    let after = helper.ok("f1", "source.find", json!({ "threadId": "t-b" }));
    for row in after["sources"].as_array().unwrap() {
        assert_eq!(row["state"], "invalid", "only t-b's own turn goes: {after}");
    }
    let page_id = {
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection
            .query_row("SELECT id FROM sources WHERE kind = 'web'", [], |row| {
                row.get::<_, String>(0)
            })
            .unwrap()
    };
    assert_eq!(source_state(&root, &page_id), "active");
}

impl Helper {
    /// Sends a request that must fail, and returns the error the helper reported.
    fn err(&mut self, id: &str, method: &str, params: Value) -> Value {
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
                assert_eq!(frame["ok"], false, "{method} was accepted: {frame}");
                return frame["error"].clone();
            }
        }
    }
}

/// The ticket is the record's current effect, so a preview taken before another
/// reader let go cannot delete a card that reader's delete made single-source.
#[test]
fn an_old_ticket_cannot_delete_the_card_the_other_reader_gave_up() {
    let root = Root::new("stale-ticket");
    let mut helper = Helper::start(&root);
    let at = now_ms();
    let page = "https://example.test/stale";
    helper.ok("a1", "source.publish", turn("t-a", "问题甲", "回答甲", at));
    helper.ok("a2", "source.publish", turn("t-b", "问题乙", "回答乙", at));
    helper.ok(
        "a3",
        "source.publish",
        material(page, "reading:stale", "t-a", "两边都读过的正文。", at),
    );
    helper.ok(
        "a4",
        "source.publish",
        material(page, "reading:stale", "t-b", "两边都读过的正文。", at),
    );
    let page_id = source_of(&mut helper, "f1")["id"]
        .as_str()
        .unwrap()
        .to_string();
    let turn_id: String = helper.ok("f2", "source.find", json!({ "threadId": "t-a" }))["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["kind"] == "chat")
        .expect("the turn is part of the thread")["id"]
        .as_str()
        .unwrap()
        .to_string();
    let own = helper.ok(
        "c1",
        "card.save",
        json!({
            "kind": "concept",
            "title": "独占结论",
            "body": "只有 t-a 的回合支持。",
            "sourceIds": [turn_id]
        }),
    );
    let shared = helper.ok(
        "c2",
        "card.save",
        json!({
            "kind": "concept",
            "title": "共享结论",
            "body": "这条结论引用了共享材料。",
            "sourceIds": [page_id]
        }),
    );
    let own_id = own["id"].as_str().unwrap().to_string();
    let shared_id = shared["id"].as_str().unwrap().to_string();

    let preview = helper.ok("i1", "card.impact", json!({ "threadId": "t-a" }));
    assert_eq!(preview["cards"], 1, "{preview}");
    assert_eq!(preview["shared"].as_array().unwrap().len(), 1, "{preview}");

    // The other reader goes away and only gives up its claim: the page stays live
    // and now belongs to t-a alone.
    let released = helper.ok(
        "r1",
        "source.release_record",
        json!({ "channel": "chat", "groupKey": "t-b", "reason": "记录已删除" }),
    );
    assert_eq!(released["detached"], 1, "{released}");
    assert_eq!(source_state(&root, &page_id), "active");

    // The preview t-a saw no longer describes the record: a card that was shared is
    // single-source now, so submitting the old ticket must change nothing at all.
    let stale = helper.err(
        "p1",
        "card.purge",
        json!({
            "threadId": "t-a",
            "cards": true,
            "confirm": { "sources": preview["sources"].clone(), "ticket": preview["ticket"].clone() }
        }),
    );
    assert_eq!(stale["code"], "source_changed", "{stale}");
    assert_eq!(source_state(&root, &page_id), "active");
    assert_eq!(
        helper.ok("g1", "card.get", json!({ "id": own_id.clone() }))["id"],
        own_id.as_str()
    );
    assert_eq!(
        helper.ok("g2", "card.get", json!({ "id": shared_id.clone() }))["id"],
        shared_id.as_str(),
        "the stale ticket left the shared card alone"
    );

    // A fresh preview describes the same delete, and confirms it.
    let fresh = helper.ok("i2", "card.impact", json!({ "threadId": "t-a" }));
    assert_eq!(fresh["cards"], 2, "{fresh}");
    let purged = helper.ok(
        "p2",
        "card.purge",
        json!({
            "threadId": "t-a",
            "cards": true,
            "confirm": { "sources": fresh["sources"].clone(), "ticket": fresh["ticket"].clone() }
        }),
    );
    assert_eq!(purged["removed"].as_array().unwrap().len(), 2, "{purged}");
}

/// The queue is settled inside the purge transaction: a reading task that just lost
/// its last live row stops with it, in the same statement batch that retired the row.
#[test]
fn a_confirmed_purge_settles_the_reading_task_it_emptied() {
    let root = Root::new("settle");
    let mut helper = Helper::start(&root);
    let at = now_ms();
    let page = "https://example.test/settled";
    helper.ok("a1", "source.publish", turn("t-a", "问题甲", "回答甲", at));
    helper.ok(
        "a2",
        "source.publish",
        material(page, "reading:settled", "t-a", "只有这一轮读过的正文。", at),
    );
    let page_id = source_of(&mut helper, "f1")["id"]
        .as_str()
        .unwrap()
        .to_string();
    helper.ok(
        "c1",
        "card.save",
        json!({
            "kind": "concept",
            "title": "独占知识",
            "body": "引用只被这一轮读过的材料。",
            "sourceIds": [page_id]
        }),
    );
    let preview = helper.ok("i1", "card.impact", json!({ "threadId": "t-a" }));
    let purged = helper.ok("p1", "card.purge", json!({
        "threadId": "t-a",
        "cards": true,
        "confirm": { "sources": preview["sources"].clone(), "ticket": preview["ticket"].clone() }
    }));
    assert_eq!(purged["removed"].as_array().unwrap().len(), 1, "{purged}");
    assert_eq!(source_state(&root, &page_id), "invalid");
    let cancelled: Vec<String> = purged["cancelled"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_str().unwrap().to_string())
        .collect();
    assert!(
        !cancelled.is_empty(),
        "the emptied reading task stopped: {purged}"
    );
    let listed = helper.ok("l1", "queue.list", json!({ "offset": 0, "limit": 50 }));
    for row in listed["items"].as_array().unwrap() {
        if cancelled.contains(&row["id"].as_str().unwrap().to_string()) {
            assert_eq!(row["state"], "cancelled", "{row}");
        }
    }
}

/// Two conversations read two versions of one page. The first delete leaves the
/// group running because the other version is still live; the last one stops it —
/// a version retired in an earlier call still counts.
#[test]
fn versions_retired_in_earlier_calls_still_settle_the_group() {
    let root = Root::new("versions");
    let mut helper = Helper::start(&root);
    let at = now_ms();
    let page = "https://example.test/versions";
    let group = "reading:versions";
    helper.ok("a1", "source.publish", turn("t-a", "问题甲", "回答甲", at));
    helper.ok("a2", "source.publish", turn("t-b", "问题乙", "回答乙", at));
    helper.ok(
        "a3",
        "source.publish",
        material(page, group, "t-a", "第一版正文内容。", at),
    );
    helper.ok(
        "a4",
        "source.publish",
        material(page, group, "t-b", "第二版正文内容更完整一些。", at),
    );
    let reading_group: String = helper.ok("l0", "queue.list", json!({ "offset": 0, "limit": 50 }))
        ["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["channel"] == "reading")
        .expect("the reading task is queued")["id"]
        .as_str()
        .unwrap()
        .to_string();
    let first = helper.ok(
        "r1",
        "source.release_record",
        json!({ "channel": "chat", "groupKey": "t-a", "reason": "记录已删除" }),
    );
    let first_cancelled: Vec<&str> = first["cancelled"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_str().unwrap())
        .collect();
    assert!(
        !first_cancelled.contains(&reading_group.as_str()),
        "the other version keeps the task alive: {first}"
    );
    assert_eq!(
        thread_key(&root, group).as_deref(),
        Some("t-b"),
        "the pointer follows the reader that is still there"
    );
    let last = helper.ok(
        "r2",
        "source.release_record",
        json!({ "channel": "chat", "groupKey": "t-b", "reason": "记录已删除" }),
    );
    let last_cancelled: Vec<&str> = last["cancelled"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_str().unwrap())
        .collect();
    assert!(
        last_cancelled.contains(&reading_group.as_str()),
        "both versions are now invalid, so the task stops: {last}"
    );
    let listed = helper.ok("l1", "queue.list", json!({ "offset": 0, "limit": 50 }));
    for row in listed["items"].as_array().unwrap() {
        if row["channel"] == "reading" {
            assert_eq!(row["state"], "cancelled", "{row}");
        }
    }
}

/// A note keeps one row per published version: far more than one preview page. The
/// release works over the record, so the answer stays a count and every version goes.
#[test]
fn a_note_with_more_versions_than_one_page_is_released_whole() {
    let root = Root::new("many-versions");
    let mut helper = Helper::start(&root);
    let at = now_ms();
    let origin = "note_many_versions";
    for index in 0..201 {
        helper.ok(
            &format!("n{index}"),
            "source.publish",
            json!({
                "channel": "note",
                "kind": "note",
                "originRef": origin,
                "groupKey": origin,
                "threadKey": origin,
                "title": "长随记",
                "scope": "随记",
                "text": format!("第 {index} 版正文，每次保存都是同一条来源的新版本。"),
                "at": at + index
            }),
        );
    }
    let released = helper.ok(
        "r1",
        "source.release_record",
        json!({ "channel": "note", "originRef": origin, "reason": "记录已删除" }),
    );
    assert_eq!(released["retired"], 201, "{released}");
    let found = helper.ok(
        "f1",
        "source.find",
        json!({ "channel": "note", "originRef": origin }),
    );
    assert_eq!(found["incomplete"], true, "a preview page is capped");
    for row in found["sources"].as_array().unwrap() {
        assert_eq!(row["state"], "invalid", "{row}");
    }
    let invalid: i64 = {
        let path = root.join("data").join("knowledge").join("knowledge.db");
        let connection = rusqlite::Connection::open(path).unwrap();
        connection
            .query_row(
                "SELECT count(*) FROM sources WHERE origin_ref = ?1 AND state = 'invalid'",
                [origin],
                |row| row.get(0),
            )
            .unwrap()
    };
    assert_eq!(invalid, 201, "every version went, not one page of them");
}

/// A database from before schema 10 only kept one thread per group. That pointer is
/// a hint, not proof: deleting that thread must not retire the page or delete a card
/// that cites it.
#[test]
fn an_upgraded_hint_never_authorizes_a_retire() {
    let root = Root::new("hint");
    let mut helper = Helper::start(&root);
    let at = now_ms();
    let page = "https://example.test/hinted";
    helper.ok("a1", "source.publish", turn("t-a", "问题甲", "回答甲", at));
    helper.ok(
        "a2",
        "source.publish",
        material(
            page,
            "reading:hinted",
            "t-a",
            "旧库里只记了一个读者的正文。",
            at,
        ),
    );
    let page_id = source_of(&mut helper, "f1")["id"]
        .as_str()
        .unwrap()
        .to_string();
    helper.ok(
        "c1",
        "card.save",
        json!({
            "kind": "concept",
            "title": "旧库知识",
            "body": "引用旧库里只记了一个读者的材料。",
            "sourceIds": [page_id]
        }),
    );
    helper.stop();
    let path = root.join("data").join("knowledge").join("knowledge.db");
    {
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection
            .execute_batch("DROP TABLE source_records; PRAGMA user_version = 8;")
            .unwrap();
    }
    let mut helper = Helper::start(&root);
    let hint: i64 = {
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection
            .query_row(
                "SELECT count(*) FROM source_records WHERE exclusive = 0",
                [],
                |row| row.get(0),
            )
            .unwrap()
    };
    assert!(hint >= 1, "the upgraded library kept the pointer as a hint");

    let released = helper.ok(
        "r1",
        "source.release_record",
        json!({ "channel": "chat", "groupKey": "t-a", "reason": "记录已删除" }),
    );
    assert_eq!(
        released["retired"], 1,
        "only the turn is provably t-a's: {released}"
    );
    assert_eq!(source_state(&root, &page_id), "active");
    let preview = helper.ok("i1", "card.impact", json!({ "threadId": "t-a" }));
    assert_eq!(
        preview["cards"], 0,
        "the hint protects the card too: {preview}"
    );
}
