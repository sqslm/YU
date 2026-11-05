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

pub const KNOWLEDGE_SCHEMA: i64 = 9;
pub const PROFILE_SCHEMA: i64 = 3;

/// Phase 2 (second pass) ties a queued task to the thread it came from, so
/// deleting or hiding a conversation also cancels its reading tasks.
/// The scan bound each history job fixed when it started. A job never re-reads
/// content newer than its own bound; that content takes the live path instead.
const HISTORY_BOUND_SQL: &str = "
ALTER TABLE history_jobs ADD COLUMN note_bound TEXT;
ALTER TABLE history_jobs ADD COLUMN chat_bound INTEGER;
";

const THREAD_SQL: &str = r#"
ALTER TABLE queue_groups ADD COLUMN thread_key TEXT;
CREATE INDEX queue_groups_thread ON queue_groups (thread_key);
"#;

/// Phase 2 adds the pending-extraction queue. It only creates tables, so a
/// phase-1 database keeps every source, card and exclusion it already had.
const QUEUE_SQL: &str = r#"
CREATE TABLE queue_groups (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('note','chat','reading')),
  group_key TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK (state IN ('stabilizing','ready','needs_reread','failed','cancelled')),
  stable_at INTEGER NOT NULL,
  reason TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (channel, group_key)
);
CREATE INDEX queue_groups_state ON queue_groups (state, stable_at);

CREATE TABLE queue_items (
  group_id TEXT NOT NULL REFERENCES queue_groups(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, ordinal)
);
CREATE INDEX queue_items_source ON queue_items (source_id);

