//! Sources: the original record a piece of knowledge came from.
//!
//! The body text is only used to compute the fingerprint; it is never written
//! to the new databases, so no duplicate copy of a note, chat or web page is
//! kept here.

use std::collections::BTreeSet;

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

/// How many records one lookup answers. A note keeps one row per published
/// version and a chat thread one row per message, so a long record would otherwise
/// answer without bound. `incomplete` says the cap cut something: a preview built
/// on a truncated set must never be confirmed.
pub(crate) const RECORD_SOURCES: usize = 200;

/// The identity a host holds for one original record: the note it is rendering, the
/// thread it is deleting, or — the older, row-level form — one source id.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FindParams {
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub note_id: Option<String>,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub channel: Option<String>,
    #[serde(default)]
    pub origin_ref: Option<String>,
    #[serde(default)]
    pub group_key: Option<String>,
}

/// Echoed back so a caller can tell which record an answer belongs to.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct RecordRef {
    pub channel: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_key: Option<String>,
}

/// The fields a card view needs to reach a record by the identity it holds, plus
/// the row id and version a preview hands back.
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
    /// Always an array: a note answers every version it was published as, a chat
    /// thread one row per message. Empty is a normal answer, not an error.
    pub sources: Vec<FoundSource>,
    pub record: RecordRef,
    /// True when [`RECORD_SOURCES`] cut the set.
    pub incomplete: bool,
}

/// Every still-traceable record of one identity, oldest first.
#[derive(Debug, Clone)]
pub(crate) struct SourceSet {
    pub record: RecordRef,
    pub sources: Vec<FoundSource>,
    pub incomplete: bool,
}

impl SourceSet {
    /// The ids of the records, in the order they were published.
    pub(crate) fn ids(&self) -> Vec<String> {
        self.sources
            .iter()
            .map(|source| source.id.clone())
            .collect()
    }
}

/// Resolves the identity a host holds to every record it produced.
///
/// One note keeps a row per published version, so `originRef` answers all of them,
/// oldest first; `groupKey` answers a whole chat thread the same way. A `sourceId`
/// answers that one row, which is what the older callers pass.
pub fn find(connection: &Connection, params: FindParams) -> ApiResult<FindResult> {
    let set = resolve_record(connection, &params)?;
    Ok(FindResult {
        sources: set.sources,
        record: set.record,
        incomplete: set.incomplete,
    })
}

/// The record-scoped resolver every card view shares: identity in, every
/// still-traceable source of that record out.
pub(crate) fn resolve_record(connection: &Connection, params: &FindParams) -> ApiResult<SourceSet> {
    let given = |value: &Option<String>| -> Option<String> {
        value
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    if let Some(id) = given(&params.source_id) {
        let source = get(connection, &id)?;
        let channel = params
            .channel
            .clone()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| channel_of(&source.kind).to_string());
        let found = FoundSource {
            id: source.id,
            kind: source.kind,
            channel: channel.clone(),
            state: source.state,
            version: source.version,
            title: source.title,
            origin_ref: source.origin_ref.clone(),
            size: source.size,
        };
        return Ok(SourceSet {
            record: RecordRef {
                channel,
                origin_ref: Some(source.origin_ref),
                group_key: None,
            },
            sources: vec![found],
            incomplete: false,
        });
    }
    // A note id or a thread id is enough: the host renders one of them and never
    // both, so the identity needs no channel.
    let (channel, origin_ref, group_key) = match (given(&params.note_id), given(&params.thread_id))
    {
        (Some(note_id), _) => ("note".to_string(), Some(note_id), None),
        (_, Some(thread_id)) => ("chat".to_string(), None, Some(thread_id)),
        _ => {
            let channel = given(&params.channel)
                .ok_or_else(|| {
                    ApiError::invalid(
                        "sourceId, noteId, threadId, or channel with originRef or groupKey, is required",
                    )
                })?
                .trim()
                .to_string();
            (channel, given(&params.origin_ref), given(&params.group_key))
        }
    };
    let kinds = channel_kinds(&channel)?;
    let record = RecordRef {
        channel: channel.clone(),
        origin_ref: origin_ref.clone(),
        group_key: group_key.clone(),
    };
    let mut sources = match (origin_ref.as_deref(), group_key.as_deref()) {
        (Some(origin_ref), _) => by_origin(connection, &channel, &kinds, origin_ref)?,
        (None, Some(group_key)) => thread_sources(connection, &channel, group_key)?,
        (None, None) => return Err(ApiError::invalid("originRef or groupKey is required")),
    };
    let incomplete = sources.len() > RECORD_SOURCES;
    sources.truncate(RECORD_SOURCES);
    Ok(SourceSet {
        record,
        sources: dedupe(sources),
        incomplete,
    })
}

