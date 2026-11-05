//! Releasing one original record's claim on everything it published.
//!
//! Deleting a note, a conversation or a conversation's reading tasks must take
//! back exactly what that record alone supported. It must not depend on how many
//! rows the preview happened to show: a note keeps one row per published version,
//! and a long-lived note has far more of them than one screen. So the work is done
//! with statements over the record's rows, and only counts and cancelled task ids
//! come back.

use rusqlite::{Connection, TransactionBehavior, params};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::protocol::{ApiError, ApiResult};
use crate::sources::channel_kinds;
use crate::util::{check_chars, ensure_not_cancelled, now_ms, require_text};

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseParams {
    /// `note` or `chat`: which kind of record is going away.
    pub channel: String,
    /// A note's identity: every version it was published as.
    #[serde(default)]
    pub origin_ref: Option<String>,
    /// A conversation's identity.
    #[serde(default)]
    pub group_key: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

fn sqlite(error: rusqlite::Error) -> ApiError {
    ApiError::storage(format!("release statement failed: {error}"))
}

/// Hands one deleted record's rows back to the library.
///
/// A row is retired only when this record proves it alone supported it: its claim
/// is its own and nothing else claims the row. A row another record also cites, or
/// one only an older database could guess at, keeps its state, its cards and its
/// links; this record merely gives up its claim. Queued work is settled in the same
/// transaction from the rows as they end up, so a task that just lost its last live
/// row stops here and a task another record still needs keeps running.
pub fn release_record(conn: &mut Connection, params: ReleaseParams) -> ApiResult<Value> {
    let channel = require_text("channel", &params.channel)?;
    check_chars("channel", &channel, 32)?;
    let reason = params
        .reason
        .clone()
        .unwrap_or_else(|| "deleted".to_string());
    check_chars("reason", &reason, 500)?;
    let transaction = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| ApiError::storage(format!("cannot start the release: {error}")))?;
    let now = now_ms();
    // The rows this record holds, gathered by the record's own identity so the size
    // of the answer never decides how much work gets done.
    transaction
        .execute_batch(
            "CREATE TEMP TABLE IF NOT EXISTS release_owned (sid TEXT PRIMARY KEY) WITHOUT ROWID;
             DELETE FROM release_owned;",
        )
        .map_err(sqlite)?;
    let group = params.group_key.as_deref();
    match channel.as_str() {
        "note" => {
            let origin_ref = require_text(
                "originRef",
                params.origin_ref.as_deref().unwrap_or_default(),
            )?;
            check_chars("originRef", &origin_ref, 400)?;
            let kinds = channel_kinds(&channel)?;
            let encoded = serde_json::to_string(&kinds)
                .map_err(|error| ApiError::storage(format!("cannot encode the kinds: {error}")))?;
            transaction
                .execute(
                    "INSERT OR IGNORE INTO release_owned
                       SELECT id FROM sources
                        WHERE origin_ref = ?1
                          AND kind IN (SELECT value FROM json_each(?2))",
                    params![origin_ref, encoded],
                )
                .map_err(sqlite)?;
        }
        "chat" => {
            let group_key = require_text("groupKey", group.unwrap_or_default())?;
            check_chars("groupKey", &group_key, 400)?;
            transaction
                .execute(
                    "INSERT OR IGNORE INTO release_owned
                       SELECT source_id FROM source_records
                        WHERE channel = 'chat' AND record_ref = ?1
                       UNION
                       SELECT i.source_id
                         FROM queue_items i JOIN queue_groups g ON g.id = i.group_id
                        WHERE g.channel = 'chat' AND g.group_key = ?1",
                    [&group_key],
                )
                .map_err(sqlite)?;
        }
        other => {
            return Err(ApiError::invalid(format!(
                "unknown release channel: {other}"
            )));
        }
    }
    // Retire only what this record alone proves: no other claim on the row, and no
    // claim that an older database could only guess at.
    let retired = transaction
        .execute(
            "UPDATE sources
                SET state = 'invalid', invalid_reason = ?1, updated_at = ?2
              WHERE state <> 'invalid'
                AND id IN (SELECT sid FROM release_owned)
                AND NOT EXISTS (
                      SELECT 1 FROM source_records r
                       WHERE r.source_id = sources.id
                         AND r.channel = 'chat'
                         AND (r.record_ref <> ?3 OR r.exclusive = 0))",
            params![reason, now, group.unwrap_or_default()],
        )
        .map_err(sqlite)?;
    // `detached` counts the rows this record gave up while they stay live: the ones
    // it just retired are not kept for anyone and must not be reported as such.
    let detached: i64 = transaction
        .query_row(
            "SELECT count(*) FROM source_records r JOIN sources s ON s.id = r.source_id
              WHERE r.channel = 'chat' AND r.record_ref = ?1 AND s.state <> 'invalid'",
            [group.unwrap_or_default()],
            |row| row.get(0),
        )
        .map_err(sqlite)?;
    transaction
        .execute(
            "DELETE FROM source_records WHERE channel = 'chat' AND record_ref = ?1",
            [group.unwrap_or_default()],
        )
        .map_err(sqlite)?;
    // The tasks that just lost their last live row stop with the record; the ones
    // another record still feeds keep running.
    let candidates: Vec<String> = {
        let mut statement = transaction
            .prepare(
                "SELECT g.id FROM queue_groups g
                  WHERE state <> 'cancelled'
                    AND (g.id IN (SELECT i.group_id FROM queue_items i
                                   WHERE i.source_id IN (SELECT sid FROM release_owned))
                      OR (?1 <> '' AND g.thread_key = ?1))
                  ORDER BY g.created_at, g.id",
            )
            .map_err(sqlite)?;
        let rows = statement
            .query_map([group.unwrap_or_default()], |row| row.get::<_, String>(0))
            .map_err(sqlite)?;
        rows.filter_map(Result::ok).collect()
    };
    let mut cancelled: Vec<String> = Vec::new();
    for id in &candidates {
        let (items, valid): (i64, i64) = transaction
            .query_row(
                "SELECT (SELECT count(*) FROM queue_items i WHERE i.group_id = ?1),
                        (SELECT count(*) FROM queue_items i JOIN sources s ON s.id = i.source_id
                          WHERE i.group_id = ?1 AND s.state <> 'invalid')",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(sqlite)?;
        if items > 0 && valid == 0 {
            transaction
                .execute(
                    "UPDATE queue_groups
                        SET state = 'cancelled', reason = ?2, updated_at = ?3 WHERE id = ?1",
                    params![id, reason, now],
                )
                .map_err(sqlite)?;
            cancelled.push(id.clone());
        }
    }
    if let Some(group_key) = group {
        transaction
            .execute(
                "UPDATE queue_groups
                    SET thread_key = (
                          SELECT r.record_ref FROM source_records r
                            JOIN queue_items i ON i.source_id = r.source_id
                           WHERE i.group_id = queue_groups.id
                             AND r.channel = 'chat' AND r.record_ref <> ?2
                           ORDER BY r.created_at LIMIT 1),
                        updated_at = ?3
                  WHERE id IN (SELECT i.group_id FROM queue_items i
                                WHERE i.source_id IN (SELECT sid FROM release_owned))
                    AND thread_key = ?2
                    AND state <> 'cancelled'",
                params![group_key, group_key, now],
            )
            .map_err(sqlite)?;
    }
    ensure_not_cancelled()?;
    transaction
        .execute_batch("DELETE FROM release_owned;")
        .map_err(sqlite)?;
    transaction
        .commit()
        .map_err(|error| ApiError::storage(format!("cannot commit the release: {error}")))?;
    Ok(json!({
        "channel": channel,
        "retired": retired,
        "detached": detached,
        "cancelled": cancelled,
        "reason": reason
    }))
}
