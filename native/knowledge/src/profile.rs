//! Profile items and the evidence behind them.
//!
//! Phase 1 only supports explicit maintenance: the user (through the app) adds,
//! edits, pins, corrects and removes items. Nothing here infers a profile from
//! behaviour. Items the user pinned or corrected can never be overwritten by an
//! automatic writer, and a removed item keeps an exclusion record so old
//! evidence cannot silently rebuild it.

use rusqlite::{Connection, Row, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

use crate::protocol::{ApiError, ApiResult, Code, fit_page};
use crate::store::CATEGORIES;
use crate::util::{check_chars, new_id, now_ms, page, require_text};

const ITEM_SELECT: &str = "SELECT id, dimension, value, category, origin, pinned, corrected, created_at, updated_at, slot FROM profile_items";

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub source_kind: String,
    pub source_id: String,
    pub origin_ref: String,
    pub locator: String,
    pub created_at: i64,
    /// The source this evidence came from was deleted or retracted. The item keeps
    /// the record so management can show it, but the text no longer supports the
    /// conclusion it was learned from.
    pub withdrawn: bool,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProfileItem {
    pub id: String,
    pub dimension: String,
    pub value: String,
    /// Stable identity of this preference; empty only in a database that has not
    /// been migrated yet.
    pub slot: String,
    pub category: String,
    pub origin: String,
    pub pinned: bool,
    pub corrected: bool,
    pub evidence: Vec<Evidence>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProfilePage {
    pub items: Vec<ProfileItem>,
    pub total: i64,
    pub offset: u32,
    pub limit: u32,
    pub has_more: bool,
    pub next_offset: Option<u32>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceInput {
    pub source_kind: String,
    pub source_id: String,
    #[serde(default)]
    pub origin_ref: String,
    #[serde(default)]
    pub locator: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveParams {
    pub dimension: String,
    pub value: String,
    pub category: String,
    /// Stable identity of the preference. Automatic writers address an item by
    /// this slot, so restating the same preference with different words cannot
    /// slip past a correction the user made.
    #[serde(default)]
    pub slot: Option<String>,
    #[serde(default)]
    pub origin: Option<String>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub corrected: bool,
    #[serde(default)]
    pub evidence: Vec<EvidenceInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateParams {
    pub id: String,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub pinned: Option<bool>,
    #[serde(default)]
    pub corrected: Option<bool>,
    #[serde(default)]
    pub evidence: Option<Vec<EvidenceInput>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListParams {
    #[serde(default)]
    pub offset: Option<u32>,
    #[serde(default)]
    pub limit: Option<u32>,
}

fn sqlite_error(error: rusqlite::Error) -> ApiError {
    ApiError::storage(format!("profile statement failed: {error}"))
}

fn protected(item: &ProfileItem) -> bool {
    item.pinned || item.corrected
}

fn map(row: &Row<'_>) -> rusqlite::Result<ProfileItem> {
    Ok(ProfileItem {
        id: row.get(0)?,
        dimension: row.get(1)?,
        value: row.get(2)?,
        category: row.get(3)?,
        origin: row.get(4)?,
        pinned: row.get::<_, i64>(5)? != 0,
        corrected: row.get::<_, i64>(6)? != 0,
        evidence: Vec::new(),
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
        slot: row.get(9)?,
    })
}

fn check_category(category: &str) -> ApiResult<()> {
    if CATEGORIES.contains(&category) {
        Ok(())
    } else {
        Err(ApiError::invalid(format!(
            "unknown profile category: {category}"
        )))
    }
}

fn check_evidence(values: &[EvidenceInput]) -> ApiResult<()> {
    if values.len() > 64 {
        return Err(ApiError::new(Code::TooLarge, "evidence exceeds 64 entries"));
    }
    for value in values {
        check_chars("sourceKind", &value.source_kind, 40)?;
        check_chars("sourceId", &value.source_id, 200)?;
        check_chars("originRef", &value.origin_ref, 400)?;
        check_chars("locator", &value.locator, 2_000)?;
        if value.source_id.trim().is_empty() {
            return Err(ApiError::invalid("evidence sourceId must not be empty"));
        }
    }
    Ok(())
}

fn attach_evidence(connection: &Connection, items: &mut [ProfileItem]) -> ApiResult<()> {
    for item in items {
        let mut statement = connection
            .prepare(
                "SELECT source_kind, source_id, origin_ref, locator, created_at,
                        EXISTS (
                          SELECT 1 FROM profile_source_state s
                          WHERE s.source_kind = profile_evidence.source_kind
                            AND s.source_id = substr(profile_evidence.source_id, 1,
                                  instr(profile_evidence.source_id, '#') - 1)
                            AND s.state = 'invalid') AS withdrawn
                 FROM profile_evidence WHERE item_id = ?1
                 ORDER BY created_at, source_kind, source_id",
            )
            .map_err(sqlite_error)?;
        let rows = statement
            .query_map([&item.id], |row| {
                Ok(Evidence {
                    source_kind: row.get(0)?,
                    source_id: row.get(1)?,
                    origin_ref: row.get(2)?,
                    locator: row.get(3)?,
                    created_at: row.get(4)?,
                    withdrawn: row.get::<_, i64>(5)? != 0,
                })
            })
            .map_err(sqlite_error)?
            .collect::<rusqlite::Result<Vec<Evidence>>>()
            .map_err(sqlite_error)?;
        item.evidence = rows;
    }
    Ok(())
}

fn load(connection: &Connection, id: &str) -> ApiResult<ProfileItem> {
    let sql = format!("{ITEM_SELECT} WHERE id = ?1");
    let item = connection
        .query_row(&sql, [id], map)
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => {
                ApiError::not_found(format!("unknown profile item: {id}"))
            }
            other => sqlite_error(other),
        })?;
    let mut items = vec![item];
    attach_evidence(connection, &mut items)?;
    items
        .pop()
        .ok_or_else(|| ApiError::new(Code::Internal, "profile item vanished"))
}

fn write_evidence(
    transaction: &rusqlite::Transaction<'_>,
    item_id: &str,
    values: &[EvidenceInput],
) -> ApiResult<()> {
    let now = now_ms();
    for value in values {
        transaction
            .execute(
                "INSERT OR IGNORE INTO profile_evidence (item_id, source_kind, source_id, origin_ref, locator, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![item_id, value.source_kind, value.source_id, value.origin_ref, value.locator, now],
            )
            .map_err(sqlite_error)?;
    }
    Ok(())
}

fn find_by_slot(
    connection: &Connection,
    dimension: &str,
    slot: &str,
) -> ApiResult<Option<ProfileItem>> {
    let sql = format!("{ITEM_SELECT} WHERE dimension = ?1 AND slot = ?2 AND slot <> ''");
    match connection.query_row(&sql, params![dimension, slot], map) {
        Ok(item) => Ok(Some(item)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(sqlite_error(error)),
    }
}

fn find_by_value(
    connection: &Connection,
    dimension: &str,
    value: &str,
) -> ApiResult<Option<ProfileItem>> {
    let sql = format!("{ITEM_SELECT} WHERE dimension = ?1 AND value = ?2");
    match connection.query_row(&sql, params![dimension, value], map) {
        Ok(item) => Ok(Some(item)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(sqlite_error(error)),
    }
}

/// Upserts one item keyed by (dimension, value). An automatic writer is refused
/// when the stored item is pinned or corrected, and when the user deleted it.
pub fn save(connection: &mut Connection, params: SaveParams) -> ApiResult<ProfileItem> {
    let dimension = require_text("dimension", &params.dimension)?;
    let value = require_text("value", &params.value)?;
    check_chars("dimension", &dimension, 100)?;
    check_chars("value", &value, 1_000)?;
    check_category(&params.category)?;
    check_evidence(&params.evidence)?;
    let origin = params.origin.as_deref().unwrap_or("manual");
    if !matches!(origin, "manual" | "auto") {
        return Err(ApiError::invalid(format!(
            "unknown profile origin: {origin}"
        )));
    }
    let automatic = origin == "auto";
    let slot = params
        .slot
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| dimension.clone());
    check_chars("slot", &slot, 100)?;
    let key = slot.clone();
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| {
            ApiError::storage(format!("cannot start the profile transaction: {error}"))
        })?;
    let excluded: i64 = transaction
        .query_row(
            "SELECT count(*) FROM exclusions WHERE kind = 'profile' AND key = ?1",
            [&key],
            |row| row.get(0),
        )
        .map_err(sqlite_error)?;
    if automatic && excluded > 0 {
        return Err(ApiError::new(
            Code::ProtectedItem,
            "this profile item was removed by the user and is not rebuilt automatically",
        ));
    }
    let now = now_ms();
    // A slot is the item's identity: saving a new value for the same controlled slot
    // replaces that item instead of creating a second one beside it. The value lookup
    // stays as the legacy path for rows written before slots existed.
    let existing = match find_by_slot(&transaction, &dimension, &slot)? {
        Some(item) => Some(item),
        None => find_by_value(&transaction, &dimension, &value)?,
    };
    let id = match existing {
        Some(item) => {
            if automatic && protected(&item) {
                return Err(ApiError::new(
                    Code::ProtectedItem,
                    "this profile item is pinned or corrected and is not overwritten automatically",
                ));
            }
            transaction
                .execute(
                    "UPDATE profile_items SET value = ?5, category = ?2, origin = ?3, updated_at = ?4,
                     corrected = max(corrected, ?6) WHERE id = ?1",
                    params![
                        item.id,
                        params.category,
                        origin,
                        now,
                        value,
                        // A manual write of a different value is a correction: the
                        // user's word must win over a later automatic restatement.
                        i64::from(!automatic && item.value != value)
                    ],
                )
                .map_err(sqlite_error)?;
            item.id
        }
        None => {
            let id = new_id("prof");
            transaction
                .execute(
                    "INSERT INTO profile_items (id, dimension, value, category, origin, pinned, corrected, slot, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?9, ?8, ?8)",
                    params![
                        id,
                        dimension,
                        value,
                        params.category,
                        origin,
                        i64::from(params.pinned),
                        i64::from(params.corrected),
                        now,
                        slot
                    ],
                )
                .map_err(sqlite_error)?;
            id
        }
    };
    if params.pinned || params.corrected {
        transaction
            .execute(
                "UPDATE profile_items SET pinned = max(pinned, ?2), corrected = max(corrected, ?3) WHERE id = ?1",
                params![id, i64::from(params.pinned), i64::from(params.corrected)],
            )
            .map_err(sqlite_error)?;
    }
    write_evidence(&transaction, &id, &params.evidence)?;
    // A manual write is an explicit decision and overrides an earlier removal.
    if !automatic {
        transaction
            .execute(
                "DELETE FROM exclusions WHERE kind = 'profile' AND key = ?1",
                [&key],
            )
            .map_err(sqlite_error)?;
    }
    crate::util::ensure_not_cancelled()?;
    transaction
        .commit()
        .map_err(|error| ApiError::storage(format!("cannot commit the profile item: {error}")))?;
    load(connection, &id)
}

pub fn update(connection: &mut Connection, params: UpdateParams) -> ApiResult<ProfileItem> {
    check_chars("id", &params.id, 128)?;
    let existing = load(connection, &params.id)?;
    if let Some(category) = params.category.as_deref() {
        check_category(category)?;
    }
    if let Some(evidence) = params.evidence.as_deref() {
        check_evidence(evidence)?;
    }
    let value = match params.value {
        Some(value) => {
            let value = require_text("value", &value)?;
            check_chars("value", &value, 1_000)?;
            value
        }
        None => existing.value.clone(),
    };
    let category = params.category.unwrap_or(existing.category.clone());
    let pinned = params.pinned.unwrap_or(existing.pinned);
    // A hand-written value is a correction, even when the caller only sends the new
    // text: otherwise a late automatic answer would simply restate it away.
    let value_changed = value != existing.value;
    let corrected = params
        .corrected
        .unwrap_or(existing.corrected || value_changed);
    let key = existing.slot.clone();
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| {
            ApiError::storage(format!("cannot start the profile transaction: {error}"))
        })?;
    transaction
        .execute(
            "UPDATE profile_items SET value = ?2, category = ?3, pinned = ?4, corrected = ?5, updated_at = ?6 WHERE id = ?1",
            params![
                params.id,
                value,
                category,
                i64::from(pinned),
                i64::from(corrected),
                now_ms()
            ],
        )
        .map_err(sqlite_error)?;
    if let Some(evidence) = params.evidence {
        write_evidence(&transaction, &params.id, &evidence)?;
    }
    transaction
        .execute(
            "DELETE FROM exclusions WHERE kind = 'profile' AND key = ?1",
            [&key],
        )
        .map_err(sqlite_error)?;
    crate::util::ensure_not_cancelled()?;
    transaction
        .commit()
        .map_err(|error| ApiError::storage(format!("cannot commit the profile item: {error}")))?;
    load(connection, &params.id)
}

/// Removes the item and records the exclusion that stops automatic rebuilds.
pub fn delete(connection: &mut Connection, id: &str) -> ApiResult<bool> {
    check_chars("id", id, 128)?;
    let existing = load(connection, id)?;
    let key = if existing.slot.is_empty() {
        existing.dimension.clone()
    } else {
        existing.slot.clone()
    };
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| {
            ApiError::storage(format!("cannot start the profile transaction: {error}"))
        })?;
    transaction
        .execute(
            "INSERT OR REPLACE INTO exclusions (kind, key, reason, created_at) VALUES ('profile', ?1, 'deleted by the user', ?2)",
            params![key, now_ms()],
        )
        .map_err(sqlite_error)?;
    // Also refuse the value itself, so the same preference cannot come back under a
    // freshly minted slot.
    transaction
        .execute(
            "INSERT OR REPLACE INTO exclusions (kind, key, reason, created_at) VALUES ('profile', ?1, 'deleted by the user', ?2)",
            params![format!("{}={}", existing.dimension, existing.value), now_ms()],
        )
        .map_err(sqlite_error)?;
    transaction
        .execute("DELETE FROM profile_evidence WHERE item_id = ?1", [id])
        .map_err(sqlite_error)?;
    transaction
        .execute("DELETE FROM profile_items WHERE id = ?1", [id])
        .map_err(sqlite_error)?;
    crate::util::ensure_not_cancelled()?;
    transaction
        .commit()
        .map_err(|error| ApiError::storage(format!("cannot commit the profile delete: {error}")))?;
    Ok(true)
}

pub fn get(connection: &Connection, id: &str) -> ApiResult<ProfileItem> {
    check_chars("id", id, 128)?;
    load(connection, id)
}

pub fn list(connection: &Connection, params: ListParams) -> ApiResult<ProfilePage> {
    let (offset, limit) = page(params.offset, params.limit);
    let total: i64 = connection
        .query_row("SELECT count(*) FROM profile_items", [], |row| row.get(0))
        .map_err(sqlite_error)?;
    let sql = format!("{ITEM_SELECT} ORDER BY updated_at DESC, id LIMIT ?1 OFFSET ?2");
    let mut statement = connection.prepare(&sql).map_err(sqlite_error)?;
    let mut items = statement
        .query_map(params![i64::from(limit), i64::from(offset)], map)
        .map_err(sqlite_error)?
        .collect::<rusqlite::Result<Vec<ProfileItem>>>()
        .map_err(sqlite_error)?;
    attach_evidence(connection, &mut items)?;
    let (items, has_more, next_offset) = fit_page(items, total, offset);
    Ok(ProfilePage {
        items,
        total,
        offset,
        limit,
        has_more,
        next_offset,
    })
}
