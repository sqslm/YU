//! The background profile loop.
//!
//! Everything the profile knows without the user typing it lives here: the
//! independent switch and pauses, the in-app usage counters, the bounded queue of
//! the user's own sentences, the learning transaction and the readable context.
//! The host only hands over facts that really happened and forwards one model
//! call; every decision — what qualifies as evidence, when a batch is due, what
//! may be written and what the context says — belongs to this module.

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::protocol::{ApiError, ApiResult, Code, MAX_BODY_CHARS};
use crate::store::Store;
use crate::util::{check_chars, ensure_not_cancelled, new_id, now_ms, require_text, sha256_hex};

/// Features the app can report. Only these four exist in stage 4.
pub const FEATURES: [&str; 4] = ["chat", "ask", "note", "card-edit"];
/// Dimensions the learner may write. A free-form dimension would let a model
/// invent taxonomy the pages cannot render.
pub const DIMENSIONS: [&str; 6] = [
    "background",
    "goal",
    "expression",
    "depth",
    "project",
    "focus",
];

/// How long freshly queued evidence waits before a batch may take it. Merging a
/// conversation into one batch is what keeps the model bill proportional to the
/// conversation, not to the sentence.
pub const DEFAULT_LEARN_MS: i64 = 30_000;
/// Recent observations older than this stop feeding the context on their own.
pub const RECENT_DAYS: i64 = 30;
pub const MAX_BATCH_CHARS: usize = 12_000;
pub const SEGMENT_CHARS: usize = 12_000;
pub const SEGMENT_OVERLAP: usize = 500;
pub const MAX_CANDIDATES: usize = 8;
pub const MAX_CANDIDATE_CHARS: usize = 4_000;
/// Removed preferences are short and few: they exist only to block a re-wording.
const MAX_FAILED: usize = 20;
const MAX_REMOVED: usize = 20;
const MAX_REMOVED_CHARS: usize = 400;
pub const MAX_UPDATES: usize = 6;
pub const MAX_TOKENS: u32 = 4_096;
pub const MAX_QUOTE_CHARS: usize = 500;
pub const CONTEXT_CHARS: usize = 2_000;
pub const MAX_PENDING_ROWS: i64 = 200;
pub const MAX_PENDING_CHARS: usize = 240_000;

const SYSTEM_PROMPT: &str = "你是用户画像归纳器。只输出一个 JSON 对象，形如 \
{\"items\":[{\"slot\":\"已有条目的 slot 或空字符串\",\"dimension\":\"background|goal|expression|depth|project|focus\",\
\"value\":\"一句话，不超过 200 字\",\"category\":\"explicit|observed|inferred\",\"evidence\":[{\"quote\":\"用户原话片段\"}]}]}。\
规则：1) 只归纳用户本人明确说出的背景、目标、表达偏好、讲解深度偏好、当前项目或近期关注；\
2) 提问者转述他人、假设、角色扮演、引用资料或助手自己的话都不是用户事实；\
3) 材料作者的说法、网页/文档正文、工具输出不是用户事实；\
4) category：用户直接陈述用 explicit，从多次使用方式观察到的用 observed，推断用 inferred；\
5) 近期关注只写 focus，且只写弱关注，不要升级为职业、能力、人格或健康判断；\
6) 需要更新已有条目时把该条目的 slot 原样写回，不要另造同义条目；7) 每条 evidence 的 quote 必须是输入里逐字出现的片段，不超过 200 字；\
8) 没有可归纳内容时输出 {\"items\":[]}；9) 最多 6 条。";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureParams {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub usage: Option<bool>,
    #[serde(default)]
    pub chat: Option<bool>,
    #[serde(default)]
    pub paused_manual: Option<bool>,
    #[serde(default)]
    pub paused_game: Option<bool>,
}

