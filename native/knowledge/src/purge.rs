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
use crate::queue::settle_after;
use crate::sources::{
    FindParams, RECORD_SOURCES, RecordRef, detach, exclusive, other_owners, owner_ref,
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
    /// Queued work that lost its last valid source and stopped with this purge.
    pub cancelled: Vec<String>,
    pub ticket: String,
}

fn sqlite(error: rusqlite::Error) -> ApiError {
    ApiError::storage(format!("purge statement failed: {error}"))
}

/// One row per card linked to the rows this record alone supports, with how many
/// valid sources the card keeps overall (`valid`) and how many of those are inside
/// that set (`owned`). A source is valid unless it was retracted, so a card whose
/// only other source is invalid still counts as single: deleting these rows would
/// delete it.
const LINKED: &str = "SELECT c.id AS id, c.title AS title, c.kind AS kind,
       c.updated_at AS updated_at,
       (SELECT count(*) FROM card_sources inner_cs
          JOIN sources inner_s ON inner_s.id = inner_cs.source_id
         WHERE inner_cs.card_id = c.id AND inner_s.state <> 'invalid') AS valid,
       (SELECT count(*) FROM card_sources inner_cs
          JOIN sources inner_s ON inner_s.id = inner_cs.source_id
         WHERE inner_cs.card_id = c.id AND inner_s.state <> 'invalid'
           AND inner_s.id IN (SELECT value FROM json_each(?1))) AS owned
  FROM cards c
 WHERE c.id IN (SELECT card_id FROM card_sources
                 WHERE source_id IN (SELECT value FROM json_each(?1)))";

