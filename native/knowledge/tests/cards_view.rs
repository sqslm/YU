//! Stage-5 checks for the page a user reads: the favourite mark, the topic and
//! kind filters with a filtered `total`, the byte-budgeted page, the topic index,
//! the revision list, the merge and the markdown export.
//!
//! Everything talks to the real helper binary over a real pipe and a throwaway
//! SQLite file. The only faked collaborator is the model: the test answers the
//! `model.request` frames the way the Electron host does, which is also the only
//! route to a revision `card.revisions` can list.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{Value, json};

struct Root(PathBuf);

impl Root {
    fn new(name: &str) -> Self {
        let path =
            std::env::temp_dir().join(format!("yu-knowledge-view-{name}-{}", std::process::id()));
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

/// A scripted model: every `model.request` is answered with the next canned
/// answer, after the placeholders are replaced with the ids this run created.
struct Helper {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    answers: Vec<String>,
    counter: u64,
    source_id: String,
    fingerprint: String,
    card_id: String,
}

impl Helper {
    fn start(root: &Path, answers: Vec<String>) -> Self {
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
            counter: 0,
            source_id: String::new(),
            fingerprint: String::new(),
            card_id: String::new(),
        };
        let ready = helper.recv();
        assert_eq!(ready["type"], "ready", "helper must report ready: {ready}");
        helper.ok("cfg", "collect.configure", json!({"enabled": true}));
        helper
    }

    fn send(&mut self, frame: Value) {
        let line = serde_json::to_string(&frame).expect("frame");
        writeln!(self.stdin, "{line}").expect("write");
        self.stdin.flush().expect("flush");
    }

    fn answer_model(&mut self, frame: &Value) {
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

    fn save(&mut self, id: &str, params: Value) -> String {
        let saved = self.ok(id, "card.save", params);
        saved["id"].as_str().expect("card id").to_string()
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
        self.source_id = result["sourceId"].as_str().expect("sourceId").to_string();
        self.fingerprint = result["fingerprint"]
            .as_str()
            .expect("fingerprint")
            .to_string();
        result
    }

    /// Builds the `extract.run` items for a claimed group out of the test's own
    /// copy of the body, exactly as the main process does.
    fn items(group: &Value, bodies: &[(String, String, String)]) -> Value {
        let mut items = Vec::new();
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
        Value::Array(items)
    }

    /// Publishes one note, claims it and runs the single batch it produces.
    fn run(&mut self, group: &str, text: &str, prefix: &str) -> Value {
        let published = self.publish(group, text);
        let fingerprint = published["fingerprint"]
            .as_str()
            .expect("fingerprint")
            .to_string();
        let next = self.ok(&format!("{prefix}-next"), "extract.next", json!({}));
        let claimed = next["group"].clone();
        let items = Helper::items(
            &claimed,
            &[(self.source_id.clone(), fingerprint, text.to_string())],
        );
        self.ok(
            &format!("{prefix}-run"),
            "extract.run",
            json!({
                "groupId": claimed["groupId"],
                "claim": claimed["claim"],
                "items": items,
            }),
        )
    }

    /// Drains a note without creating knowledge and reports the source it left.
    fn seed(&mut self, group: &str, text: &str, prefix: &str) -> String {
        self.run(group, text, prefix);
        self.source_id.clone()
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

fn merge_answer() -> String {
    json!({"decisions": [{"index": 0, "action": "merge", "targetCardId": "CARD/1",
                          "reason": "补充细节"}]})
    .to_string()
}

const BODY: &str =
    "这张卡片说明了知识提炼的结论、适用条件与关键机制，并标出哪些内容是待验证的推断。";

fn draft(title: &str, body: &str, source: &str) -> Value {
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

fn card_params(
    kind: &str,
    title: &str,
    summary: &str,
    body: &str,
    topics: &[&str],
    aliases: &[&str],
    sources: &[String],
) -> Value {
    json!({
        "kind": kind,
        "title": title,
        "summary": summary,
        "body": body,
        "topics": topics,
        "aliases": aliases,
        "sourceIds": sources,
    })
}

fn ids(page: &Value) -> Vec<String> {
    page["items"]
        .as_array()
        .expect("items")
        .iter()
        .map(|item| item["id"].as_str().expect("id").to_string())
        .collect()
}

#[test]
fn the_favourite_and_topic_filters_page_with_a_filtered_total() {
    let root = Root::new("filters");
    let mut helper = Helper::start(&root, vec![]);
    let first = helper.save(
        "s1",
        card_params(
            "concept",
            "甲",
            "甲的摘要",
            "甲的正文。",
            &["rust"],
            &[],
            &[],
        ),
    );
    let second = helper.save(
        "s2",
        card_params(
            "concept",
            "乙",
            "乙的摘要",
            "乙的正文。",
            &["rust", "sqlite"],
            &[],
            &[],
        ),
    );
    let third = helper.save(
        "s3",
        card_params(
            "method",
            "丙",
            "丙的摘要",
            "丙的正文。",
            &["sqlite"],
            &[],
            &[],
        ),
    );
    let fourth = helper.save(
        "s4",
        card_params(
            "concept",
            "丁",
            "丁的摘要",
            "丁的正文。",
            &["kotlin"],
            &[],
            &[],
        ),
    );

    // A favourite is a label, not an edit: it moves `updated_at` and nothing else.
    let flipped = helper.ok("f1", "card.update", json!({"id": first, "favorite": true}));
    assert_eq!(flipped["favorite"], true, "{flipped}");
    assert_eq!(
        flipped["edited"], false,
        "a favourite is not an edit: {flipped}"
    );
    assert_eq!(
        flipped["revision"], 1,
        "a favourite must not bump the revision: {flipped}"
    );
    helper.ok("f2", "card.update", json!({"id": third, "favorite": true}));

    let all = helper.ok("l1", "card.list", json!({}));
    assert_eq!(all["total"], 4);
    assert_eq!(ids(&all).len(), 4);
    assert!(
        all["items"][0].get("body").is_none(),
        "a listing carries no body: {all}"
    );

    let favourites = helper.ok("l2", "card.list", json!({"favorite": true}));
    assert_eq!(
        favourites["total"], 2,
        "total counts the filtered rows: {favourites}"
    );
    let mut marked = ids(&favourites);
    marked.sort();
    let mut expected = vec![first.clone(), third.clone()];
    expected.sort();
    assert_eq!(marked, expected);
    for item in favourites["items"].as_array().expect("items") {
        assert_eq!(item["favorite"], true, "{item}");
    }
    let rest = helper.ok("l3", "card.list", json!({"favorite": false}));
    assert_eq!(rest["total"], 2, "{rest}");
    let mut others = ids(&rest);
    others.sort();
    let mut expected = vec![second.clone(), fourth.clone()];
    expected.sort();
    assert_eq!(others, expected);

    let rust = helper.ok("l4", "card.list", json!({"topic": "rust"}));
    assert_eq!(rust["total"], 2, "{rust}");
    let rust_favourite = helper.ok(
        "l5",
        "card.list",
        json!({"topic": "rust", "favorite": true}),
    );
    assert_eq!(rust_favourite["total"], 1, "{rust_favourite}");
    assert_eq!(ids(&rust_favourite), vec![first.clone()]);
    let methods = helper.ok("l6", "card.list", json!({"kind": "method"}));
    assert_eq!(methods["total"], 1, "{methods}");
    assert_eq!(ids(&methods), vec![third.clone()]);

    // Filters run before the page is cut, so the page agrees with the filtered total.
    let page = helper.ok("p1", "card.list", json!({"topic": "rust", "limit": 1}));
    assert_eq!(page["total"], 2, "{page}");
    assert_eq!(ids(&page).len(), 1);
    assert_eq!(page["hasMore"], true);
    let next = page["nextOffset"].as_u64().expect("next offset");
    assert_eq!(next, 1, "{page}");
    let tail = helper.ok(
        "p2",
        "card.list",
        json!({"topic": "rust", "offset": next, "limit": 1}),
    );
    assert_eq!(tail["total"], 2, "{tail}");
    assert_eq!(ids(&tail).len(), 1);
    assert_eq!(tail["hasMore"], false);

    // The search carries the same filters and the same total.
    let searched = helper.ok(
        "q1",
        "card.search",
        json!({"query": "正文", "topic": "rust"}),
    );
    assert_eq!(searched["total"], 2, "{searched}");
    let marked_search = helper.ok(
        "q2",
        "card.search",
        json!({"query": "正文", "favorite": true}),
    );
    assert_eq!(marked_search["total"], 2, "{marked_search}");
}

#[test]
fn a_byte_budgeted_page_still_names_the_next_offset() {
    let root = Root::new("budget");
    let mut helper = Helper::start(&root, vec![]);
    // A summary is the largest field a page carries, so a legal page of these
    // fills the result budget long before the limit is reached.
    let summary = "摘".repeat(2_000);
    let topics: Vec<String> = (0..32)
        .map(|index| format!("{index:02}主{}", "题".repeat(97)))
        .collect();
    let topics: Vec<&str> = topics.iter().map(String::as_str).collect();
    for index in 0..70 {
        helper.save(
            &format!("b{index}"),
            card_params(
                "concept",
                &format!("卡片{index:02}"),
                &summary,
                "正文",
                &topics,
                &[],
                &[],
            ),
        );
    }
    let page = helper.ok("p1", "card.list", json!({"limit": 100}));
    assert_eq!(page["total"], 70, "the count is not the page");
    let shown = ids(&page).len();
    assert!(shown < 70, "the byte budget must trim the page: {shown}");
    assert_eq!(page["hasMore"], true, "{shown} of 70 fits the budget");
    assert_eq!(
        page["nextOffset"].as_u64().expect("next offset"),
        shown as u64,
        "the next page starts where this one stopped, not at offset + limit"
    );
    let tail = helper.ok("p2", "card.list", json!({"offset": shown, "limit": 100}));
    assert_eq!(tail["total"], 70);
    assert_eq!(tail["hasMore"], false);
    assert_eq!(shown + ids(&tail).len(), 70, "every card is reachable");
}

#[test]
fn the_topic_index_counts_every_card_once_per_topic() {
    let root = Root::new("topics");
    let mut helper = Helper::start(&root, vec![]);
    helper.save(
        "s1",
        card_params("concept", "甲", "", "", &["rust", "sqlite"], &[], &[]),
    );
    helper.save(
        "s2",
        card_params("concept", "乙", "", "", &["rust"], &[], &[]),
    );
    helper.save(
        "s3",
        card_params("concept", "丙", "", "", &["rust", "kotlin"], &[], &[]),
    );
    helper.save(
        "s4",
        card_params("concept", "丁", "", "", &["sqlite"], &[], &[]),
    );

    let listed = helper.ok("t1", "topic.list", json!({}));
    let topics = listed["topics"].as_array().expect("topics");
    assert_eq!(
        topics
            .iter()
            .map(|entry| (
                entry["topic"].as_str().expect("topic").to_string(),
                entry["count"].as_i64().expect("count")
            ))
            .collect::<Vec<_>>(),
        vec![
            ("rust".to_string(), 3),
            ("sqlite".to_string(), 2),
            ("kotlin".to_string(), 1),
        ],
        "count first, then the topic name: {listed}"
    );
    assert_eq!(listed["total"], 3);

    let limited = helper.ok("t2", "topic.list", json!({"limit": 2}));
    assert_eq!(limited["topics"].as_array().expect("topics").len(), 2);
    assert_eq!(
        limited["total"], 3,
        "the total counts distinct topics before the limit: {limited}"
    );
}

#[test]
fn revisions_are_newest_first_and_bounded() {
    let root = Root::new("revisions");
    let mut helper = Helper::start(
        &root,
        vec![
            drafts_answer(json!([])),
            drafts_answer(json!([draft(
                "知识提炼",
                &format!("{BODY}补充细节 A：第一批材料带来的结论。"),
                "src/1"
            )])),
            merge_answer(),
            drafts_answer(json!([draft(
                "知识提炼",
                &format!("{BODY}补充细节 B：第二批材料带来的结论。"),
                "src/1"
            )])),
            merge_answer(),
        ],
    );
    let seed = helper.seed("seed", "种子正文，内容足够长以便提炼。", "seed");
    let existing = format!("{BODY}条件 A：仅在离线时成立。");
    let card = helper.save(
        "c1",
        card_params(
            "concept",
            "知识提炼",
            "摘要",
            &existing,
            &["知识"],
            &[],
            &[seed],
        ),
    );
    helper.card_id = card.clone();
    // Two extracted merges leave two snapshots behind, one per replaced revision.
    let first = helper.run("note-a", "第一段正文，内容足够长以便合并。", "a");
    assert_eq!(first["cards"][0]["action"], "merge", "{first}");
    let second = helper.run("note-b", "第二段正文，内容同样足够长。", "b");
    assert_eq!(second["cards"][0]["action"], "merge", "{second}");

    let listed = helper.ok("v1", "card.revisions", json!({"id": card}));
    assert_eq!(listed["id"], card);
    let entries = listed["revisions"].as_array().expect("revisions");
    assert_eq!(
        entries.len(),
        3,
        "the current revision plus two snapshots: {listed}"
    );
    assert_eq!(
        entries[0]["revision"], 3,
        "the current revision comes first"
    );
    assert_eq!(entries[1]["revision"], 2);
    assert_eq!(entries[2]["revision"], 1);
    assert!(
        entries[2]["body"]
            .as_str()
            .expect("body")
            .contains("条件 A"),
        "the oldest snapshot keeps what the card said: {listed}"
    );
    assert_eq!(entries[0]["topics"], json!(["知识"]));

    let one = helper.ok("v2", "card.revisions", json!({"id": card, "limit": 1}));
    assert_eq!(one["revisions"].as_array().expect("revisions").len(), 1);
    assert_eq!(one["revisions"][0]["revision"], 3);
    // The limit is clamped, never rejected.
    let clamped = helper.ok("v3", "card.revisions", json!({"id": card, "limit": 99}));
    assert_eq!(clamped["revisions"].as_array().expect("revisions").len(), 3);
    let missing = helper.call("v4", "card.revisions", json!({"id": "card_missing"}));
    assert_eq!(missing["ok"], false, "{missing}");
    assert_eq!(missing["error"]["code"], "not_found", "{missing}");
}

#[test]
fn a_merge_joins_two_cards_and_keeps_the_older_revision_readable() {
    let root = Root::new("merge");
    let mut helper = Helper::start(
        &root,
        vec![
            drafts_answer(json!([])),
            drafts_answer(json!([draft(
                "知识提炼",
                &format!("{BODY}补充细节 A：第一批材料带来的结论。"),
                "src/1"
            )])),
            merge_answer(),
            drafts_answer(json!([])),
            drafts_answer(json!([draft(
                "知识提炼",
                &format!("{BODY}补充细节 B：第二批材料带来的结论。"),
                "src/1"
            )])),
            merge_answer(),
        ],
    );
    let seed_a = helper.seed("seed-a", "种子正文甲，内容足够长以便提炼。", "sa");
    let kept_saved = helper.save(
        "k1",
        card_params(
            "concept",
            "知识提炼",
            "甲的摘要",
            &format!("{BODY}甲的条件：只在离线时成立。"),
            &["rust", "sqlite"],
            &["甲别名"],
            &[seed_a],
        ),
    );
    helper.card_id = kept_saved.clone();
    helper.run("note-a", "第一段正文，内容足够长以便合并。", "ma");

    let seed_b = helper.seed("seed-b", "种子正文乙，内容足够长以便提炼。", "sb");
    let merged_saved = helper.save(
        "k2",
        card_params(
            "concept",
            "知识提炼",
            "乙的摘要",
            &format!("{BODY}乙的细节：只在联网时成立。"),
            &["rust", "kotlin"],
            &["乙别名"],
            &[seed_b],
        ),
    );
    helper.card_id = merged_saved.clone();
    helper.run("note-b", "第二段正文，内容同样足够长。", "mb");
    // The merged card is the favourite one; the union must keep the mark.
    helper.ok(
        "fav",
        "card.update",
        json!({"id": merged_saved, "favorite": true}),
    );

    let other = helper.save(
        "k3",
        card_params("concept", "邻居", "", "第三张卡片。", &["rust"], &[], &[]),
    );
    let outgoing = helper.ok(
        "rl1",
        "relation.add",
        json!({"fromId": merged_saved, "toId": other, "kind": "derives"}),
    );
    // This edge becomes a self-loop the moment the two cards become one.
    helper.ok(
        "rl2",
        "relation.add",
        json!({"fromId": merged_saved, "toId": kept_saved, "kind": "contains"}),
    );
    let kept_before = helper.ok("g1", "card.get", json!({"id": kept_saved}));
    let merged_before = helper.ok("g2", "card.get", json!({"id": merged_saved}));
    let merged_revision = merged_before["revision"].as_i64().expect("revision");

    let joined = helper.ok(
        "m1",
        "card.merge",
        json!({
            "keepId": kept_saved,
            "mergeId": merged_saved,
            "keepRevision": kept_before["revision"],
            "mergeRevision": merged_revision,
            "title": "知识提炼（合并）",
            "summary": "合并后的摘要",
            "body": "合并后的正文，保留甲的条件与乙的细节。",
        }),
    );
    let card = joined["card"].clone();
    assert_eq!(card["id"], kept_saved, "{joined}");
    assert_eq!(joined["removedId"], merged_saved);
    assert_eq!(card["title"], "知识提炼（合并）");
    assert_eq!(card["body"], "合并后的正文，保留甲的条件与乙的细节。");
    assert_eq!(card["edited"], true, "a merge is a hand edit: {card}");
    assert_eq!(card["favorite"], true, "favourite survives: {card}");
    assert_eq!(
        card["revision"],
        kept_before["revision"].as_i64().expect("revision") + 1
    );
    let topics = card["topics"].as_array().expect("topics");
    for topic in ["rust", "sqlite", "kotlin"] {
        assert!(
            topics.iter().any(|value| value == topic),
            "{topic} must survive the union: {card}"
        );
    }
    let aliases = card["aliases"].as_array().expect("aliases");
    for alias in ["甲别名", "乙别名"] {
        assert!(
            aliases.iter().any(|value| value == alias),
            "{alias} must survive the union: {card}"
        );
    }
    let sources = card["sourceIds"].as_array().expect("sources").len();
    assert_eq!(
        joined["sources"], sources,
        "the report counts what the kept card now holds: {joined}"
    );
    assert!(sources >= 4, "both cards' sources are repointed: {card}");

    let gone = helper.call("g3", "card.get", json!({"id": merged_saved}));
    assert_eq!(gone["ok"], false, "{gone}");
    assert_eq!(gone["error"]["code"], "not_found", "{gone}");

    // The edge to the third card is repointed, the one that became a self-loop goes.
    let listed = helper.ok("rl3", "relation.list", json!({"cardId": kept_saved}));
    let items = listed["items"].as_array().expect("items");
    assert_eq!(items.len(), 1, "only the repointed edge survives: {listed}");
    assert_eq!(items[0]["toId"], other);
    assert_eq!(items[0]["direction"], "out");
    assert_eq!(joined["relations"], listed["total"], "{joined}");
    let kept_edge = items[0]["id"].as_str().expect("id");
    assert_eq!(kept_edge, outgoing["id"]);

    // Both old revisions stay readable, under the kept card.
    let revisions = helper.ok("v1", "card.revisions", json!({"id": kept_saved}));
    let entries = revisions["revisions"].as_array().expect("revisions");
    let bodies: Vec<&str> = entries
        .iter()
        .map(|entry| entry["body"].as_str().expect("body"))
        .collect();
    assert!(
        bodies.iter().any(|body| body.contains("甲的条件")),
        "the kept card's snapshot survives: {revisions}"
    );
    assert!(
        bodies.iter().any(|body| body.contains("乙的细节")),
        "the merged card's snapshot moves over: {revisions}"
    );
    let mut numbers: Vec<i64> = entries
        .iter()
        .map(|entry| entry["revision"].as_i64().expect("revision"))
        .collect();
    numbers.sort_unstable();
    numbers.dedup();
    assert_eq!(
        numbers.len(),
        entries.len(),
        "moved revisions must not collide: {revisions}"
    );
}

#[test]
fn a_refused_merge_leaves_both_cards_untouched() {
    let root = Root::new("merge-refused");
    let mut helper = Helper::start(&root, vec![]);
    let kept = helper.save(
        "c1",
        card_params("concept", "甲", "甲摘要", "甲的正文。", &["rust"], &[], &[]),
    );
    let merged = helper.save(
        "c2",
        card_params(
            "concept",
            "乙",
            "乙摘要",
            "乙的正文。",
            &["sqlite"],
            &[],
            &[],
        ),
    );

    let same = helper.call(
        "m1",
        "card.merge",
        json!({"keepId": kept, "mergeId": kept, "keepRevision": 1, "mergeRevision": 1}),
    );
    assert_eq!(same["ok"], false, "{same}");
    assert_eq!(same["error"]["code"], "invalid_params", "{same}");

    let empty = helper.call(
        "m2",
        "card.merge",
        json!({"keepId": "", "mergeId": merged, "keepRevision": 1, "mergeRevision": 1}),
    );
    assert_eq!(empty["error"]["code"], "invalid_params", "{empty}");

    let stale = helper.call(
        "m3",
        "card.merge",
        json!({"keepId": kept, "mergeId": merged, "keepRevision": 9, "mergeRevision": 1}),
    );
    assert_eq!(stale["ok"], false, "{stale}");
    assert_eq!(stale["error"]["code"], "source_changed", "{stale}");

    let long = "长".repeat(200_001);
    let oversized = helper.call(
        "m4",
        "card.merge",
        json!({
            "keepId": kept,
            "mergeId": merged,
            "keepRevision": 1,
            "mergeRevision": 1,
            "body": long,
        }),
    );
    assert_eq!(oversized["error"]["code"], "invalid_params", "{oversized}");

    let still_there = helper.ok("g1", "card.list", json!({}));
    assert_eq!(still_there["total"], 2, "{still_there}");
    let first = helper.ok("g2", "card.get", json!({"id": kept}));
    assert_eq!(first["body"], "甲的正文。");
    assert_eq!(first["revision"], 1);
    let second = helper.ok("g3", "card.get", json!({"id": merged}));
    assert_eq!(second["body"], "乙的正文。");
    assert_eq!(second["revision"], 1);
    let missing = helper.call(
        "m5",
        "card.merge",
        json!({"keepId": kept, "mergeId": "card_missing", "keepRevision": 1, "mergeRevision": 1}),
    );
    assert_eq!(missing["error"]["code"], "not_found", "{missing}");
}

#[test]
fn the_export_writes_markdown_and_sanitises_the_filename() {
    let root = Root::new("export");
    let mut helper = Helper::start(&root, vec![]);
    let source = helper.ok(
        "src1",
        "source.save",
        json!({
            "kind": "note",
            "originRef": "n:1",
            "title": "合成来源",
            "version": "v1",
            "text": "一段用来算出指纹的正文。",
        }),
    );
    let source_id = source["id"].as_str().expect("source id").to_string();
    let title = "导出/文件名:*?\"<>|检查";
    let card = helper.save(
        "c1",
        card_params(
            "decision",
            title,
            "导出摘要",
            "导出正文。",
            &["rust", "sqlite"],
            &[],
            &[source_id],
        ),
    );
    let exported = helper.ok("e1", "card.export", json!({"id": card}));
    assert_eq!(exported["id"], card);
    let markdown = exported["markdown"].as_str().expect("markdown");
    assert!(
        markdown.starts_with(&format!("# {title}\n")),
        "the title opens the document: {markdown}"
    );
    assert!(markdown.contains("- 类型：decision\n"), "{markdown}");
    assert!(markdown.contains("- 主题：rust、sqlite\n"), "{markdown}");
    assert!(markdown.contains("- 版本：1\n"), "{markdown}");
    assert!(markdown.contains("导出摘要"), "{markdown}");
    assert!(markdown.contains("导出正文。"), "{markdown}");
    assert!(markdown.contains("## 来源\n"), "{markdown}");
    assert!(
        markdown.contains("- note · 合成来源 · n:1 · active"),
        "{markdown}"
    );
    assert!(
        !markdown.contains("<script") && !markdown.contains("<br"),
        "plain text only: {markdown}"
    );

    let filename = exported["filename"].as_str().expect("filename");
    assert!(filename.ends_with(".md"), "{filename}");
    assert_eq!(
        filename.matches('_').count(),
        8,
        "seven separators plus the slash: {filename}"
    );
    assert!(filename.starts_with("导出_文件名"), "{filename}");
    assert!(filename.ends_with("检查.md"), "{filename}");

    let control = helper.save(
        "c2",
        card_params("concept", "控制\u{7}字符", "", "", &[], &[], &[]),
    );
    let plain = helper.ok("e2", "card.export", json!({"id": control}));
    assert_eq!(
        plain["filename"], "控制_字符.md",
        "a control character becomes an underscore"
    );

    let long = helper.save(
        "c3",
        card_params("concept", &"长".repeat(120), "", "", &[], &[], &[]),
    );
    let trimmed = helper.ok("e3", "card.export", json!({"id": long}));
    let name = trimmed["filename"].as_str().expect("filename");
    assert_eq!(
        name.chars().count(),
        63,
        "sixty characters plus .md: {name}"
    );
    assert!(
        trimmed["markdown"]
            .as_str()
            .expect("markdown")
            .contains(&"长".repeat(120)),
        "the document keeps the whole title"
    );
}

#[test]
fn an_unedited_merge_keeps_both_current_bodies() {
    let root = Root::new("merge-unedited");
    let mut helper = Helper::start(&root, vec![]);
    let kept = helper.save(
        "a1",
        card_params(
            "concept",
            "甲",
            "甲的摘要",
            "甲的正文，从来没有被人改过。",
            &["rust"],
            &[],
            &[],
        ),
    );
    let merged = helper.save(
        "b1",
        card_params(
            "concept",
            "乙",
            "乙的摘要",
            "乙的正文，也从来没有被人改过。",
            &["rust"],
            &[],
            &[],
        ),
    );
    let kept_before = helper.ok("g1", "card.get", json!({"id": kept}));
    let merged_before = helper.ok("g2", "card.get", json!({"id": merged}));

    let joined = helper.ok(
        "m1",
        "card.merge",
        json!({
            "keepId": kept,
            "mergeId": merged,
            "keepRevision": kept_before["revision"],
            "mergeRevision": merged_before["revision"],
            "body": "合并后的正文。",
        }),
    );
    assert_eq!(joined["card"]["body"], "合并后的正文。", "{joined}");
    assert_eq!(
        joined["bodySource"], "request",
        "the preview says the body came from the request: {joined}"
    );
    assert_eq!(
        joined["preview"], "合并后的正文。",
        "and carries the text the interface shows: {joined}"
    );

    // Neither card had a revision list before the merge, so both current bodies
    // have to be written down as part of it.
    let revisions = helper.ok("v1", "card.revisions", json!({"id": kept}));
    let entries = revisions["revisions"].as_array().expect("revisions");
    let bodies: Vec<&str> = entries
        .iter()
        .map(|entry| entry["body"].as_str().expect("body"))
        .collect();
    assert!(
        bodies.iter().any(|body| body.contains("从来没有被人改过")),
        "the kept card's old body survives: {revisions}"
    );
    assert!(
        bodies
            .iter()
            .any(|body| body.contains("也从来没有被人改过")),
        "the merged card's old body survives: {revisions}"
    );
    let mut numbers: Vec<i64> = entries
        .iter()
        .map(|entry| entry["revision"].as_i64().expect("revision"))
        .collect();
    numbers.sort_unstable();
    let count = numbers.len();
    numbers.dedup();
    assert_eq!(
        count,
        numbers.len(),
        "snapshot numbers stay unique: {revisions}"
    );
    assert_eq!(
        joined["card"]["revision"].as_i64().expect("revision"),
        kept_before["revision"].as_i64().expect("revision") + 1
    );
}

#[test]
fn a_merge_folds_the_two_contrast_edges_into_one() {
    let root = Root::new("merge-contrast");
    let mut helper = Helper::start(&root, vec![]);
    let kept = helper.save(
        "a1",
        card_params("concept", "甲", "", "甲的正文。", &["rust"], &[], &[]),
    );
    let merged = helper.save(
        "b1",
        card_params("concept", "乙", "", "乙的正文。", &["rust"], &[], &[]),
    );
    let other = helper.save(
        "c1",
        card_params("concept", "丙", "", "丙的正文。", &["rust"], &[], &[]),
    );
    helper.ok(
        "r1",
        "relation.add",
        json!({"fromId": kept, "toId": other, "kind": "contrast",
               "evidence": "两者相反"}),
    );
    helper.ok(
        "r2",
        "relation.add",
        json!({"fromId": merged, "toId": other, "kind": "contrast",
               "evidence": "乙与丙也相反"}),
    );
    let kept_before = helper.ok("g1", "card.get", json!({"id": kept}));
    let merged_before = helper.ok("g2", "card.get", json!({"id": merged}));
    helper.ok(
        "m1",
        "card.merge",
        json!({
            "keepId": kept,
            "mergeId": merged,
            "keepRevision": kept_before["revision"],
            "mergeRevision": merged_before["revision"],
        }),
    );

    // Repointing turns both edges into the same pair, and a contrast pair is one
    // edge however many times it is written.
    let around = helper.ok("l1", "relation.list", json!({"cardId": other}));
    assert_eq!(around["total"], 1, "one contrast edge survives: {around}");
    let items = around["items"].as_array().expect("items");
    assert_eq!(items[0]["kind"], "contrast");
    assert_eq!(items[0]["origin"], "manual", "the hand-drawn origin stays");
    let from = items[0]["fromId"].as_str().expect("fromId");
    let to = items[0]["toId"].as_str().expect("toId");
    assert!(
        from < to,
        "a symmetric edge keeps its canonical direction: {around}"
    );
    assert!(
        items[0]["evidence"] == "两者相反" || items[0]["evidence"] == "乙与丙也相反",
        "the surviving edge keeps real evidence: {around}"
    );
    let node = helper.ok("l2", "relation.list", json!({"cardId": kept}));
    assert_eq!(node["total"], 1, "{node}");
}

#[test]
fn a_note_lists_only_the_cards_it_produced_and_filters_before_paging() {
    let root = Root::new("by-source");
    let mut helper = Helper::start(
        &root,
        vec![
            drafts_answer(json!([
                draft(
                    "甲",
                    "甲这条正文说明了适用条件、关键机制与失败时的退路，并标出仍然待验证的推断。",
                    "src/1"
                ),
                draft(
                    "乙",
                    "乙这条正文记录了另一组结论、边界与代价，同样标出哪些部分还没有被验证过。",
                    "src/1"
                ),
                json!({
                    "kind": "method",
                    "title": "丙",
                    "summary": "丙的摘要",
                    "body": "丙这条正文给出了一串可以照做的步骤，从准备到收尾都有明确的判断条件。",
                    "topics": ["方法"],
                    "aliases": [],
                    "sources": [{"sourceId": "src/1", "segment": 0}],
                    "reason": "可复用",
                }),
            ])),
            drafts_answer(json!([draft(
                "丁",
                "丁这条正文属于另一条随记，只写了一段可以复用的结论与它的适用前提。",
                "src/2"
            )])),
        ],
    );
    helper.run("note-a", "第一条随记写下了三段可以复用的结论。", "a");
    let first = helper.source_id.clone();
    helper.run("note-b", "第二条随记只写了一段结论。", "b");
    let second = helper.source_id.clone();
    assert_ne!(first, second, "each note owns its own record");

    let all = helper.ok("b1", "card.by_source", json!({"sourceId": first}));
    assert_eq!(all["total"], 3, "{all}");
    assert_eq!(ids(&all).len(), 3, "{all}");
    assert_eq!(all["hasMore"], false, "{all}");
    assert_eq!(all["nextOffset"], Value::Null, "{all}");
    let titles: Vec<&str> = all["items"]
        .as_array()
        .expect("items")
        .iter()
        .map(|item| item["title"].as_str().expect("title"))
        .collect();
    assert!(
        titles.contains(&"甲") && titles.contains(&"乙") && titles.contains(&"丙"),
        "{all}"
    );
    assert!(
        !titles.contains(&"丁"),
        "another note's card must not appear: {all}"
    );

    let other = helper.ok("b2", "card.by_source", json!({"sourceId": second}));
    assert_eq!(other["total"], 1, "{other}");
    assert_eq!(other["items"][0]["title"], "丁");

    // The filters narrow the record's cards before the page, so the total is real.
    let methods = helper.ok(
        "b3",
        "card.by_source",
        json!({"sourceId": first, "kind": "method"}),
    );
    assert_eq!(methods["total"], 1, "{methods}");
    assert_eq!(methods["items"][0]["title"], "丙");
    let topic = helper.ok(
        "b4",
        "card.by_source",
        json!({"sourceId": first, "topic": "方法"}),
    );
    assert_eq!(topic["total"], 1, "{topic}");

    let paged = helper.ok(
        "b5",
        "card.by_source",
        json!({"sourceId": first, "offset": 1, "limit": 1}),
    );
    assert_eq!(
        paged["total"], 3,
        "the total counts the whole record: {paged}"
    );
    assert_eq!(ids(&paged).len(), 1, "{paged}");
    assert_eq!(paged["hasMore"], true, "{paged}");
    assert_eq!(paged["nextOffset"], 2, "{paged}");

    let unknown = helper.call("b6", "card.by_source", json!({"sourceId": "src_missing"}));
    assert_eq!(unknown["ok"], false, "{unknown}");
    assert_eq!(unknown["error"]["code"], "not_found", "{unknown}");

    // The identity a detail view holds resolves to the same page.
    let found = helper.ok(
        "f1",
        "source.find",
        json!({"channel": "note", "originRef": "note-a"}),
    );
    let found = found["sources"].as_array().expect("sources");
    assert_eq!(found.len(), 1, "a note matches one record");
    assert_eq!(found[0]["id"], first);
    assert_eq!(found[0]["originRef"], "note-a");
    assert_eq!(found[0]["channel"], "note");
    assert_eq!(found[0]["state"], "active");
    let by_identity = helper.ok(
        "b7",
        "card.by_source",
        json!({"channel": "note", "originRef": "note-a"}),
    );
    assert_eq!(by_identity["total"], 3, "{by_identity}");

    let unresolved = helper.ok(
        "b8",
        "card.by_source",
        json!({"channel": "note", "originRef": "note-missing"}),
    );
    assert_eq!(unresolved["total"], 0, "{unresolved}");
    assert_eq!(unresolved["items"], json!([]), "{unresolved}");
    let empty = helper.ok(
        "f2",
        "source.find",
        json!({"channel": "note", "originRef": "note-missing"}),
    );
    assert_eq!(empty["sources"], json!([]), "{empty}");
}

/// Publishes one more version of the same note: the identity stays, the queue group
/// does not, so a republished note mints a second row under one `originRef`.
fn publish_version(helper: &mut Helper, note: &str, group: &str, text: &str) -> Value {
    let id = helper.next_id();
    let result = helper.ok(
        &id,
        "source.publish",
        json!({
            "channel": "note",
            "kind": "note",
            "originRef": note,
            "groupKey": group,
            "title": note,
            "scope": "notes",
            "text": text,
            "at": 1_700_000_000_000i64 + helper.counter as i64,
        }),
    );
    helper.source_id = result["sourceId"].as_str().expect("sourceId").to_string();
    helper.fingerprint = result["fingerprint"]
        .as_str()
        .expect("fingerprint")
        .to_string();
    result
}

#[test]
fn a_republished_note_answers_every_version_before_paging() {
    let root = Root::new("record");
    let mut helper = Helper::start(&root, vec![]);
    let first = publish_version(
        &mut helper,
        "note-a",
        "note-a",
        "第一版正文，说明了适用条件。",
    );
    let version_one = first["sourceId"].as_str().expect("sourceId").to_string();
    let second = publish_version(
        &mut helper,
        "note-a",
        "note-a-v2",
        "第二版正文，补充了关键机制。",
    );
    let version_two = second["sourceId"].as_str().expect("sourceId").to_string();
    assert_ne!(version_one, version_two, "a republished note is a new row");

    let old = helper.save(
        "c1",
        card_params(
            "concept",
            "旧",
            "旧的摘要",
            BODY,
            &["方法"],
            &[],
            std::slice::from_ref(&version_one),
        ),
    );
    let both = helper.save(
        "c2",
        card_params(
            "method",
            "双",
            "双的摘要",
            BODY,
            &["方法"],
            &[],
            &[version_one.clone(), version_two.clone()],
        ),
    );
    let fresh = helper.save(
        "c3",
        card_params(
            "concept",
            "新",
            "新的摘要",
            BODY,
            &["知识"],
            &[],
            std::slice::from_ref(&version_two),
        ),
    );

    let found = helper.ok("f1", "source.find", json!({ "noteId": "note-a" }));
    let sources = found["sources"].as_array().expect("sources");
    assert_eq!(sources.len(), 2, "both versions stay traceable: {found}");
    assert_eq!(sources[0]["id"], version_one, "oldest first: {found}");
    assert_eq!(sources[1]["id"], version_two, "{found}");

    let all = helper.ok("b1", "card.by_source", json!({ "noteId": "note-a" }));
    assert_eq!(
        all["total"], 3,
        "a card citing both versions is still one card: {all}"
    );
    let mut listed = ids(&all);
    listed.sort();
    let mut expected = vec![old.clone(), both.clone(), fresh.clone()];
    expected.sort();
    assert_eq!(listed, expected, "{all}");

    let only_kind = helper.ok(
        "b2",
        "card.by_source",
        json!({ "noteId": "note-a", "kind": "method" }),
    );
    assert_eq!(ids(&only_kind), vec![both.clone()], "{only_kind}");
    assert_eq!(only_kind["total"], 1, "{only_kind}");

    let only_topic = helper.ok(
        "b3",
        "card.by_source",
        json!({ "noteId": "note-a", "topic": "知识" }),
    );
    assert_eq!(ids(&only_topic), vec![fresh.clone()], "{only_topic}");

    let page = helper.ok(
        "b4",
        "card.by_source",
        json!({ "noteId": "note-a", "offset": 1, "limit": 1 }),
    );
    assert_eq!(
        page["total"], 3,
        "the total counts the whole record, not the page: {page}"
    );
    assert_eq!(page["hasMore"], true, "{page}");
    assert_eq!(page["nextOffset"], 2, "{page}");

    let by_identity = helper.ok(
        "b5",
        "card.by_source",
        json!({ "channel": "note", "originRef": "note-a" }),
    );
    assert_eq!(by_identity["total"], 3, "{by_identity}");

    let unknown = helper.call("b6", "card.by_source", json!({ "sourceId": "src_missing" }));
    assert_eq!(unknown["ok"], false, "{unknown}");
    assert_eq!(unknown["error"]["code"], "not_found", "{unknown}");

    let missing = helper.ok("b7", "card.by_source", json!({ "noteId": "note-missing" }));
    assert_eq!(missing["total"], 0, "{missing}");
    assert_eq!(missing["items"], json!([]), "{missing}");
}