#[derive(Deserialize)]
pub struct PauseParams {
    pub reason: String,
    pub paused: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventParams {
    pub op_id: String,
    pub feature: String,
    #[serde(default)]
    pub at: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceInput {
    pub source_kind: String,
    pub source_id: String,
    pub version: String,
    #[serde(default)]
    pub origin_ref: String,
    #[serde(default)]
    pub locator: String,
    #[serde(default)]
    pub at: Option<i64>,
    pub text: String,
}

#[derive(Deserialize)]
pub struct EvidenceParams {
    pub items: Vec<EvidenceInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetractParams {
    pub source_kind: String,
    pub source_id: String,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunParams {
    pub claim: String,
    #[serde(default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailParams {
    pub claim: String,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

fn sqlite(error: rusqlite::Error) -> ApiError {
    ApiError::storage(format!("profile statement failed: {error}"))
}

fn flag(connection: &Connection, key: &str) -> ApiResult<bool> {
    let value: Option<String> = connection
        .query_row(
            "SELECT value FROM profile_control WHERE key = ?1",
            [key],
            |row| row.get(0),
        )
        .optional()
        .map_err(sqlite)?;
    Ok(value.as_deref() == Some("1"))
}

fn set_flag(connection: &Connection, key: &str, value: bool) -> ApiResult<()> {
    connection
        .execute(
            "INSERT INTO profile_control (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, if value { "1" } else { "0" }, now_ms()],
        )
        .map_err(sqlite)?;
    Ok(())
}

fn epoch(connection: &Connection) -> ApiResult<i64> {
    let value: Option<String> = connection
        .query_row(
            "SELECT value FROM profile_control WHERE key = 'epoch'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(sqlite)?;
    Ok(value.and_then(|text| text.parse().ok()).unwrap_or(0))
}

/// Switches as one object, so a caller never has to read four keys.
pub fn control(connection: &Connection) -> ApiResult<Value> {
    Ok(json!({
        "enabled": flag(connection, "enabled")?,
        "usage": flag(connection, "usage")?,
        "chat": flag(connection, "chat")?,
        "pausedManual": flag(connection, "paused_manual")?,
        "pausedGame": flag(connection, "paused_game")?,
        "epoch": epoch(connection)?,
    }))
}

/// Clears the game pause whenever the game ends, without touching a manual one.
pub fn configure(connection: &mut Connection, params: ConfigureParams) -> ApiResult<Value> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite)?;
    if let Some(enabled) = params.enabled {
        set_flag(&transaction, "enabled", enabled)?;
    }
    if let Some(usage) = params.usage {
        set_flag(&transaction, "usage", usage)?;
    }
    if let Some(chat) = params.chat {
        set_flag(&transaction, "chat", chat)?;
    }
    if let Some(paused) = params.paused_manual {
        set_flag(&transaction, "paused_manual", paused)?;
    }
    if let Some(paused) = params.paused_game {
        set_flag(&transaction, "paused_game", paused)?;
    }
    // Whatever stops the loop releases the batch it was holding, inside this same
    // transaction. A caller may re-enable the moment this returns, and the wake that
    // follows must already see those rows as pending instead of `working` until the
    // cancelled run gets around to releasing them.
    if !flag(&transaction, "enabled")?
        || !flag(&transaction, "chat")?
        || flag(&transaction, "paused_manual")?
        || flag(&transaction, "paused_game")?
    {
        transaction
            .execute(
                "UPDATE profile_pending SET state = 'pending', claim = NULL, reason = '',
                 updated_at = ?1 WHERE state = 'working'",
                params![now_ms()],
            )
            .map_err(sqlite)?;
    }
    ensure_not_cancelled()?;
    transaction.commit().map_err(sqlite)?;
    control(connection)
}

pub fn pause(connection: &mut Connection, params: PauseParams) -> ApiResult<Value> {
    let key = match params.reason.as_str() {
        "manual" => "paused_manual",
        "game" => "paused_game",
        other => return Err(ApiError::invalid(format!("unknown pause reason: {other}"))),
    };
    configure(
        connection,
        ConfigureParams {
            enabled: None,
            usage: None,
            chat: None,
            paused_manual: if key == "paused_manual" {
                Some(params.paused)
            } else {
                None
            },
            paused_game: if key == "paused_game" {
                Some(params.paused)
            } else {
                None
            },
        },
    )
}

/// The state the pages and the host need, without any text.
pub fn status(connection: &Connection) -> ApiResult<Value> {
    let pending: i64 = connection
        .query_row(
            "SELECT count(*) FROM profile_pending WHERE state = 'pending'",
            [],
            |row| row.get(0),
        )
        .map_err(sqlite)?;
    let items: i64 = connection
        .query_row("SELECT count(*) FROM profile_items", [], |row| row.get(0))
        .map_err(sqlite)?;
    let usage: i64 = connection
        .query_row(
            "SELECT coalesce(sum(count), 0) FROM profile_usage",
            [],
            |row| row.get(0),
        )
        .map_err(sqlite)?;
    // A small, bounded window onto what is stuck, so a caller can offer a retry
    // without reading the queue itself.
    let mut statement = connection
        .prepare(
            "SELECT id, reason, length(text), at FROM profile_pending
             WHERE state = 'failed' ORDER BY updated_at DESC LIMIT ?1",
        )
        .map_err(sqlite)?;
    let failed_items = statement
        .query_map(params![MAX_FAILED as i64], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "reason": row.get::<_, String>(1)?,
                "chars": row.get::<_, i64>(2)?,
                "at": row.get::<_, i64>(3)?,
            }))
        })
        .map_err(sqlite)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(sqlite)?;
    drop(statement);
    let failed: i64 = connection
        .query_row(
            "SELECT count(*) FROM profile_pending WHERE state = 'failed'",
            [],
            |row| row.get(0),
        )
        .map_err(sqlite)?;
    let mut control = control(connection)?;
    let next_due = next_due_at(connection)?;
    control["pending"] = json!(pending);
    control["items"] = json!(items);
    control["usageTotal"] = json!(usage);
    control["failed"] = json!(failed);
    control["failedItems"] = json!(failed_items);
    control["nextDueAt"] = json!(next_due);
    Ok(control)
}

fn window_ms() -> i64 {
    match std::env::var("YU_PROFILE_LEARN_MS") {
        Ok(text) => text.trim().parse().unwrap_or(DEFAULT_LEARN_MS).max(0),
        Err(_) => DEFAULT_LEARN_MS,
    }
}

fn next_due_at(connection: &Connection) -> ApiResult<Option<i64>> {
    if !flag(connection, "enabled")?
        || flag(connection, "paused_manual")?
        || flag(connection, "paused_game")?
    {
        return Ok(None);
    }
    let oldest: Option<i64> = connection
        .query_row(
            "SELECT min(at) FROM profile_pending WHERE state = 'pending'",
            [],
            |row| row.get(0),
        )
        .map_err(sqlite)?;
    Ok(oldest.map(|at| at + window_ms()))
}

fn day_of(at: i64) -> i64 {
    at.div_euclid(86_400_000)
}

/// Counts one real, completed action. Repeat deliveries of the same operation id
/// are ignored, so a retried callback never inflates the numbers.
pub fn record_event(connection: &mut Connection, params: EventParams) -> ApiResult<Value> {
    require_text("opId", &params.op_id)?;
    check_chars("opId", &params.op_id, 200)?;
    if !FEATURES.contains(&params.feature.as_str()) {
        return Err(ApiError::invalid(format!(
            "unknown usage feature: {}",
            params.feature
        )));
    }
    let at = params.at.unwrap_or_else(now_ms);
    if !flag(connection, "enabled")? || !flag(connection, "usage")? {
        return Ok(json!({"counted": false, "reason": "usage is off"}));
    }
    // A manual or in-game pause stops the loop; counting while it is paused would
    // keep a number moving that the user asked to freeze.
    if flag(connection, "paused_manual")? || flag(connection, "paused_game")? {
        return Ok(json!({"counted": false, "reason": "profile learning is paused"}));
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite)?;
    // A clear is a barrier: an event observed before it, replayed verbatim after a
    // restart, must not come back as a fresh count. The operation id alone cannot
    // catch that replay because a clear deletes the operation log as well.
    if at <= cleared_at(&transaction)? {
        return Ok(json!({"counted": false, "reason": "an earlier clear covers this event"}));
    }
    let inserted = transaction
        .execute(
            "INSERT OR IGNORE INTO profile_usage_ops (op_id, feature, at) VALUES (?1, ?2, ?3)",
            params![params.op_id, params.feature, at],
        )
        .map_err(sqlite)?;
    if inserted == 0 {
        return Ok(json!({"counted": false, "reason": "already counted"}));
    }
    transaction
        .execute(
            "INSERT INTO profile_usage (day, feature, count, updated_at) VALUES (?1, ?2, 1, ?3)
             ON CONFLICT (day, feature) DO UPDATE SET count = count + 1, updated_at = excluded.updated_at",
            params![day_of(at), params.feature, at],
        )
        .map_err(sqlite)?;
    // Bounded bookkeeping: the operation ids only exist to deduplicate a window
    // that a retry could re-deliver.
    transaction
        .execute(
            "DELETE FROM profile_usage_ops WHERE at < ?1",
            params![at - RECENT_DAYS * 86_400_000],
        )
        .map_err(sqlite)?;
    ensure_not_cancelled()?;
    transaction.commit().map_err(sqlite)?;
    Ok(json!({"counted": true}))
}

