//! Sources: the original record a piece of knowledge came from.
//!
//! The body text is only used to compute the fingerprint; it is never written
//! to the new databases, so no duplicate copy of a note, chat or web page is
//! kept here.

use rusqlite::{Connection, Row, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

use serde_json::{Value, json};

use crate::protocol::{ApiError, ApiResult, MAX_BODY_CHARS};
use crate::store::SOURCE_KINDS;
use crate::util::{check_chars, now_ms, optional_text, require_text, sha256_hex};

const COLUMNS: &str = "id, kind, origin_ref, locator, title, version, scope, read_at, fingerprint, size, state, invalid_reason, created_at, updated_at";

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub kind: String,
    pub origin_ref: String,
    pub locator: String,
    pub title: String,
    pub version: String,
    pub scope: String,
    pub read_at: i64,
    pub fingerprint: String,
    pub size: i64,
    pub state: String,
    pub invalid_reason: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveParams {
    pub kind: String,
    pub origin_ref: String,
    #[serde(default)]
    pub locator: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub read_at: Option<i64>,
    pub text: String,
}

fn map(row: &Row<'_>) -> rusqlite::Result<Source> {
    Ok(Source {
        id: row.get(0)?,
        kind: row.get(1)?,
        origin_ref: row.get(2)?,
        locator: row.get(3)?,
        title: row.get(4)?,
        version: row.get(5)?,
        scope: row.get(6)?,
        read_at: row.get(7)?,
        fingerprint: row.get(8)?,
        size: row.get(9)?,
        state: row.get(10)?,
        invalid_reason: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}

fn sqlite_error(error: rusqlite::Error) -> ApiError {
    ApiError::storage(format!("source statement failed: {error}"))
}

/// The field limits every source-producing entry shares.
///
/// `source.save` and `queue.publish` both go through this, so a new entry point
/// cannot quietly accept more than the contract allows.
pub struct Fields<'a> {
    pub kind: &'a str,
    pub origin_ref: &'a str,
    pub title: &'a str,
    pub locator: &'a str,
    pub version: &'a str,
    pub scope: &'a str,
    pub text: &'a str,
}

pub fn validate(fields: Fields<'_>) -> ApiResult<()> {
    if !SOURCE_KINDS.contains(&fields.kind) {
        return Err(ApiError::invalid(format!(
            "unknown source kind: {}",
            fields.kind
        )));
    }
    let origin_ref = require_text("originRef", fields.origin_ref)?;
    check_chars("originRef", &origin_ref, 400)?;
    check_chars("title", fields.title, 200)?;
    check_chars("locator", fields.locator, 2_000)?;
    check_chars("version", fields.version, 200)?;
    check_chars("scope", fields.scope, 1_000)?;
    // The body is in memory only: it is measured and hashed, never stored, but an
    // unbounded body would still have to be hashed in one piece, so it is capped.
    check_chars("text", fields.text, MAX_BODY_CHARS)?;
    Ok(())
}

/// Reads one source by its bound id and says whether it still matches the
/// fingerprint a caller expected. Recovery uses this instead of trusting a
/// queue row: the store is the authority on what still exists.
pub fn read(connection: &Connection, id: &str, expect: Option<&str>) -> ApiResult<Value> {
    let source = get(connection, id)?;
    if let Some(expect) = expect {
        check_chars("expectFingerprint", expect, 200)?;
    }
    let matched = expect.is_none_or(|value| value == source.fingerprint || value == source.version);
    Ok(json!({ "source": source, "matched": matched }))
}

/// Inserts or refreshes the source identified by (kind, originRef, version).
/// Re-reading the same version refreshes its fingerprint instead of duplicating
/// the row, and clears a previous invalid mark.
pub fn save(connection: &mut Connection, params: SaveParams) -> ApiResult<Source> {
    validate(Fields {
        kind: &params.kind,
        origin_ref: &params.origin_ref,
        title: &params.title,
        locator: &params.locator,
        version: &params.version,
        scope: &params.scope,
        text: &params.text,
    })?;
    let origin_ref = require_text("originRef", &params.origin_ref)?;
    let locator = optional_text("locator", Some(params.locator), 2_000)?.unwrap_or_default();
    let fingerprint = sha256_hex(&params.text);
    let size = i64::try_from(params.text.chars().count()).unwrap_or(i64::MAX);
    let now = params.read_at.unwrap_or_else(now_ms);
    let id = crate::util::new_id("src");
    let sql = format!(
        "INSERT INTO sources ({COLUMNS})
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'active', NULL, ?11, ?11)
         ON CONFLICT (kind, origin_ref, version) DO UPDATE SET
           locator = excluded.locator,
           title = excluded.title,
           scope = excluded.scope,
           read_at = excluded.read_at,
           fingerprint = excluded.fingerprint,
           size = excluded.size,
           state = 'active',
           invalid_reason = NULL,
           updated_at = excluded.updated_at
         RETURNING {COLUMNS}"
    );
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| {
            ApiError::storage(format!("cannot start the source transaction: {error}"))
        })?;
    let source = transaction
        .query_row(
            &sql,
            params![
                id,
                params.kind,
                origin_ref,
                locator,
                params.title,
                params.version,
                params.scope,
                now,
                fingerprint,
                size,
                now
            ],
            map,
        )
        .map_err(sqlite_error)?;
    // A cancelled request must not land its write, so the token is checked at the
    // commit point, after the statement but before the transaction is durable.
    crate::util::ensure_not_cancelled()?;
    transaction
        .commit()
        .map_err(|error| ApiError::storage(format!("cannot commit the source: {error}")))?;
    Ok(source)
}

pub fn get(connection: &Connection, id: &str) -> ApiResult<Source> {
    check_chars("id", id, 128)?;
    let sql = format!("SELECT {COLUMNS} FROM sources WHERE id = ?1");
    connection
        .query_row(&sql, [id], map)
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => {
                ApiError::not_found(format!("unknown source: {id}"))
            }
            other => sqlite_error(other),
        })
}

/// Marks the source as removed or unreadable. Cards that cite it stay intact;
/// only the source row changes state.
pub fn invalidate(
    connection: &mut Connection,
    id: &str,
    reason: Option<&str>,
) -> ApiResult<Source> {
    check_chars("id", id, 128)?;
    if let Some(reason) = reason {
        check_chars("reason", reason, 500)?;
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| {
            ApiError::storage(format!("cannot start the source transaction: {error}"))
        })?;
    let changed = transaction
        .execute(
            "UPDATE sources SET state = 'invalid', invalid_reason = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, reason, now_ms()],
        )
        .map_err(sqlite_error)?;
    if changed == 0 {
        return Err(ApiError::not_found(format!("unknown source: {id}")));
    }
    crate::util::ensure_not_cancelled()?;
    transaction
        .commit()
        .map_err(|error| ApiError::storage(format!("cannot commit the source: {error}")))?;
    get(connection, id)
}

/// True when the source row exists; used before linking a card to it.
pub fn exists(connection: &Connection, id: &str) -> ApiResult<bool> {
    let count: i64 = connection
        .query_row("SELECT count(*) FROM sources WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .map_err(sqlite_error)?;
    Ok(count > 0)
}