/// Every version one note was published as, oldest first.
///
/// Re-publishing a note mints a new row with a new fingerprint, so the identity —
/// not the row — is what a preview must count.
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
    let mut statement = connection
        .prepare(
            "SELECT id, kind, state, version, title, origin_ref, size FROM sources
              WHERE origin_ref = ?1 AND kind IN (SELECT value FROM json_each(?2))
              ORDER BY read_at ASC, created_at ASC, rowid ASC LIMIT ?3",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map(
            params![origin_ref, kinds, RECORD_SOURCES as i64 + 1],
            |row| map_found(row, channel),
        )
        .map_err(sqlite_error)?
        .collect::<rusqlite::Result<Vec<FoundSource>>>()
        .map_err(sqlite_error)?;
    Ok(rows)
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
    // A conversation owns its own turns and every material it read, and a material
    // can be owned by several conversations. `source_records` carries that
    // relation; the queue join stays as the older, per-turn trace.
    let mut statement = connection
        .prepare(
            "SELECT s.id, s.kind, s.state, s.version, s.title, s.origin_ref, s.size
               FROM sources s
              WHERE s.id IN (
                SELECT i.source_id
                  FROM queue_items i JOIN queue_groups g ON g.id = i.group_id
                 WHERE g.channel = ?1 AND g.group_key = ?2
                UNION
                SELECT r.source_id FROM source_records r
                 WHERE r.channel = 'chat' AND r.record_ref = ?2)
              GROUP BY s.id
              ORDER BY s.read_at ASC, s.created_at ASC, rowid ASC
              LIMIT ?3",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map(
            params![channel, group_key, RECORD_SOURCES as i64 + 1],
            |row| map_found(row, channel),
        )
        .map_err(sqlite_error)?
        .collect::<rusqlite::Result<Vec<FoundSource>>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

/// The record a source-ownership question is about, when the identity names a
/// conversation. A note owns its versions by `originRef`, not through a relation.
pub(crate) fn owner_ref(record: &RecordRef) -> Option<String> {
    if record.channel == "chat" {
        record.group_key.clone()
    } else {
        None
    }
}

/// True when some other record also owns this source, so retiring it for one
/// record would take evidence away from the other.
pub(crate) fn other_owners(
    connection: &Connection,
    source_id: &str,
    record_ref: &str,
) -> ApiResult<bool> {
    let count: i64 = connection
        .query_row(
            "SELECT count(*) FROM source_records
              WHERE source_id = ?1 AND channel = 'chat' AND record_ref <> ?2",
            params![source_id, record_ref],
            |row| row.get(0),
        )
        .map_err(sqlite_error)?;
    Ok(count > 0)
}

/// Whether one record's claim on a source proves it can retire it.
///
/// A claim is proof when it was written for this record by the code that published
/// the row. A claim carried over from a database that only kept a group pointer is a
/// hint: it may protect the row from another record's delete, but it must never let
/// a delete take the row — or its cards — away. A record with no claim at all is the
/// older row-level form, and nothing contradicts retiring it.
pub(crate) fn exclusive(
    connection: &Connection,
    source_id: &str,
    record_ref: &str,
) -> ApiResult<bool> {
    let (claims, exclusive): (i64, i64) = connection
        .query_row(
            "SELECT count(*), coalesce(sum(exclusive), 0) FROM source_records
              WHERE source_id = ?1 AND channel = 'chat' AND record_ref = ?2",
            params![source_id, record_ref],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(sqlite_error)?;
    Ok(claims == 0 || exclusive > 0)
}

/// Gives up one record's claim on a source. The source itself stays exactly as it
/// was: its state, its cards, and every other claim on it.
pub(crate) fn detach(connection: &Connection, source_id: &str, record_ref: &str) -> ApiResult<()> {
    connection
        .execute(
            "DELETE FROM source_records
              WHERE source_id = ?1 AND channel = 'chat' AND record_ref = ?2",
            params![source_id, record_ref],
        )
        .map_err(sqlite_error)?;
    Ok(())
}

/// Drops every claim on a source that is being retired anyway.
pub(crate) fn detach_all(connection: &Connection, source_id: &str) -> ApiResult<()> {
    connection
        .execute(
            "DELETE FROM source_records WHERE source_id = ?1",
            params![source_id],
        )
        .map_err(sqlite_error)?;
    Ok(())
}

/// The records that still claim one source, in the order they first claimed it.
pub(crate) fn owners(connection: &Connection, source_id: &str) -> ApiResult<Vec<String>> {
    let mut statement = connection
        .prepare(
            "SELECT record_ref FROM source_records
              WHERE source_id = ?1 AND channel = 'chat'
              ORDER BY created_at ASC, record_ref ASC",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([source_id], |row| row.get::<_, String>(0))
        .map_err(sqlite_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

/// One row per source id, first occurrence wins.
fn dedupe(rows: Vec<FoundSource>) -> Vec<FoundSource> {
    let mut seen = BTreeSet::new();
    rows.into_iter()
        .filter(|row| seen.insert(row.id.clone()))
        .collect()
}

/// The collect channel a source kind belongs to, for callers that name one row and
/// never a channel.
pub(crate) fn channel_of(kind: &str) -> &str {
    match kind {
        "note" => "note",
        "chat" => "chat",
        _ => "reading",
    }
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