/// Queues the user's own sentences for later learning. Long text is split by this
/// module, never by the caller, so nothing silently loses its tail.
pub fn enqueue(connection: &mut Connection, params: EvidenceParams) -> ApiResult<Value> {
    if !flag(connection, "enabled")? || !flag(connection, "chat")? {
        return Ok(json!({"queued": 0, "reason": "profile learning is off"}));
    }
    if flag(connection, "paused_manual")? || flag(connection, "paused_game")? {
        return Ok(json!({"queued": 0, "reason": "profile learning is paused"}));
    }
    let at = now_ms();
    let barrier = cleared_at(connection)?;
    let (active_rows, active_chars) = active_usage(connection)?;
    // Plan the call before writing anything. A later "capacity" check that only
    // deletes what it just inserted is exactly the silent loss this replaces.
    let mut planned: Vec<Planned> = Vec::new();
    let mut skipped = 0i64;
    let mut chars = 0i64;
    for item in params.items {
        check_chars("sourceKind", &item.source_kind, 40)?;
        check_chars("sourceId", &item.source_id, 200)?;
        check_chars("version", &item.version, 200)?;
        check_chars("originRef", &item.origin_ref, 400)?;
        check_chars("locator", &item.locator, 2_000)?;
        let text = item.text.trim();
        if text.is_empty() {
            skipped += 1;
            continue;
        }
        check_chars("text", text, MAX_BODY_CHARS)?;
        let observed = item.at.unwrap_or(at);
        // A segment the user already cleared, or one whose source was retracted,
        // must not come back just because the callback is delivered again.
        if observed <= barrier {
            skipped += 1;
            continue;
        }
        if source_invalid(connection, &item.source_kind, &item.source_id)? {
            skipped += 1;
            continue;
        }
        let segments = segments_of(text);
        for (index, segment) in segments.iter().enumerate() {
            let slot = index as i64;
            if marked(
                connection,
                &item.source_kind,
                &item.source_id,
                &item.version,
                slot,
            )? {
                skipped += 1;
                continue;
            }
            chars += segment.chars().count() as i64;
            planned.push(Planned {
                source_kind: item.source_kind.clone(),
                source_id: item.source_id.clone(),
                version: item.version.clone(),
                origin_ref: item.origin_ref.clone(),
                locator: item.locator.clone(),
                segment: slot,
                text: segment.clone(),
                at: observed,
            });
        }
    }
    if planned.is_empty() {
        return Ok(json!({"queued": 0, "skipped": skipped}));
    }
    if active_rows + planned.len() as i64 > MAX_PENDING_ROWS
        || active_chars + chars > MAX_PENDING_CHARS as i64
    {
        return Ok(json!({
            "queued": 0,
            "skipped": skipped + planned.len() as i64,
            "reason": "capacity",
            "capacity": {"rows": MAX_PENDING_ROWS, "chars": MAX_PENDING_CHARS},
            "pending": {"rows": active_rows, "chars": active_chars},
        }));
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite)?;
    let mut queued = 0i64;
    for row in planned {
        queued += transaction
            .execute(
                "INSERT OR IGNORE INTO profile_pending
                 (id, source_kind, source_id, version, segment, origin_ref, locator, text, state, at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9, ?9)",
                params![
                    new_id("ppd"),
                    row.source_kind,
                    row.source_id,
                    row.version,
                    row.segment,
                    row.origin_ref,
                    row.locator,
                    row.text,
                    row.at
                ],
            )
            .map_err(sqlite)? as i64;
    }
    prune(&transaction)?;
    ensure_not_cancelled()?;
    transaction.commit().map_err(sqlite)?;
    Ok(json!({"queued": queued, "skipped": skipped}))
}

