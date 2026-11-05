//! What deleting one original record would cost, and the purge that does it.
//!
//! Both questions are about the same join: a card disappears with a record only
//! when that record was its last valid source. They are also about the same unit —
//! the RECORD, not one source row, because a note keeps a row per published version
//! and a chat thread one row per message. The preview is bounded because the caller
//! renders a handful of rows, and it hands back a ticket so the purge can prove the
//! rows it acts on are still the rows the caller saw.

use std::collections::BTreeSet;

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

use crate::protocol::{ApiError, ApiResult, Code};
use crate::sources::{
    FindParams, RECORD_SOURCES, RecordRef, detach, detach_all, other_owners, owner_ref,
    resolve_record,
};
use crate::util::{check_chars, ensure_not_cancelled, now_ms, sha256_hex};

/// How many affected cards the preview names; `more` says the rest exist.
const IMPACT_ITEMS: usize = 20;

/// Written to `invalid_reason` so a retracted record explains itself.
const PURGE_REASON: &str = "记录已清除";

/// The error a purge returns when the rows moved under the caller.
const STALE: &str = "预览已失效，请重新确认";

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImpactParams {
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

impl ImpactParams {
    fn find(&self) -> FindParams {
        FindParams {
            source_id: self.source_id.clone(),
            note_id: self.note_id.clone(),
            thread_id: self.thread_id.clone(),
            channel: self.channel.clone(),
            origin_ref: self.origin_ref.clone(),
            group_key: self.group_key.clone(),
        }
    }
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImpactItem {
    pub id: String,
    pub title: String,
    pub kind: String,
    /// How many valid sources the card keeps, the matched records included.
    pub sources: i64,
    /// True when every valid source of the card is inside the matched set, so a
    /// purge of it deletes the card.
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
    /// The single matched record; empty when the query matched several (a note with
    /// history, a chat thread) or none — `sources` is the authoritative list then.
    pub source_id: String,
    pub version: String,
    /// Which record this preview is about.
    pub record: RecordRef,
    /// Every record the preview counted, so a purge needs no second lookup.
    pub sources: Vec<ImpactSource>,
    /// Cards that cite at least one live record of this set.
    pub cards: i64,
    /// Cards that would be deleted; always `cards - multi`.
    pub single: i64,
    /// Cards that keep another valid source and only lose these links.
    pub multi: i64,
    pub items: Vec<ImpactItem>,
    pub more: bool,
    /// Sources this record keeps only because another record owns them too. A
    /// delete gives up the claim and leaves the row, its cards and the other
    /// record's evidence untouched.
    pub shared: Vec<String>,
    /// True when the record holds more rows than one answer may carry: the preview
    /// is a slice and must not be confirmed.
    pub incomplete: bool,
    /// A digest of the counted set and the cards it touches, echoed back by
    /// `card.purge`.
    pub ticket: String,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PurgeSource {
    pub id: String,
    pub version: String,
}

/// The snapshot a caller confirms: the rows the preview listed and the ticket that
/// proves nothing moved since.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Confirm {
    #[serde(default)]
    pub sources: Vec<PurgeSource>,
    #[serde(default)]
    pub ticket: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PurgeParams {
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
    /// The older, row-level form: a bare list without a ticket.
    #[serde(default)]
    pub sources: Vec<PurgeSource>,
    #[serde(default)]
    pub confirm: Option<Confirm>,
    #[serde(default)]
    pub cards: bool,
}

impl PurgeParams {
    fn find(&self) -> FindParams {
        FindParams {
            source_id: self.source_id.clone(),
            note_id: self.note_id.clone(),
            thread_id: self.thread_id.clone(),
            channel: self.channel.clone(),
            origin_ref: self.origin_ref.clone(),
            group_key: self.group_key.clone(),
        }
    }
}

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct PurgeResult {
    pub removed: Vec<String>,
    /// Sources kept alive for another record; only the claim was dropped.
    pub detached: Vec<String>,
    pub kept: Vec<String>,
    pub skipped: Vec<String>,
    pub ticket: String,
}

fn sqlite(error: rusqlite::Error) -> ApiError {
    ApiError::storage(format!("purge statement failed: {error}"))
}

/// One row per card linked to the matched records, with how many valid sources it
/// keeps overall (`valid`) and how many of those are inside the matched set
/// (`owned`). A source is valid unless it was retracted, so a card whose only other
/// source is invalid still counts as single: deleting these records would delete
/// it. Both parameters carry the same id array.
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

/// A digest over the matched rows and the cards they touch: same state → same
/// ticket; any version, membership, affected card or surviving-source count change →
/// different ticket.
fn ticket(sources: &[ImpactSource], cards: &[(String, i64)]) -> String {
    let mut text = String::new();
    for source in sources {
        text.push_str(&source.id);
        text.push('\u{1f}');
        text.push_str(&source.version);
        text.push('\n');
    }
    text.push('\u{1e}');
    for (card, valid) in cards {
        text.push_str(card);
        text.push('\t');
        text.push_str(&valid.to_string());
        text.push('\n');
    }
    sha256_hex(&text)
}

fn impact_source(source: &crate::sources::FoundSource) -> ImpactSource {
    ImpactSource {
        id: source.id.clone(),
        version: source.version.clone(),
    }
}

/// The cards one matched set touches, with how many valid sources each keeps, in
/// id order so the ticket is stable.
fn affected(connection: &Connection, ids: &[String]) -> ApiResult<Vec<(String, i64)>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let key = serde_json::to_string(ids)
        .map_err(|error| ApiError::storage(format!("cannot encode the sources: {error}")))?;
    let mut statement = connection
        .prepare(
            "SELECT cs.card_id,
                    (SELECT count(*) FROM card_sources inner_cs
                       JOIN sources inner_s ON inner_s.id = inner_cs.source_id
                      WHERE inner_cs.card_id = cs.card_id AND inner_s.state <> 'invalid') AS valid
               FROM card_sources cs JOIN sources s ON s.id = cs.source_id
              WHERE cs.source_id IN (SELECT value FROM json_each(?1))
                AND s.state <> 'invalid'
              GROUP BY cs.card_id
              ORDER BY cs.card_id",
        )
        .map_err(sqlite)?;
    let cards = statement
        .query_map([&key], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(sqlite)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(sqlite)?;
    Ok(cards)
}

/// Reports what deleting this record would do to the cards that cite it, read from
/// the current rows. Newest cards first, matching the card list ranking.
pub fn impact(connection: &Connection, params: ImpactParams) -> ApiResult<CardImpact> {
    let set = resolve_record(connection, &params.find())?;
    let sources: Vec<ImpactSource> = set.sources.iter().map(impact_source).collect();
    let (source_id, version) = match set.sources.as_slice() {
        [only] => (only.id.clone(), only.version.clone()),
        _ => (String::new(), String::new()),
    };
    // What this record really takes away: the live rows no other record also
    // owns. A material read by two conversations is kept for the other one, so
    // counting it as lost would promise a deletion that never happens.
    let owner = owner_ref(&set.record);
    let mut shared: Vec<String> = Vec::new();
    let mut lost: Vec<String> = Vec::new();
    for source in set
        .sources
        .iter()
        .filter(|source| source.state != "invalid")
    {
        let also = match owner.as_deref() {
            Some(record) => other_owners(connection, &source.id, record)?,
            None => false,
        };
        if also {
            shared.push(source.id.clone());
        } else {
            lost.push(source.id.clone());
        }
    }
    // The digest covers the whole record, shared rows included, so a preview and
    // the purge that confirms it hash exactly the same inputs.
    let touched = affected(connection, &set.ids())?;
    let digest = ticket(&sources, &touched);
    if lost.is_empty() {
        return Ok(CardImpact {
            source_id,
            version,
            record: set.record,
            sources,
            cards: 0,
            single: 0,
            multi: 0,
            items: Vec::new(),
            more: false,
            incomplete: set.incomplete,
            shared,
            ticket: digest,
        });
    }
    let key = serde_json::to_string(&set.ids())
        .map_err(|error| ApiError::storage(format!("cannot encode the sources: {error}")))?;
    let lost_encoded = serde_json::to_string(&lost)
        .map_err(|error| ApiError::storage(format!("cannot encode the sources: {error}")))?;
    let mut statement = connection
        .prepare(&format!(
            "WITH linked AS ({LINKED})
             SELECT id, title, kind, valid, owned FROM linked
              WHERE owned > 0
              ORDER BY updated_at DESC, id"
        ))
        .map_err(sqlite)?;
    let rows = statement
        .query_map(params![&key, &lost_encoded], |row| {
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
        .collect::<rusqlite::Result<Vec<ImpactItem>>>()
        .map_err(sqlite)?;
    let cards = rows.len() as i64;
    let single = rows.iter().filter(|item| item.single).count() as i64;
    let more = rows.len() > IMPACT_ITEMS;
    let items: Vec<ImpactItem> = rows.into_iter().take(IMPACT_ITEMS).collect();
    Ok(CardImpact {
        source_id,
        version,
        record: set.record,
        cards,
        single,
        multi: cards - single,
        items,
        more,
        incomplete: set.incomplete,
        shared,
        sources,
        ticket: digest,
    })
}

/// Retracts the confirmed records and, when asked, deletes the cards left without a
/// valid source.
///
/// The whole call is one transaction, so a failure leaves every row as it was. With
/// a `confirm` block the record is resolved again inside the transaction and the
/// ticket recomputed: anything that moved in between aborts the call untouched. A
/// record is skipped — with no side effect at all — when its row is missing, was
/// already retracted, or no longer carries the version the caller saw.
pub fn purge(connection: &mut Connection, params: PurgeParams) -> ApiResult<PurgeResult> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| {
            ApiError::storage(format!("cannot start the purge transaction: {error}"))
        })?;
    let now = now_ms();
    let (targets, digest, owner) = snapshot(&transaction, &params)?;
    let mut purged: BTreeSet<String> = BTreeSet::new();
    let mut detached: BTreeSet<String> = BTreeSet::new();
    let mut skipped: Vec<String> = Vec::new();
    for entry in &targets {
        // Another record still owns this row: this delete gives up its own claim
        // and leaves the row, its cards and the other record's evidence alone.
        if let Some(record) = owner.as_deref()
            && other_owners(&transaction, &entry.id, record)?
        {
            detach(&transaction, &entry.id, record)?;
            detached.insert(entry.id.clone());
            continue;
        }
        match retract(&transaction, entry, now)? {
            Some(id) => {
                detach_all(&transaction, &id)?;
                purged.insert(id);
            }
            None => skipped.push(entry.id.clone()),
        }
    }
    let mut touched: BTreeSet<String> = BTreeSet::new();
    for source in &purged {
        for card in linked_cards(&transaction, source)? {
            touched.insert(card);
        }
    }
    let list: Vec<String> = purged.iter().cloned().collect();
    let encoded = serde_json::to_string(&list)
        .map_err(|error| ApiError::storage(format!("cannot encode the sources: {error}")))?;
    let mut removed: BTreeSet<String> = BTreeSet::new();
    let mut kept: BTreeSet<String> = BTreeSet::new();
    for card in &touched {
        // Every confirmed record is already invalid here, so this counts exactly
        // the sources that survive the purge.
        let remaining = valid_sources(&transaction, card)?;
        if params.cards && remaining == 0 {
            // The shared delete path keeps the exclusions, the history and the
            // relation cascade exactly as a manual delete does.
            crate::cards::delete_in(&transaction, card)?;
            removed.insert(card.clone());
        } else {
            transaction
                .execute(
                    "DELETE FROM card_sources
                      WHERE card_id = ?1
                        AND source_id IN (SELECT value FROM json_each(?2))",
                    params![card, encoded],
                )
                .map_err(sqlite)?;
            kept.insert(card.clone());
        }
    }
    ensure_not_cancelled()?;
    transaction
        .commit()
        .map_err(|error| ApiError::storage(format!("cannot commit the purge: {error}")))?;
    Ok(PurgeResult {
        removed: removed.into_iter().collect(),
        detached: detached.into_iter().collect(),
        kept: kept.into_iter().collect(),
        skipped,
        ticket: digest,
    })
}

/// The rows this purge may act on, plus the ticket it is acting under.
///
/// A confirmed call re-resolves the record and compares the ticket; an older caller
/// that handed a bare list keeps working, without the guard.
fn snapshot(
    transaction: &Connection,
    params: &PurgeParams,
) -> ApiResult<(Vec<PurgeSource>, String, Option<String>)> {
    let Some(confirm) = params.confirm.as_ref() else {
        let targets = params.sources.clone();
        let ids: Vec<String> = targets.iter().map(|entry| entry.id.clone()).collect();
        let cards = affected(transaction, &ids)?;
        let sources: Vec<ImpactSource> = targets
            .iter()
            .map(|entry| ImpactSource {
                id: entry.id.clone(),
                version: entry.version.clone(),
            })
            .collect();
        return Ok((targets, ticket(&sources, &cards), None));
    };
    let set = resolve_record(transaction, &params.find())?;
    if set.incomplete {
        return Err(ApiError::new(
            Code::TooLarge,
            format!("这条记录超过 {RECORD_SOURCES} 条来源，无法一次确认清除"),
        ));
    }
    let sources: Vec<ImpactSource> = set.sources.iter().map(impact_source).collect();
    let expected = ticket(&sources, &affected(transaction, &set.ids())?);
    let listed: Vec<(String, String)> = confirm
        .sources
        .iter()
        .map(|entry| (entry.id.clone(), entry.version.clone()))
        .collect();
    let counted: Vec<(String, String)> = sources
        .iter()
        .map(|entry| (entry.id.clone(), entry.version.clone()))
        .collect();
    if confirm.ticket != expected || listed != counted {
        return Err(ApiError::new(Code::SourceChanged, STALE));
    }
    let owner = owner_ref(&set.record);
    let targets = sources
        .into_iter()
        .map(|entry| PurgeSource {
            id: entry.id,
            version: entry.version,
        })
        .collect();
    Ok((targets, expected, owner))
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
