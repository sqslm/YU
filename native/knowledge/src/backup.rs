//! Consistent snapshots of the two databases for the existing backup feature.
//!
//! The backup API reads the source through a live connection, so the file it
//! produces holds the committed state: pages whose transaction never committed
//! are not part of the read snapshot, while committed pages still sitting in WAL
//! are. The destination is a fresh file — no `-wal` or `-shm` is created or
//! copied, so a later restore cannot replay old frames onto the restored
//! database. The snapshot is switched back to rollback journal mode once it is
//! complete, so the file main process copies around is self-contained.
//!
//! The helper only ever writes the two databases it owns, and only to a path the
//! host asked for: a target inside the data root, an existing file or a relative
//! path are refused before anything is opened.

use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

use rusqlite::backup::{Backup, StepResult};
use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;

use crate::protocol::{ApiError, ApiResult};
use crate::store::{KNOWLEDGE_SCHEMA, PROFILE_SCHEMA, expected_tables};
use crate::util::ensure_not_cancelled;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupParams {
    database: String,
    target: String,
    /// How long the copy may take before it gives up. The host's own deadline is
    /// longer than this, so a busy database fails here instead of leaving a
    /// snapshot to be written after the caller already gave up on it.
    #[serde(default)]
    timeout_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectParams {
    path: String,
}

/// The two databases the backup carries, at the paths `Store::open` uses.
fn library_path(root: &Path, database: &str) -> ApiResult<(PathBuf, i64)> {
    match database {
        "knowledge" => Ok((root.join("data/knowledge/knowledge.db"), KNOWLEDGE_SCHEMA)),
        "profile" => Ok((root.join("data/profile/profile.db"), PROFILE_SCHEMA)),
        other => Err(ApiError::invalid(format!("unknown database: {other}"))),
    }
}

/// Copies one database into `target` and returns the snapshot size in bytes.
///
/// The source is opened read-only on its own, so a backup never creates, migrates
/// or reopens the business store: a database that is not there stays absent, and
/// one that is there is read exactly as it lies on disk.
pub fn snapshot(root: &Path, params: BackupParams) -> ApiResult<u64> {
    let (path, _) = library_path(root, &params.database)?;
    if !path.exists() {
        return Err(ApiError::invalid(format!(
            "database not found: {}",
            params.database
        )));
    }
    let target = destination_path(root, &path, &params.target)?;
    if params.timeout_ms == Some(0) {
        // No budget at all: refuse before touching the target, so a caller that
        // cancelled in the same breath leaves nothing behind.
        return Err(ApiError::storage(
            "the snapshot timed out: the database is busy",
        ));
    }
    {
        let source = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|error| ApiError::storage(format!("cannot open the database: {error}")))?;
        copy(&source, &target, params.timeout_ms.unwrap_or(1_500))?;
    }
    settle(&target)?;
    let bytes = std::fs::metadata(&target)
        .map_err(|error| ApiError::storage(format!("cannot read the snapshot back: {error}")))?
        .len();
    Ok(bytes)
}

/// Reads what a file claims to be, without touching the business store: the
/// restore paths use this to refuse a snapshot whose kind or schema does not
/// belong where the manifest says it goes.
pub fn inspect(params: InspectParams) -> ApiResult<serde_json::Value> {
    let path = PathBuf::from(&params.path);
    if params.path.trim().is_empty() || !path.is_absolute() {
        return Err(ApiError::invalid("the database path must be absolute"));
    }
    if !path.exists() {
        return Err(ApiError::invalid("the database file is missing"));
    }
    let connection = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| ApiError::storage(format!("cannot open the database: {error}")))?;
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| ApiError::storage(format!("cannot read the schema version: {error}")))?;
    let has = |table: &str| -> ApiResult<bool> {
        connection
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |row| row.get::<_, i64>(0),
            )
            .map(|count| count > 0)
            .map_err(|error| ApiError::storage(format!("cannot read the schema: {error}")))
    };
    let (kind, supported) = if has("cards")? && has("sources")? {
        ("knowledge", KNOWLEDGE_SCHEMA)
    } else if has("profile_items")? {
        ("profile", PROFILE_SCHEMA)
    } else {
        ("unknown", 0)
    };
    // Being the right kind is not the same as being openable: a file at a version
    // that promised a table which is missing fails the moment the helper recovers
    // its interrupted work. The migrations say which tables that version owes.
    let mut missing = Vec::new();
    if kind != "unknown" {
        for table in expected_tables(kind, version) {
            if !has(&table)? {
                missing.push(table);
            }
        }
    }
    Ok(serde_json::json!({
        "ok": true,
        "kind": kind,
        "version": version,
        "supported": supported,
        "missing": missing,
    }))
}