fn cleared_at(connection: &Connection) -> ApiResult<i64> {
    let value: Option<String> = connection
        .query_row(
            "SELECT value FROM profile_control WHERE key = 'cleared_at'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(sqlite)?;
    Ok(value.and_then(|text| text.parse().ok()).unwrap_or(0))
}

/// Rows and characters still waiting, which is what capacity is measured against.
fn active_usage(connection: &Connection) -> ApiResult<(i64, i64)> {
    connection
        .query_row(
            // A failed row keeps its text until a retry runs it, so it has to count
            // against the budget: otherwise a batch that keeps failing could fill the
            // database while every capacity check still reported room.
            "SELECT count(*), coalesce(sum(length(text)), 0) FROM profile_pending
             WHERE state IN ('pending', 'working', 'failed')",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(sqlite)
}

fn marked(
    connection: &Connection,
    source_kind: &str,
    source_id: &str,
    version: &str,
    segment: i64,
) -> ApiResult<bool> {
    let count: i64 = connection
        .query_row(
            "SELECT count(*) FROM profile_markers
             WHERE source_kind = ?1 AND source_id = ?2 AND version = ?3 AND segment = ?4",
            params![source_kind, source_id, version, segment],
            |row| row.get(0),
        )
        .map_err(sqlite)?;
    Ok(count > 0)
}

fn source_invalid(connection: &Connection, source_kind: &str, source_id: &str) -> ApiResult<bool> {
    let state: Option<String> = connection
        .query_row(
            "SELECT state FROM profile_source_state WHERE source_kind = ?1 AND source_id = ?2",
            params![source_kind, source_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(sqlite)?;
    Ok(state.as_deref() == Some("invalid"))
}

/// Splits by characters with a small overlap so a sentence cut at the boundary is
/// still readable in one segment.
fn segments_of(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= SEGMENT_CHARS {
        return vec![text.to_string()];
    }
    let step = SEGMENT_CHARS - SEGMENT_OVERLAP;
    let mut out = Vec::new();
    let mut start = 0;
    while start < chars.len() {
        let end = (start + SEGMENT_CHARS).min(chars.len());
        out.push(chars[start..end].iter().collect());
        if end == chars.len() {
            break;
        }
        start += step;
    }
    out
}

/// Retires the lightweight markers of old work. The queue itself is never trimmed
/// to make room: work that has not been learned yet is either refused up front or
/// kept, never silently dropped.
fn prune(transaction: &rusqlite::Transaction<'_>) -> ApiResult<()> {
    transaction
        .execute(
            "DELETE FROM profile_markers WHERE created_at < ?1",
            params![now_ms() - RECENT_DAYS * 86_400_000],
        )
        .map_err(sqlite)?;
    Ok(())
}

/// Hands the next due batch of the user's own sentences to the host. Rust decides
/// the batch, the claim and the deadline; the host only reads text into a model.
pub fn next(connection: &mut Connection) -> ApiResult<Value> {
    let mut control = control(connection)?;
    let due = next_due_at(connection)?;
    control["nextDueAt"] = json!(due);
    if !control["enabled"].as_bool().unwrap_or(false) || !control["chat"].as_bool().unwrap_or(false)
    {
        control["batch"] = Value::Null;
        control["nextDueAt"] = Value::Null;
        return Ok(control);
    }
    if control["pausedManual"].as_bool().unwrap_or(false)
        || control["pausedGame"].as_bool().unwrap_or(false)
    {
        control["batch"] = Value::Null;
        control["nextDueAt"] = Value::Null;
        return Ok(control);
    }
    let now = now_ms();
    let ready = due.map(|at| at <= now).unwrap_or(false);
    if !ready {
        control["batch"] = Value::Null;
        return Ok(control);
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite)?;
    let mut statement = transaction
        .prepare(
            "SELECT id, source_kind, source_id, version, segment, origin_ref, locator, text, at
             FROM profile_pending WHERE state = 'pending' AND at <= ?1 ORDER BY at, id",
        )
        .map_err(sqlite)?;
    let rows = statement
        .query_map(params![now - window_ms()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, i64>(8)?,
            ))
        })
        .map_err(sqlite)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(sqlite)?;
    drop(statement);
    let mut taken = Vec::new();
    let mut chars = 0;
    for row in rows {
        let length = row.7.chars().count();
        if !taken.is_empty() && chars + length > MAX_BATCH_CHARS {
            break;
        }
        chars += length;
        taken.push(row);
        if chars >= MAX_BATCH_CHARS {
            break;
        }
    }
    if taken.is_empty() {
        transaction.commit().map_err(sqlite)?;
        control["batch"] = Value::Null;
        return Ok(control);
    }
    let claim = new_id("pcl");
    let epoch_now = epoch(&transaction)?;
    let mut items = Vec::new();
    for (id, source_kind, source_id, version, segment, origin_ref, locator, text, at) in &taken {
        transaction
            .execute(
                "UPDATE profile_pending SET state = 'working', claim = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, claim, now],
            )
            .map_err(sqlite)?;
        items.push(json!({
            "id": id,
            "sourceKind": source_kind,
            "sourceId": source_id,
            "version": version,
            "segment": segment,
            "originRef": origin_ref,
            "locator": locator,
            "text": text,
            "at": at,
        }));
    }
    ensure_not_cancelled()?;
    transaction.commit().map_err(sqlite)?;
    control["batch"] = json!({"claim": claim, "epoch": epoch_now, "items": items});
    control["nextDueAt"] = Value::Null;
    Ok(control)
}

/// What the user removed, so a re-wording cannot smuggle it back in.
fn removed(connection: &Connection) -> ApiResult<Vec<String>> {
    let mut statement = connection
        .prepare(
            "SELECT key FROM exclusions WHERE kind = 'profile'
             ORDER BY created_at DESC LIMIT ?1",
        )
        .map_err(sqlite)?;
    let keys = statement
        .query_map(params![MAX_REMOVED as i64], |row| row.get::<_, String>(0))
        .map_err(sqlite)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(sqlite)?;
    let mut out = Vec::new();
    let mut chars = 0;
    for key in keys {
        chars += key.chars().count();
        if chars > MAX_REMOVED_CHARS {
            break;
        }
        out.push(key);
    }
    Ok(out)
}

fn candidates(connection: &Connection) -> ApiResult<Vec<Value>> {
    let mut statement = connection
        .prepare(
            "SELECT id, slot, dimension, value, category, pinned, corrected, updated_at
             FROM profile_items
             ORDER BY pinned DESC, corrected DESC, updated_at DESC LIMIT ?1",
        )
        .map_err(sqlite)?;
    let rows = statement
        .query_map(params![MAX_CANDIDATES as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
            ))
        })
        .map_err(sqlite)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(sqlite)?;
    let mut out = Vec::new();
    let mut chars = 0;
    for (id, slot, dimension, value, category, pinned, corrected, updated_at) in rows {
        let cost = dimension.chars().count() + value.chars().count() + slot.chars().count();
        if !out.is_empty() && chars + cost > MAX_CANDIDATE_CHARS {
            break;
        }
        chars += cost;
        out.push(json!({
            "id": id,
            "slot": slot,
            "dimension": dimension,
            "value": value,
            "category": category,
            "pinned": pinned != 0,
            "corrected": corrected != 0,
            "updatedAt": updated_at,
        }));
    }
    Ok(out)
}

