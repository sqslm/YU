//! The pending-extraction queue: sources grouped per note, conversation or
//! reading, held still for a settling window before they become eligible.
//!
//! Phase 2 only *collects*. A `ready` task waits for stage 3 to consume it; no
//! row here is ever marked extracted, because nothing extracts yet.

use rusqlite::{Connection, OptionalExtension, Row, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::protocol::{
    ApiError, ApiResult, Code, DEFAULT_PAGE, MAX_GROUP_CHARS, MAX_PAGE, fit_page,
};
use crate::util::{check_chars, ensure_not_cancelled, new_id, now_ms, require_text, sha256_hex};

pub const CHANNELS: [&str; 3] = ["note", "chat", "reading"];
pub const STATES: [&str; 5] = [
    "stabilizing",
    "ready",
    "needs_reread",
    "failed",
    "cancelled",
];

/// How long a group must stay unchanged before it counts as eligible.
pub const DEFAULT_WINDOW_MS: i64 = 60_000;

pub fn window_ms() -> i64 {
    std::env::var("YU_KNOWLEDGE_STABLE_MS")
        .ok()
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .filter(|value| *value >= 0)
        .unwrap_or(DEFAULT_WINDOW_MS)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishParams {
    pub channel: String,
    pub kind: String,
    pub origin_ref: String,
    pub group_key: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub locator: Option<String>,
    #[serde(default)]
    pub read_at: Option<i64>,
    pub text: String,
    /// When the user produced the content, in milliseconds since the epoch.
    pub at: i64,
    /// The conversation or note this content belongs to, so deleting it can
    /// cancel every task that quoted it, including reading tasks.
    #[serde(default)]
    pub thread_key: Option<String>,
    /// Position inside the group. Reading publishes several materials at once.
    #[serde(default)]
    pub ordinal: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishResult {
    pub source_id: String,
    pub version: String,
    pub fingerprint: String,
    pub group_id: String,
    pub state: String,
    /// True when this publish changed nothing: same text, or an older event.
    pub duplicate: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueItem {
    pub source_id: String,
    pub ordinal: i64,
    pub kind: String,
    pub origin_ref: String,
    pub title: String,
    pub locator: String,
    pub scope: String,
    pub size: i64,
    pub read_at: i64,
    /// `active` or `invalid`: a caller must not treat an invalid source as text
    /// it can still read.
    pub state: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueTask {
    pub id: String,
    pub channel: String,
    pub group_key: String,
    pub title: String,
    pub scope: String,
    /// The state a caller should act on: a settled `stabilizing` row is `ready`.
    pub state: String,
    pub stable_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub attempts: i64,
    pub items: Vec<QueueItem>,
    pub items_total: i64,
    pub items_offset: u32,
    pub items_has_more: bool,
    pub items_next_offset: Option<u32>,
    pub updated_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuePage {
    pub items: Vec<QueueTask>,
    pub total: i64,
    pub offset: u32,
    pub limit: u32,
    pub has_more: bool,
    pub next_offset: Option<u32>,
    pub paused: bool,
    pub channels: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueStatus {
    pub counts: Value,
    pub total: i64,
    pub paused: bool,
    pub paused_reasons: Value,
    pub channels: Value,
    pub window_ms: i64,
}

/// One task can hold a long conversation: its items are paged like everything
/// else, so a 201st turn stays reachable instead of vanishing behind a LIMIT.
pub const ITEM_PAGE: u32 = 32;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemsParams {
    pub group_id: String,
    #[serde(default)]
    pub offset: u32,
    #[serde(default)]
    pub limit: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListParams {
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub offset: u32,
    #[serde(default)]
    pub limit: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupParams {
    #[serde(default)]
    pub group_id: Option<String>,
    /// A caller that knows the channel and the group key need not track the id.
    #[serde(default)]
    pub channel: Option<String>,
    #[serde(default)]
    pub group_key: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

/// The id a caller meant: either the minted one or the (channel, key) pair.
fn group_id(conn: &Connection, params: &GroupParams) -> ApiResult<String> {
    if let Some(id) = params.group_id.as_ref() {
        return Ok(id.clone());
    }
    let (channel, key) = match (params.channel.as_ref(), params.group_key.as_ref()) {
        (Some(channel), Some(key)) => (channel, key),
        _ => {
            return Err(ApiError::invalid(
                "groupId, or both channel and groupKey, are required",
            ));
        }
    };
    conn.query_row(
        "SELECT id FROM queue_groups WHERE channel = ?1 AND group_key = ?2",
        params![channel, key],
        |row| row.get::<_, String>(0),
    )
    .map_err(|_| ApiError::not_found("queue group not found"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PauseParams {
    /// `manual` survives leaving game mode; `game` is cleared when it ends.
    pub reason: String,
    pub paused: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureParams {
    /// The master switch. When it is off nothing is accepted, whatever the
    /// per-channel flags say.
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub notes: Option<bool>,
    #[serde(default)]
    pub chat: Option<bool>,
    #[serde(default)]
    pub reading: Option<bool>,
    #[serde(default)]
    pub paused: Option<ConfigurePause>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurePause {
    #[serde(default)]
    pub manual: Option<bool>,
    #[serde(default)]
    pub game: Option<bool>,
}

// ------------------------------------------------------------------ control

fn control(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM queue_control WHERE key = ?1",
        [key],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
}

fn set_control(conn: &Connection, key: &str, value: &str) -> ApiResult<()> {
    conn.execute(
        "INSERT INTO queue_control (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, value, now_ms()],
    )
    .map_err(|error| ApiError::storage(format!("cannot record {key}: {error}")))?;
    Ok(())
}

fn flag(conn: &Connection, key: &str, fallback: bool) -> bool {
    match control(conn, key) {
        Some(value) => value == "1",
        None => fallback,
    }
}

/// The master switch, off until the user turns collection on.
pub fn enabled(conn: &Connection) -> bool {
    flag(conn, "enabled", false)
}

pub fn channel_enabled(conn: &Connection, channel: &str) -> bool {
    enabled(conn) && flag(conn, &format!("channel_{channel}"), true)
}

pub fn paused(conn: &Connection) -> bool {
    flag(conn, "paused_manual", false) || flag(conn, "paused_game", false)
}

pub fn channels_json(conn: &Connection) -> Value {
    json!({
        "enabled": enabled(conn),
        "note": channel_enabled(conn, "note"),
        "chat": channel_enabled(conn, "chat"),
        "reading": channel_enabled(conn, "reading"),
        "pausedManual": flag(conn, "paused_manual", false),
        "pausedGame": flag(conn, "paused_game", false),
    })
}

pub fn configure(conn: &mut Connection, params: ConfigureParams) -> ApiResult<Value> {
    let transaction = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| ApiError::storage(format!("cannot start the configure: {error}")))?;
    if let Some(value) = params.enabled {
        set_control(&transaction, "enabled", if value { "1" } else { "0" })?;
    }
    for (name, value) in [
        ("notes", params.notes),
        ("chat", params.chat),
        ("reading", params.reading),
    ] {
        if let Some(value) = value {
            let channel = match name {
                "notes" => "note",
                other => other,
            };
            set_control(
                &transaction,
                &format!("channel_{channel}"),
                if value { "1" } else { "0" },
            )?;
        }
    }
    if let Some(pause) = params.paused {
        if let Some(value) = pause.manual {
            set_control(&transaction, "paused_manual", if value { "1" } else { "0" })?;
        }
        if let Some(value) = pause.game {
            set_control(&transaction, "paused_game", if value { "1" } else { "0" })?;
        }
    }
    ensure_not_cancelled()?;
    transaction
        .commit()
        .map_err(|error| ApiError::storage(format!("cannot commit the configure: {error}")))?;
    Ok(channels_json(conn))
}

pub fn pause(conn: &Connection, params: PauseParams) -> ApiResult<Value> {
    let key = match params.reason.as_str() {
        "manual" => "paused_manual",
        "game" => "paused_game",
        other => {
            return Err(ApiError::invalid(format!("unknown pause reason: {other}")));
        }
    };
    set_control(conn, key, if params.paused { "1" } else { "0" })?;
    Ok(channels_json(conn))
}

// ------------------------------------------------------------------- publish

fn exclusion(conn: &Connection, kind: &str, key: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM exclusions WHERE kind = ?1 AND key = ?2",
        params![kind, key],
        |_| Ok(()),
    )
    .optional()
    .ok()
    .flatten()
    .is_some()
}

fn top_source(conn: &Connection, group_id: &str) -> Option<(String, String, i64)> {
    conn.query_row(
        "SELECT s.id, s.fingerprint, s.read_at FROM queue_items i JOIN sources s ON s.id = i.source_id
         WHERE i.group_id = ?1 ORDER BY i.ordinal DESC LIMIT 1",
        [group_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .optional()
    .ok()
    .flatten()
}

pub fn publish(conn: &mut Connection, params: PublishParams) -> ApiResult<PublishResult> {
    let transaction = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| ApiError::storage(format!("cannot start the publish: {error}")))?;
    let result = publish_in(&transaction, params)?;
    ensure_not_cancelled()?;
    transaction
        .commit()
        .map_err(|error| ApiError::storage(format!("cannot commit the publish: {error}")))?;
    Ok(result)
}

/// The body of a publish, run inside a transaction the caller already owns so a
/// history batch can store sources and its checkpoint in one commit.
pub fn publish_in(conn: &Connection, params: PublishParams) -> ApiResult<PublishResult> {
    // Named for readability: the caller already opened the transaction.
    let transaction = conn;
    let channel = params.channel.trim();
    if !CHANNELS.contains(&channel) {
        return Err(ApiError::invalid(format!("unknown channel: {channel}")));
    }
    // Every entry point that can mint a source goes through the same limits, so a
    // new publish path cannot accept a body the storage path would refuse.
    crate::sources::validate(crate::sources::Fields {
        kind: &params.kind,
        origin_ref: &params.origin_ref,
        title: params.title.as_deref().unwrap_or_default(),
        locator: params.locator.as_deref().unwrap_or_default(),
        version: "",
        scope: params.scope.as_deref().unwrap_or_default(),
        text: &params.text,
    })?;
    let origin_ref = require_text("originRef", &params.origin_ref)?;
    let group_key = require_text("groupKey", &params.group_key)?;
    check_chars("groupKey", &group_key, MAX_GROUP_CHARS)?;
    if params.text.trim().is_empty() {
        return Err(ApiError::invalid("text is empty"));
    }
    if !channel_enabled(conn, channel) {
        return Err(ApiError::new(
            Code::ChannelDisabled,
            format!("the {channel} channel is switched off"),
        ));
    }
    if exclusion(conn, channel, &group_key) {
        return Err(ApiError::new(
            Code::Excluded,
            "this source is excluded from collection",
        ));
    }

    let fingerprint = sha256_hex(&params.text);
    let size = params.text.chars().count() as i64;
    let at = params.at.max(0);
    let read_at = params.read_at.unwrap_or(at);
    let title = params.title.clone().unwrap_or_default();
    let scope = params.scope.clone().unwrap_or_default();
    let locator = params.locator.clone().unwrap_or_default();

    // One source row per (kind, origin, content). Re-publishing the same text is
    // how a restarted host proves it can still project the body, so it must be a
    // no-op rather than a second task.
    let existing: Option<(String, bool)> = transaction
        .query_row(
            "SELECT id, size FROM sources WHERE kind = ?1 AND origin_ref = ?2 AND version = ?3",
            params![params.kind, origin_ref, fingerprint],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .ok()
        .flatten();
    let duplicate_source = existing.is_some();
    let source_id = match &existing {
        Some((id, _)) => {
            transaction
                .execute(
                    "UPDATE sources SET title = ?2, scope = ?3, locator = ?4, read_at = ?5, size = ?6,
                     state = 'active', invalid_reason = NULL, updated_at = ?7 WHERE id = ?1",
                    params![id, title, scope, locator, read_at, size, now_ms()],
                )
                .map_err(|error| ApiError::storage(format!("cannot refresh the source: {error}")))?;
            id.clone()
        }
        None => {
            let id = new_id("src");
            transaction
                .execute(
                    "INSERT INTO sources (id, kind, origin_ref, locator, title, version, scope, read_at,
                       fingerprint, size, state, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'active', ?11, ?11)",
                    params![
                        id,
                        params.kind,
                        origin_ref,
                        locator,
                        title,
                        fingerprint,
                        scope,
                        read_at,
                        fingerprint,
                        size,
                        now_ms()
                    ],
                )
                .map_err(|error| ApiError::storage(format!("cannot save the source: {error}")))?;
            id
        }
    };

    let stable_at = at.saturating_add(window_ms());
    let group: Option<(String, String, i64)> = transaction
        .query_row(
            "SELECT id, state, updated_at FROM queue_groups WHERE channel = ?1 AND group_key = ?2",
            params![channel, group_key],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .ok()
        .flatten();

    let (group_id, state, duplicate) = match group {
        None => {
            let id = new_id("grp");
            transaction
                .execute(
                    "INSERT INTO queue_groups (id, channel, group_key, thread_key, title, scope, state,
                       stable_at, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'stabilizing', ?7, ?8, ?9)",
                    params![
                        id,
                        channel,
                        group_key,
                        params.thread_key,
                        title,
                        scope,
                        stable_at,
                        at,
                        at
                    ],
                )
                .map_err(|error| ApiError::storage(format!("cannot queue the group: {error}")))?;
            source_link(transaction, &id, 0, &source_id)?;
            (id, "stabilizing".to_string(), false)
        }
        Some((id, state, _updated_at)) => {
            let top = top_source(transaction, &id);
            let same = top
                .as_ref()
                .is_some_and(|(_, print, _)| print == &fingerprint);
            // Only an older event of the *same* source is stale. Two different
            // turns of one thread are independent records: a late or replayed one
            // must still be kept and ordered, never folded into the newer turn.
            let stale: bool = transaction
                .query_row(
                    "SELECT EXISTS (SELECT 1 FROM queue_items i JOIN sources s ON s.id = i.source_id
                       WHERE i.group_id = ?1 AND s.origin_ref = ?2 AND s.read_at > ?3)",
                    params![id, origin_ref, at],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap_or(0)
                == 1;
            // A newer event for a group whose body did not change only refreshes
            // metadata: it must neither extend the window nor create work.
            if same || stale || state == "cancelled" {
                (id, state, true)
            } else {
                if channel == "note" {
                    transaction
                        .execute("DELETE FROM queue_items WHERE group_id = ?1", [&id])
                        .map_err(|error| {
                            ApiError::storage(format!("cannot replace the queued item: {error}"))
                        })?;
                    source_link(transaction, &id, 0, &source_id)?;
                } else {
                    // Chat turns and reading materials each keep their own slot.
                    let ordinal = match params.ordinal {
                        Some(value) => value.max(0),
                        None => transaction
                            .query_row(
                                "SELECT COALESCE(max(ordinal), -1) + 1 FROM queue_items WHERE group_id = ?1",
                                [&id],
                                |row| row.get(0),
                            )
                            .unwrap_or(0),
                    };
                    source_link(transaction, &id, ordinal, &source_id)?;
                }
                transaction
                    .execute(
                        "UPDATE queue_groups SET state = 'stabilizing', stable_at = ?2, title = ?3,
                         scope = ?4, reason = NULL, error = NULL, updated_at = ?5,
                         thread_key = COALESCE(?6, thread_key) WHERE id = ?1",
                        params![id, stable_at, title, scope, at, params.thread_key],
                    )
                    .map_err(|error| {
                        ApiError::storage(format!("cannot settle the queue group: {error}"))
                    })?;
                (id, "stabilizing".to_string(), false)
            }
        }
    };

    Ok(PublishResult {
        source_id,
        version: fingerprint.clone(),
        fingerprint,
        group_id,
        state,
        duplicate: duplicate || duplicate_source,
    })
}

fn source_link(conn: &Connection, group_id: &str, ordinal: i64, source_id: &str) -> ApiResult<()> {
    conn.execute(
        "INSERT OR REPLACE INTO queue_items (group_id, ordinal, source_id, created_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![group_id, ordinal, source_id, now_ms()],
    )
    .map_err(|error| ApiError::storage(format!("cannot link the queued item: {error}")))?;
    Ok(())
}

// ------------------------------------------------------------------- listing

/// `stabilizing` rows whose window has elapsed read as `ready`, so a restart
/// needs no replayed timer and a caller never sees a settled task as pending.
const EFFECTIVE: &str =
    "CASE WHEN state = 'stabilizing' AND stable_at <= ?1 THEN 'ready' ELSE state END";

fn items_total(conn: &Connection, group_id: &str) -> i64 {
    conn.query_row(
        "SELECT count(*) FROM queue_items WHERE group_id = ?1",
        [group_id],
        |row| row.get(0),
    )
    .unwrap_or(0)
}

fn items_of(
    conn: &Connection,
    group_id: &str,
    offset: u32,
    limit: u32,
) -> ApiResult<Vec<QueueItem>> {
    let mut statement = conn
        .prepare(
            "SELECT s.id, i.ordinal, s.kind, s.origin_ref, s.title, s.locator, s.scope, s.size,
                    s.read_at, s.state
             FROM queue_items i JOIN sources s ON s.id = i.source_id
             WHERE i.group_id = ?1 ORDER BY i.ordinal LIMIT ?2 OFFSET ?3",
        )
        .map_err(|error| ApiError::storage(format!("cannot read the queue items: {error}")))?;
    let rows = statement
        .query_map(params![group_id, limit, offset], |row| {
            Ok(QueueItem {
                source_id: row.get(0)?,
                ordinal: row.get(1)?,
                kind: row.get(2)?,
                origin_ref: row.get(3)?,
                title: row.get(4)?,
                locator: row.get(5)?,
                scope: row.get(6)?,
                size: row.get(7)?,
                read_at: row.get(8)?,
                state: row.get(9)?,
            })
        })
        .map_err(|error| ApiError::storage(format!("cannot read the queue items: {error}")))?;
    Ok(rows.filter_map(Result::ok).collect())
}

/// One page of a task's own items. A long thread keeps every turn reachable,
/// and the caller is told exactly where to continue.
pub fn items(conn: &Connection, params: ItemsParams) -> ApiResult<Value> {
    check_chars("groupId", &params.group_id, 128)?;
    let total = items_total(conn, &params.group_id);
    let limit = if params.limit == 0 {
        ITEM_PAGE
    } else {
        params.limit.min(MAX_PAGE)
    };
    let rows = items_of(conn, &params.group_id, params.offset, limit)?;
    let (kept, has_more, next_offset) = fit_page(rows, total, params.offset);
    Ok(json!({
        "items": kept,
        "total": total,
        "offset": params.offset,
        "limit": limit,
        "hasMore": has_more,
        "nextOffset": next_offset,
    }))
}

fn task_row(conn: &Connection, row: &Row<'_>, now: i64) -> rusqlite::Result<QueueTask> {
    let id: String = row.get(0)?;
    let stored: String = row.get(5)?;
    let stable_at: i64 = row.get(6)?;
    let state = if stored == "stabilizing" && stable_at <= now {
        "ready".to_string()
    } else {
        stored
    };
    let total = items_total(conn, &id);
    let rows = items_of(conn, &id, 0, ITEM_PAGE).unwrap_or_default();
    let (items, has_more, next_offset) = fit_page(rows, total, 0);
    Ok(QueueTask {
        id,
        channel: row.get(1)?,
        group_key: row.get(2)?,
        title: row.get(3)?,
        scope: row.get(4)?,
        state,
        stable_at,
        reason: row.get(7)?,
        error: row.get(8)?,
        attempts: row.get(9)?,
        items,
        items_total: total,
        items_offset: 0,
        items_has_more: has_more,
        items_next_offset: next_offset,
        updated_at: row.get(10)?,
    })
}

pub fn list(conn: &Connection, params: ListParams) -> ApiResult<QueuePage> {
    let now = now_ms();
    let offset = params.offset;
    let limit = if params.limit == 0 {
        DEFAULT_PAGE
    } else {
        params.limit.min(MAX_PAGE)
    };
    let wanted = params
        .state
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(state) = wanted
        && !STATES.contains(&state)
    {
        return Err(ApiError::invalid(format!("unknown queue state: {state}")));
    }
    let (total, tasks) = match wanted {
        Some(state) => {
            let total: i64 = conn
                .query_row(
                    &format!("SELECT count(*) FROM queue_groups WHERE {EFFECTIVE} = ?2"),
                    params![now, state],
                    |row| row.get(0),
                )
                .map_err(|error| ApiError::storage(format!("cannot count the queue: {error}")))?;
            let sql = format!(
                "SELECT id, channel, group_key, title, scope, state, stable_at, reason, error, attempts, updated_at
                 FROM queue_groups WHERE {EFFECTIVE} = ?2
                 ORDER BY updated_at DESC LIMIT ?3 OFFSET ?4",
            );
            let mut statement = conn
                .prepare(&sql)
                .map_err(|error| ApiError::storage(format!("cannot read the queue: {error}")))?;
            let rows = statement
                .query_map(params![now, state, limit as i64, offset as i64], |row| {
                    task_row(conn, row, now)
                })
                .map_err(|error| ApiError::storage(format!("cannot read the queue: {error}")))?;
            (total, rows.filter_map(Result::ok).collect::<Vec<_>>())
        }
        None => {
            let total: i64 = conn
                .query_row("SELECT count(*) FROM queue_groups", [], |row| row.get(0))
                .map_err(|error| ApiError::storage(format!("cannot count the queue: {error}")))?;
            let sql = format!(
                "SELECT id, channel, group_key, title, scope, state, stable_at, reason, error, attempts, updated_at
                 FROM queue_groups
                 ORDER BY CASE WHEN {EFFECTIVE} = 'ready' THEN 0 ELSE 1 END, updated_at DESC
                 LIMIT ?2 OFFSET ?3",
            );
            let mut statement = conn
                .prepare(&sql)
                .map_err(|error| ApiError::storage(format!("cannot read the queue: {error}")))?;
            let rows = statement
                .query_map(params![now, limit as i64, offset as i64], |row| {
                    task_row(conn, row, now)
                })
                .map_err(|error| ApiError::storage(format!("cannot read the queue: {error}")))?;
            (total, rows.filter_map(Result::ok).collect::<Vec<_>>())
        }
    };
    // One outbound page obeys the same serialized budget the card listing uses and
    // reports where the next call resumes, so a caller never skips a task.
    let (kept, has_more, next_offset) = fit_page(tasks, total, offset);
    Ok(QueuePage {
        items: kept,
        total,
        offset,
        limit,
        has_more,
        next_offset,
        paused: paused(conn),
        channels: channels_json(conn),
    })
}

pub fn status(conn: &Connection) -> ApiResult<QueueStatus> {
    let now = now_ms();
    let mut counts = serde_json::Map::new();
    for state in STATES {
        let count: i64 = conn
            .query_row(
                &format!("SELECT count(*) FROM queue_groups WHERE {EFFECTIVE} = ?2"),
                params![now, state],
                |row| row.get(0),
            )
            .unwrap_or(0);
        counts.insert(state.to_string(), json!(count));
    }
    let total: i64 = conn
        .query_row("SELECT count(*) FROM queue_groups", [], |row| row.get(0))
        .unwrap_or(0);
    Ok(QueueStatus {
        counts: Value::Object(counts),
        total,
        paused: paused(conn),
        paused_reasons: json!({
            "manual": flag(conn, "paused_manual", false),
            "game": flag(conn, "paused_game", false),
        }),
        channels: channels_json(conn),
        window_ms: window_ms(),
    })
}

// -------------------------------------------------------------------- mutate

fn set_state(
    conn: &Connection,
    id: &str,
    state: &str,
    reason: Option<&str>,
    error: Option<&str>,
) -> ApiResult<()> {
    let changed = conn
        .execute(
            "UPDATE queue_groups SET state = ?2, reason = ?3, error = ?4, updated_at = ?5 WHERE id = ?1",
            params![id, state, reason, error, now_ms()],
        )
        .map_err(|err| ApiError::storage(format!("cannot update the queue group: {err}")))?;
    if changed == 0 {
        return Err(ApiError::not_found("queue group not found"));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadParams {
    pub thread_key: String,
    #[serde(default)]
    pub reason: Option<String>,
}

/// Cancels every task that quoted a conversation: its chat turns and the reading
/// tasks it produced. A deleted or made-temporary thread must not leave work
/// behind just because reading tasks live under their material identity.
pub fn invalidate_thread(conn: &mut Connection, params: ThreadParams) -> ApiResult<Value> {
    let thread_key = require_text("threadKey", &params.thread_key)?;
    check_chars("threadKey", &thread_key, MAX_GROUP_CHARS)?;
    let reason = params
        .reason
        .clone()
        .unwrap_or_else(|| "deleted".to_string());
    check_chars("reason", &reason, 500)?;
    let transaction = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| ApiError::storage(format!("cannot start the invalidate: {error}")))?;
    let groups: Vec<String> = {
        let mut statement = transaction
            .prepare("SELECT id FROM queue_groups WHERE thread_key = ?1 AND state <> 'cancelled'")
            .map_err(|error| ApiError::storage(format!("cannot read the threads: {error}")))?;
        let rows = statement
            .query_map([&thread_key], |row| row.get::<_, String>(0))
            .map_err(|error| ApiError::storage(format!("cannot read the threads: {error}")))?;
        rows.filter_map(Result::ok).collect()
    };
    for id in &groups {
        transaction
            .execute(
                "UPDATE sources SET state = 'invalid', invalid_reason = ?2, updated_at = ?3
                 WHERE id IN (SELECT source_id FROM queue_items WHERE group_id = ?1)",
                params![id, reason, now_ms()],
            )
            .map_err(|error| {
                ApiError::storage(format!("cannot invalidate the sources: {error}"))
            })?;
        set_state(&transaction, id, "cancelled", Some(&reason), None)?;
    }
    ensure_not_cancelled()?;
    transaction
        .commit()
        .map_err(|error| ApiError::storage(format!("cannot commit the invalidate: {error}")))?;
    Ok(json!({ "threadKey": thread_key, "cancelled": groups, "reason": reason }))
}

pub fn cancel(conn: &Connection, params: GroupParams) -> ApiResult<Value> {
    let id = group_id(conn, &params)?;
    set_state(
        conn,
        &id,
        "cancelled",
        params.reason.as_deref().or(Some("cancelled")),
        None,
    )?;
    Ok(json!({ "groupId": id, "state": "cancelled" }))
}

pub fn retry(conn: &Connection, params: GroupParams) -> ApiResult<Value> {
    let id = group_id(conn, &params)?;
    let now = now_ms();
    let changed = conn
        .execute(
            "UPDATE queue_groups SET state = 'stabilizing', stable_at = ?2, reason = NULL, error = NULL,
             attempts = attempts + 1, updated_at = ?3 WHERE id = ?1 AND state IN ('failed','needs_reread')",
            params![id, now.saturating_add(window_ms()), now],
        )
        .map_err(|error| ApiError::storage(format!("cannot retry the queue group: {error}")))?;
    if changed == 0 {
        return Err(ApiError::invalid(
            "only a failed or unreadable task can be retried",
        ));
    }
    Ok(json!({ "groupId": id, "state": "stabilizing" }))
}

pub fn needs_reread(conn: &Connection, params: GroupParams) -> ApiResult<Value> {
    let id = group_id(conn, &params)?;
    set_state(
        conn,
        &id,
        "needs_reread",
        Some(params.reason.as_deref().unwrap_or("body unavailable")),
        None,
    )?;
    Ok(json!({ "groupId": id, "state": "needs_reread" }))
}

/// A deleted note or thread invalidates its sources and drops the pending work,
/// exactly like the phase-1 exclusion of a card's source.
pub fn invalidate(conn: &mut Connection, params: GroupParams) -> ApiResult<Value> {
    let id = group_id(conn, &params)?;
    let transaction = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| ApiError::storage(format!("cannot start the invalidate: {error}")))?;
    let reason = params
        .reason
        .clone()
        .unwrap_or_else(|| "deleted".to_string());
    transaction
        .execute(
            "UPDATE sources SET state = 'invalid', invalid_reason = ?2, updated_at = ?3
             WHERE id IN (SELECT source_id FROM queue_items WHERE group_id = ?1)",
            params![id, reason, now_ms()],
        )
        .map_err(|error| ApiError::storage(format!("cannot invalidate the sources: {error}")))?;
    set_state(&transaction, &id, "cancelled", Some(&reason), None)?;
    ensure_not_cancelled()?;
    transaction
        .commit()
        .map_err(|error| ApiError::storage(format!("cannot commit the invalidate: {error}")))?;
    Ok(json!({ "groupId": id, "state": "cancelled", "reason": reason }))
}

// ----------------------------------------------------------------- exclusion

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExcludeParams {
    pub kind: String,
    pub key: String,
    #[serde(default)]
    pub reason: Option<String>,
}

pub fn exclude_add(conn: &mut Connection, params: ExcludeParams) -> ApiResult<Value> {
    if !CHANNELS.contains(&params.kind.as_str()) {
        return Err(ApiError::invalid(format!(
            "unknown channel: {}",
            params.kind
        )));
    }
    let key = require_text("key", &params.key)?;
    check_chars("key", &key, MAX_GROUP_CHARS)?;
    let transaction = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| ApiError::storage(format!("cannot start the exclusion: {error}")))?;
    transaction
        .execute(
            "INSERT INTO exclusions (kind, key, reason, created_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(kind, key) DO UPDATE SET reason = excluded.reason",
            params![
                params.kind,
                key,
                params.reason.unwrap_or_default(),
                now_ms()
            ],
        )
        .map_err(|error| ApiError::storage(format!("cannot record the exclusion: {error}")))?;
    // An exclusion covers every version of the source, so pending work stops now.
    transaction
        .execute(
            "UPDATE queue_groups SET state = 'cancelled', reason = 'excluded', updated_at = ?3
             WHERE channel = ?1 AND group_key = ?2",
            params![params.kind, key, now_ms()],
        )
        .map_err(|error| ApiError::storage(format!("cannot cancel the excluded group: {error}")))?;
    ensure_not_cancelled()?;
    transaction
        .commit()
        .map_err(|error| ApiError::storage(format!("cannot commit the exclusion: {error}")))?;
    Ok(json!({ "kind": params.kind, "key": key, "excluded": true }))
}

pub fn exclude_remove(conn: &Connection, params: ExcludeParams) -> ApiResult<Value> {
    conn.execute(
        "DELETE FROM exclusions WHERE kind = ?1 AND key = ?2",
        params![params.kind, params.key],
    )
    .map_err(|error| ApiError::storage(format!("cannot remove the exclusion: {error}")))?;
    Ok(json!({ "kind": params.kind, "key": params.key, "excluded": false }))
}

pub fn exclude_list(conn: &Connection) -> ApiResult<Value> {
    let mut statement = conn
        .prepare("SELECT kind, key, reason, created_at FROM exclusions ORDER BY created_at DESC")
        .map_err(|error| ApiError::storage(format!("cannot read the exclusions: {error}")))?;
    let rows = statement
        .query_map([], |row| {
            Ok(json!({
                "kind": row.get::<_, String>(0)?,
                "key": row.get::<_, String>(1)?,
                "reason": row.get::<_, String>(2)?,
                "createdAt": row.get::<_, i64>(3)?,
            }))
        })
        .map_err(|error| ApiError::storage(format!("cannot read the exclusions: {error}")))?;
    Ok(Value::Array(rows.filter_map(Result::ok).collect()))
}
