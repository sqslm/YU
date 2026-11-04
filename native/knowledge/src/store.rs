//! Opening, migrating and probing the two phase-1 databases.
//!
//! `knowledge.db` owns sources and cards; `profile.db` owns profile items and
//! their evidence. They are separate files on purpose: clearing knowledge must
//! never cascade into the profile.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use rusqlite::Connection;

use crate::protocol::{ApiError, ApiResult, Code};

pub const KNOWLEDGE_SCHEMA: i64 = 1;
pub const PROFILE_SCHEMA: i64 = 1;

pub const CARD_KINDS: [&str; 7] = [
    "concept",
    "method",
    "question",
    "decision",
    "comparison",
    "reading",
    "review",
];
pub const SOURCE_KINDS: [&str; 4] = ["note", "chat", "web", "document"];
pub const CATEGORIES: [&str; 3] = ["explicit", "observed", "inferred"];

const KNOWLEDGE_SQL: &str = r#"
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('note','chat','web','document')),
  origin_ref TEXT NOT NULL,
  locator TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT '',
  read_at INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','invalid')),
  invalid_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (kind, origin_ref, version)
);
CREATE INDEX sources_origin ON sources (kind, origin_ref);

CREATE TABLE cards (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('concept','method','question','decision','comparison','reading','review')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  topics TEXT NOT NULL DEFAULT '[]',
  aliases TEXT NOT NULL DEFAULT '[]',
  edited INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX cards_updated ON cards (updated_at DESC);
CREATE INDEX cards_kind ON cards (kind, updated_at DESC);

CREATE TABLE card_sources (
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (card_id, source_id)
);
CREATE INDEX card_sources_source ON card_sources (source_id);

CREATE VIRTUAL TABLE cards_fts USING fts5(
  card_id UNINDEXED,
  title,
  summary,
  body,
  topics,
  aliases,
  tokenize = 'trigram'
);

CREATE TABLE exclusions (
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (kind, key)
);
"#;

const PROFILE_SQL: &str = r#"
CREATE TABLE profile_items (
  id TEXT PRIMARY KEY,
  dimension TEXT NOT NULL,
  value TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('explicit','observed','inferred')),
  origin TEXT NOT NULL CHECK (origin IN ('manual','auto')),
  pinned INTEGER NOT NULL DEFAULT 0,
  corrected INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (dimension, value)
);
CREATE INDEX profile_items_updated ON profile_items (updated_at DESC);

CREATE TABLE profile_evidence (
  item_id TEXT NOT NULL REFERENCES profile_items(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  origin_ref TEXT NOT NULL DEFAULT '',
  locator TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, source_kind, source_id)
);

CREATE TABLE exclusions (
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (kind, key)
);
"#;

/// Both databases, opened lazily on the first data request.
pub struct Store {
    pub knowledge: Mutex<Connection>,
    pub profile: Mutex<Connection>,
    pub knowledge_path: PathBuf,
    pub profile_path: PathBuf,
}

impl Store {
    pub fn open(root: &Path) -> ApiResult<Store> {
        let knowledge_path = root.join("data").join("knowledge").join("knowledge.db");
        let profile_path = root.join("data").join("profile").join("profile.db");
        let knowledge = open_db(&knowledge_path, KNOWLEDGE_SCHEMA, KNOWLEDGE_SQL)?;
        let profile = open_db(&profile_path, PROFILE_SCHEMA, PROFILE_SQL)?;
        Ok(Store {
            knowledge: Mutex::new(knowledge),
            profile: Mutex::new(profile),
            knowledge_path,
            profile_path,
        })
    }
}

fn open_db(path: &Path, schema: i64, schema_sql: &str) -> ApiResult<Connection> {
    if let Some(directory) = path.parent() {
        fs::create_dir_all(directory).map_err(|error| {
            ApiError::storage(format!(
                "cannot create the data directory {}: {error}",
                directory.display()
            ))
        })?;
    }
    let mut connection = Connection::open(path)
        .map_err(|error| ApiError::storage(format!("cannot open {}: {error}", path.display())))?;
    connection
        .busy_timeout(Duration::from_millis(5_000))
        .map_err(|error| ApiError::storage(format!("cannot set the busy timeout: {error}")))?;
    let _: String = connection
        .query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))
        .map_err(|error| ApiError::storage(format!("cannot enable WAL: {error}")))?;
    connection
        .execute_batch("PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;")
        .map_err(|error| ApiError::storage(format!("cannot configure the connection: {error}")))?;
    migrate(&mut connection, schema, schema_sql)?;
    Ok(connection)
}