/// One bounded learning call. The batch's text goes to the model, the answer is
/// validated against that text, and only then does one transaction write it.
pub fn learn(
    store: &Store,
    link: &std::sync::Arc<crate::link::Link>,
    parent: &str,
    params: RunParams,
) -> ApiResult<Value> {
    let connection = store
        .profile
        .lock()
        .map_err(|_| ApiError::new(Code::Internal, "the profile lock was poisoned"))?;
    let control_value = control(&connection)?;
    let control = control_value;
    if !control["enabled"].as_bool().unwrap_or(false) || !control["chat"].as_bool().unwrap_or(false)
    {
        return Err(ApiError::new(Code::Cancelled, "profile learning is off"));
    }
    if control["pausedManual"].as_bool().unwrap_or(false)
        || control["pausedGame"].as_bool().unwrap_or(false)
    {
        return Err(ApiError::new(Code::Cancelled, "profile learning is paused"));
    }
    let rows = claimed_rows(&connection, &params.claim)?;
    if rows.is_empty() {
        return Err(ApiError::new(
            Code::InvalidParams,
            "no pending evidence for this claim",
        ));
    }
    let batch: String = rows
        .iter()
        .map(|row| row.text.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    let known = candidates(&connection)?;
    let removed = removed(&connection)?;
    let prompt = json!({
        "evidence": rows.iter().map(|row| json!({"id": row.id, "text": row.text})).collect::<Vec<_>>(),
        "existing": known,
        "removed": removed,
    });
    let messages = json!([
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": prompt.to_string()},
    ]);
    drop(connection);
    // An unset profile is not an error: the main process resolves "the first
    // enabled model" exactly once, in `createKnowledgeCompleter`, so both modules
    // share one rule instead of each guessing.
    let profile_id = params.profile_id.clone().unwrap_or_default();
    let effort = params.effort.clone().unwrap_or_else(|| "high".into());
    let answer = link.request_model(crate::link::ModelRequest {
        parent_id: parent,
        profile_id: &profile_id,
        effort: &effort,
        messages: &messages,
        max_tokens: Some(MAX_TOKENS),
    })?;
    let parsed = parse_updates(&answer)?;
    let mut connection = store
        .profile
        .lock()
        .map_err(|_| ApiError::new(Code::Internal, "the profile lock was poisoned"))?;
    apply(
        &mut connection,
        &params.claim,
        &rows,
        &known,
        &batch,
        parsed,
    )
}

/// One accepted piece of evidence, planned before anything is written.
struct Planned {
    source_kind: String,
    source_id: String,
    version: String,
    origin_ref: String,
    locator: String,
    segment: i64,
    text: String,
    at: i64,
}

struct Row {
    id: String,
    source_kind: String,
    source_id: String,
    version: String,
    segment: i64,
    origin_ref: String,
    locator: String,
    text: String,
    at: i64,
}

/// One profile item as the model saw it, kept only for this judgement.
struct Candidate {
    id: String,
    slot: String,
    dimension: String,
    updated_at: i64,
}

fn snapshot_of(known: &[Value]) -> Vec<Candidate> {
    known
        .iter()
        .filter_map(|entry| {
            Some(Candidate {
                id: entry.get("id")?.as_str()?.to_string(),
                slot: entry.get("slot")?.as_str()?.to_string(),
                dimension: entry.get("dimension")?.as_str()?.to_string(),
                updated_at: entry.get("updatedAt")?.as_i64()?,
            })
        })
        .collect()
}

/// Dimensions that hold several separate things at once. Everything else is a
/// single value the user has one of.
fn is_multi(dimension: &str) -> bool {
    matches!(dimension, "project" | "focus")
}

fn excluded(transaction: &rusqlite::Transaction<'_>, key: &str) -> ApiResult<bool> {
    let count: i64 = transaction
        .query_row(
            "SELECT count(*) FROM exclusions WHERE kind = 'profile' AND key = ?1",
            [key],
            |row| row.get(0),
        )
        .map_err(sqlite)?;
    Ok(count > 0)
}

fn claimed_rows(connection: &Connection, claim: &str) -> ApiResult<Vec<Row>> {
    let mut statement = connection
        .prepare(
            "SELECT id, source_kind, source_id, version, segment, origin_ref, locator, text, at
             FROM profile_pending WHERE state = 'working' AND claim = ?1 ORDER BY at, id",
        )
        .map_err(sqlite)?;
    let rows = statement
        .query_map([claim], |row| {
            Ok(Row {
                id: row.get(0)?,
                source_kind: row.get(1)?,
                source_id: row.get(2)?,
                version: row.get(3)?,
                segment: row.get(4)?,
                origin_ref: row.get(5)?,
                locator: row.get(6)?,
                text: row.get(7)?,
                at: row.get(8)?,
            })
        })
        .map_err(sqlite)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(sqlite)?;
    Ok(rows)
}

struct Update {
    slot: Option<String>,
    dimension: String,
    value: String,
    category: String,
    quotes: Vec<String>,
}

/// Strict parsing: a missing field is a failure, never an empty result.
fn parse_updates(answer: &str) -> ApiResult<Vec<Update>> {
    let text = answer.trim();
    let body = match (text.find('{'), text.rfind('}')) {
        (Some(start), Some(end)) if end > start => &text[start..=end],
        _ => {
            return Err(ApiError::new(
                Code::InvalidOutput,
                "the model did not answer with JSON",
            ));
        }
    };
    let value: Value = serde_json::from_str(body).map_err(|error| {
        ApiError::new(
            Code::InvalidOutput,
            format!("invalid profile JSON: {error}"),
        )
    })?;
    let items = value
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(|| ApiError::new(Code::InvalidOutput, "missing items array"))?;
    if items.len() > MAX_UPDATES {
        return Err(ApiError::new(
            Code::InvalidOutput,
            "too many profile updates",
        ));
    }
    let mut out = Vec::new();
    for item in items {
        let dimension = item
            .get("dimension")
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::new(Code::InvalidOutput, "missing dimension"))?
            .to_string();
        if !DIMENSIONS.contains(&dimension.as_str()) {
            return Err(ApiError::new(
                Code::InvalidOutput,
                format!("unknown dimension: {dimension}"),
            ));
        }
        let value_text = item
            .get("value")
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::new(Code::InvalidOutput, "missing value"))?
            .trim()
            .to_string();
        if value_text.is_empty() {
            return Err(ApiError::new(Code::InvalidOutput, "empty profile value"));
        }
        let category = item
            .get("category")
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::new(Code::InvalidOutput, "missing category"))?
            .to_string();
        if !crate::store::CATEGORIES.contains(&category.as_str()) {
            return Err(ApiError::new(
                Code::InvalidOutput,
                format!("unknown category: {category}"),
            ));
        }
        let slot = item
            .get("slot")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string);
        let quotes = item
            .get("evidence")
            .and_then(Value::as_array)
            .ok_or_else(|| ApiError::new(Code::InvalidOutput, "missing evidence"))?
            .iter()
            .map(|entry| {
                entry
                    .get("quote")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                    .map(str::to_string)
                    .ok_or_else(|| ApiError::new(Code::InvalidOutput, "missing evidence quote"))
            })
            .collect::<ApiResult<Vec<String>>>()?;
        if quotes.is_empty() {
            return Err(ApiError::new(
                Code::InvalidOutput,
                "evidence quotes must not be empty",
            ));
        }
        out.push(Update {
            slot,
            dimension,
            value: value_text,
            category,
            quotes,
        });
    }
    Ok(out)
}

