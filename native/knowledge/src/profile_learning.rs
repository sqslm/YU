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
use crate::util::{check_chars, ensure_not_cancelled, new_id, now_ms, require_text};

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
        // A paused game only parks work that is still legal; a batch that was in
        // flight is released so it can run again once the game ends.
        if paused {
            transaction
                .execute(
                    "UPDATE profile_pending SET state = 'pending', claim = NULL, updated_at = ?1
                     WHERE state = 'working'",
                    params![now_ms()],
                )
                .map_err(sqlite)?;
        }
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
    let mut control = control(connection)?;
    let next_due = next_due_at(connection)?;
    control["pending"] = json!(pending);
    control["items"] = json!(items);
    control["usageTotal"] = json!(usage);
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
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite)?;
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
    let at = now_ms();
    let mut queued = 0;
    let mut skipped = 0;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite)?;
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
        let segments = segments_of(text);
        for (index, segment) in segments.iter().enumerate() {
            let inserted = transaction
                .execute(
                    "INSERT OR IGNORE INTO profile_pending
                     (id, source_kind, source_id, version, segment, origin_ref, locator, text, state, at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9, ?9)",
                    params![
                        new_id("ppd"),
                        item.source_kind,
                        item.source_id,
                        item.version,
                        index as i64,
                        item.origin_ref,
                        item.locator,
                        segment,
                        item.at.unwrap_or(at)
                    ],
                )
                .map_err(sqlite)?;
            queued += inserted;
        }
    }
    prune(&transaction)?;
    ensure_not_cancelled()?;
    transaction.commit().map_err(sqlite)?;
    Ok(json!({"queued": queued, "skipped": skipped}))
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

/// Keeps the queue bounded in both rows and characters by dropping the oldest
/// work, which is the only work a later batch would already have covered.
fn prune(transaction: &rusqlite::Transaction<'_>) -> ApiResult<()> {
    transaction
        .execute(
            "DELETE FROM profile_pending WHERE state = 'done' AND updated_at < ?1",
            params![now_ms() - RECENT_DAYS * 86_400_000],
        )
        .map_err(sqlite)?;
    let rows: i64 = transaction
        .query_row("SELECT count(*) FROM profile_pending", [], |row| row.get(0))
        .map_err(sqlite)?;
    if rows > MAX_PENDING_ROWS {
        transaction
            .execute(
                "DELETE FROM profile_pending WHERE id IN (
                   SELECT id FROM profile_pending WHERE state = 'pending'
                   ORDER BY at LIMIT ?1)",
                params![rows - MAX_PENDING_ROWS],
            )
            .map_err(sqlite)?;
    }
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
    let prompt = json!({
        "evidence": rows.iter().map(|row| json!({"id": row.id, "text": row.text})).collect::<Vec<_>>(),
        "existing": known,
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
    apply(&mut connection, &params.claim, &rows, &batch, parsed)
}

struct Row {
    id: String,
    source_kind: String,
    source_id: String,
    version: String,
    origin_ref: String,
    locator: String,
    text: String,
}

fn claimed_rows(connection: &Connection, claim: &str) -> ApiResult<Vec<Row>> {
    let mut statement = connection
        .prepare(
            "SELECT id, source_kind, source_id, version, origin_ref, locator, text
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
                origin_ref: row.get(4)?,
                locator: row.get(5)?,
                text: row.get(6)?,
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
        let slot = update
            .slot
            .clone()
            .unwrap_or_else(|| update.dimension.clone());
        let excluded: i64 = transaction
            .query_row(
                "SELECT count(*) FROM exclusions WHERE kind = 'profile' AND key = ?1",
                [&slot],
                |row| row.get(0),
            )
            .map_err(sqlite)?;
        if excluded > 0 {
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
                transaction
                    .execute(
                        "UPDATE profile_items SET value = ?2, category = ?3, origin = 'auto', updated_at = ?4 WHERE id = ?1",
                        params![id, update.value, update.category, now],
                    )
                    .map_err(sqlite)?;
                attach(&transaction, &id, rows, &quotes, now)?;
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
                attach(&transaction, &id, rows, &quotes, now)?;
                written.push(json!({"id": id, "action": "created"}));
            }
        }
    }
    for row in rows {
        transaction
            .execute(
                "UPDATE profile_pending SET state = 'done', claim = NULL, reason = '', updated_at = ?2 WHERE id = ?1",
                params![row.id, now],
            )
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
    now: i64,
) -> ApiResult<()> {
    for row in rows {
        if !row
            .text
            .contains(quotes.first().map(String::as_str).unwrap_or_default())
        {
            continue;
        }
        let locator: String = quotes.join(" / ");
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
                    now
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
    let (state, next) = match code.as_str() {
        "cancelled" | "paused" => ("pending", "pending"),
        "source_changed" | "retracted" => ("done", "done"),
        _ => ("failed", "failed"),
    };
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite)?;
    let changed = transaction
        .execute(
            "UPDATE profile_pending SET state = ?2, claim = NULL, reason = ?3, updated_at = ?4
             WHERE state = 'working' AND claim = ?1",
            params![params.claim, next, reason, now_ms()],
        )
        .map_err(sqlite)?;
    ensure_not_cancelled()?;
    transaction.commit().map_err(sqlite)?;
    Ok(json!({"released": changed, "state": state}))
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

/// The bounded, traceable profile context. No model, no Mem0, no writes.
pub fn context(connection: &Connection) -> ApiResult<Value> {
    if !flag(connection, "enabled")? {
        return Ok(json!({"enabled": false, "text": "", "items": [], "bytes": 0}));
    }
    let recent_after = now_ms() - RECENT_DAYS * 86_400_000;
    let mut statement = connection
        .prepare(
            "SELECT i.id, i.dimension, i.value, i.category, i.pinned, i.corrected, i.updated_at,
                    (SELECT max(e.created_at) FROM profile_evidence e WHERE e.item_id = i.id
                      AND NOT EXISTS (
                        SELECT 1 FROM profile_source_state s
                        WHERE s.source_kind = e.source_kind
                          AND s.source_id = substr(e.source_id, 1, instr(e.source_id, '#') - 1)
                          AND s.state = 'invalid'))
               AS recent_at
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
                row.get::<_, Option<i64>>(7)?,
            ))
        })
        .map_err(sqlite)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(sqlite)?;
    let mut lines = Vec::new();
    let mut items = Vec::new();
    let mut bytes = 0usize;
    for (id, dimension, value, category, pinned, corrected, _, recent_at) in rows {
        let protected = pinned != 0 || corrected != 0;
        let fresh = recent_at.map(|at| at >= recent_after).unwrap_or(false);
        if !protected && !fresh {
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
    let text = lines.join("\n");
    Ok(json!({
        "enabled": true,
        "text": text,
        "items": items,
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
    transaction
        .execute(
            "INSERT INTO profile_control (key, value, updated_at) VALUES ('epoch', ?1, ?2)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![next.to_string(), now_ms()],
        )
        .map_err(sqlite)?;
    ensure_not_cancelled()?;
    transaction.commit().map_err(sqlite)?;
    Ok(json!({"cleared": true, "items": items, "pending": pending, "epoch": next}))
}