/// Creates or upgrades the schema inside one transaction. A database written by
/// a newer build is refused instead of rebuilt, so no data is silently dropped.
fn migrate(connection: &mut Connection, target: i64, schema_sql: &str) -> ApiResult<()> {
    let current: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| ApiError::storage(format!("cannot read the schema version: {error}")))?;
    if current > target {
        return Err(ApiError::new(
            Code::StorageSchemaNewer,
            format!("database schema {current} is newer than the supported {target}"),
        ));
    }
    if current == target {
        return Ok(());
    }
    let transaction = connection.transaction().map_err(|error| {
        ApiError::storage(format!("cannot start the schema transaction: {error}"))
    })?;
    if current < 1 {
        transaction
            .execute_batch(schema_sql)
            .map_err(|error| ApiError::storage(format!("cannot create the schema: {error}")))?;
    }
    transaction
        .execute_batch(&format!("PRAGMA user_version = {target}"))
        .map_err(|error| ApiError::storage(format!("cannot record the schema version: {error}")))?;
    transaction.commit().map_err(|error| {
        ApiError::storage(format!("cannot commit the schema transaction: {error}"))
    })?;
    Ok(())
}

/// Verifies that the SQLite this binary was built with has FTS5 and the
/// `trigram` tokenizer, in memory and without touching the data directory.
///
/// The probe matches a three-character run because `trigram` indexes three
/// characters at a time: a one- or two-character term returns nothing through
/// `MATCH` and is answered by the literal `LIKE` branch instead.
pub fn probe_capabilities() -> (bool, bool) {
    let Ok(connection) = Connection::open_in_memory() else {
        return (false, false);
    };
    let fts5 = connection
        .execute_batch("CREATE VIRTUAL TABLE probe USING fts5(value);")
        .is_ok();
    if !fts5 {
        return (false, false);
    }
    let trigram = connection
        .execute_batch(
            "CREATE VIRTUAL TABLE probe_tri USING fts5(value, tokenize = 'trigram');
             INSERT INTO probe_tri(value) VALUES ('知识图谱');
             INSERT INTO probe(value) VALUES ('知识图谱');",
        )
        .is_ok();
    if !trigram {
        return (true, false);
    }
    let hits: i64 = connection
        .query_row(
            "SELECT count(*) FROM probe_tri WHERE probe_tri MATCH '\"识图谱\"'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    (true, hits == 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("yu-knowledge-store-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        root
    }

    #[test]
    fn builds_the_schema_and_reopens_it() {
        let root = temp_root("schema");
        {
            let store = Store::open(&root).expect("open");
            let version: i64 = store
                .knowledge
                .lock()
                .expect("lock")
                .query_row("PRAGMA user_version", [], |row| row.get(0))
                .expect("version");
            assert_eq!(version, KNOWLEDGE_SCHEMA);
            assert!(store.knowledge_path.exists());
            assert!(store.profile_path.exists());
        }
        let reopened = Store::open(&root).expect("reopen");
        let tables: i64 = reopened
            .knowledge
            .lock()
            .expect("lock")
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name = 'cards'",
                [],
                |row| row.get(0),
            )
            .expect("tables");
        assert_eq!(tables, 1);
        // Windows refuses to delete files a live connection still holds open.
        drop(reopened);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn refuses_a_newer_schema_instead_of_rebuilding() {
        let root = temp_root("newer");
        {
            let _store = Store::open(&root).expect("open");
        }
        let path = root.join("data").join("knowledge").join("knowledge.db");
        let connection = Connection::open(&path).expect("open raw");
        connection
            .execute_batch("PRAGMA user_version = 99")
            .expect("bump");
        drop(connection);
        let error = match Store::open(&root) {
            Ok(_) => panic!("a newer schema must be refused"),
            Err(error) => error,
        };
        assert_eq!(error.code, Code::StorageSchemaNewer);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn probes_fts5_and_the_trigram_tokenizer() {
        let (fts5, trigram) = probe_capabilities();
        assert!(fts5, "the bundled SQLite must ship FTS5");
        assert!(
            trigram,
            "the bundled SQLite must ship the trigram tokenizer"
        );
    }
}