fn apply(
    connection: &mut Connection,
    claim: &str,
    rows: &[Row],
    known: &[Value],
    batch: &str,
    updates: Vec<Update>,
) -> ApiResult<Value> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite)?;
    // Re-check control, claims and the archive generation inside the write
    // transaction: a pause, a clear or a manual edit that landed while the model
    // was answering must win over this answer.
    if !flag(&transaction, "enabled")?
        || !flag(&transaction, "chat")?
        || flag(&transaction, "paused_manual")?
        || flag(&transaction, "paused_game")?
    {
        return Err(ApiError::new(
            Code::Cancelled,
            "profile learning was switched off",
        ));
    }
    let still_claimed: i64 = transaction
        .query_row(
            "SELECT count(*) FROM profile_pending WHERE state = 'working' AND claim = ?1",
            [claim],
            |row| row.get(0),
        )
        .map_err(sqlite)?;
    if still_claimed as usize != rows.len() {
        return Err(ApiError::new(Code::Cancelled, "the evidence was withdrawn"));
    }
    let now = now_ms();
    let snapshot = snapshot_of(known);
    let mut written = Vec::new();
    let mut skipped = 0;
    for update in updates {
        check_chars("value", &update.value, 1_000)?;
        let mut quote_ok = true;
        let mut quotes = Vec::new();
        for quote in &update.quotes {
            check_chars("quote", quote, MAX_QUOTE_CHARS)?;
            if !batch.contains(quote.as_str()) {
                quote_ok = false;
                break;
            }
            quotes.push(quote.clone());
        }
        if !quote_ok {
            return Err(ApiError::new(
                Code::InvalidOutput,
                "an evidence quote is not part of the input",
            ));
        }
        let dimension = update.dimension.clone();
        if !DIMENSIONS.contains(&dimension.as_str()) {
            return Err(ApiError::new(
                Code::InvalidOutput,
                format!("unknown profile dimension: {dimension}"),
            ));
        }
        // The answer may only name a slot this batch actually offered. An invented
        // slot would be a new identity, which is how a restatement used to slip past
        // a pinned or corrected item.
        let offered = match &update.slot {
            Some(slot) => {
                let entry = snapshot
                    .iter()
                    .find(|entry| &entry.slot == slot)
                    .ok_or_else(|| {
                        ApiError::new(
                            Code::InvalidOutput,
                            format!("the answer referenced an unknown slot: {slot}"),
                        )
                    })?;
                // A slot carries the dimension it was offered under. Borrowing the
                // slot of another dimension would mint a second, contradictory
                // identity for this one, next to the protected item it names.
                if entry.dimension != dimension {
                    return Err(ApiError::new(
                        Code::InvalidOutput,
                        format!(
                            "the answer referenced slot {slot} of another dimension: {}",
                            entry.dimension
                        ),
                    ));
                }
                Some(entry)
            }
            None => None,
        };
        let slot = match (offered, &update.slot) {
            (Some(entry), _) => entry.slot.clone(),
            (None, Some(slot)) => slot.clone(),
            // Interests and projects coexist, so they get one entity per value with
            // an identity minted here rather than one shared slot per dimension.
            (None, None) if is_multi(&dimension) => {
                format!("{dimension}:{}", &sha256_hex(&update.value)[..12])
            }
            (None, None) => snapshot
                .iter()
                .find(|entry| entry.dimension == dimension)
                .map(|entry| entry.slot.clone())
                .unwrap_or_else(|| dimension.clone()),
        };
        if excluded(&transaction, &slot)?
            || excluded(&transaction, &format!("{dimension}={}", update.value))?
        {
            skipped += 1;
            continue;
        }
        let existing: Option<(String, i64, i64)> = transaction
            .query_row(
                "SELECT id, pinned, corrected FROM profile_items WHERE slot = ?1 AND dimension = ?2",
                params![slot, update.dimension],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(sqlite)?;
        match existing {
            Some((_, pinned, corrected)) if pinned != 0 || corrected != 0 => {
                // A pinned or corrected item is the user's word: an automatic
                // writer may add evidence to it but never restate it.
                skipped += 1;
            }
            Some((id, _, _)) => {
                // Compare against what the model actually saw. A manual edit that
                // landed while the answer was on its way wins.
                let current: Option<i64> = transaction
                    .query_row(
                        "SELECT updated_at FROM profile_items WHERE id = ?1",
                        [&id],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(sqlite)?;
                let judged = snapshot
                    .iter()
                    .find(|entry| entry.id == id)
                    .map(|entry| entry.updated_at);
                if current.is_none() || current != judged {
                    skipped += 1;
                    continue;
                }
                transaction
                    .execute(
                        "UPDATE profile_items SET value = ?2, category = ?3, origin = 'auto', slot = ?4, updated_at = ?5 WHERE id = ?1",
                        params![id, update.value, update.category, slot, now],
                    )
                    .map_err(sqlite)?;
                attach(&transaction, &id, rows, &quotes)?;
                written.push(json!({"id": id, "action": "updated"}));
            }
            None => {
                let id = new_id("prof");
                transaction
                    .execute(
                        "INSERT INTO profile_items
                         (id, dimension, value, category, origin, pinned, corrected, slot, created_at, updated_at)
                         VALUES (?1, ?2, ?3, ?4, 'auto', 0, 0, ?5, ?6, ?6)",
                        params![id, update.dimension, update.value, update.category, slot, now],
                    )
                    .map_err(sqlite)?;
                attach(&transaction, &id, rows, &quotes)?;
                written.push(json!({"id": id, "action": "created"}));
            }
        }
    }
    // A learned segment becomes a light marker, so the queue stops holding its full
    // text and a replayed callback cannot learn it twice.
    for row in rows {
        transaction
            .execute(
                "INSERT OR IGNORE INTO profile_markers
                 (source_kind, source_id, version, segment, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    row.source_kind,
                    row.source_id,
                    row.version,
                    row.segment,
                    now
                ],
            )
            .map_err(sqlite)?;
        transaction
            .execute("DELETE FROM profile_pending WHERE id = ?1", [&row.id])
            .map_err(sqlite)?;
    }
    prune(&transaction)?;
    ensure_not_cancelled()?;
    transaction.commit().map_err(sqlite)?;
    Ok(json!({"written": written, "skipped": skipped, "evidence": rows.len()}))
}

fn attach(
    transaction: &rusqlite::Transaction<'_>,
    item_id: &str,
    rows: &[Row],
    quotes: &[String],
) -> ApiResult<()> {
    for row in rows {
        if !row
            .text
            .contains(quotes.first().map(String::as_str).unwrap_or_default())
        {
            continue;
        }
        let locator: String = quotes.join(" / ");
        // The evidence keeps the time it was observed, not the time it was learned:
        // a whole month late is still "a month ago", not "today".
        transaction
            .execute(
                "INSERT OR IGNORE INTO profile_evidence
                 (item_id, source_kind, source_id, origin_ref, locator, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    item_id,
                    row.source_kind,
                    format!("{}#{}", row.source_id, row.version),
                    row.origin_ref,
                    if locator.is_empty() {
                        row.locator.clone()
                    } else {
                        locator
                    },
                    row.at
                ],
            )
            .map_err(sqlite)?;
    }
    Ok(())
}

/// Releases a batch that will not be committed. A pause parks it; anything else is
/// a real failure the user can retry.
pub fn fail(connection: &mut Connection, params: FailParams) -> ApiResult<Value> {
    let code = params.code.unwrap_or_else(|| "internal".into());
    let reason = params.reason.unwrap_or_default();
    check_chars("reason", &reason, 300)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite)?;
    let now = now_ms();
    let (state, changed) = match code.as_str() {
        // A pause parks the batch: the same evidence is learned after a resume.
        "cancelled" | "paused" => (
            "pending",
            transaction
                .execute(
                    "UPDATE profile_pending SET state = 'pending', claim = NULL, reason = ?2,
                     updated_at = ?3 WHERE state = 'working' AND claim = ?1",
                    params![params.claim, reason, now],
                )
                .map_err(sqlite)?,
        ),
        // The source is gone, so its text goes with it; a marker keeps a replayed
        // callback from queueing the same segment again.
        "source_changed" | "retracted" => ("done", drop_claim(&transaction, &params.claim)?),
        // Anything else is a real failure the user can retry explicitly.
        _ => (
            "failed",
            transaction
                .execute(
                    "UPDATE profile_pending SET state = 'failed', claim = NULL, reason = ?2,
                     updated_at = ?3 WHERE state = 'working' AND claim = ?1",
                    params![params.claim, reason, now],
                )
                .map_err(sqlite)?,
        ),
    };
    ensure_not_cancelled()?;
    transaction.commit().map_err(sqlite)?;
    Ok(json!({"released": changed, "state": state}))
}