CREATE TABLE queue_control (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE history_jobs (
  id TEXT PRIMARY KEY,
  scopes TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running','paused','completed','cancelled')),
  note_cursor TEXT,
  chat_cursor TEXT,
  note_done INTEGER NOT NULL DEFAULT 0,
  chat_done INTEGER NOT NULL DEFAULT 0,
  scanned INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  deduped INTEGER NOT NULL DEFAULT 0,
  ready INTEGER NOT NULL DEFAULT 0,
  needs_reread INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
"#;

/// Phase 3 adds extraction: a task can be claimed and worked, cards remember the
/// fingerprint of their content and their revision, processed segments are
/// recorded per source version, and a conflict becomes a suggestion instead of a
/// silent overwrite. `queue_groups.state` needs two more values, so the table is
/// rebuilt — children first, so the drop never cascades.
const EXTRACT_SQL: &str = r#"
CREATE TABLE queue_groups_v5 (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('note','chat','reading')),
  group_key TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK (state IN ('stabilizing','ready','working','completed','needs_reread','failed','cancelled')),
  stable_at INTEGER NOT NULL,
  reason TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  claim TEXT,
  thread_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (channel, group_key)
);
INSERT INTO queue_groups_v5 (id, channel, group_key, title, scope, state, stable_at, reason, error, attempts, thread_key, created_at, updated_at)
  SELECT id, channel, group_key, title, scope, state, stable_at, reason, error, attempts, thread_key, created_at, updated_at FROM queue_groups;

CREATE TABLE queue_items_v5 (
  group_id TEXT NOT NULL REFERENCES queue_groups_v5(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, ordinal)
);
INSERT INTO queue_items_v5 (group_id, ordinal, source_id, created_at) SELECT group_id, ordinal, source_id, created_at FROM queue_items;
DROP TABLE queue_items;
DROP TABLE queue_groups;
ALTER TABLE queue_groups_v5 RENAME TO queue_groups;
ALTER TABLE queue_items_v5 RENAME TO queue_items;
CREATE INDEX queue_groups_state ON queue_groups (state, stable_at);
CREATE INDEX queue_groups_thread ON queue_groups (thread_key);
CREATE INDEX queue_items_source ON queue_items (source_id);

ALTER TABLE cards ADD COLUMN fingerprint TEXT;
ALTER TABLE cards ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
UPDATE cards SET fingerprint = '' WHERE fingerprint IS NULL;

CREATE TABLE card_history (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  body TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX card_history_card ON card_history (card_id, revision);

CREATE TABLE extract_progress (
  source_id TEXT NOT NULL,
  version TEXT NOT NULL,
  segment INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('done')),
  group_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (source_id, version, segment)
);

CREATE TABLE suggestions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  target_card_id TEXT,
  target_revision INTEGER,
  action TEXT NOT NULL CHECK (action IN ('reference','merge','propose')),
  draft TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  source_ids TEXT NOT NULL DEFAULT '[]',
  fingerprint TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK (state IN ('open','accepted','rejected')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX suggestions_state ON suggestions (state, created_at DESC);
CREATE INDEX suggestions_target ON suggestions (target_card_id, fingerprint, state);
"#;

/// Stage 5 adds the favourite mark and the card graph. Only additive
/// statements, so a schema-5 database keeps every card, source, history row,
/// suggestion and exclusion it already had.
const GRAPH_SQL: &str = r#"
ALTER TABLE cards ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
CREATE INDEX cards_favorite ON cards (favorite, updated_at DESC);

CREATE TABLE card_relations (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('contains','prerequisite','applies','contrast','derives')),
  origin TEXT NOT NULL CHECK (origin IN ('manual','model')),
  evidence TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (from_id, to_id, kind)
);
CREATE INDEX card_relations_from ON card_relations (from_id);
CREATE INDEX card_relations_to ON card_relations (to_id);
ALTER TABLE card_history ADD COLUMN topics TEXT NOT NULL DEFAULT '[]';
ALTER TABLE card_history ADD COLUMN edited INTEGER NOT NULL DEFAULT 0;
"#;

/// Stage 6 records the segment a deduced relation was quoted from, so every
/// model edge can be traced back to the one paragraph that produced it. Edges
/// written before this column existed keep an empty source and no segment: what
/// they were built from is not recoverable, and guessing would be a lie.
const RELATION_SOURCE_SQL: &str = r#"
ALTER TABLE card_relations ADD COLUMN source_id TEXT NOT NULL DEFAULT '';
ALTER TABLE card_relations ADD COLUMN segment INTEGER NOT NULL DEFAULT -1;
CREATE INDEX card_relations_source ON card_relations (source_id, segment);
"#;

/// Stage 6 lets a projection name the cards its own answer cited. The list is a
/// JSON array of card ids on the source row, so a later extraction can offer
/// those cards to the comparison round as already-known knowledge instead of
/// minting a duplicate. Additive only: every source, card, link, history row and
/// exclusion a schema-7 database had is kept.
const CITED_SQL: &str = r#"
ALTER TABLE sources ADD COLUMN cited_card_ids TEXT NOT NULL DEFAULT '[]';
"#;

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
/// The five card relations. `contrast` is the only symmetric one.
pub const RELATION_KINDS: [&str; 5] =
    ["contains", "prerequisite", "applies", "contrast", "derives"];
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

/// Stage 4 adds the background profile loop to `profile.db`, so its schema moves
/// to 2 while `knowledge.db` stays at 5.
const PROFILE_LEARN_SQL: &str = r#"
ALTER TABLE profile_items ADD COLUMN slot TEXT NOT NULL DEFAULT '';
UPDATE profile_items SET slot = dimension WHERE slot = '';
CREATE INDEX profile_items_slot ON profile_items (slot, value);

CREATE TABLE profile_control (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE profile_usage (
  day INTEGER NOT NULL,
  feature TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day, feature)
);

CREATE TABLE profile_usage_ops (
  op_id TEXT PRIMARY KEY,
  feature TEXT NOT NULL,
  at INTEGER NOT NULL
);

CREATE TABLE profile_pending (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  version TEXT NOT NULL,
  segment INTEGER NOT NULL DEFAULT 0,
  origin_ref TEXT NOT NULL DEFAULT '',
  locator TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'working', 'done', 'failed')),
  claim TEXT,
  reason TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (source_kind, source_id, version, segment)
);
CREATE INDEX profile_pending_state ON profile_pending (state, at);

CREATE TABLE profile_source_state (
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'invalid')),
  reason TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (source_kind, source_id)
);
"#;