/// The cards one set of rows touches, newest first, with the counts the preview
/// shows and the digest needs.
fn card_rows(connection: &Connection, ids: &[String]) -> ApiResult<Vec<ImpactItem>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let encoded = serde_json::to_string(ids)
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
        .query_map([&encoded], |row| {
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
    Ok(rows)
}

/// The digest a preview hands back and a purge re-checks: which record it is about,
/// every row the record holds with the version the user saw, which of those rows
/// only this record still supports, and the cards the purge would delete or merely
/// unlink. Two previews of the same record that would do different things can never
/// share a ticket, so a confirmation can only carry out the preview the user read.
fn ticket(
    record: &RecordRef,
    sources: &[ImpactSource],
    shared: &[String],
    lost: &[String],
    remove: &[String],
    keep: &[String],
) -> String {
    let mut text = String::new();
    text.push_str(&record.channel);
    text.push('\u{1f}');
    text.push_str(record.origin_ref.as_deref().unwrap_or(""));
    text.push('\u{1f}');
    text.push_str(record.group_key.as_deref().unwrap_or(""));
    text.push('\n');
    for source in sources {
        text.push_str(&source.id);
        text.push('\u{1f}');
        text.push_str(&source.version);
        text.push('\n');
    }
    text.push('\u{1e}');
    for group in [shared, lost] {
        for id in group {
            text.push_str(id);
            text.push('\n');
        }
        text.push('\u{1d}');
    }
    // Card lists are hashed in id order: the preview sorts them for reading, and a
    // re-ranking alone must not invalidate a ticket the user is looking at.
    for group in [remove, keep] {
        let mut ids: Vec<&String> = group.iter().collect();
        ids.sort();
        for id in ids {
            text.push_str(id);
            text.push('\n');
        }
        text.push('\u{1d}');
    }
    sha256_hex(&text)
}

fn impact_source(source: &crate::sources::FoundSource) -> ImpactSource {
    ImpactSource {
        id: source.id.clone(),
        version: source.version.clone(),
    }
}

/// Everything deleting one record would do, read from the rows in one place so the
/// preview, the confirmation check and the purge itself describe the same work.
struct Effect {
    record: RecordRef,
    /// The whole matched set, oldest first, with the versions the preview showed.
    sources: Vec<ImpactSource>,
    /// Live rows another record also owns: this delete only gives up its claim.
    shared: Vec<String>,
    /// Live rows this record alone supports: they are retired.
    lost: Vec<String>,
    /// Rows of this record that were already gone: the purge reports them as skipped.
    gone: Vec<String>,
    /// Cards left without any valid source: the purge deletes them.
    remove: Vec<String>,
    /// Cards that keep another valid source and only lose these links.
    keep: Vec<String>,
    items: Vec<ImpactItem>,
    more: bool,
    incomplete: bool,
    ticket: String,
}

impl Effect {
    fn single(&self) -> i64 {
        self.remove.len() as i64
    }

    fn cards(&self) -> i64 {
        self.remove.len() as i64 + self.keep.len() as i64
    }

    fn into_impact(self, source_id: String, version: String) -> CardImpact {
        let cards = self.cards();
        let single = self.single();
        CardImpact {
            source_id,
            version,
            record: self.record,
            sources: self.sources,
            cards,
            single,
            multi: cards - single,
            items: self.items,
            more: self.more,
            shared: self.shared,
            incomplete: self.incomplete,
            ticket: self.ticket,
        }
    }
}

/// Reads what deleting this record would do, from the rows as they are now.
fn describe(connection: &Connection, find: &FindParams) -> ApiResult<Effect> {
    let set = resolve_record(connection, find)?;
    let sources: Vec<ImpactSource> = set.sources.iter().map(impact_source).collect();
    // A material another record also owns is not this record's to retire: counting
    // it as lost would promise a deletion that never happens, and would let a stale
    // ticket delete a card the other record still needs.
    let owner = owner_ref(&set.record);
    // Ownership is asked about every row of the record, retired ones included: a row
    // the record already gave up still belongs to it in this question, and letting
    // its state decide would make the ticket move whenever the record's own rows
    // were retired — the preview would then always look stale to the purge that
    // follows the very deletion it was shown for.
    let mut shared: Vec<String> = Vec::new();
    let mut claimed: Vec<String> = Vec::new();
    let gone: Vec<String> = set
        .sources
        .iter()
        .filter(|source| source.state == "invalid")
        .map(|source| source.id.clone())
        .collect();
    for source in &set.sources {
        // Shared unless this record alone proves the row: another claim protects it,
        // and a claim older databases could only guess is never proof enough to
        // retire a source or delete a card that cites it.
        let also = match owner.as_deref() {
            Some(record) => {
                !exclusive(connection, &source.id, record)?
                    || other_owners(connection, &source.id, record)?
            }
            None => false,
        };
        if also {
            shared.push(source.id.clone());
        } else {
            claimed.push(source.id.clone());
        }
    }
    // What the purge may actually retire: the claimed rows that are still read.
    let lost: Vec<String> = set
        .sources
        .iter()
        .filter(|source| source.state != "invalid")
        .map(|source| source.id.clone())
        .filter(|id| claimed.contains(id))
        .collect();
    let rows = card_rows(connection, &lost)?;
    let remove: Vec<String> = rows
        .iter()
        .filter(|item| item.single)
        .map(|item| item.id.clone())
        .collect();
    let keep: Vec<String> = rows
        .iter()
        .filter(|item| !item.single)
        .map(|item| item.id.clone())
        .collect();
    let more = rows.len() > IMPACT_ITEMS;
    let items: Vec<ImpactItem> = rows.into_iter().take(IMPACT_ITEMS).collect();
    // The ticket answers one thing: is this still the record the user looked at? It
    // counts every row the record holds, which ones another record also owns, and
    // the cards those rows support — none of it depending on whether a row is still
    // readable, so retiring the record's own rows cannot invalidate its own preview.
    let stable = card_rows(connection, &claimed)?;
    let mut stable_remove: Vec<String> = Vec::new();
    let mut stable_keep: Vec<String> = Vec::new();
    for item in &stable {
        if item.single {
            stable_remove.push(item.id.clone());
        } else {
            stable_keep.push(item.id.clone());
        }
    }
    let digest = ticket(
        &set.record,
        &sources,
        &shared,
        &claimed,
        &stable_remove,
        &stable_keep,
    );
    Ok(Effect {
        record: set.record,
        sources,
        shared,
        lost,
        gone,
        remove,
        keep,
        items,
        more,
        incomplete: set.incomplete,
        ticket: digest,
    })
}

/// The older, row-level form: a bare list of rows, with no record to ask about
/// ownership. It still works for callers that hold ids and nothing else.
fn listed_effect(connection: &Connection, listed: &[PurgeSource]) -> ApiResult<Effect> {
    // The older form carries no ticket, so the rows alone decide what may go: a row
    // that moved to another version, was already retracted or never existed stays
    // untouched and is reported as skipped. Counting it as lost would delete a card
    // that only the row it names still supports.
    let mut lost: Vec<String> = Vec::new();
    let mut gone: Vec<String> = Vec::new();
    for entry in listed {
        match state_of(connection, &entry.id)? {
            Some((state, version)) if state != "invalid" && version == entry.version => {
                lost.push(entry.id.clone());
            }
            _ => gone.push(entry.id.clone()),
        }
    }
    let sources: Vec<ImpactSource> = listed
        .iter()
        .map(|entry| ImpactSource {
            id: entry.id.clone(),
            version: entry.version.clone(),
        })
        .collect();
    let rows = card_rows(connection, &lost)?;
    let remove: Vec<String> = rows
        .iter()
        .filter(|item| item.single)
        .map(|item| item.id.clone())
        .collect();
    let keep: Vec<String> = rows
        .iter()
        .filter(|item| !item.single)
        .map(|item| item.id.clone())
        .collect();
    let more = rows.len() > IMPACT_ITEMS;
    let items: Vec<ImpactItem> = rows.into_iter().take(IMPACT_ITEMS).collect();
    let record = RecordRef::default();
    let digest = ticket(&record, &sources, &[], &lost, &remove, &keep);
    Ok(Effect {
        record,
        sources,
        shared: Vec::new(),
        lost,
        gone,
        remove,
        keep,
        items,
        more,
        incomplete: false,
        ticket: digest,
    })
}

/// Reports what deleting this record would do to the cards that cite it, read from
/// the current rows. Newest cards first, matching the card list ranking.
pub fn impact(connection: &Connection, params: ImpactParams) -> ApiResult<CardImpact> {
    let effect = describe(connection, &params.find())?;
    let (source_id, version) = match effect.sources.as_slice() {
        [only] => (only.id.clone(), only.version.clone()),
        _ => (String::new(), String::new()),
    };
    Ok(effect.into_impact(source_id, version))
}

/// Retracts the confirmed record and, when asked, deletes the cards left without a
/// valid source.
///
/// The whole call is one transaction, so a failure leaves every row as it was. A
/// confirmed call describes the record again inside the transaction and compares
/// the ticket: anything that moved in between — a version, another reader's claim,
/// a card that appeared or lost its last other source — aborts the call untouched.
/// The queues are settled inside the same transaction from the rows as they stand,
/// so work that lost its last live row stops here and work another record still
/// needs keeps running.
pub fn purge(connection: &mut Connection, params: PurgeParams) -> ApiResult<PurgeResult> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| {
            ApiError::storage(format!("cannot start the purge transaction: {error}"))
        })?;
    let now = now_ms();
    let effect = match params.confirm.as_ref() {
        Some(_) => describe(&transaction, &params.find())?,
        None => listed_effect(&transaction, &params.sources)?,
    };
    if let Some(confirm) = params.confirm.as_ref() {
        if effect.incomplete {
            return Err(ApiError::new(
                Code::TooLarge,
                format!("这条记录超过 {RECORD_SOURCES} 条来源，无法一次确认清除"),
            ));
        }
        // The ticket already digests the rows the preview counted, so echoing the
        // ticket alone is a full check against the same set. A caller that also
        // lists rows is held to a row-for-row match, which is how the older block
        // form stayed honest.
        let mut moved = confirm.ticket != effect.ticket;
        if !moved && !confirm.sources.is_empty() {
            let listed: Vec<(String, String)> = confirm
                .sources
                .iter()
                .map(|entry| (entry.id.clone(), entry.version.clone()))
                .collect();
            let counted: Vec<(String, String)> = effect
                .sources
                .iter()
                .map(|entry| (entry.id.clone(), entry.version.clone()))
                .collect();
            moved = listed != counted;
        }
        if moved {
            return Err(ApiError::new(Code::SourceChanged, STALE));
        }
    }
    let owner = owner_ref(&effect.record);
    let mut detached: BTreeSet<String> = BTreeSet::new();
    let mut purged: BTreeSet<String> = BTreeSet::new();
    // Rows of this record that were already gone are reported, not re-retracted:
    // a second confirmed purge says exactly what it skipped.
    let mut skipped: Vec<String> = effect.gone.clone();
    // Which rows may really go is settled before any card is judged: a row that
    // moved, was already retracted or never existed is skipped, and a row that is
    // skipped must not take its card, links or relations with it.
    let mut retirable: Vec<String> = Vec::new();
    for id in &effect.lost {
        let version = version_of(&effect.sources, id);
        match state_of(&transaction, id)? {
            Some((state, current)) if state != "invalid" && current == version => {
                retirable.push(id.clone());
            }
            _ => skipped.push(id.clone()),
        }
    }
    let rows = card_rows(&transaction, &retirable)?;
    let remove: Vec<String> = rows
        .iter()
        .filter(|item| item.single)
        .map(|item| item.id.clone())
        .collect();
    let keep: Vec<String> = rows
        .iter()
        .filter(|item| !item.single)
        .map(|item| item.id.clone())
        .collect();
    for id in &effect.shared {
        // Another record still owns this row: only this record's claim goes.
        if let Some(record) = owner.as_deref() {
            detach(&transaction, id, record)?;
            detached.insert(id.clone());
        }
    }
    for id in &retirable {
        let listed = PurgeSource {
            id: id.clone(),
            version: version_of(&effect.sources, id),
        };
        match retract(&transaction, &listed, now)? {
            Some(retired) => {
                purged.insert(retired);
            }
            // The checks above and this retraction share one transaction, so a row
            // that moved in between means the transaction is not the one we read.
            None => return Err(ApiError::new(Code::SourceChanged, STALE)),
        }
    }
    let list: Vec<String> = purged.iter().cloned().collect();
    let encoded = serde_json::to_string(&list)
        .map_err(|error| ApiError::storage(format!("cannot encode the sources: {error}")))?;
    let mut removed: BTreeSet<String> = BTreeSet::new();
    if params.cards {
        for card in &remove {
            // The shared delete path keeps the exclusions, the history and the
            // relation cascade exactly as a manual delete does.
            crate::cards::delete_in(&transaction, card)?;
            removed.insert(card.clone());
        }
    }
    // A card that keeps another valid source only loses the links to the rows that
    // just went. When the user did not tick the delete, the doomed cards stay too
    // and keep their now invalid links, exactly as the default path does.
    let mut unlinked: Vec<String> = keep;
    if !params.cards {
        unlinked.extend(remove.iter().cloned());
    }
    // Nothing was retired, so there is no link to drop: the rows the caller listed
    // turned out to have moved and were skipped instead.
    let mut kept: BTreeSet<String> = BTreeSet::new();
    if !list.is_empty() {
        for card in &unlinked {
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
    let cancelled = settle_after(&transaction, PURGE_REASON, owner.as_deref(), &list)?;
    transaction
        .commit()
        .map_err(|error| ApiError::storage(format!("cannot commit the purge: {error}")))?;
    Ok(PurgeResult {
        removed: removed.into_iter().collect(),
        detached: detached.into_iter().collect(),
        kept: kept.into_iter().collect(),
        skipped,
        cancelled,
        ticket: effect.ticket,
    })
}

/// The version a preview listed for one row.
fn version_of(sources: &[ImpactSource], id: &str) -> String {
    sources
        .iter()
        .find(|entry| entry.id == id)
        .map(|entry| entry.version.clone())
        .unwrap_or_default()
}

/// The state and version a row carries now, or nothing when the row is gone.
fn state_of(connection: &Connection, id: &str) -> ApiResult<Option<(String, String)>> {
    connection
        .query_row(
            "SELECT state, version FROM sources WHERE id = ?1",
            [id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(sqlite)
}

/// Retracts one listed record when it still carries the version the caller saw.
/// Returns its id when it was retracted, `None` when the entry must be skipped
/// without touching anything.
fn retract(transaction: &Connection, entry: &PurgeSource, now: i64) -> ApiResult<Option<String>> {
    check_chars("id", &entry.id, 128)?;
    check_chars("version", &entry.version, 200)?;
    let Some((state, version)) = state_of(transaction, &entry.id)? else {
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
