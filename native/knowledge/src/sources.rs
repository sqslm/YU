//! Sources: the original record a piece of knowledge came from.
//!
//! The body text is only used to compute the fingerprint; it is never written
//! to the new databases, so no duplicate copy of a note, chat or web page is
//! kept here.

use rusqlite::{Connection, OptionalExtension, Row, TransactionBehavior, params};
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

/// Reads one source by its bound id and says whether it still matches.
///
/// When the host supplies the body it just read out of the original store, the
/// fingerprint is recomputed here and compared with the stored one — a caller
/// cannot declare "unchanged" by echoing a string back. Without a body only the
/// caller's expectation is compared, which is what the queue's own retry needs.
pub fn read(
    connection: &Connection,
    id: &str,
    expect: Option<&str>,
    text: Option<&str>,
) -> ApiResult<Value> {
    let source = get(connection, id)?;
    if let Some(expect) = expect {
        check_chars("expectFingerprint", expect, 200)?;
    }
    let recomputed = match text {
        Some(text) => {
            check_chars("text", text, MAX_BODY_CHARS)?;
            Some(crate::util::sha256_hex(text))
        }
        None => None,
    };
    let matches_expect = expect.is_none_or(|value| {
        value == source.fingerprint
            || value == source.version
            || recomputed.as_deref() == Some(value)
    });
    let matched = match recomputed.as_deref() {
        // The store is the authority: a changed body is a different version.
        Some(print) => print == source.fingerprint && matches_expect,
        None => matches_expect,
    };
    Ok(json!({
        "source": source,
        "matched": matched,
        "fingerprint": recomputed,
        "size": text.map(|text| text.chars().count() as i64),
    }))
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

/// Which source kinds a collect channel can mint. A reading material is either a
/// web page or a document; the other two channels each own one kind.
const CHANNEL_KINDS: [(&str, &[&str]); 3] = [
    ("note", &["note"]),
    ("chat", &["chat"]),
    ("reading", &["web", "document"]),
];

/// The kinds one collect channel writes, or an invalid-params error for a
/// channel that does not exist.
pub(crate) fn channel_kinds(channel: &str) -> ApiResult<Vec<String>> {
    let channel = channel.trim();
    CHANNEL_KINDS
        .iter()
        .find(|(name, _)| *name == channel)
        .map(|(_, kinds)| kinds.iter().map(|kind| (*kind).to_string()).collect())
        .ok_or_else(|| ApiError::invalid(format!("unknown channel: {channel}")))
}

/// How many records one thread lookup may answer. A chat thread is one row per
/// message, so the cap keeps a long conversation's answer bounded; the host
/// purges what it got and asks again.
const THREAD_SOURCES: i64 = 200;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindParams {
    pub channel: String,
    #[serde(default)]
    pub origin_ref: Option<String>,
    #[serde(default)]
    pub group_key: Option<String>,
}

/// The fields a detail view needs to reach a record by the identity it holds: the
/// note id or thread id it is rendering, never the row id or the fingerprint.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FoundSource {
    pub id: String,
    pub kind: String,
    pub channel: String,
    pub state: String,
    pub version: String,
    pub title: String,
    pub origin_ref: String,
    pub size: i64,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FindResult {
    /// Always an array: a note matches at most one record, a chat thread matches
    /// one per message. Empty is a normal answer, not an error — the note was
    /// never collected, or the thread produced nothing yet.
    pub sources: Vec<FoundSource>,
}

/// Resolves the identity a host holds to the records it produced.
///
/// `originRef` names one row (the note id); `groupKey` names a whole chat thread
/// and answers every record under it, oldest first. Read-only, no transaction.
pub fn find(connection: &Connection, params: FindParams) -> ApiResult<FindResult> {
    let channel = params.channel.trim().to_string();
    let kinds = channel_kinds(&channel)?;
    let sources = match (params.origin_ref.as_deref(), params.group_key.as_deref()) {
        (Some(origin_ref), _) => by_origin(connection, &channel, &kinds, origin_ref)?,
        (None, Some(group_key)) => thread_sources(connection, &channel, group_key)?,
        (None, None) => {
            return Err(ApiError::invalid("originRef or groupKey is required"));
        }
    };
    Ok(FindResult { sources })
}

/// The record one note produced.
fn by_origin(
    connection: &Connection,
    channel: &str,
    kinds: &[String],
    origin_ref: &str,
) -> ApiResult<Vec<FoundSource>> {
    let origin_ref = require_text("originRef", origin_ref)?;
    check_chars("originRef", &origin_ref, 400)?;
    let kinds = serde_json::to_string(kinds)
        .map_err(|error| ApiError::storage(format!("cannot encode the kinds: {error}")))?;
    // A live row wins over an invalidated one: the caller shows what the note
    // produced right now, and re-collecting a note reactivates its row anyway.
    let found = connection
        .query_row(
            "SELECT id, kind, state, version, title, origin_ref, size FROM sources
              WHERE origin_ref = ?1 AND kind IN (SELECT value FROM json_each(?2))
              ORDER BY (state = 'active') DESC, updated_at DESC, id DESC LIMIT 1",
            params![origin_ref, kinds],
            |row| map_found(row, channel),
        )
        .optional()
        .map_err(sqlite_error)?;
    Ok(found.into_iter().collect())
}

/// Every record a chat thread produced, oldest first.
///
/// `sources` carries no thread column, so the queue is the only place the thread
/// id lives: a record belongs to a thread when the thread's queue items point at
/// it.
fn thread_sources(
    connection: &Connection,
    channel: &str,
    group_key: &str,
) -> ApiResult<Vec<FoundSource>> {
    let group_key = require_text("groupKey", group_key)?;
    check_chars("groupKey", &group_key, 400)?;
    let mut statement = connection
        .prepare(
            "SELECT s.id, s.kind, s.state, s.version, s.title, s.origin_ref, s.size
               FROM sources s
               JOIN queue_items i ON i.source_id = s.id
               JOIN queue_groups g ON g.id = i.group_id
              WHERE g.channel = ?1 AND g.group_key = ?2
              GROUP BY s.id
              ORDER BY s.read_at ASC, s.created_at ASC, s.id ASC
              LIMIT ?3",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map(params![channel, group_key, THREAD_SOURCES], |row| {
            map_found(row, channel)
        })
        .map_err(sqlite_error)?
        .collect::<rusqlite::Result<Vec<FoundSource>>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

fn map_found(row: &Row<'_>, channel: &str) -> rusqlite::Result<FoundSource> {
    Ok(FoundSource {
        id: row.get(0)?,
        kind: row.get(1)?,
        state: row.get(2)?,
        version: row.get(3)?,
        title: row.get(4)?,
        origin_ref: row.get(5)?,
        size: row.get(6)?,
        channel: channel.to_string(),
    })
}

/// Finds the records a caller named, by bound id or by the identity a note or a
/// thread still carries. An empty answer means "no such record", which the card
/// views render as an empty page; an unknown id stays an error, because the caller
/// named something it believes exists.
pub(crate) fn resolve_many(
    connection: &Connection,
    id: Option<&str>,
    channel: Option<&str>,
    origin_ref: Option<&str>,
    group_key: Option<&str>,
) -> ApiResult<Vec<FoundSource>> {
    if let Some(id) = id.filter(|value| !value.is_empty()) {
        let source = get(connection, id)?;
        return Ok(vec![FoundSource {
            id: source.id,
            kind: source.kind,
            channel: channel.unwrap_or_default().to_string(),
            state: source.state,
            version: source.version,
            title: source.title,
            origin_ref: source.origin_ref,
            size: source.size,
        }]);
    }
    let Some(channel) = channel else {
        return Err(ApiError::invalid(
            "sourceId, or channel with originRef or groupKey, is required",
        ));
    };
    let found = find(
        connection,
        FindParams {
            channel: channel.to_string(),
            origin_ref: origin_ref.map(str::to_string),
            group_key: group_key.map(str::to_string),
        },
    )?;
    Ok(found.sources)
}