/// Stage 4 leaves a processed segment behind as a lightweight marker instead of a
/// row full of text, so finished work cannot crowd out the segments still waiting.
/// The marker also keeps a replayed callback (same source, version and segment)
/// from being learned twice, including after `clear`.
const PROFILE_MARKER_SQL: &str = r#"
CREATE TABLE profile_markers (
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  version TEXT NOT NULL,
  segment INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (source_kind, source_id, version, segment)
);
CREATE INDEX profile_markers_created ON profile_markers (created_at);
"#;

/// A source belongs to the record that produced it, and one source can belong to
/// several records: the same page read by two conversations is one row with two
/// owners. Deleting one record must therefore drop its claim, not retire the
/// source; only the last owner going away retires it. `queue_groups.thread_key`
/// is a single column and keeps only the newest thread, so it is never used to
/// answer ownership.
const SOURCE_OWNER_SQL: &str = r#"
CREATE TABLE source_records (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  record_ref TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (source_id, channel, record_ref)
);
CREATE INDEX source_records_record ON source_records (channel, record_ref);
INSERT OR IGNORE INTO source_records (source_id, channel, record_ref, created_at)
  SELECT i.source_id, 'chat', g.group_key, g.created_at
    FROM queue_items i JOIN queue_groups g ON g.id = i.group_id
   WHERE g.channel = 'chat';
INSERT OR IGNORE INTO source_records (source_id, channel, record_ref, created_at)
  SELECT i.source_id, 'chat', g.thread_key, g.created_at
    FROM queue_items i JOIN queue_groups g ON g.id = i.group_id
   WHERE g.channel = 'reading' AND g.thread_key IS NOT NULL AND g.thread_key <> '';
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
        let knowledge = open_db(
            &knowledge_path,
            KNOWLEDGE_SCHEMA,
            &[
                KNOWLEDGE_SQL,
                QUEUE_SQL,
                THREAD_SQL,
                HISTORY_BOUND_SQL,
                EXTRACT_SQL,
                GRAPH_SQL,
                RELATION_SOURCE_SQL,
                CITED_SQL,
                SOURCE_OWNER_SQL,
            ],
        )?;
        let profile = open_db(
            &profile_path,
            PROFILE_SCHEMA,
            &[PROFILE_SQL, PROFILE_LEARN_SQL, PROFILE_MARKER_SQL],
        )?;
        // A helper that died mid-batch leaves a claim nobody can release. Turning
        // such tasks into a retryable failure keeps them from sitting in `working`
        // forever; segments already committed stay committed, so a retry does not
        // redo the work that landed.
        knowledge
            .execute(
                "UPDATE queue_groups SET state = 'failed', error = '助手中断，需重试',
                 claim = NULL, updated_at = ?1 WHERE state = 'working'",
                rusqlite::params![crate::util::now_ms()],
            )
            .map_err(|error| {
                ApiError::storage(format!("cannot recover interrupted tasks: {error}"))
            })?;
        // The profile loop needs the same recovery, and it is a *retryable* failure
        // so `profile.retry` can put the batch back in the queue.
        profile
            .execute(
                "UPDATE profile_pending SET state = 'failed', claim = NULL,
                 reason = '助手中断，需重试', updated_at = ?1 WHERE state = 'working'",
                rusqlite::params![crate::util::now_ms()],
            )
            .map_err(|error| {
                ApiError::storage(format!("cannot recover interrupted profile work: {error}"))
            })?;
        // Schema 2 kept a finished batch as a `done` row carrying its full text, and
        // nothing ever collected it. The text is not needed to keep a replay
        // idempotent, so a `done` row becomes the lightweight marker it always was
        // and the body goes. This runs on every open, so a database that already
        // passed the migration cannot keep text written by an older build.
        profile
            .execute(
                "INSERT OR IGNORE INTO profile_markers
                 (source_kind, source_id, version, segment, created_at)
                 SELECT source_kind, source_id, version, segment, updated_at
                 FROM profile_pending WHERE state = 'done'",
                [],
            )
            .map_err(|error| {
                ApiError::storage(format!("cannot archive finished profile work: {error}"))
            })?;
        profile
            .execute("DELETE FROM profile_pending WHERE state = 'done'", [])
            .map_err(|error| {
                ApiError::storage(format!("cannot reclaim finished profile text: {error}"))
            })?;
        Ok(Store {
            knowledge: Mutex::new(knowledge),
            profile: Mutex::new(profile),
            knowledge_path,
            profile_path,
        })
    }
}

