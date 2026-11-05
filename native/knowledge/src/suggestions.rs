//! Reviewing what extraction proposes instead of writing: `list`, `get`,
//! `accept` and `reject`.
//!
//! A suggestion is only ever applied on top of the card revision it was written
//! for. If the card moved on — a person edited it, another batch merged into it —
//! accepting is refused instead of silently overwriting the newer content.

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::cards;
use crate::protocol::{ApiError, ApiResult, Code};
use crate::util::{ensure_not_cancelled, now_ms, page};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListParams {
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    offset: Option<u32>,
    #[serde(default)]
    limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdParams {
    pub id: String,
}

const SELECT: &str = "SELECT id, kind, target_card_id, target_revision, action, draft, reason, source_ids, state, created_at, updated_at FROM suggestions";

fn sqlite(error: rusqlite::Error) -> ApiError {
    ApiError::storage(format!("knowledge database error: {error}"))
}

fn row_json(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let draft: String = row.get(5)?;
    let sources: String = row.get(7)?;
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "kind": row.get::<_, String>(1)?,
        "targetCardId": row.get::<_, String>(2)?,
        "targetRevision": row.get::<_, i64>(3)?,
        "action": row.get::<_, String>(4)?,
        "draft": serde_json::from_str::<Value>(&draft).unwrap_or(Value::Null),
        "reason": row.get::<_, String>(6)?,
        "sourceIds": serde_json::from_str::<Value>(&sources).unwrap_or_else(|_| json!([])),
        "state": row.get::<_, String>(8)?,
        "createdAt": row.get::<_, i64>(9)?,
        "updatedAt": row.get::<_, i64>(10)?,
    }))
}

pub fn list(conn: &Connection, params: ListParams) -> ApiResult<Value> {
    let (offset, limit) = page(params.offset, params.limit);
    let state = params.state.filter(|value| !value.is_empty());
    let total: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM suggestions WHERE (?1 IS NULL OR state = ?1)",
            params![state],
            |row| row.get(0),
        )
        .map_err(sqlite)?;
    let mut statement = conn
        .prepare(&format!(
            "{SELECT} WHERE (?1 IS NULL OR state = ?1) ORDER BY created_at DESC, id DESC LIMIT ?2 OFFSET ?3"
        ))
        .map_err(sqlite)?;
    let items = statement
        .query_map(params![state, limit, offset], row_json)
        .map_err(sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite)?;
    let shown = items.len() as u32;
    Ok(json!({
        "items": items,
        "total": total,
        "offset": offset,
        "limit": limit,
        "hasMore": (offset + shown) < total as u32,
        "nextOffset": if (offset + shown) < total as u32 { Some(offset + shown) } else { None },
    }))
}

pub fn get(conn: &Connection, id: &str) -> ApiResult<Value> {
    conn.query_row(&format!("{SELECT} WHERE id = ?1"), params![id], row_json)
        .optional()
        .map_err(sqlite)?
        .ok_or_else(|| ApiError::not_found("建议不存在"))
}

/// Applies a proposal to the card it was written for, `accept` only when the
/// card still sits on the revision the suggestion targeted.
pub fn accept(conn: &mut Connection, id: &str) -> ApiResult<Value> {
    let transaction = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite)?;
    let (target, target_revision, draft, sources, state): (
        String,
        i64,
        String,
        String,
        String,
    ) = transaction
        .query_row(
            "SELECT target_card_id, target_revision, draft, source_ids, state FROM suggestions WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()
        .map_err(sqlite)?
        .ok_or_else(|| ApiError::not_found("建议不存在"))?;
    if state != "open" {
        return Err(ApiError::invalid("建议已处理"));
    }
    let revision: Option<i64> = transaction
        .query_row(
            "SELECT revision FROM cards WHERE id = ?1",
            params![target],
            |row| row.get(0),
        )
        .optional()
        .map_err(sqlite)?;
    let revision = revision.ok_or_else(|| ApiError::not_found("目标卡片不存在"))?;
    if revision != target_revision {
        // The card moved on, so this proposal can never be applied. It is closed
        // instead of staying open forever, and the reason is kept for the reader.
        transaction
            .execute(
                "UPDATE suggestions SET state = 'rejected', reason = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, "目标卡片已更新，建议已过期", now_ms()],
            )
            .map_err(sqlite)?;
        ensure_not_cancelled()?;
        transaction.commit().map_err(sqlite)?;
        return Err(ApiError::new(
            Code::SourceChanged,
            "目标卡片已更新，建议已过期",
        ));
    }

    let parsed: Value = serde_json::from_str(&draft)
        .map_err(|error| ApiError::invalid(format!("建议草稿无法解析：{error}")))?;
    let text = |key: &str| {
        parsed
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let list = |key: &str| {
        parsed
            .get(key)
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };
    let body = text("body");
    let fingerprint = cards::fingerprint_of(&body);
    let now = now_ms();
    let (title, summary, previous): (String, String, String) = transaction
        .query_row(
            "SELECT title, summary, body FROM cards WHERE id = ?1",
            params![target],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(sqlite)?;
    transaction
        .execute(
            "INSERT INTO card_history (id, card_id, revision, title, summary, body, reason, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                crate::util::new_id("his"),
                target,
                revision,
                title,
                summary,
                previous,
                "接受建议",
                now
            ],
        )
        .map_err(sqlite)?;
    transaction
        .execute(
            "UPDATE cards SET title = ?2, summary = ?3, body = ?4, topics = ?5, aliases = ?6,
             fingerprint = ?7, revision = revision + 1, updated_at = ?8 WHERE id = ?1",
            params![
                target,
                text("title"),
                text("summary"),
                body,
                serde_json::to_string(&list("topics")).unwrap_or_else(|_| "[]".into()),
                serde_json::to_string(&list("aliases")).unwrap_or_else(|_| "[]".into()),
                fingerprint,
                now
            ],
        )
        .map_err(sqlite)?;
    for source_id in serde_json::from_str::<Vec<String>>(&sources).unwrap_or_default() {
        transaction
            .execute(
                "INSERT OR IGNORE INTO card_sources (card_id, source_id, created_at) VALUES (?1, ?2, ?3)",
                params![target, source_id, now],
            )
            .map_err(sqlite)?;
    }
    cards::reindex(&transaction, &target)?;
    transaction
        .execute(
            "UPDATE suggestions SET state = 'accepted', updated_at = ?2 WHERE id = ?1",
            params![id, now],
        )
        .map_err(sqlite)?;
    ensure_not_cancelled()?;
    transaction.commit().map_err(sqlite)?;

    Ok(json!({ "id": id, "targetCardId": target, "revision": revision + 1, "state": "accepted" }))
}

pub fn reject(conn: &mut Connection, id: &str) -> ApiResult<Value> {
    let transaction = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite)?;
    let state: Option<String> = transaction
        .query_row(
            "SELECT state FROM suggestions WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(sqlite)?;
    match state.as_deref() {
        None => return Err(ApiError::not_found("建议不存在")),
        Some("open") => {}
        Some(_) => return Err(ApiError::invalid("建议已处理")),
    }
    transaction
        .execute(
            "UPDATE suggestions SET state = 'rejected', updated_at = ?2 WHERE id = ?1",
            params![id, now_ms()],
        )
        .map_err(sqlite)?;
    ensure_not_cancelled()?;
    transaction.commit().map_err(sqlite)?;
    Ok(json!({ "id": id, "state": "rejected" }))
}
