//! Snapshots of the two databases for the existing backup feature.
//!
//! The snapshot must hold what the database would hold after a restart: every
//! committed transaction, including the pages still in WAL, and nothing a live
//! writer has not committed. It also has to be a single self-contained file —
//! no `-wal`/`-shm` beside it — and the helper must refuse any target the host
//! should not have asked for.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{Value, json};

struct Root {
    data: PathBuf,
    snapshots: PathBuf,
}

impl Root {
    fn new(tag: &str) -> Root {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!(
            "yu-knowledge-backup-{tag}-{}-{nanos}",
            std::process::id()
        ));
        let data = base.join("data-root");
        let snapshots = base.join("snapshots");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&snapshots).unwrap();
        Root { data, snapshots }
    }

    /// Where a snapshot is allowed to go: beside the data root, never inside it.
    fn outside(&self) -> PathBuf {
        self.snapshots.clone()
    }
}

impl std::ops::Deref for Root {
    type Target = Path;

    fn deref(&self) -> &Path {
        &self.data
    }
}

impl Drop for Root {
    fn drop(&mut self) {
        if let Some(base) = self.data.parent() {
            let _ = std::fs::remove_dir_all(base);
        }
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
        helper
    }

    fn recv(&mut self) -> Value {
        let mut line = String::new();
        let read = self.out.read_line(&mut line).unwrap();
        assert!(read > 0, "the helper closed its stdout");
        serde_json::from_str(line.trim_end()).unwrap()
    }

    fn send(&mut self, id: &str, method: &str, params: Value) -> Value {
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
        let frame = self.send(id, method, params);
        assert_eq!(frame["ok"], true, "{method} failed: {frame}");
        frame["result"].clone()
    }

    fn err(&mut self, id: &str, method: &str, params: Value) -> Value {
        let frame = self.send(id, method, params);
        assert_eq!(frame["ok"], false, "{method} was accepted: {frame}");
        frame["error"].clone()
    }

    /// A snapshot request with the target rendered the way the host sends it.
    fn snapshot(&mut self, id: &str, database: &str, target: &Path) -> Value {
        self.ok(
            id,
            "backup.db",
            json!({ "database": database, "target": target.display().to_string() }),
        )
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        self.stdin = None;
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn source(id: &str, origin: &str) -> Value {
    json!({
        "kind": "web",
        "originRef": origin,
        "version": &format!("v-{id}"),
        "title": "网页",
        "locator": origin,
        "readAt": 1,
        "text": format!("{id} 的正文"),
    })
}

fn rows(database: &Path, table: &str) -> i64 {
    let connection = rusqlite::Connection::open(database).unwrap();
    connection
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .unwrap()
}

/// The database the helper is using, opened the way the feature stores it.
fn live(root: &Path, name: &str) -> PathBuf {
    root.join("data").join(name).join(format!("{name}.db"))
}

#[test]
fn a_snapshot_holds_committed_wal_content_and_nothing_uncommitted() {
    let root = Root::new("wal");
    let mut helper = Helper::start(&root);
    helper.ok(
        "f1",
        "source.save",
        source("src_done", "https://example.test/a"),
    );
    // A second connection keeps a transaction open while the snapshot runs: its
    // pages are in WAL, but nothing about them committed, so they must stay out.
    let knowledge = live(&root, "knowledge");
    let writer = rusqlite::Connection::open(&knowledge).unwrap();
    writer.execute_batch("BEGIN IMMEDIATE").unwrap();
    writer
        .execute(
            "INSERT INTO sources (id, kind, origin_ref, locator, title, version, read_at, fingerprint, size, state, created_at, updated_at)
             VALUES ('src_pending', 'web', 'https://example.test/b', '', '网页', 'v-pending', 1, 'fp', 12, 'active', 1, 1)",
            [],
        )
        .unwrap();

    let first = root.outside().join("first.db");
    let reported = helper.snapshot("f2", "knowledge", &first);
    assert!(reported["bytes"].as_u64().unwrap() > 0, "{reported}");
    assert_eq!(
        rows(&first, "sources"),
        1,
        "the uncommitted row leaked into the snapshot"
    );
    assert!(
        !first.with_extension("db-wal").exists()
            && !PathBuf::from(format!("{}-wal", first.display())).exists(),
        "the snapshot kept a WAL sidecar"
    );
    let mode: String = rusqlite::Connection::open(&first)
        .unwrap()
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .unwrap();
    assert_eq!(
        mode, "delete",
        "the snapshot still claims a log it does not carry"
    );

    writer.execute_batch("COMMIT").unwrap();
    let second = root.outside().join("second.db");
    helper.snapshot("f3", "knowledge", &second);
    assert_eq!(rows(&second, "sources"), 2, "committed WAL pages were lost");
}

#[test]
fn a_snapshot_needs_its_own_new_file_outside_the_data_root() {
    let root = Root::new("targets");
    let mut helper = Helper::start(&root);
    helper.ok(
        "f1",
        "source.save",
        source("src_a", "https://example.test/a"),
    );
    let outside = root.outside();

    let relative = helper.err(
        "f2",
        "backup.db",
        json!({ "database": "knowledge", "target": "snapshot.db" }),
    );
    assert!(
        relative["message"].as_str().unwrap().contains("absolute"),
        "{relative}"
    );

    let inside = live(&root, "knowledge");
    let refused = helper.err(
        "f3",
        "backup.db",
        json!({ "database": "knowledge", "target": inside.file_name().unwrap().to_str().unwrap() }),
    );
    assert!(refused["message"].is_string(), "{refused}");
    let inside_abs = helper.err(
        "f4",
        "backup.db",
        json!({ "database": "knowledge", "target": inside.display().to_string() }),
    );
    assert!(
        inside_abs["message"]
            .as_str()
            .unwrap()
            .contains("outside the data root")
            || inside_abs["message"]
                .as_str()
                .unwrap()
                .contains("already exists"),
        "{inside_abs}"
    );

    let existing = outside.join("taken.db");
    std::fs::write(&existing, b"not a database").unwrap();
    let taken = helper.err(
        "f5",
        "backup.db",
        json!({ "database": "knowledge", "target": existing.display().to_string() }),
    );
    assert!(
        taken["message"]
            .as_str()
            .unwrap()
            .contains("already exists"),
        "{taken}"
    );
    assert_eq!(std::fs::read(&existing).unwrap(), b"not a database");

    let unknown = helper.err(
        "f6",
        "backup.db",
        json!({ "database": "chat", "target": outside.join("chat.db").display().to_string() }),
    );
    assert!(
        unknown["message"]
            .as_str()
            .unwrap()
            .contains("unknown database"),
        "{unknown}"
    );
}

#[test]
fn the_profile_database_snapshots_the_same_way() {
    let root = Root::new("profile");
    let mut helper = Helper::start(&root);
    // Any data method opens both databases; opening is what the snapshot copies.
    helper.ok("f1", "status", json!({}));
    let target = root.outside().join("profile.db");
    let reported = helper.snapshot("f2", "profile", &target);
    assert!(reported["bytes"].as_u64().unwrap() > 0, "{reported}");
    let connection = rusqlite::Connection::open(&target).unwrap();
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert!(version >= 1, "the profile schema did not come across");
    let tables: i64 = connection
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'profile_items'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        tables, 1,
        "the profile tables are missing from the snapshot"
    );
}