/// Drops a claim's text and leaves a marker per segment behind.
fn drop_claim(transaction: &rusqlite::Transaction<'_>, claim: &str) -> ApiResult<usize> {
    transaction
        .execute(
            "INSERT OR IGNORE INTO profile_markers
             (source_kind, source_id, version, segment, created_at)
             SELECT source_kind, source_id, version, segment, ?2
             FROM profile_pending WHERE state = 'working' AND claim = ?1",
            params![claim, now_ms()],
        )
        .map_err(sqlite)?;
    transaction
        .execute(
            "DELETE FROM profile_pending WHERE state = 'working' AND claim = ?1",
            [claim],
        )
        .map_err(sqlite)
}

/// Returns a cancelled claim to the queue. The host calls this when a run is
/// aborted mid-flight so no row stays `working` without an owner.
pub fn release(connection: &mut Connection, claim: &str) -> ApiResult<usize> {
    connection
        .execute(
            "UPDATE profile_pending SET state = 'pending', claim = NULL, reason = '',
             updated_at = ?2 WHERE state = 'working' AND claim = ?1",
            params![claim, now_ms()],
        )
        .map_err(sqlite)
}

/// Puts failed batches back in the queue. The only way a real failure is retried,
/// and never an automatic paid call.
pub fn retry(connection: &mut Connection) -> ApiResult<Value> {
    let retried = connection
        .execute(
            "UPDATE profile_pending SET state = 'pending', claim = NULL, reason = '',
             updated_at = ?1 WHERE state = 'failed'",
            params![now_ms()],
        )
        .map_err(sqlite)?;
    Ok(json!({"retried": retried}))
}

/// Marks a source as gone. Evidence already written stays, but it stops being
/// fed back into the context, and queued text for it is dropped.
pub fn retract(connection: &mut Connection, params: RetractParams) -> ApiResult<Value> {
    check_chars("sourceKind", &params.source_kind, 40)?;
    check_chars("sourceId", &params.source_id, 200)?;
    let reason = params
        .reason
        .unwrap_or_else(|| "removed by the user".into());
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite)?;
    transaction
        .execute(
            "INSERT INTO profile_source_state (source_kind, source_id, state, reason, updated_at)
             VALUES (?1, ?2, 'invalid', ?3, ?4)
             ON CONFLICT (source_kind, source_id) DO UPDATE
             SET state = 'invalid', reason = excluded.reason, updated_at = excluded.updated_at",
            params![params.source_kind, params.source_id, reason, now_ms()],
        )
        .map_err(sqlite)?;
    let dropped = transaction
        .execute(
            "DELETE FROM profile_pending WHERE source_kind = ?1 AND source_id = ?2",
            params![params.source_kind, params.source_id],
        )
        .map_err(sqlite)?;
    ensure_not_cancelled()?;
    transaction.commit().map_err(sqlite)?;
    Ok(json!({"retracted": true, "dropped": dropped}))
}