/// Rejects a target the host should not have asked for, before opening anything:
/// relative, escaping, inside the data root, or already there.
fn destination_path(root: &Path, source: &Path, target: &str) -> ApiResult<PathBuf> {
    let path = PathBuf::from(target);
    if target.trim().is_empty() || !path.is_absolute() {
        return Err(ApiError::invalid(
            "the snapshot target must be an absolute path",
        ));
    }
    if path
        .components()
        .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(ApiError::invalid(
            "the snapshot target may not step out of its directory",
        ));
    }
    if path == source || path.starts_with(root) {
        return Err(ApiError::invalid(
            "the snapshot target must live outside the data root",
        ));
    }
    match std::fs::metadata(&path) {
        Ok(_) => return Err(ApiError::invalid("the snapshot target already exists")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(ApiError::storage(format!(
                "cannot inspect the snapshot target: {error}"
            )));
        }
    }
    let parent = path
        .parent()
        .ok_or_else(|| ApiError::invalid("the snapshot target has no parent directory"))?;
    let stat = std::fs::metadata(parent).map_err(|error| {
        ApiError::storage(format!("cannot reach the snapshot directory: {error}"))
    })?;
    if !stat.is_dir() {
        return Err(ApiError::invalid(
            "the snapshot directory is not a directory",
        ));
    }
    Ok(path)
}

fn copy(source: &Connection, target: &Path, timeout_ms: u64) -> ApiResult<()> {
    let mut destination = Connection::open_with_flags(
        target,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| {
        let _ = std::fs::remove_file(target);
        ApiError::storage(format!("cannot create the snapshot: {error}"))
    })?;
    // Pages are stepped one at a time so the copy can stop: a database held under
    // an exclusive lock, or one whose pages keep changing, must not leave a
    // complete-looking snapshot behind after the caller's deadline.
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    // SQLite's own busy handler would otherwise sit inside one `step` for the whole
    // lock wait, so the deadline would only be noticed after the copy finished. A
    // short wait makes every step return, which keeps the loop in control of the
    // budget: a locked source fails here instead of producing a late snapshot.
    source
        .busy_timeout(Duration::from_millis(50))
        .map_err(|error| ApiError::storage(format!("cannot bound the snapshot wait: {error}")))?;
    let result = (|| -> ApiResult<()> {
        let backup = Backup::new(source, &mut destination)
            .map_err(|error| ApiError::storage(format!("cannot start the snapshot: {error}")))?;
        loop {
            // The host may cancel while the copy runs: a snapshot nobody waits for
            // must not keep writing pages. Checked every step, before and after it,
            // so a cancel that lands on the last page still leaves nothing behind.
            ensure_not_cancelled()?;
            if Instant::now() >= deadline {
                return Err(ApiError::storage(
                    "the snapshot timed out: the database is busy",
                ));
            }
            match backup.step(-1) {
                // The last page can be the expensive one: a copy that only finishes
                // after the deadline must not look like a success.
                Ok(StepResult::Done) => {
                    ensure_not_cancelled()?;
                    if Instant::now() >= deadline {
                        return Err(ApiError::storage(
                            "the snapshot timed out: the database is busy",
                        ));
                    }
                    return Ok(());
                }
                Ok(StepResult::More) => {}
                Ok(StepResult::Busy) | Ok(StepResult::Locked) => {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Ok(_) => {}
                Err(error) => {
                    return Err(ApiError::storage(format!(
                        "cannot finish the snapshot: {error}"
                    )));
                }
            }
        }
    })();
    drop(destination);
    match result {
        Ok(()) => Ok(()),
        Err(error) => {
            // A half-written snapshot must not look like a usable one.
            let _ = std::fs::remove_file(target);
            Err(error)
        }
    }
}

/// The pages came across as they were stored, so a WAL-mode database would arrive
/// claiming a log it does not have. Switching the finished copy to the rollback
/// journal makes the single file the whole database.
fn settle(target: &Path) -> ApiResult<()> {
    let connection = Connection::open_with_flags(
        target,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| {
        let _ = std::fs::remove_file(target);
        ApiError::storage(format!("cannot reopen the snapshot: {error}"))
    })?;
    let result = connection
        .query_row("PRAGMA journal_mode = DELETE", [], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| ApiError::storage(format!("cannot settle the snapshot: {error}")));
    drop(connection);
    match result {
        Ok(mode) if mode.eq_ignore_ascii_case("delete") => Ok(()),
        Ok(mode) => {
            let _ = std::fs::remove_file(target);
            Err(ApiError::storage(format!(
                "the snapshot kept journal mode {mode}"
            )))
        }
        Err(error) => {
            let _ = std::fs::remove_file(target);
            Err(error)
        }
    }
}
