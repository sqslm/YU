//! One-off history collection.
//!
//! The host owns the read side — its stores are the only place an existing note
//! or conversation can be projected from — so a job keeps its cursor and its
//! counters here and asks for one bounded batch at a time. A job never scans
//! dictation history, the file system or old URLs: only the notes and the
//! completed persistent conversations the host already holds.

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::protocol::{ApiError, ApiResult, Code};
use crate::queue::{self, PublishParams};
use crate::util::{ensure_not_cancelled, new_id, now_ms, require_text};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryJob {
    pub id: String,
    pub scopes: Value,
    pub state: String,
    pub note_cursor: Option<String>,
    pub chat_cursor: Option<String>,
    pub note_done: bool,
    pub chat_done: bool,
    /// Scan bounds fixed when the job started; new content never enters this scan.
    pub note_bound: Option<String>,
    pub chat_bound: Option<i64>,
    pub scanned: i64,
    pub skipped: i64,
    pub deduped: i64,
    pub ready: i64,
    pub needs_reread: i64,
    pub failed: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

fn read(conn: &Connection, id: &str) -> ApiResult<HistoryJob> {
    conn.query_row(
        "SELECT id, scopes, state, note_cursor, chat_cursor, note_done, chat_done, scanned, skipped,
           deduped, ready, needs_reread, failed, created_at, updated_at, note_bound, chat_bound
         FROM history_jobs WHERE id = ?1",
        [id],
        |row| {
            Ok(HistoryJob {
                id: row.get(0)?,
                scopes: serde_json::from_str(&row.get::<_, String>(1)?).unwrap_or(Value::Null),
                state: row.get(2)?,
                note_cursor: row.get(3)?,
                chat_cursor: row.get(4)?,
                note_done: row.get::<_, i64>(5)? == 1,
                chat_done: row.get::<_, i64>(6)? == 1,
                scanned: row.get(7)?,
                skipped: row.get(8)?,
                deduped: row.get(9)?,
                ready: row.get(10)?,
                needs_reread: row.get(11)?,
                failed: row.get(12)?,
                created_at: row.get(13)?,
                updated_at: row.get(14)?,
                note_bound: row.get(15)?,
                chat_bound: row.get(16)?,
            })
        },
    )
    .optional()
    .ok()
    .flatten()
    .ok_or_else(|| ApiError::new(Code::NotFound, "history job not found"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginParams {
    #[serde(default)]
    pub notes: bool,
    #[serde(default)]
    pub chat: bool,
    /// Highest note key and chat sequence that existed when the scan started. The
    /// host reads them from its own stores; a job never re-enumerates them.
    #[serde(default)]
    pub note_bound: Option<String>,
    #[serde(default)]
    pub chat_bound: Option<i64>,
}

pub fn begin(conn: &mut Connection, params: BeginParams) -> ApiResult<Value> {
    if !params.notes && !params.chat {
        return Err(ApiError::invalid("choose notes, conversations or both"));
    }
    // A second start while one job is still alive returns that job: two scans of
    // the same history would produce two identical sets of tasks.
    if let Some((id, _)) = conn
        .query_row(
            "SELECT id, state FROM history_jobs WHERE state IN ('running','paused') ORDER BY created_at DESC LIMIT 1",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| ApiError::storage(format!("cannot read the history job: {error}")))?
    {
        return Ok(json!({ "job": read(conn, &id)?, "resumed": true }));
    }
    let id = new_id("his");
    let now = now_ms();
    let scopes = json!({ "notes": params.notes, "chat": params.chat });
    conn.execute(
        "INSERT INTO history_jobs (id, scopes, state, created_at, updated_at, note_bound, chat_bound)
         VALUES (?1, ?2, 'running', ?3, ?3, ?4, ?5)",
        params![
            id,
            serde_json::to_string(&scopes).unwrap_or_default(),
            now,
            params.note_bound,
            params.chat_bound
        ],
    )
    .map_err(|error| ApiError::storage(format!("cannot start the history job: {error}")))?;
    Ok(json!({ "job": read(conn, &id)?, "resumed": false }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepParams {
    pub job_id: String,
    pub kind: String,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub rows: Vec<PublishParams>,
    /// The host reached the end of this kind's history.
    #[serde(default)]
    pub done: bool,
}

pub fn step(conn: &mut Connection, params: StepParams) -> ApiResult<Value> {
    let job_id = require_text("jobId", &params.job_id)?;
    let job = read(conn, &job_id)?;
    if job.state != "running" {
        return Err(ApiError::invalid(format!("history job is {}", job.state)));
    }
    let allowed = ["note", "chat"];
    if !allowed.contains(&params.kind.as_str()) {
        return Err(ApiError::invalid(format!(
            "unknown history kind: {}",
            params.kind
        )));
    }
    let scope_on = match params.kind.as_str() {
        "note" => job.scopes["notes"] == json!(true),
        _ => job.scopes["chat"] == json!(true),
    };
    if !scope_on {
        return Err(ApiError::invalid("this scope was not selected"));
    }

    let stored_cursor = if params.kind == "note" {
        job.note_cursor.clone()
    } else {
        job.chat_cursor.clone()
    };
    // A replayed batch is not a second scan: the checkpoint already covers it.
    // An empty batch at the same cursor is different — it is the completion
    // marker for that position, and it must still finish the scope.
    if !params.rows.is_empty() && params.cursor.is_some() && params.cursor == stored_cursor {
        return Ok(json!({
            "job": job,
            "done": job.state == "completed",
            "replayed": true,
        }));
    }

    let mut scanned = job.scanned;
    let mut skipped = job.skipped;
    let mut deduped = job.deduped;
    let mut ready = job.ready;
    let mut needs_reread = job.needs_reread;
    let mut failed = job.failed;
    // Publishes, counters and the cursor move together: a cancelled or failed
    // step must not leave a checkpoint that points past sources it never stored.
    let transaction = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| ApiError::storage(format!("cannot start the history step: {error}")))?;
    for row in params.rows {
        scanned += 1;
        match queue::publish_in(&transaction, row) {
            Ok(result) => {
                if result.duplicate {
                    deduped += 1;
                } else {
                    ready += 1;
                }
            }
            Err(error) => match error.code {
                Code::Cancelled => return Err(error),
                Code::Excluded | Code::ChannelDisabled => skipped += 1,
                Code::TooLarge => needs_reread += 1,
                _ => failed += 1,
            },
        }
    }

    let (column, done_column) = if params.kind == "note" {
        ("note_cursor", "note_done")
    } else {
        ("chat_cursor", "chat_done")
    };
    // A scope that reached its end keeps its completion marker, so a resumed job
    // never rescans it; the job finishes once every selected scope is marked.
    let (note_done, chat_done) = if params.kind == "note" {
        (job.note_done || params.done, job.chat_done)
    } else {
        (job.note_done, job.chat_done || params.done)
    };
    let finished = (!job.scopes["notes"].as_bool().unwrap_or(false) || note_done)
        && (!job.scopes["chat"].as_bool().unwrap_or(false) || chat_done);
    let state = if finished { "completed" } else { "running" };
    transaction
        .execute(
            &format!(
                "UPDATE history_jobs SET {column} = ?2, {done_column} = ?3, state = ?4, scanned = ?5,
                 skipped = ?6, deduped = ?7, ready = ?8, needs_reread = ?9, failed = ?10,
                 updated_at = ?11 WHERE id = ?1"
            ),
            params![
                params.job_id,
                params.cursor,
                if params.done { 1 } else { 0 },
                state,
                scanned,
                skipped,
                deduped,
                ready,
                needs_reread,
                failed,
                now_ms()
            ],
        )
        .map_err(|error| ApiError::storage(format!("cannot record the history step: {error}")))?;
    ensure_not_cancelled()?;
    transaction
        .commit()
        .map_err(|error| ApiError::storage(format!("cannot commit the history step: {error}")))?;
    Ok(json!({ "job": read(conn, &params.job_id)?, "done": state == "completed" }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobParams {
    pub job_id: String,
}

pub fn pause(conn: &Connection, params: JobParams) -> ApiResult<Value> {
    transit(conn, &params.job_id, "paused", &["running"])
}

pub fn resume(conn: &Connection, params: JobParams) -> ApiResult<Value> {
    transit(conn, &params.job_id, "running", &["paused"])
}

pub fn cancel(conn: &Connection, params: JobParams) -> ApiResult<Value> {
    // Cancelling keeps every source and card the scan already collected.
    transit(conn, &params.job_id, "cancelled", &["running", "paused"])
}

pub fn status(conn: &Connection, params: JobParams) -> ApiResult<Value> {
    let job = read(conn, &params.job_id)?;
    Ok(json!({ "job": job }))
}

/// The newest job, or null when the user never ran one.
pub fn latest(conn: &Connection) -> ApiResult<Value> {
    let id: Option<String> = conn
        .query_row(
            "SELECT id FROM history_jobs ORDER BY created_at DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| ApiError::storage(format!("cannot read the history job: {error}")))?;
    match id {
        Some(id) => Ok(json!({ "job": read(conn, &id)? })),
        None => Ok(json!({ "job": Value::Null })),
    }
}

fn transit(conn: &Connection, id: &str, state: &str, from: &[&str]) -> ApiResult<Value> {
    let job = read(conn, id)?;
    if !from.contains(&job.state.as_str()) {
        return Err(ApiError::invalid(format!("history job is {}", job.state)));
    }
    conn.execute(
        "UPDATE history_jobs SET state = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, state, now_ms()],
    )
    .map_err(|error| ApiError::storage(format!("cannot update the history job: {error}")))?;
    Ok(json!({ "job": read(conn, id)? }))
}
