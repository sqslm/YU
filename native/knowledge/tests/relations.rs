//! Stage-5 checks for the card graph: hand-drawn relations, the symmetric
//! `contrast` edge, the cascade a card deletion must trigger, the bounded graph
//! view and the relations a model may propose inside one extraction batch.
//!
//! The helper binary is the real one and every database is a throwaway file. The
//! model is faked the way the Electron host fakes it: the test answers the
//! `model.request` frames itself.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{Value, json};

struct Root(PathBuf);

impl Root {
    fn new(name: &str) -> Self {
        let path =
            std::env::temp_dir().join(format!("yu-knowledge-graph-{name}-{}", std::process::id()));
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
/// answer.
struct Helper {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    answers: Vec<String>,
    counter: u64,
    source_id: String,
    fingerprint: String,
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
            .replace("\"src/1\"", &format!("\"{}\"", self.source_id));
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

    fn publish_on(&mut self, channel: &str, group: &str, text: &str) -> (String, String) {
        let id = self.next_id();
        let result = self.ok(
            &id,
            "source.publish",
            json!({
                "channel": channel,
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
        (self.source_id.clone(), self.fingerprint.clone())
    }

    fn publish_full(&mut self, group: &str, text: &str) -> (String, String) {
        self.publish_on("note", group, text)
    }

    /// Claims the next batch and slices every planned range out of the test's own
    /// copy of that source's text, so the helper proves each range itself.
    fn claim_parts(&mut self, prefix: &str, sources: &[(String, String, String)]) -> Value {
        let next = self.ok(&format!("{prefix}-next"), "extract.next", json!({}));
        let claimed = next["group"].clone();
        let mut items = Vec::new();
        for item in claimed["items"].as_array().expect("items") {
            let planned = item["sourceId"].as_str().expect("sourceId");
            let (_, fingerprint, text) = sources
                .iter()
                .find(|(source, _, _)| source == planned)
                .expect("planned source");
            let chars: Vec<char> = text.chars().collect();
            let start = item["start"].as_u64().expect("start") as usize;
            let end = item["end"].as_u64().expect("end") as usize;
            items.push(json!({
                "sourceId": item["sourceId"],
                "version": item["version"],
                "fingerprint": fingerprint,
                "segment": item["segment"],
                "start": item["start"],
                "end": item["end"],
                "text": chars[start..end].iter().collect::<String>(),
            }));
        }
        json!({"groupId": claimed["groupId"], "claim": claimed["claim"], "items": items})
    }

    /// Publishes one note, claims the task it creates and builds the `extract.run`
    /// params out of the test's own copy of the body.
    fn claim(&mut self, group: &str, text: &str, prefix: &str) -> Value {
        let (id, fingerprint) = self.publish_full(group, text);
        self.claim_parts(prefix, &[(id, fingerprint, text.to_string())])
    }

    fn run(&mut self, group: &str, text: &str, prefix: &str) -> Value {
        let params = self.claim(group, text, prefix);
        self.ok(&format!("{prefix}-run"), "extract.run", params)
    }

    /// Runs one batch and hands back the raw frame, so a refusal can be inspected.
    fn run_failing(&mut self, group: &str, text: &str) -> Value {
        let params = self.claim(group, text, "fail");
        self.call("fail-run", "extract.run", params)
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn card_params(kind: &str, title: &str, body: &str, topics: &[&str]) -> Value {
    json!({
        "kind": kind,
        "title": title,
        "summary": format!("{title}的摘要"),
        "body": body,
        "topics": topics,
        "aliases": [],
        "sourceIds": [],
    })
}

fn draft(title: &str, body: &str) -> Value {
    json!({
        "kind": "concept",
        "title": title,
        "summary": format!("{title}的摘要"),
        "body": body,
        "topics": ["知识"],
        "aliases": [],
        "sources": [{"sourceId": "src/1", "segment": 0}],
        "reason": "可复用",
    })
}

fn node_ids(graph: &Value) -> Vec<String> {
    graph["nodes"]
        .as_array()
        .expect("nodes")
        .iter()
        .map(|node| node["id"].as_str().expect("id").to_string())
        .collect()
}

#[test]
fn relations_can_be_added_listed_and_removed() {
    let root = Root::new("crud");
    let mut helper = Helper::start(&root, vec![]);
    let first = helper.save("c1", card_params("concept", "甲", "甲的正文。", &["rust"]));
    let second = helper.save("c2", card_params("concept", "乙", "乙的正文。", &["rust"]));
    let third = helper.save("c3", card_params("concept", "丙", "丙的正文。", &["rust"]));
    let added = helper.ok(
        "a1",
        "relation.add",
        json!({"fromId": first, "toId": second, "kind": "prerequisite",
               "evidence": "手工画的"}),
    );
    assert_eq!(added["fromId"], first);
    assert_eq!(added["toId"], second);
    assert_eq!(added["kind"], "prerequisite");
    assert_eq!(added["origin"], "manual");
    assert_eq!(added["evidence"], "手工画的");
    let relation = added["id"].as_str().expect("relation id").to_string();
    assert!(added["createdAt"].as_i64().expect("created") > 0);

    // A second add of the same edge is the same edge, not an error.
    let again = helper.ok(
        "a2",
        "relation.add",
        json!({"fromId": first, "toId": second, "kind": "prerequisite"}),
    );
    assert_eq!(
        again["id"], relation,
        "a duplicate returns the existing row"
    );

    helper.ok(
        "a3",
        "relation.add",
        json!({"fromId": first, "toId": third, "kind": "applies"}),
    );

    let from_first = helper.ok("l1", "relation.list", json!({"cardId": first}));
    assert_eq!(from_first["total"], 2, "{from_first}");
    let items = from_first["items"].as_array().expect("items");
    assert!(
        items.iter().all(|item| item["direction"] == "out"),
        "{from_first}"
    );
    assert!(
        items
            .iter()
            .all(|item| item["card"].get("summary").is_none()),
        "a neighbour carries metadata only: {from_first}"
    );
    let neighbours: Vec<&str> = items
        .iter()
        .map(|item| item["card"]["title"].as_str().expect("title"))
        .collect();
    assert!(neighbours.contains(&"乙"), "{from_first}");
    assert!(neighbours.contains(&"丙"), "{from_first}");
    assert!(
        !neighbours.contains(&"甲"),
        "a list never names the card that asked: {from_first}"
    );

    let from_second = helper.ok("l2", "relation.list", json!({"cardId": second}));
    assert_eq!(from_second["total"], 1, "{from_second}");
    let item = &from_second["items"][0];
    assert_eq!(
        item["direction"], "in",
        "the other end sees an incoming edge"
    );
    assert_eq!(item["card"]["id"], first);
    assert_eq!(item["card"]["title"], "甲");
    assert_eq!(item["card"]["kind"], "concept");

    let limited = helper.ok("l3", "relation.list", json!({"cardId": first, "limit": 1}));
    assert_eq!(limited["items"].as_array().expect("items").len(), 1);
    assert_eq!(limited["total"], 2, "the total is not the page: {limited}");

    let removed = helper.ok("r1", "relation.remove", json!({"id": relation}));
    assert_eq!(removed["removed"], true);
    let missing = helper.call("r2", "relation.remove", json!({"id": relation}));
    assert_eq!(missing["ok"], false, "{missing}");
    assert_eq!(missing["error"]["code"], "not_found", "{missing}");
    let after = helper.ok("l4", "relation.list", json!({"cardId": first}));
    assert_eq!(after["total"], 1, "{after}");
    let unknown_card = helper.call("l5", "relation.list", json!({"cardId": "card_missing"}));
    assert_eq!(unknown_card["error"]["code"], "not_found", "{unknown_card}");
}

#[test]
fn a_relation_refuses_its_own_ends_and_unknown_cards() {
    let root = Root::new("refuse");
    let mut helper = Helper::start(&root, vec![]);
    let first = helper.save("c1", card_params("concept", "甲", "甲的正文。", &[]));
    let second = helper.save("c2", card_params("concept", "乙", "乙的正文。", &[]));

    let looped = helper.call(
        "e1",
        "relation.add",
        json!({"fromId": first, "toId": first, "kind": "contains"}),
    );
    assert_eq!(looped["ok"], false, "{looped}");
    assert_eq!(looped["error"]["code"], "invalid_params", "{looped}");

    let unknown = helper.call(
        "e2",
        "relation.add",
        json!({"fromId": first, "toId": "card_missing", "kind": "contains"}),
    );
    assert_eq!(unknown["ok"], false, "{unknown}");
    assert_eq!(unknown["error"]["code"], "not_found", "{unknown}");

    let kind = helper.call(
        "e3",
        "relation.add",
        json!({"fromId": first, "toId": second, "kind": "related"}),
    );
    assert_eq!(kind["error"]["code"], "invalid_params", "{kind}");

    let evidence = "证".repeat(501);
    let long = helper.call(
        "e4",
        "relation.add",
        json!({"fromId": first, "toId": second, "kind": "contains", "evidence": evidence}),
    );
    assert_eq!(long["error"]["code"], "invalid_params", "{long}");

    let empty = helper.call(
        "e5",
        "relation.add",
        json!({"fromId": "", "toId": second, "kind": "contains"}),
    );
    assert_eq!(empty["error"]["code"], "invalid_params", "{empty}");

    let listed = helper.ok("l1", "relation.list", json!({"cardId": first}));
    assert_eq!(listed["total"], 0, "nothing was drawn: {listed}");
}

#[test]
fn contrast_is_one_edge_in_both_directions() {
    let root = Root::new("contrast");
    let mut helper = Helper::start(&root, vec![]);
    let first = helper.save("c1", card_params("concept", "甲", "甲的正文。", &[]));
    let second = helper.save("c2", card_params("concept", "乙", "乙的正文。", &[]));

    let forward = helper.ok(
        "a1",
        "relation.add",
        json!({"fromId": first, "toId": second, "kind": "contrast"}),
    );
    let backward = helper.ok(
        "a2",
        "relation.add",
        json!({"fromId": second, "toId": first, "kind": "contrast"}),
    );
    assert_eq!(
        forward["id"], backward["id"],
        "(a,b) and (b,a) are the same edge: {forward} {backward}"
    );
    let from_first = helper.ok("l1", "relation.list", json!({"cardId": first}));
    assert_eq!(from_first["total"], 1, "{from_first}");
    let from_second = helper.ok("l2", "relation.list", json!({"cardId": second}));
    assert_eq!(from_second["total"], 1, "{from_second}");

    // The other kinds stay directed: the same pair can carry both directions.
    helper.ok(
        "a3",
        "relation.add",
        json!({"fromId": first, "toId": second, "kind": "contains"}),
    );
    helper.ok(
        "a4",
        "relation.add",
        json!({"fromId": second, "toId": first, "kind": "contains"}),
    );
    let listed = helper.ok("l3", "relation.list", json!({"cardId": first, "limit": 10}));
    assert_eq!(listed["total"], 3, "{listed}");
}

#[test]
fn deleting_a_card_takes_its_relations_with_it() {
    let root = Root::new("cascade");
    let mut helper = Helper::start(&root, vec![]);
    let first = helper.save("c1", card_params("concept", "甲", "甲的正文。", &[]));
    let second = helper.save("c2", card_params("concept", "乙", "乙的正文。", &[]));
    let relation = helper.ok(
        "a1",
        "relation.add",
        json!({"fromId": first, "toId": second, "kind": "derives"}),
    );
    let id = relation["id"].as_str().expect("id").to_string();

    helper.ok("d1", "card.delete", json!({"id": second}));
    let listed = helper.ok("l1", "relation.list", json!({"cardId": first}));
    assert_eq!(listed["total"], 0, "the edge went with the card: {listed}");
    let removed = helper.call("r1", "relation.remove", json!({"id": id}));
    assert_eq!(removed["error"]["code"], "not_found", "{removed}");
    // The kept card is still readable and the deleted one is gone.
    let kept = helper.ok("g1", "card.get", json!({"id": first}));
    assert_eq!(kept["title"], "甲");
    let gone = helper.call("g2", "card.get", json!({"id": second}));
    assert_eq!(gone["error"]["code"], "not_found", "{gone}");
}

#[test]
fn the_graph_filters_expands_the_focus_and_caps_the_nodes() {
    let root = Root::new("graph");
    let mut helper = Helper::start(&root, vec![]);
    let first = helper.save(
        "c1",
        card_params("concept", "甲", "第一张卡片的正文。", &["rust"]),
    );
    let second = helper.save(
        "c2",
        card_params("concept", "乙", "第二张卡片的正文。", &["rust"]),
    );
    let third = helper.save(
        "c3",
        card_params("concept", "丙", "第三张卡片的正文。", &["sqlite"]),
    );
    let fourth = helper.save(
        "c4",
        card_params("concept", "丁", "第四张卡片的正文。", &["rare"]),
    );
    for (index, (from, to, kind)) in [
        (&first, &second, "contains"),
        (&second, &third, "derives"),
        (&third, &fourth, "prerequisite"),
    ]
    .iter()
    .enumerate()
    {
        helper.ok(
            &format!("a{index}"),
            "relation.add",
            json!({"fromId": from, "toId": to, "kind": kind}),
        );
    }

    let filtered = helper.ok("g1", "graph.query", json!({"topic": "rust"}));
    assert_eq!(filtered["total"], 2, "{filtered}");
    assert_eq!(filtered["shown"], 2);
    assert_eq!(filtered["truncated"], false);
    assert!(filtered["limitedBy"].is_null(), "{filtered}");
    let mut nodes = node_ids(&filtered);
    nodes.sort();
    let mut expected = vec![first.clone(), second.clone()];
    expected.sort();
    assert_eq!(nodes, expected);
    let edges = filtered["edges"].as_array().expect("edges");
    assert_eq!(
        edges.len(),
        1,
        "an edge needs both ends in the view: {filtered}"
    );
    assert_eq!(edges[0]["kind"], "contains");
    assert_eq!(edges[0]["origin"], "manual");
    for node in filtered["nodes"].as_array().expect("nodes") {
        assert!(node.get("body").is_none(), "a node carries no body: {node}");
        assert!(node.get("summary").is_none(), "{node}");
        assert!(node.get("topics").is_some(), "{node}");
        assert!(node.get("favorite").is_some(), "{node}");
        assert!(node.get("kind").is_some(), "{node}");
    }

    // A short query takes the literal branch, a longer one the trigram index.
    let short = helper.ok("g2", "graph.query", json!({"query": "丙"}));
    assert_eq!(short["total"], 1, "{short}");
    assert_eq!(node_ids(&short), vec![third.clone()]);
    let long = helper.ok("g3", "graph.query", json!({"query": "第三张卡片"}));
    assert_eq!(long["total"], 1, "{long}");
    assert_eq!(node_ids(&long), vec![third.clone()]);

    // The focus is always in the view and pulls in one hop per depth.
    let one = helper.ok(
        "g4",
        "graph.query",
        json!({"topic": "rare", "focusId": first, "depth": 1}),
    );
    let mut nodes = node_ids(&one);
    nodes.sort();
    let mut expected = vec![first.clone(), second.clone(), fourth.clone()];
    expected.sort();
    assert_eq!(nodes, expected, "{one}");
    let two = helper.ok(
        "g5",
        "graph.query",
        json!({"topic": "rare", "focusId": first, "depth": 2}),
    );
    let mut nodes = node_ids(&two);
    nodes.sort();
    let mut expected = vec![first.clone(), second.clone(), third.clone(), fourth.clone()];
    expected.sort();
    assert_eq!(nodes, expected, "{two}");
    let deep = helper.ok(
        "g6",
        "graph.query",
        json!({"topic": "rare", "focusId": first, "depth": 9}),
    );
    assert_eq!(node_ids(&deep).len(), 4, "depth stops at two hops: {deep}");

    // The cap trims the view and reports the real total.
    let capped = helper.ok("g7", "graph.query", json!({"limit": 2}));
    assert_eq!(capped["total"], 4, "{capped}");
    assert_eq!(capped["shown"], 2);
    assert_eq!(capped["truncated"], true);
    assert_eq!(capped["limitedBy"], "nodes", "{capped}");
    let visible = node_ids(&capped);
    assert_eq!(visible.len(), 2);
    for edge in capped["edges"].as_array().expect("edges") {
        for end in ["fromId", "toId"] {
            let id = edge[end].as_str().expect("endpoint");
            assert!(
                visible.iter().any(|node| node == id),
                "every edge stays inside the view: {capped}"
            );
        }
    }

    let missing = helper.call(
        "g8",
        "graph.query",
        json!({"focusId": "card_missing", "depth": 1}),
    );
    assert_eq!(missing["error"]["code"], "not_found", "{missing}");
}

#[test]
fn the_byte_budget_limits_the_view_before_the_node_cap() {
    let root = Root::new("graph-bytes");
    let mut helper = Helper::start(&root, vec![]);
    let topics: Vec<String> = (0..32)
        .map(|index| format!("{index:02}主{}", "题".repeat(97)))
        .collect();
    let topics: Vec<&str> = topics.iter().map(String::as_str).collect();
    for index in 0..70 {
        helper.save(
            &format!("b{index}"),
            json!({
                "kind": "concept",
                "title": format!("卡片{index:02}{}", "标".repeat(190)),
                "summary": "",
                "body": "",
                "topics": topics,
                "aliases": [],
                "sourceIds": [],
            }),
        );
    }
    let graph = helper.ok("g1", "graph.query", json!({"limit": 200}));
    assert_eq!(graph["total"], 70, "{graph}");
    let shown = node_ids(&graph).len();
    assert!(shown < 70, "the byte budget must trim the view: {shown}");
    assert_eq!(graph["shown"].as_u64().expect("shown"), shown as u64);
    assert_eq!(graph["truncated"], true);
    assert_eq!(graph["limitedBy"], "bytes", "{shown} nodes exceed 512 KiB");
    assert!(
        graph["edges"].as_array().expect("edges").is_empty(),
        "these cards have no relations: {graph}"
    );
}

#[test]
fn model_relations_land_with_the_text_they_quote() {
    let root = Root::new("model-relations");
    let text = "第一段原文，讲卡片甲，也讲卡片乙。";
    let mut helper = Helper::start(
        &root,
        vec![
            json!({
                "cards": [
                    draft("甲卡", "甲卡的完整正文，说明第一件事的结论、适用条件与关键机制，并标出待验证的推断。"),
                    draft("乙卡", "乙卡的完整正文，说明第二件事的结论、适用条件与关键机制，并标出待验证的推断。"),
                ],
                "relations": [
                    {"from": "draft:0", "to": "draft:1", "kind": "contains",
                     "evidence": "也讲卡片乙"},
                    {"from": "draft:0", "to": "draft:1", "kind": "contains",
                     "evidence": "也讲卡片乙"},
                ],
                "reason": "ok",
            })
            .to_string(),
        ],
    );
    let outcome = helper.run("note-a", text, "n");
    assert_eq!(outcome["state"], "completed", "{outcome}");
    let listed = helper.ok("l1", "card.list", json!({}));
    assert_eq!(listed["total"], 2, "{listed}");
    let first = listed["items"]
        .as_array()
        .expect("items")
        .iter()
        .find(|item| item["title"] == "甲卡")
        .expect("甲卡")
        .get("id")
        .and_then(Value::as_str)
        .expect("id")
        .to_string();
    let second = listed["items"]
        .as_array()
        .expect("items")
        .iter()
        .find(|item| item["title"] == "乙卡")
        .expect("乙卡")
        .get("id")
        .and_then(Value::as_str)
        .expect("id")
        .to_string();

    let relations = helper.ok("l2", "relation.list", json!({"cardId": first}));
    assert_eq!(
        relations["total"], 1,
        "the duplicate in the answer is one edge: {relations}"
    );
    let item = &relations["items"][0];
    assert_eq!(item["kind"], "contains");
    assert_eq!(item["origin"], "model");
    assert_eq!(item["evidence"], "也讲卡片乙");
    assert_eq!(item["toId"], second);
    assert_eq!(item["direction"], "out");
}

#[test]
fn a_relation_outside_the_batch_fails_the_batch() {
    let root = Root::new("model-outside");
    let text = "一段等待提炼的正文，内容足够长以便提炼。";
    let mut helper = Helper::start(
        &root,
        vec![
            json!({
                "cards": [draft("甲卡", "甲卡的完整正文，说明第一件事的结论、适用条件与关键机制，并标出待验证的推断。")],
                "relations": [
                    {"from": "draft:0", "to": "card_not_offered", "kind": "contains",
                     "evidence": "内容足够长"},
                ],
                "reason": "ok",
            })
            .to_string(),
        ],
    );
    let failed = helper.run_failing("note-a", text);
    assert_eq!(failed["ok"], false, "{failed}");
    assert_eq!(failed["error"]["code"], "invalid_output", "{failed}");
    let listed = helper.ok("l1", "card.list", json!({}));
    assert_eq!(listed["total"], 0, "the batch is rolled back: {listed}");
}

#[test]
fn a_relation_whose_quote_is_missing_fails_the_batch() {
    let root = Root::new("model-quote");
    let mut helper = Helper::start(
        &root,
        vec![
            json!({
                "cards": [draft("甲卡", "甲卡的完整正文，说明第一件事的结论、适用条件与关键机制，并标出待验证的推断。")],
                "relations": [
                    {"from": "draft:0", "to": "draft:1", "kind": "derives",
                     "evidence": "材料里没有这句话"},
                ],
                "reason": "ok",
            })
            .to_string(),
        ],
    );
    let published = helper.run_failing("note-a", "一段等待提炼的正文，内容足够长以便提炼。");
    assert_eq!(published["ok"], false, "{published}");
    assert_eq!(published["error"]["code"], "invalid_output", "{published}");
    let listed = helper.ok("l1", "card.list", json!({}));
    assert_eq!(listed["total"], 0, "{listed}");
}

#[test]
fn too_many_relations_fail_the_batch() {
    let root = Root::new("model-too-many");
    let edges: Vec<Value> = (0..13)
        .map(|_| {
            json!({"from": "draft:0", "to": "draft:0", "kind": "contains",
                   "evidence": "内容足够长"})
        })
        .collect();
    let mut helper = Helper::start(
        &root,
        vec![
            json!({
                "cards": [draft("甲卡", "甲卡的完整正文，说明第一件事的结论、适用条件与关键机制，并标出待验证的推断。")],
                "relations": edges,
                "reason": "ok",
            })
            .to_string(),
        ],
    );
    let failed = helper.run_failing("note-a", "一段等待提炼的正文，内容足够长以便提炼。");
    assert_eq!(failed["ok"], false, "{failed}");
    assert_eq!(failed["error"]["code"], "invalid_output", "{failed}");
    let listed = helper.ok("l1", "card.list", json!({}));
    assert_eq!(listed["total"], 0, "{listed}");
}

#[test]
fn the_byte_budget_keeps_the_focus_and_its_neighbour() {
    let root = Root::new("graph-focus-bytes");
    let mut helper = Helper::start(&root, vec![]);
    // The focus pair is written first, so the newest-first page would leave it at
    // the tail the byte budget trims.
    let focus = helper.save(
        "f0",
        card_params("concept", "焦点", "焦点的正文。", &["focus"]),
    );
    let neighbour = helper.save(
        "n0",
        card_params("concept", "邻居", "邻居的正文。", &["focus"]),
    );
    helper.ok(
        "r0",
        "relation.add",
        json!({"fromId": focus, "toId": neighbour, "kind": "contains"}),
    );
    let topics: Vec<String> = std::iter::once("bulk".to_string())
        .chain((0..31).map(|index| format!("{index:02}主{}", "题".repeat(97))))
        .collect();
    let topics: Vec<&str> = topics.iter().map(String::as_str).collect();
    for index in 0..70 {
        helper.save(
            &format!("b{index}"),
            json!({
                "kind": "concept",
                "title": format!("卡片{index:02}{}", "标".repeat(190)),
                "summary": "",
                "body": "",
                "topics": topics,
                "aliases": [],
                "sourceIds": [],
            }),
        );
    }

    let graph = helper.ok(
        "g1",
        "graph.query",
        json!({"topic": "bulk", "focusId": focus, "depth": 1, "limit": 200}),
    );
    assert_eq!(graph["total"], 70, "the filter's real total: {graph}");
    let shown = node_ids(&graph);
    assert!(
        shown.len() < 70,
        "the byte budget still trims the page: {}",
        shown.len()
    );
    assert_eq!(graph["shown"].as_u64().expect("shown"), shown.len() as u64);
    assert_eq!(graph["truncated"], true);
    assert_eq!(graph["limitedBy"], "bytes", "{:?}", graph["limitedBy"]);
    assert_eq!(
        graph["focused"], true,
        "the focus survived the cut: {graph}"
    );
    assert_eq!(
        graph["expanded"], 2,
        "the focus and its neighbour came in from outside the filter: {graph}"
    );
    assert!(
        shown.iter().any(|id| id == &focus) && shown.iter().any(|id| id == &neighbour),
        "the focus and the neighbour the panel asked for stay: {shown:?}"
    );
    for edge in graph["edges"].as_array().expect("edges") {
        for end in ["fromId", "toId"] {
            let id = edge[end].as_str().expect("endpoint");
            assert!(
                shown.iter().any(|node| node == id),
                "every edge stays inside the view: {graph}"
            );
        }
    }
}

#[test]
fn a_full_page_still_admits_the_focus_and_one_neighbour() {
    let root = Root::new("graph-focus-full");
    let mut helper = Helper::start(&root, vec![]);
    let neighbour = helper.save(
        "n0",
        card_params("concept", "邻居", "邻居的正文。", &["rust"]),
    );
    let focus = helper.save(
        "f0",
        card_params("concept", "焦点", "焦点的正文。", &["rust"]),
    );
    let mut others = Vec::new();
    for index in 0..4 {
        others.push(helper.save(
            &format!("o{index}"),
            card_params(
                "concept",
                &format!("其余{index}"),
                "其余的正文。",
                &["rust"],
            ),
        ));
    }
    helper.ok(
        "r0",
        "relation.add",
        json!({"fromId": focus, "toId": neighbour, "kind": "prerequisite"}),
    );

    // The page is full and the filter does not rank the focus's neighbour into it.
    let graph = helper.ok(
        "g1",
        "graph.query",
        json!({"focusId": focus, "depth": 1, "limit": 2}),
    );
    let shown = node_ids(&graph);
    assert_eq!(graph["shown"], 2, "{graph}");
    assert_eq!(
        graph["total"], 6,
        "the filter's own total is unaffected: {graph}"
    );
    assert_eq!(graph["truncated"], true);
    assert_eq!(graph["limitedBy"], "nodes", "{graph}");
    assert_eq!(graph["focused"], true, "{graph}");
    // Nothing was filtered out, so both nodes are matches even though they had to
    // take the page's lowest-ranked slots to be drawn.
    assert_eq!(
        graph["expanded"], 0,
        "an unfiltered graph has no extra nodes: {graph}"
    );
    assert!(
        shown.iter().any(|id| id == &focus),
        "the focus is always in the view: {shown:?}"
    );
    assert!(
        shown.iter().any(|id| id == &neighbour),
        "so is the one neighbour it asked for: {shown:?}"
    );
    assert!(
        !shown
            .iter()
            .any(|id| others.iter().any(|other| other == id)),
        "the two lowest-ranked cards gave way: {shown:?}"
    );
    let edges = graph["edges"].as_array().expect("edges");
    assert_eq!(edges.len(), 1, "the one edge inside the view: {graph}");
    assert_eq!(edges[0]["kind"], "prerequisite");
}

#[test]
fn a_quote_stitched_from_two_notes_fails_the_batch() {
    let root = Root::new("model-stitched");
    let first = "甲段原文，结尾写着甲乙相连";
    let second = "乙段原文，开头也提到甲乙相连";
    let mut helper = Helper::start(&root, vec![]);
    // Two sources in one batch: the quote runs from the end of the first into the
    // start of the second, so neither note holds it on its own.
    let one = helper.publish_on("reading", "note-a", first);
    let two = helper.publish_on("reading", "note-a", second);
    helper.answers.push(
        json!({
            "cards": [draft("甲卡", "甲卡的完整正文，说明第一件事的结论、适用条件与关键机制，并标出待验证的推断。")],
            "relations": [
                {"from": "draft:0", "to": "draft:0", "kind": "derives",
                 "evidence": "甲乙相连\n乙段原文"},
            ],
            "reason": "ok",
        })
        .to_string(),
    );
    helper.source_id = two.0.clone();
    let params = helper.claim_parts(
        "s",
        &[
            (one.0.clone(), one.1.clone(), first.to_string()),
            (two.0.clone(), two.1.clone(), second.to_string()),
        ],
    );
    assert_eq!(
        params["items"].as_array().expect("items").len(),
        2,
        "both notes are in the batch: {params}"
    );
    let failed = helper.call("s-run", "extract.run", params);
    assert_eq!(failed["ok"], false, "{failed}");
    assert_eq!(failed["error"]["code"], "invalid_output", "{failed}");
    let listed = helper.ok("l1", "card.list", json!({}));
    assert_eq!(listed["total"], 0, "the batch is rolled back: {listed}");
}

#[test]
fn a_model_relation_records_the_segment_it_quotes() {
    let root = Root::new("model-segment");
    let text = "第一段原文，讲卡片甲，也讲卡片乙。";
    let mut helper = Helper::start(
        &root,
        vec![
            json!({
                "cards": [
                    draft("甲卡", "甲卡的完整正文，说明第一件事的结论、适用条件与关键机制，并标出待验证的推断。"),
                    draft("乙卡", "乙卡的完整正文，说明第二件事的结论、适用条件与关键机制，并标出待验证的推断。"),
                ],
                "relations": [
                    {"from": "draft:0", "to": "draft:1", "kind": "contains",
                     "evidence": "也讲卡片乙"},
                ],
                "reason": "ok",
            })
            .to_string(),
        ],
    );
    let outcome = helper.run("note-a", text, "n");
    assert_eq!(outcome["state"], "completed", "{outcome}");
    let first = outcome["cards"][0]["cardId"]
        .as_str()
        .expect("card id")
        .to_string();
    let relations = helper.ok("l1", "relation.list", json!({"cardId": first}));
    let item = &relations["items"][0];
    assert_eq!(item["origin"], "model");
    assert_eq!(
        item["sourceId"], helper.source_id,
        "the edge names the note it came from: {item}"
    );
    assert_eq!(
        item["segment"], 0,
        "and the segment that holds the quote: {item}"
    );
}

#[test]
fn a_relation_may_not_name_a_card_the_round_hid() {
    let root = Root::new("model-hidden");
    let text = "第一段正文，讲甲卡的内容，足够长以便提炼。";
    let mut helper = Helper::start(&root, vec![]);
    helper.answers.push(
        json!({
            "cards": [draft("甲卡", "甲卡的完整正文，说明第一件事的结论、适用条件与关键机制，并标出待验证的推断。")],
            "reason": "ok",
        })
        .to_string(),
    );
    let first = helper.run("note-a", text, "a");
    assert_eq!(first["state"], "completed", "{first}");
    let known = first["cards"][0]["cardId"]
        .as_str()
        .expect("card id")
        .to_string();

    // The same note is extracted again, so the card above is a comparison
    // candidate — but the extraction round never showed it.
    let queued = helper.ok("q1", "queue.extract", json!({"sourceId": helper.source_id}));
    assert_eq!(queued["queued"], 1, "{queued}");
    helper.answers.push(
        json!({
            "cards": [draft("甲卡补编", "补编的完整正文，说明结论与适用条件，也够长。")],
            "relations": [
                {"from": "draft:0", "to": known, "kind": "derives",
                 "evidence": "足够长以便提炼"},
            ],
            "reason": "ok",
        })
        .to_string(),
    );
    helper.answers.push(
        json!({"decisions": [{"index": 0, "action": "new", "targetCardId": null, "reason": "新卡"}]})
            .to_string(),
    );
    let params = helper.claim_parts(
        "again",
        &[(
            helper.source_id.clone(),
            helper.fingerprint.clone(),
            text.to_string(),
        )],
    );
    let failed = helper.call("again-run", "extract.run", params);
    assert_eq!(failed["ok"], false, "{failed}");
    assert_eq!(failed["error"]["code"], "invalid_output", "{failed}");
    let listed = helper.ok("l1", "card.list", json!({}));
    assert_eq!(listed["total"], 1, "only the first round's card: {listed}");
    let relations = helper.ok("l2", "relation.list", json!({"cardId": known}));
    assert_eq!(relations["total"], 0, "no edge was written: {relations}");
}

/// A card the page could not hold is still a match when the filter selects it.
///
/// The page bounds what is drawn, not what matches: focusing a page-out card must
/// report it as a match (`shown - expanded`) instead of pretending it is extra
/// context the filter never selected.
#[test]
fn a_page_out_focus_that_matches_the_filter_is_counted_as_a_match() {
    let root = Root::new("graph-focus-page-out");
    let mut helper = Helper::start(&root, vec![]);
    let one = helper.save(
        "a0",
        card_params("concept", "甲匹配", "甲的正文。", &["Match"]),
    );
    let two = helper.save(
        "b0",
        card_params("concept", "乙匹配", "乙的正文。", &["Match"]),
    );

    // Topic filter: whichever card the page keeps, the other one is page-out.
    let page = helper.ok("p1", "graph.query", json!({"topic": "Match", "limit": 1}));
    let kept = node_ids(&page);
    assert_eq!(kept.len(), 1, "the page is bounded: {page}");
    let focus = if kept[0] == one {
        two.clone()
    } else {
        one.clone()
    };
    let graph = helper.ok(
        "g1",
        "graph.query",
        json!({"topic": "Match", "focusId": focus, "depth": 1, "limit": 1}),
    );
    assert_eq!(node_ids(&graph), vec![focus.clone()], "{graph}");
    assert_eq!(graph["total"], 2, "{graph}");
    assert_eq!(graph["shown"], 1, "{graph}");
    assert_eq!(graph["focused"], true, "{graph}");
    assert_eq!(graph["truncated"], true, "{graph}");
    assert_eq!(
        graph["expanded"], 0,
        "a matching focus is a match even when the page could not hold it: {graph}"
    );

    // Search filter: the same rule, with the plan's own condition instead of a topic.
    let search = helper.ok("s1", "graph.query", json!({"query": "乙", "limit": 1}));
    let found = node_ids(&search);
    assert_eq!(found, vec![two.clone()], "{search}");
    let expanded = helper.ok(
        "g2",
        "graph.query",
        json!({"query": "甲", "focusId": one, "depth": 1, "limit": 1}),
    );
    assert_eq!(node_ids(&expanded), vec![one.clone()], "{expanded}");
    assert_eq!(expanded["total"], 1, "{expanded}");
    assert_eq!(
        expanded["expanded"], 0,
        "the search filter matches the focus too: {expanded}"
    );
}