fn open_db(path: &Path, schema: i64, migrations: &[&str]) -> ApiResult<Connection> {
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
    migrate(&mut connection, schema, migrations)?;
    Ok(connection)
}

/// Creates or upgrades the schema inside one transaction. A database written by
/// a newer build is refused instead of rebuilt, so no data is silently dropped.
fn migrate(connection: &mut Connection, target: i64, migrations: &[&str]) -> ApiResult<()> {
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
    // Each entry upgrades the database by exactly one version, so a phase-1
    // file picks up the phase-2 tables without rebuilding what it already has.
    for (index, migration) in migrations.iter().enumerate() {
        if current <= index as i64 {
            transaction.execute_batch(migration).map_err(|error| {
                ApiError::storage(format!("cannot apply schema {}: {error}", index + 1))
            })?;
        }
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
    fn a_phase_one_database_keeps_its_rows_and_gains_the_queue() {
        let root = temp_root("upgrade");
        fs::create_dir_all(root.join("data").join("knowledge")).unwrap();
        let path = root.join("data").join("knowledge").join("knowledge.db");
        {
            // A database exactly as phase 1 shipped it: schema 1, one source.
            let connection = Connection::open(&path).unwrap();
            connection.execute_batch(KNOWLEDGE_SQL).unwrap();
            connection
                .execute_batch("PRAGMA user_version = 1;")
                .unwrap();
            connection
                .execute(
                    "INSERT INTO sources (id, kind, origin_ref, version, fingerprint, read_at,
                       created_at, updated_at) VALUES ('src_old', 'note', 'n', 'v', 'f', 1, 1, 1)",
                    [],
                )
                .unwrap();
        }
        let store = Store::open(&root).expect("upgrade");
        let connection = store.knowledge.lock().unwrap();
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, KNOWLEDGE_SCHEMA, "the file reports the new schema");
        let kept: i64 = connection
            .query_row(
                "SELECT count(*) FROM sources WHERE id = 'src_old'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(kept, 1, "an upgrade must not drop what phase 1 stored");
        for table in [
            "queue_groups",
            "queue_items",
            "queue_control",
            "history_jobs",
        ] {
            let exists: i64 = connection
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(exists, 1, "{table} must exist after the upgrade");
        }
        // Windows keeps every file of the database open while the store lives.
        drop(connection);
        drop(store);
        let _ = fs::remove_dir_all(&root);
    }

    /// Stage 5 only adds a column, an index and one table. A schema-5 file must
    /// keep every card, source, history row, suggestion and exclusion it already
    /// had, and the new column has to arrive with a usable default.
    #[test]
    fn a_stage_four_database_gains_favourites_and_the_card_graph() {
        let root = temp_root("stage-four");
        let directory = root.join("data").join("knowledge");
        fs::create_dir_all(&directory).expect("directory");
        {
            let connection = Connection::open(directory.join("knowledge.db")).expect("open");
            for migration in [
                KNOWLEDGE_SQL,
                QUEUE_SQL,
                THREAD_SQL,
                HISTORY_BOUND_SQL,
                EXTRACT_SQL,
            ] {
                connection
                    .execute_batch(migration)
                    .expect("stage four schema");
            }
            connection
                .execute_batch(
                    "PRAGMA user_version = 5;
                     INSERT INTO sources
                       (id, kind, origin_ref, version, fingerprint, read_at, created_at, updated_at)
                       VALUES ('src_1', 'note', 'n1', 'v1', 'f', 1, 1, 1);
                     INSERT INTO cards
                       (id, kind, title, summary, body, topics, aliases, edited,
                        fingerprint, revision, created_at, updated_at)
                       VALUES ('card_1', 'concept', '既有卡片', '摘要', '正文', '[\"rust\"]', '[]',
                               1, 'f', 2, 5, 5);
                     INSERT INTO card_sources (card_id, source_id, created_at)
                       VALUES ('card_1', 'src_1', 5);
                     INSERT INTO card_history
                       (id, card_id, revision, title, summary, body, reason, created_at)
                       VALUES ('his_1', 'card_1', 1, '旧标题', '旧摘要', '旧正文', '手工编辑', 4);
                     INSERT INTO suggestions
                       (id, kind, target_card_id, target_revision, action, draft, reason,
                        source_ids, fingerprint, state, created_at, updated_at)
                       VALUES ('sug_1', 'merge', 'card_1', 2, 'merge', '{}', '',
                               '[\"src_1\"]', 'f', 'open', 5, 5);
                     INSERT INTO exclusions (kind, key, reason, created_at)
                       VALUES ('card', 'card_gone', '', 5);",
                )
                .expect("stage four rows");
        }
        let store = Store::open(&root).expect("upgrade");
        let connection = store.knowledge.lock().expect("lock");
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("version");
        assert_eq!(version, KNOWLEDGE_SCHEMA);
        for table in [
            "sources",
            "cards",
            "card_sources",
            "card_history",
            "suggestions",
        ] {
            let rows: i64 = connection
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .expect("rows");
            assert_eq!(rows, 1, "{table} must survive the upgrade");
        }
        let (title, favorite, revision): (String, i64, i64) = connection
            .query_row(
                "SELECT title, favorite, revision FROM cards WHERE id = 'card_1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("kept card");
        assert_eq!(title, "既有卡片");
        assert_eq!(favorite, 0, "an old card starts unfavourited");
        assert_eq!(revision, 2);
        let (topics, edited): (String, i64) = connection
            .query_row(
                "SELECT topics, edited FROM card_history WHERE id = 'his_1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("kept history");
        assert_eq!(topics, "[]", "an old snapshot keeps an empty topic list");
        assert_eq!(edited, 0);
        let relations: i64 = connection
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'card_relations'",
                [],
                |row| row.get(0),
            )
            .expect("relations table");
        assert_eq!(relations, 1, "the graph table arrives with the upgrade");
        drop(connection);
        drop(store);
        let _ = fs::remove_dir_all(&root);
    }

    /// Stage 6 only adds one column to `sources`. A schema-7 file must keep every
    /// row it already had, and the new column must arrive with a usable default so
    /// an old publishes' citations read as "none".
    #[test]
    fn a_stage_six_database_gains_the_cited_card_list() {
        let root = temp_root("stage-six");
        let directory = root.join("data").join("knowledge");
        fs::create_dir_all(&directory).expect("directory");
        {
            let connection = Connection::open(directory.join("knowledge.db")).expect("open");
            for migration in [
                KNOWLEDGE_SQL,
                QUEUE_SQL,
                THREAD_SQL,
                HISTORY_BOUND_SQL,
                EXTRACT_SQL,
                GRAPH_SQL,
                RELATION_SOURCE_SQL,
            ] {
                connection
                    .execute_batch(migration)
                    .expect("stage six schema");
            }
            connection
                .execute_batch(
                    "PRAGMA user_version = 7;
                     INSERT INTO sources
                       (id, kind, origin_ref, version, fingerprint, read_at, size,
                        state, created_at, updated_at)
                       VALUES ('src_1', 'note', 'n1', 'v1', 'f', 1, 12, 'active', 1, 1);
                     INSERT INTO cards
                       (id, kind, title, summary, body, topics, aliases, edited,
                        fingerprint, revision, created_at, updated_at, favorite)
                       VALUES ('card_1', 'concept', '既有卡片', '摘要', '正文', '[\"rust\"]', '[]',
                                0, 'f', 1, 5, 5, 1);
                     INSERT INTO card_sources (card_id, source_id, created_at)
                       VALUES ('card_1', 'src_1', 5);",
                )
                .expect("stage six rows");
        }
        let store = Store::open(&root).expect("upgrade");
        let connection = store.knowledge.lock().expect("lock");
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("version");
        assert_eq!(version, KNOWLEDGE_SCHEMA);
        let cited: String = connection
            .query_row(
                "SELECT cited_card_ids FROM sources WHERE id = 'src_1'",
                [],
                |row| row.get(0),
            )
            .expect("cited column");
        assert_eq!(cited, "[]", "an old source cited nothing");
        let links: i64 = connection
            .query_row("SELECT count(*) FROM card_sources", [], |row| row.get(0))
            .expect("links");
        assert_eq!(links, 1, "the upgrade must not drop an existing link");
        drop(connection);
        drop(store);
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

    /// A schema-2 file kept finished batches as `done` rows carrying their full text,
    /// and nothing ever collected them. Opening it must fold those rows into the
    /// lightweight marker and drop the text — for the upgrade itself and for a file
    /// that already reached schema 3 under a build that still wrote `done` rows.
    #[test]
    fn a_finished_stage_two_row_loses_its_text_when_the_database_opens() {
        let root = temp_root("stage-two-done");
        let directory = root.join("data").join("profile");
        fs::create_dir_all(&directory).expect("directory");
        let insert = |connection: &Connection| {
            connection
                .execute(
                    "INSERT INTO profile_pending
                     (id, source_kind, source_id, version, segment, origin_ref, locator,
                      text, state, claim, reason, at, updated_at)
                     VALUES ('pp_done', 'chat', 't1', 'v1', 0, 't1:v1', '对话',
                             '一整段已经归纳过的原文', 'done', NULL, '', 7, 7)",
                    [],
                )
                .expect("done row");
        };
        {
            let connection = Connection::open(directory.join("profile.db")).expect("open");
            connection
                .execute_batch(PROFILE_SQL)
                .expect("stage one schema");
            connection
                .execute_batch(PROFILE_LEARN_SQL)
                .expect("stage two schema");
            insert(&connection);
            connection
                .execute("PRAGMA user_version = 2", [])
                .expect("version");
        }
        let store = Store::open(&root).expect("open");
        {
            let profile = store.profile.lock().expect("lock");
            let version: i64 = profile
                .query_row("PRAGMA user_version", [], |row| row.get(0))
                .expect("version");
            assert_eq!(version, PROFILE_SCHEMA);
            let pending: i64 = profile
                .query_row("SELECT count(*) FROM profile_pending", [], |row| row.get(0))
                .expect("pending");
            let markers: i64 = profile
                .query_row("SELECT count(*) FROM profile_markers", [], |row| row.get(0))
                .expect("markers");
            assert_eq!(pending, 0, "finished rows are records, not work");
            assert_eq!(markers, 1, "the deduplication key survives the text");
            // The marker keeps a replay of the same segment idempotent.
            let marked: i64 = profile
                .query_row(
                    "SELECT count(*) FROM profile_markers
                     WHERE source_kind = 'chat' AND source_id = 't1' AND version = 'v1'
                       AND segment = 0",
                    [],
                    |row| row.get(0),
                )
                .expect("marked");
            assert_eq!(marked, 1);
            // A file that already reached schema 3 is repaired the same way.
            profile
                .execute(
                    "INSERT INTO profile_pending
                     (id, source_kind, source_id, version, segment, origin_ref, locator,
                      text, state, claim, reason, at, updated_at)
                     VALUES ('pp_done2', 'ask', 'a1', 'v1', 0, 'ask:a1', '提问',
                             '另一段残留的原文', 'done', NULL, '', 9, 9)",
                    [],
                )
                .expect("late done row");
        }
        drop(store);
        let reopened = Store::open(&root).expect("reopen");
        {
            let profile = reopened.profile.lock().expect("lock");
            let pending: i64 = profile
                .query_row("SELECT count(*) FROM profile_pending", [], |row| row.get(0))
                .expect("pending");
            let markers: i64 = profile
                .query_row("SELECT count(*) FROM profile_markers", [], |row| row.get(0))
                .expect("markers");
            assert_eq!(pending, 0);
            assert_eq!(markers, 2);
        }
        drop(reopened);
        let _ = fs::remove_dir_all(&root);
    }
}
