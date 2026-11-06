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
use std::time::Duration;

use rusqlite::backup::Backup;
use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;

use crate::protocol::{ApiError, ApiResult, Code};
use crate::store::Store;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupParams {
    database: String,
    target: String,
}

/// Copies one database into `target` and returns the snapshot size in bytes.
pub fn snapshot(store: &Store, root: &Path, params: BackupParams) -> ApiResult<u64> {
    let (path, destination) = match params.database.as_str() {
        "knowledge" => (&store.knowledge_path, &store.knowledge),
        "profile" => (&store.profile_path, &store.profile),
        other => return Err(ApiError::invalid(format!("unknown database: {other}"))),
    };
    let target = destination_path(root, path, &params.target)?;
    {
        let source = destination
            .lock()
            .map_err(|_| ApiError::new(Code::Internal, "the database lock was poisoned"))?;
        copy(&source, &target)?;
    }
    settle(&target)?;
    let bytes = std::fs::metadata(&target)
        .map_err(|error| ApiError::storage(format!("cannot read the snapshot back: {error}")))?
        .len();
    Ok(bytes)
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

fn copy(source: &Connection, target: &Path) -> ApiResult<()> {
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
    let result = (|| -> ApiResult<()> {
        let backup = Backup::new(source, &mut destination)
            .map_err(|error| ApiError::storage(format!("cannot start the snapshot: {error}")))?;
        backup
            .run_to_completion(512, Duration::from_millis(2), None)
            .map_err(|error| ApiError::storage(format!("cannot finish the snapshot: {error}")))
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