/// Usage inside the window, by feature. Counts only: never the user's text.
fn usage_days(connection: &Connection, after: i64) -> ApiResult<Vec<(String, i64)>> {
    let mut statement = connection
        .prepare(
            "SELECT feature, sum(count) FROM profile_usage WHERE day * 86400000 >= ?1
             GROUP BY feature ORDER BY sum(count) DESC, feature",
        )
        .map_err(sqlite)?;
    let rows = statement
        .query_map([after], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(sqlite)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(sqlite)?;
    Ok(rows)
}

/// The bounded, traceable profile context. No model, no Mem0, no writes.
pub fn context(connection: &Connection) -> ApiResult<Value> {
    if !flag(connection, "enabled")? {
        return Ok(json!({"enabled": false, "text": "", "items": [], "bytes": 0}));
    }
    let recent_after = now_ms() - RECENT_DAYS * 86_400_000;
    let mut statement = connection
        .prepare(
            "SELECT i.id, i.dimension, i.value, i.category, i.pinned, i.corrected, i.updated_at,
                    i.origin,
                    (SELECT max(e.created_at) FROM profile_evidence e WHERE e.item_id = i.id
                      AND NOT EXISTS (
                        SELECT 1 FROM profile_source_state s
                        WHERE s.source_kind = e.source_kind
                          AND s.source_id = substr(e.source_id, 1, instr(e.source_id, '#') - 1)
                          AND s.state = 'invalid'))
               AS recent_at,
                    (SELECT count(*) FROM profile_evidence e WHERE e.item_id = i.id
                      AND NOT EXISTS (
                        SELECT 1 FROM profile_source_state s
                        WHERE s.source_kind = e.source_kind
                          AND s.source_id = substr(e.source_id, 1, instr(e.source_id, '#') - 1)
                          AND s.state = 'invalid'))
               AS valid_evidence
             FROM profile_items i
             ORDER BY i.pinned DESC, i.corrected DESC,
                      CASE i.category WHEN 'explicit' THEN 0 WHEN 'observed' THEN 1 ELSE 2 END,
                      i.updated_at DESC",
        )
        .map_err(sqlite)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, Option<i64>>(8)?,
                row.get::<_, i64>(9)?,
            ))
        })
        .map_err(sqlite)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(sqlite)?;
    let mut lines = Vec::new();
    let mut items = Vec::new();
    let mut bytes = 0usize;
    for (id, dimension, value, category, pinned, corrected, _, origin, recent_at, valid) in rows {
        let protected = pinned != 0 || corrected != 0;
        let fresh = recent_at.map(|at| at >= recent_after).unwrap_or(false);
        // An automatic item whose every source was retracted has lost its footing,
        // even when the observation itself is recent. A manual one is the user's own
        // word and stays; its detail still reports the retracted evidence.
        if !protected && origin != "manual" && valid == 0 {
            continue;
        }
        // The 30-day window is about *now*: which interests and projects are alive.
        // A stable preference the user stated is not retracted by the calendar.
        if !protected && is_multi(&dimension) && !fresh {
            continue;
        }
        let line = format!("- {value}（{dimension}/{category}，id={id}）");
        let cost = line.chars().count();
        if bytes + cost > CONTEXT_CHARS && !items.is_empty() {
            break;
        }
        bytes += cost;
        lines.push(line);
        items.push(json!({
            "id": id,
            "dimension": dimension,
            "value": value,
            "category": category,
            "pinned": pinned != 0,
            "corrected": corrected != 0,
            "recent": fresh,
        }));
    }
    let mut shown = items.len();
    for (feature, count) in usage_days(connection, recent_after)? {
        let line = format!("- 近期常用：{feature} {count} 次");
        let cost = line.chars().count();
        if bytes + cost > CONTEXT_CHARS {
            break;
        }
        bytes += cost;
        shown += 1;
        lines.push(line);
    }
    let text = lines.join("\n");
    Ok(json!({
        "enabled": true,
        "text": text,
        "items": items,
        "recent": shown,
        "bytes": text.len(),
    }))
}

/// Wipes this module's data and raises the barrier that keeps an in-flight answer
/// from refilling the database. Chats, notes, cards and Mem0 are untouched.
pub fn clear(connection: &mut Connection) -> ApiResult<Value> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite)?;
    let items = transaction
        .execute("DELETE FROM profile_items", [])
        .map_err(sqlite)?;
    transaction
        .execute("DELETE FROM profile_evidence", [])
        .map_err(sqlite)?;
    // Whatever was still waiting is remembered as a marker before the text goes: a
    // callback for the same turn must not be able to queue it again.
    transaction
        .execute(
            "INSERT OR IGNORE INTO profile_markers
             (source_kind, source_id, version, segment, created_at)
             SELECT source_kind, source_id, version, segment, ?1 FROM profile_pending",
            params![now_ms()],
        )
        .map_err(sqlite)?;
    let pending = transaction
        .execute("DELETE FROM profile_pending", [])
        .map_err(sqlite)?;
    transaction
        .execute("DELETE FROM profile_usage", [])
        .map_err(sqlite)?;
    transaction
        .execute("DELETE FROM profile_usage_ops", [])
        .map_err(sqlite)?;
    transaction
        .execute(
            "DELETE FROM exclusions WHERE kind IN ('profile', 'profileClear')",
            [],
        )
        .map_err(sqlite)?;
    let next = epoch(&transaction)? + 1;
    let cleared = now_ms();
    transaction
        .execute(
            "INSERT INTO profile_control (key, value, updated_at) VALUES ('epoch', ?1, ?2)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![next.to_string(), cleared],
        )
        .map_err(sqlite)?;
    // The barrier outlives the deleted rows: a callback already on its way carries an
    // older observation time and is refused at the queue instead of reviving the item.
    transaction
        .execute(
            "INSERT INTO profile_control (key, value, updated_at) VALUES ('cleared_at', ?1, ?1)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![cleared.to_string()],
        )
        .map_err(sqlite)?;
    ensure_not_cancelled()?;
    transaction.commit().map_err(sqlite)?;
    Ok(
        json!({"cleared": true, "items": items, "pending": pending, "epoch": next, "clearedAt": cleared}),
    )
}
