//! What deleting one original record would cost, and the purge that does it.
//!
//! Both questions are about the same join: a card disappears with a record only
//! when that record was its last valid source. The preview is bounded because the
//! caller renders a handful of rows; the purge itself looks at every card.

use std::collections::BTreeSet;

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

use crate::protocol::{ApiError, ApiResult};
use crate::util::{check_chars, ensure_not_cancelled, now_ms};

/// How many affected cards the preview names; `more` says the rest exist.
const IMPACT_ITEMS: usize = 20;

/// Written to `invalid_reason` so a retracted record explains itself.
const PURGE_REASON: &str = "记录已清除";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImpactParams {
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub channel: Option<String>,
    #[serde(default)]
    pub origin_ref: Option<String>,
    #[serde(default)]
    pub group_key: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImpactItem {
    pub id: String,
    pub title: String,
    pub kind: String,
    /// How many valid sources the card keeps, the matched records included.
    pub sources: i64,
    /// True when every valid source of the card is one of these records, so a
    /// purge of them deletes the card.
    pub single: bool,
}

/// One matched record, ready to be handed straight back to `card.purge`.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImpactSource {
    pub id: String,
    pub version: String,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CardImpact {
    /// The single matched record; empty when the query matched several (a chat
    /// thread) or none — `sources` is the authoritative list then.
    pub source_id: String,
    pub version: String,
    /// Every record the query matched, so a purge needs no second lookup.
    pub sources: Vec<ImpactSource>,
    /// Cards that cite at least one of these records.
    pub cards: i64,
    /// Cards that would be deleted; always `cards - multi`.
    pub single: i64,
    /// Cards that keep another valid source and only lose these links.
    pub multi: i64,
    pub items: Vec<ImpactItem>,
    pub more: bool,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PurgeSource {
    pub id: String,
    pub version: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeParams {
    pub sources: Vec<PurgeSource>,
    pub cards: bool,
}

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct PurgeResult {
    pub removed: Vec<String>,
    pub kept: Vec<String>,
    pub skipped: Vec<String>,
}

fn sqlite(error: rusqlite::Error) -> ApiError {
    ApiError::storage(format!("purge statement failed: {error}"))
}

/// One row per card linked to the matched records, with how many valid sources it
/// keeps overall (`valid`) and how many of those are the matched records
/// (`owned`). A source is valid unless it was retracted, so a card whose only
/// other source is invalid still counts as single: deleting these records would
/// delete it. Both parameters carry the same id array.
const LINKED: &str = "SELECT c.id AS id, c.title AS title, c.kind AS kind,
       c.updated_at AS updated_at,
       (SELECT count(*) FROM card_sources inner_cs
          JOIN sources inner_s ON inner_s.id = inner_cs.source_id
         WHERE inner_cs.card_id = c.id AND inner_s.state <> 'invalid') AS valid,
       (SELECT count(*) FROM card_sources inner_cs
          JOIN sources inner_s ON inner_s.id = inner_cs.source_id
         WHERE inner_cs.card_id = c.id AND inner_s.state <> 'invalid'
           AND inner_s.id IN (SELECT value FROM json_each(?2))) AS owned
  FROM cards c
 WHERE c.id IN (SELECT card_id FROM card_sources
                 WHERE source_id IN (SELECT value FROM json_each(?1)))";

/// Reports what deleting the matched records would do to the cards that cite
/// them, read from the current rows. Newest cards first, matching the card list
/// ranking.
pub fn impact(connection: &Connection, params: ImpactParams) -> ApiResult<CardImpact> {
    let matched = crate::sources::resolve_many(
        connection,
        params.source_id.as_deref(),
        params.channel.as_deref(),
        params.origin_ref.as_deref(),
        params.group_key.as_deref(),
    )?;
    let sources: Vec<ImpactSource> = matched
        .iter()
        .map(|source| ImpactSource {
            id: source.id.clone(),
            version: source.version.clone(),
        })
        .collect();
    let (source_id, version) = match matched.len() {
        1 => (matched[0].id.clone(), matched[0].version.clone()),
        _ => (String::new(), String::new()),
    };
    // A record already retracted threatens no card: its links were dropped when it
    // was retracted, and a purge would skip it. Only live records count here.
    let ids: Vec<String> = matched
        .iter()
        .filter(|source| source.state != "invalid")
        .map(|source| source.id.clone())
        .collect();
    if ids.is_empty() {
        return Ok(CardImpact {
            source_id,
            version,
            sources,
            cards: 0,
            single: 0,
            multi: 0,
            items: Vec::new(),
            more: false,
        });
    }
    let key = serde_json::to_string(&ids)
        .map_err(|error| ApiError::storage(format!("cannot encode the sources: {error}")))?;
    let (cards, single): (i64, i64) = connection
        .query_row(
            &format!(
                "WITH linked AS ({LINKED})
                 SELECT count(*), COALESCE(sum(CASE WHEN valid <= owned THEN 1 ELSE 0 END), 0)
                   FROM linked"
            ),
            params![&key, &key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(sqlite)?;
    let mut statement = connection
        .prepare(&format!(
            "WITH linked AS ({LINKED})
             SELECT id, title, kind, valid, owned FROM linked
              ORDER BY updated_at DESC, id LIMIT ?3"
        ))
        .map_err(sqlite)?;
    let items = statement
        .query_map(params![&key, &key, IMPACT_ITEMS as i64], |row| {
            let valid: i64 = row.get(3)?;
            let owned: i64 = row.get(4)?;
            Ok(ImpactItem {
                id: row.get(0)?,
                title: row.get(1)?,
                kind: row.get(2)?,
                sources: valid,
                single: valid <= owned,
            })
        })
        .map_err(sqlite)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(sqlite)?;
    Ok(CardImpact {
        source_id,
        version,
        sources,
        cards,
        single,
        multi: cards - single,
        more: cards > items.len() as i64,
        items,
    })
}

/// Retracts the listed records and, when asked, deletes the cards left without a
/// valid source.
///
/// The whole call is one transaction, so a failure leaves every row as it was.
/// A record is skipped — with no side effect at all — when its row is missing,
/// was already retracted, or no longer carries the version the caller saw.
pub fn purge(connection: &mut Connection, params: PurgeParams) -> ApiResult<PurgeResult> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| {
            ApiError::storage(format!("cannot start the purge transaction: {error}"))
        })?;
    let now = now_ms();
    let mut purged: BTreeSet<String> = BTreeSet::new();
    let mut skipped: Vec<String> = Vec::new();
    for entry in &params.sources {
        match retract(&transaction, entry, now)? {
            Some(id) => {
                purged.insert(id);
            }
            None => skipped.push(entry.id.clone()),
        }
    }
    let mut removed: BTreeSet<String> = BTreeSet::new();
    let mut kept: BTreeSet<String> = BTreeSet::new();
    for source in &purged {
        for card in linked_cards(&transaction, source)? {
            // The record is already invalid here, so this counts the sources that
            // survive the purge and nothing else.
            let remaining = valid_sources(&transaction, &card)?;
            if params.cards && remaining == 0 {
                // The shared delete path keeps the exclusions, the history and the
                // relation cascade exactly as a manual delete does.
                crate::cards::delete_in(&transaction, &card)?;
                removed.insert(card);
            } else {
                transaction
                    .execute(
                        "DELETE FROM card_sources WHERE card_id = ?1 AND source_id = ?2",
                        params![card, source],
                    )
                    .map_err(sqlite)?;
                kept.insert(card);
            }
        }
    }
    ensure_not_cancelled()?;
    transaction
        .commit()
        .map_err(|error| ApiError::storage(format!("cannot commit the purge: {error}")))?;
    Ok(PurgeResult {
        removed: removed.into_iter().collect(),
        kept: kept.into_iter().collect(),
        skipped,
    })
}

/// Retracts one listed record when it still carries the version the caller saw.
/// Returns its id when it was retracted, `None` when the entry must be skipped
/// without touching anything.
fn retract(transaction: &Connection, entry: &PurgeSource, now: i64) -> ApiResult<Option<String>> {
    check_chars("id", &entry.id, 128)?;
    check_chars("version", &entry.version, 200)?;
    let current = transaction
        .query_row(
            "SELECT state, version FROM sources WHERE id = ?1",
            [&entry.id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(sqlite)?;
    let Some((state, version)) = current else {
        return Ok(None);
    };
    if state == "invalid" || version != entry.version {
        return Ok(None);
    }
    transaction
        .execute(
            "UPDATE sources SET state = 'invalid', invalid_reason = ?2, updated_at = ?3
              WHERE id = ?1",
            params![entry.id, PURGE_REASON, now],
        )
        .map_err(sqlite)?;
    Ok(Some(entry.id.clone()))
}

/// The cards linked to one record, in id order so the result lists are stable.
fn linked_cards(transaction: &Connection, source: &str) -> ApiResult<Vec<String>> {
    let mut statement = transaction
        .prepare("SELECT DISTINCT card_id FROM card_sources WHERE source_id = ?1 ORDER BY card_id")
        .map_err(sqlite)?;
    let cards = statement
        .query_map([source], |row| row.get::<_, String>(0))
        .map_err(sqlite)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(sqlite)?;
    Ok(cards)
}

/// How many sources still count as valid for one card.
fn valid_sources(transaction: &Connection, card: &str) -> ApiResult<i64> {
    transaction
        .query_row(
            "SELECT count(*) FROM card_sources cs JOIN sources s ON s.id = cs.source_id
              WHERE cs.card_id = ?1 AND s.state <> 'invalid'",
            [card],
            |row| row.get(0),
        )
        .map_err(sqlite)
}
