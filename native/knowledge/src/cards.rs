//! Knowledge cards: shared storage, editing and search.
//!
//! All seven card kinds share one table and one editing path; the kind only
//! groups and filters. Extraction strategy per kind arrives in a later stage.

use std::collections::BTreeMap;

use rusqlite::types::Value;
use rusqlite::{
    Connection, OptionalExtension, Row, Transaction, TransactionBehavior, params, params_from_iter,
};
use serde::{Deserialize, Serialize};

use crate::protocol::{
    ApiError, ApiResult, Code, MAX_BODY_CHARS, MAX_FRAME_BYTES, MAX_QUERY_CHARS, MAX_SUMMARY_CHARS,
    MAX_TITLE_CHARS, MAX_TOPIC_CHARS, MAX_TOPICS, fit_page,
};
use crate::store::CARD_KINDS;
use crate::util::{check_chars, new_id, now_ms, page, require_text};

const CARD_SELECT: &str = "SELECT c.id, c.kind, c.title, c.summary, c.body, c.topics, c.aliases, c.edited, c.created_at, c.updated_at, c.revision,
       (SELECT group_concat(source_id) FROM card_sources WHERE card_id = c.id) AS source_ids,
       c.favorite
  FROM cards c";

/// A listing never carries the body: eleven legal cards of 200,000 characters
/// would otherwise exceed one frame and fail the whole page. `length(c.body)`
/// tells a caller whether there is a body worth fetching.
const CARD_LIST_SELECT: &str = "SELECT c.id, c.kind, c.title, c.summary, c.topics, c.aliases, c.edited, c.created_at, c.updated_at,
       length(c.body) AS body_chars,
       (SELECT group_concat(source_id) FROM card_sources WHERE card_id = c.id) AS source_ids,
       c.revision, c.favorite
  FROM cards c";

/// `topic.list` returns the most used topics first; a knowledge base with more
/// than this many topics answers with the head of that list.
const DEFAULT_TOPIC_COUNT: u32 = 50;
const MAX_TOPIC_COUNT: u32 = 200;
/// Revisions one card returns; the oldest are dropped, and the frame budget may
/// drop more.
const DEFAULT_REVISIONS: u32 = 10;
const MAX_REVISIONS: u32 = 20;
/// Room left in a frame for the envelope around the payload.
const FRAME_HEADROOM: usize = 4_096;

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub summary: String,
    pub body: String,
    pub topics: Vec<String>,
    pub aliases: Vec<String>,
    pub source_ids: Vec<String>,
    /// Persisted favourite mark. It is a human label, not a content edit.
    pub favorite: bool,
    pub edited: bool,
    /// Bumped by every write, so a proposal can say which version it applies to.
    pub revision: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// One row of a card listing: everything the list view needs, without the body.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CardSummary {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub summary: String,
    pub topics: Vec<String>,
    pub aliases: Vec<String>,
    pub source_ids: Vec<String>,
    pub body_chars: i64,
    pub favorite: bool,
    pub edited: bool,
    /// Bumped by every write, so a proposal can say which version it applies to.
    pub revision: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// `hasMore` and `nextOffset` describe what the helper actually returned, so a
/// caller that asked for 100 items never skips the ones dropped by the byte
/// budget: the next request starts at `nextOffset`, not at `offset + limit`.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CardPage {
    pub items: Vec<CardSummary>,
    pub total: i64,
    pub offset: u32,
    pub limit: u32,
    pub has_more: bool,
    pub next_offset: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveParams {
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub topics: Vec<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub source_ids: Vec<String>,
    #[serde(default)]
    pub edited: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateParams {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub topics: Option<Vec<String>>,
    #[serde(default)]
    pub aliases: Option<Vec<String>>,
    #[serde(default)]
    pub source_ids: Option<Vec<String>>,
    /// A favourite flip is not a content edit: it touches neither `revision` nor
    /// `edited`, and only moves `updated_at`.
    #[serde(default)]
    pub favorite: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListParams {
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub topic: Option<String>,
    #[serde(default)]
    pub favorite: Option<bool>,
    #[serde(default)]
    pub offset: Option<u32>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchParams {
    pub query: String,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub topic: Option<String>,
    #[serde(default)]
    pub favorite: Option<bool>,
    #[serde(default)]
    pub offset: Option<u32>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicParams {
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TopicCount {
    pub topic: String,
    pub count: i64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TopicList {
    pub topics: Vec<TopicCount>,
    /// Distinct topics, before the limit trimmed the list.
    pub total: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionsParams {
    pub id: String,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CardRevision {
    pub revision: i64,
    pub title: String,
    pub summary: String,
    pub body: String,
    pub topics: Vec<String>,
    pub edited: bool,
    pub created_at: i64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CardRevisions {
    pub id: String,
    pub revisions: Vec<CardRevision>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeParams {
    pub keep_id: String,
    pub merge_id: String,
    pub keep_revision: i64,
    pub merge_revision: i64,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MergedCards {
    pub card: Card,
    pub removed_id: String,
    /// Sources on the kept card after the merge.
    pub sources: i64,
    /// Relations on the kept card after the merge.
    pub relations: i64,
    /// `request` when the caller typed the body, `keep` when the kept card's own
    /// text survived: a preview can say which text the merge keeps.
    pub body_source: &'static str,
    /// The head of the stored body, so a panel can label the result without
    /// loading 200,000 characters on every merge.
    pub preview: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportParams {
    pub id: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CardExport {
    pub id: String,
    pub filename: String,
    pub markdown: String,
}

fn sqlite_error(error: rusqlite::Error) -> ApiError {
    ApiError::storage(format!("card statement failed: {error}"))
}

pub(crate) fn decode_list(text: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(text).unwrap_or_default()
}

fn map(row: &Row<'_>) -> rusqlite::Result<Card> {
    let topics: String = row.get(5)?;
    let aliases: String = row.get(6)?;
    let source_ids: Option<String> = row.get(11)?;
    let mut source_ids: Vec<String> = source_ids
        .unwrap_or_default()
        .split(',')
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect();
    source_ids.sort();
    Ok(Card {
        id: row.get(0)?,
        kind: row.get(1)?,
        title: row.get(2)?,
        summary: row.get(3)?,
        body: row.get(4)?,
        topics: decode_list(&topics),
        aliases: decode_list(&aliases),
        source_ids,
        favorite: row.get::<_, i64>(12)? != 0,
        edited: row.get::<_, i64>(7)? != 0,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        revision: row.get(10)?,
    })
}

fn map_summary(row: &Row<'_>) -> rusqlite::Result<CardSummary> {
    let topics: String = row.get(4)?;
    let aliases: String = row.get(5)?;
    let source_ids: Option<String> = row.get(10)?;
    let mut source_ids: Vec<String> = source_ids
        .unwrap_or_default()
        .split(',')
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect();
    source_ids.sort();
    Ok(CardSummary {
        id: row.get(0)?,
        kind: row.get(1)?,
        title: row.get(2)?,
        summary: row.get(3)?,
        topics: decode_list(&topics),
        aliases: decode_list(&aliases),
        edited: row.get::<_, i64>(6)? != 0,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
        body_chars: row.get(9)?,
        source_ids,
        favorite: row.get::<_, i64>(12)? != 0,
        revision: row.get(11)?,
    })
}

fn check_kind(kind: &str) -> ApiResult<()> {
    if CARD_KINDS.contains(&kind) {
        Ok(())
    } else {
        Err(ApiError::invalid(format!("unknown card kind: {kind}")))
    }
}

fn check_terms(field: &str, values: &[String]) -> ApiResult<()> {
    if values.len() > crate::protocol::MAX_TOPICS {
        return Err(ApiError::new(
            Code::TooLarge,
            format!("{field} exceeds {} entries", crate::protocol::MAX_TOPICS),
        ));
    }
    for value in values {
        check_chars(field, value, crate::protocol::MAX_TOPIC_CHARS)?;
    }
    Ok(())
}

fn encode_list(values: &[String]) -> ApiResult<String> {
    serde_json::to_string(values).map_err(|error| {
        ApiError::new(
            Code::Internal,
            format!("cannot encode the term list: {error}"),
        )
    })
}

/// Accumulates conditions and their bindings in one order, so a statement with
/// an optional filter never has to guess placeholder numbers. Every condition is
/// `?N`-numbered and the values are bound in the same sequence.
pub(crate) struct Where {
    conditions: String,
    values: Vec<Value>,
}

impl Where {
    pub(crate) fn new() -> Where {
        Where {
            conditions: String::new(),
            values: Vec::new(),
        }
    }

    /// Binds one value and answers its placeholder, so a condition can use the
    /// same value twice (`LIKE ?1 ... OR ... LIKE ?1`).
    pub(crate) fn bind(&mut self, value: Value) -> String {
        self.values.push(value);
        format!("?{}", self.values.len())
    }

    pub(crate) fn and(&mut self, condition: String) {
        if !self.conditions.is_empty() {
            self.conditions.push_str(" AND ");
        }
        self.conditions.push_str(&condition);
    }

    /// Empty when nothing was added, so callers can concatenate it directly.
    pub(crate) fn sql(&self) -> String {
        if self.conditions.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", self.conditions)
        }
    }

    pub(crate) fn values(&self) -> &[Value] {
        &self.values
    }
}

/// Which cards a listing shows. Every filter runs in SQL, so `total` and the
/// page describe the same set.
pub(crate) struct Filter {
    kind: Option<String>,
    topic: Option<String>,
    favorite: Option<bool>,
}

impl Filter {
    pub(crate) fn new(
        kind: Option<&str>,
        topic: Option<&str>,
        favorite: Option<bool>,
    ) -> ApiResult<Filter> {
        let kind = match kind.filter(|value| !value.is_empty()) {
            Some(kind) => {
                check_kind(kind)?;
                Some(kind.to_string())
            }
            None => None,
        };
        let topic = match topic.filter(|value| !value.trim().is_empty()) {
            Some(topic) => {
                check_chars("topic", topic, MAX_TOPIC_CHARS)?;
                Some(topic.to_string())
            }
            None => None,
        };
        Ok(Filter {
            kind,
            topic,
            favorite,
        })
    }

    pub(crate) fn apply(&self, target: &mut Where) {
        if let Some(kind) = &self.kind {
            let at = target.bind(Value::Text(kind.clone()));
            target.and(format!("c.kind = {at}"));
        }
        if let Some(topic) = &self.topic {
            let at = target.bind(Value::Text(topic.clone()));
            target.and(format!(
                "EXISTS (SELECT 1 FROM json_each(c.topics) WHERE json_each.value = {at})"
            ));
        }
        if let Some(favorite) = self.favorite {
            let flag = if favorite { 1 } else { 0 };
            target.and(format!("c.favorite = {flag}"));
        }
    }
}

/// How the text query is answered. Queries shorter than one trigram (1-2
/// characters, which covers two-character Chinese words) cannot use the index
/// and fall back to a literal LIKE scan.
pub(crate) enum Plan {
    All,
    Like(String),
    Fts(String),
}

pub(crate) fn plan_for(query: &str) -> ApiResult<Plan> {
    check_chars("query", query, MAX_QUERY_CHARS)?;
    let query = query.trim();
    if query.is_empty() {
        Ok(Plan::All)
    } else if query.chars().count() < 3 {
        Ok(Plan::Like(like_pattern(query)))
    } else {
        Ok(Plan::Fts(fts_phrase(query)))
    }
}

/// Adds the query condition to `target` and answers the JOIN the statement
/// needs. Ranking stays in the caller's ORDER BY.
pub(crate) fn plan_condition(plan: &Plan, target: &mut Where) -> &'static str {
    match plan {
        Plan::All => "",
        Plan::Like(pattern) => {
            let at = target.bind(Value::Text(pattern.clone()));
            target.and(format!(
                "(c.title LIKE {at} ESCAPE '\\' OR c.summary LIKE {at} ESCAPE '\\'
                  OR c.body LIKE {at} ESCAPE '\\' OR c.topics LIKE {at} ESCAPE '\\'
                  OR c.aliases LIKE {at} ESCAPE '\\')"
            ));
            ""
        }
        Plan::Fts(phrase) => {
            let at = target.bind(Value::Text(phrase.clone()));
            target.and(format!("cards_fts MATCH {at}"));
            " JOIN cards_fts ON cards_fts.card_id = c.id"
        }
    }
}

/// Restricts a listing to the cards generated from the given original records,
/// ignoring links whose source row was invalidated: a retracted record no longer
/// claims the cards it once produced. An empty list restricts nothing.
fn limit_to_sources(target: &mut Where, sources: &[String]) {
    if sources.is_empty() {
        return;
    }
    let ids = serde_json::to_string(sources).unwrap_or_else(|_| "[]".to_string());
    let at = target.bind(Value::Text(ids));
    target.and(format!(
        "c.id IN (SELECT cs.card_id FROM card_sources cs JOIN sources s ON s.id = cs.source_id
                   WHERE cs.source_id IN (SELECT value FROM json_each({at}))
                     AND s.state <> 'invalid')"
    ));
}

/// One page of the filtered, ordered listing, with every filter already applied
/// to both the page and its count. `sources` restricts the listing to the cards
/// extracted from those original records — a chat thread passes several, a note
/// one — and the join runs before the count and before paging, so `total` is the
/// real number of cards those records produced.
fn query_page(
    connection: &Connection,
    filter: &Filter,
    plan: &Plan,
    sources: &[String],
    offset: u32,
    limit: u32,
) -> ApiResult<CardPage> {
    let mut counting = Where::new();
    let join = plan_condition(plan, &mut counting);
    limit_to_sources(&mut counting, sources);
    filter.apply(&mut counting);
    let total: i64 = connection
        .query_row(
            &format!("SELECT count(*) FROM cards c{join}{}", counting.sql()),
            params_from_iter(counting.values().iter()),
            |row| row.get(0),
        )
        .map_err(sqlite_error)?;
    let mut paging = Where::new();
    let join = plan_condition(plan, &mut paging);
    limit_to_sources(&mut paging, sources);
    filter.apply(&mut paging);
    let ranking = match plan {
        Plan::All => "c.updated_at DESC, c.id".to_string(),
        Plan::Like(pattern) => {
            let at = paging.bind(Value::Text(pattern.clone()));
            format!(
                "CASE WHEN c.title LIKE {at} ESCAPE '\\' OR c.aliases LIKE {at} ESCAPE '\\'
                    OR c.topics LIKE {at} ESCAPE '\\' THEN 0 ELSE 1 END, c.updated_at DESC, c.id"
            )
        }
        Plan::Fts(_) => {
            "bm25(cards_fts, 0.0, 10.0, 4.0, 1.0, 8.0, 8.0), c.updated_at DESC, c.id".to_string()
        }
    };
    let limit_at = paging.bind(Value::Integer(i64::from(limit)));
    let offset_at = paging.bind(Value::Integer(i64::from(offset)));
    let sql = format!(
        "{CARD_LIST_SELECT}{join}{} ORDER BY {ranking} LIMIT {limit_at} OFFSET {offset_at}",
        paging.sql()
    );
    let mut statement = connection.prepare(&sql).map_err(sqlite_error)?;
    let rows = statement
        .query_map(params_from_iter(paging.values().iter()), map_summary)
        .map_err(sqlite_error)?
        .collect::<rusqlite::Result<Vec<CardSummary>>>()
        .map_err(sqlite_error)?;
    let (items, has_more, next_offset) = fit_page(rows, total, offset);
    Ok(CardPage {
        items,
        total,
        offset,
        limit,
        has_more,
        next_offset,
    })
}

/// Writes the search row for one card. The FTS table carries the card id so an
/// update can replace exactly one row.
fn index(transaction: &Transaction<'_>, card: &Card) -> ApiResult<()> {
    transaction
        .execute("DELETE FROM cards_fts WHERE card_id = ?1", [&card.id])
        .map_err(sqlite_error)?;
    transaction
        .execute(
            "INSERT INTO cards_fts (card_id, title, summary, body, topics, aliases) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                card.id,
                card.title,
                card.summary,
                card.body,
                card.topics.join(" "),
                card.aliases.join(" ")
            ],
        )
        .map_err(sqlite_error)?;
    Ok(())
}

/// Rewrites the search row of one card from its stored columns. Extraction
/// merges a card without holding a `Card` value, so the row is rebuilt by
/// re-reading it instead of duplicating the insert statement.
pub(crate) fn reindex(connection: &Connection, card_id: &str) -> ApiResult<()> {
    connection
        .execute("DELETE FROM cards_fts WHERE card_id = ?1", [card_id])
        .map_err(sqlite_error)?;
    connection
        .execute(
            "INSERT INTO cards_fts (card_id, title, summary, body, topics, aliases)
             SELECT id, title, summary, body, topics, aliases FROM cards WHERE id = ?1",
            [card_id],
        )
        .map_err(sqlite_error)?;
    Ok(())
}

/// Content identity of a card body. Whitespace is normalised so the same
/// conclusion written with other line breaks is still one card; code, paths and
/// version numbers are left untouched.
pub(crate) fn fingerprint_of(body: &str) -> String {
    let normalized = body.split_whitespace().collect::<Vec<_>>().join(" ");
    crate::util::sha256_hex(&normalized)
}

/// Replaces the card's source links, refusing the whole write when one of the
/// sources does not exist. The caller's transaction is rolled back on error.
fn relink(transaction: &Transaction<'_>, card_id: &str, source_ids: &[String]) -> ApiResult<()> {
    transaction
        .execute("DELETE FROM card_sources WHERE card_id = ?1", [card_id])
        .map_err(sqlite_error)?;
    let now = now_ms();
    for source_id in source_ids {
        check_chars("sourceId", source_id, 128)?;
        let known: i64 = transaction
            .query_row(
                "SELECT count(*) FROM sources WHERE id = ?1",
                [source_id],
                |row| row.get(0),
            )
            .map_err(sqlite_error)?;
        if known == 0 {
            return Err(ApiError::not_found(format!("unknown source: {source_id}")));
        }
        transaction
            .execute(
                "INSERT OR IGNORE INTO card_sources (card_id, source_id, created_at) VALUES (?1, ?2, ?3)",
                params![card_id, source_id, now],
            )
            .map_err(sqlite_error)?;
    }
    Ok(())
}

fn load(connection: &Connection, id: &str) -> ApiResult<Card> {
    let sql = format!("{CARD_SELECT} WHERE c.id = ?1");
    connection
        .query_row(&sql, [id], map)
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => {
                ApiError::not_found(format!("unknown card: {id}"))
            }
            other => sqlite_error(other),
        })
}

pub fn save(connection: &mut Connection, params: SaveParams) -> ApiResult<Card> {
    check_kind(&params.kind)?;
    let title = require_text("title", &params.title)?;
    check_chars("title", &title, MAX_TITLE_CHARS)?;
    check_chars("summary", &params.summary, MAX_SUMMARY_CHARS)?;
    check_chars("body", &params.body, MAX_BODY_CHARS)?;
    check_terms("topics", &params.topics)?;
    check_terms("aliases", &params.aliases)?;
    let topics = encode_list(&params.topics)?;
    let aliases = encode_list(&params.aliases)?;
    let id = new_id("card");
    let now = now_ms();
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| {
            ApiError::storage(format!("cannot start the card transaction: {error}"))
        })?;
    transaction
        .execute(
            "INSERT INTO cards (id, kind, title, summary, body, topics, aliases, edited, fingerprint, revision, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10, ?10)",
            params![
                id,
                params.kind,
                title,
                params.summary,
                params.body,
                topics,
                aliases,
                i64::from(params.edited),
                fingerprint_of(&params.body),
                now
            ],
        )
        .map_err(sqlite_error)?;
    relink(&transaction, &id, &params.source_ids)?;
    let card = load(&transaction, &id)?;
    index(&transaction, &card)?;
    crate::util::ensure_not_cancelled()?;
    transaction
        .commit()
        .map_err(|error| ApiError::storage(format!("cannot commit the card: {error}")))?;
    Ok(card)
}

pub fn update(connection: &mut Connection, params: UpdateParams) -> ApiResult<Card> {
    check_chars("id", &params.id, 128)?;
    let existing = load(connection, &params.id)?;
    let touches_content = params.title.is_some()
        || params.summary.is_some()
        || params.body.is_some()
        || params.topics.is_some()
        || params.aliases.is_some()
        || params.source_ids.is_some();
    // A favourite flip is a label, not an edit: it must not bump the revision the
    // model uses to spot a hand-edited card, and must not raise the edit flag.
    if !touches_content && let Some(favorite) = params.favorite {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| {
                ApiError::storage(format!("cannot start the card transaction: {error}"))
            })?;
        transaction
            .execute(
                "UPDATE cards SET favorite = ?2, updated_at = ?3 WHERE id = ?1",
                params![params.id, i64::from(favorite), now_ms()],
            )
            .map_err(sqlite_error)?;
        let card = load(&transaction, &params.id)?;
        crate::util::ensure_not_cancelled()?;
        transaction
            .commit()
            .map_err(|error| ApiError::storage(format!("cannot commit the card: {error}")))?;
        return Ok(card);
    }
    let title = match params.title {
        Some(title) => {
            let title = require_text("title", &title)?;
            check_chars("title", &title, MAX_TITLE_CHARS)?;
            title
        }
        None => existing.title.clone(),
    };
    let summary = match params.summary {
        Some(summary) => {
            check_chars("summary", &summary, MAX_SUMMARY_CHARS)?;
            summary
        }
        None => existing.summary.clone(),
    };
    let body = match params.body {
        Some(body) => {
            check_chars("body", &body, MAX_BODY_CHARS)?;
            body
        }
        None => existing.body.clone(),
    };
    let topics = match params.topics {
        Some(values) => {
            check_terms("topics", &values)?;
            encode_list(&values)?
        }
        None => encode_list(&existing.topics)?,
    };
    let aliases = match params.aliases {
        Some(values) => {
            check_terms("aliases", &values)?;
            encode_list(&values)?
        }
        None => encode_list(&existing.aliases)?,
    };
    // Any edit through this API is a human edit unless the caller says otherwise.
    // A human update always marks the card as edited: the model may never clear
    // that protection, and no caller can pass `edited: false` to get around it.
    let edited = true;
    let favorite = params.favorite.unwrap_or(existing.favorite);
    let now = now_ms();
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| {
            ApiError::storage(format!("cannot start the card transaction: {error}"))
        })?;
    transaction
        .execute(
            "UPDATE cards SET title = ?2, summary = ?3, body = ?4, topics = ?5, aliases = ?6, edited = ?7,
             fingerprint = ?9, favorite = ?10, revision = revision + 1, updated_at = ?8 WHERE id = ?1",
            params![
                params.id,
                title,
                summary,
                body,
                topics,
                aliases,
                i64::from(edited),
                now,
                fingerprint_of(&body),
                i64::from(favorite)
            ],
        )
        .map_err(sqlite_error)?;
    if let Some(source_ids) = params.source_ids {
        relink(&transaction, &params.id, &source_ids)?;
    }
    let card = load(&transaction, &params.id)?;
    index(&transaction, &card)?;
    crate::util::ensure_not_cancelled()?;
    transaction
        .commit()
        .map_err(|error| ApiError::storage(format!("cannot commit the card: {error}")))?;
    Ok(card)
}

/// Deletes the card, its links and its search row. Every source version it cited
/// is recorded as excluded so a later extraction run cannot resurrect it.
pub fn delete(connection: &mut Connection, id: &str) -> ApiResult<bool> {
    check_chars("id", id, 128)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| {
            ApiError::storage(format!("cannot start the card transaction: {error}"))
        })?;
    delete_in(&transaction, id)?;
    crate::util::ensure_not_cancelled()?;
    transaction
        .commit()
        .map_err(|error| ApiError::storage(format!("cannot commit the card delete: {error}")))?;
    Ok(true)
}

/// The delete itself, run inside a transaction the caller owns. `card.purge`
/// removes several cards under one commit through this, so the exclusions, the
/// links, the search row and the cascade behave exactly as a single delete.
pub(crate) fn delete_in(transaction: &Connection, id: &str) -> ApiResult<()> {
    let existing: i64 = transaction
        .query_row("SELECT count(*) FROM cards WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .map_err(sqlite_error)?;
    if existing == 0 {
        return Err(ApiError::not_found(format!("unknown card: {id}")));
    }
    let now = now_ms();
    let mut statement = transaction
        .prepare(
            "SELECT s.id || ':' || s.version FROM card_sources cs JOIN sources s ON s.id = cs.source_id WHERE cs.card_id = ?1",
        )
        .map_err(sqlite_error)?;
    let keys: Vec<String> = statement
        .query_map([id], |row| row.get::<_, String>(0))
        .map_err(sqlite_error)?
        .collect::<rusqlite::Result<Vec<String>>>()
        .map_err(sqlite_error)?;
    drop(statement);
    for key in keys {
        transaction
            .execute(
                "INSERT OR REPLACE INTO exclusions (kind, key, reason, created_at) VALUES ('source_version', ?1, 'card deleted', ?2)",
                params![key, now],
            )
            .map_err(sqlite_error)?;
    }
    transaction
        .execute(
            "INSERT OR REPLACE INTO exclusions (kind, key, reason, created_at) VALUES ('card', ?1, 'card deleted', ?2)",
            params![id, now],
        )
        .map_err(sqlite_error)?;
    transaction
        .execute("DELETE FROM card_sources WHERE card_id = ?1", [id])
        .map_err(sqlite_error)?;
    transaction
        .execute("DELETE FROM cards_fts WHERE card_id = ?1", [id])
        .map_err(sqlite_error)?;
    transaction
        .execute("DELETE FROM cards WHERE id = ?1", [id])
        .map_err(sqlite_error)?;
    Ok(())
}

pub fn get(connection: &Connection, id: &str) -> ApiResult<Card> {
    check_chars("id", id, 128)?;
    load(connection, id)
}

pub fn list(connection: &Connection, params: ListParams) -> ApiResult<CardPage> {
    let (offset, limit) = page(params.offset, params.limit);
    let filter = Filter::new(
        params.kind.as_deref(),
        params.topic.as_deref(),
        params.favorite,
    )?;
    query_page(connection, &filter, &Plan::All, &[], offset, limit)
}

/// The cards generated from the original records a caller names.
///
/// `sourceId` names one bound record; `noteId` or `channel` + `originRef` name the
/// note itself and answer every version it was published as; `threadId` or
/// `channel` + `groupKey` name a whole chat thread and answer the union of its
/// records' cards. A note that never produced a record is a normal state for that
/// detail view, so an unresolved identity answers an empty page instead of
/// `not_found`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCardsParams {
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
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub topic: Option<String>,
    #[serde(default)]
    pub favorite: Option<bool>,
    #[serde(default)]
    pub offset: Option<u32>,
    #[serde(default)]
    pub limit: Option<u32>,
}

pub fn by_source(connection: &Connection, params: SourceCardsParams) -> ApiResult<CardPage> {
    let (offset, limit) = page(params.offset, params.limit);
    let filter = Filter::new(
        params.kind.as_deref(),
        params.topic.as_deref(),
        params.favorite,
    )?;
    let found = crate::sources::resolve_record(
        connection,
        &crate::sources::FindParams {
            source_id: params.source_id,
            note_id: params.note_id,
            thread_id: params.thread_id,
            channel: params.channel,
            origin_ref: params.origin_ref,
            group_key: params.group_key,
        },
    )?;
    if found.sources.is_empty() {
        return Ok(CardPage {
            items: Vec::new(),
            total: 0,
            offset,
            limit,
            has_more: false,
            next_offset: None,
        });
    }
    let ids = found.ids();
    query_page(connection, &filter, &Plan::All, &ids, offset, limit)
}

/// Escapes the LIKE wildcards so user text is never a pattern.
fn like_pattern(query: &str) -> String {
    let mut escaped = String::with_capacity(query.len() + 2);
    escaped.push('%');
    for character in query.chars() {
        match character {
            '\\' | '%' | '_' => {
                escaped.push('\\');
                escaped.push(character);
            }
            other => escaped.push(other),
        }
    }
    escaped.push('%');
    escaped
}

/// Quotes the query as one FTS phrase, so operators, quotes and wildcards are
/// literal text rather than query syntax.
fn fts_phrase(query: &str) -> String {
    let mut phrase = String::with_capacity(query.len() + 2);
    phrase.push('"');
    for character in query.chars() {
        if character == '"' {
            phrase.push('"');
        }
        phrase.push(character);
    }
    phrase.push('"');
    phrase
}

/// Runs the search. Queries shorter than one trigram (1-2 characters, which
/// covers two-character Chinese words) fall back to a literal LIKE scan with
/// title, aliases and topics ranked before the body.
pub fn search(connection: &Connection, params: SearchParams) -> ApiResult<CardPage> {
    let (offset, limit) = page(params.offset, params.limit);
    let filter = Filter::new(
        params.kind.as_deref(),
        params.topic.as_deref(),
        params.favorite,
    )?;
    let plan = plan_for(&params.query)?;
    query_page(connection, &filter, &plan, &[], offset, limit)
}

/// Every distinct topic across the cards, most used first, then alphabetically
/// so the order is stable between calls.
pub fn topics(connection: &Connection, params: TopicParams) -> ApiResult<TopicList> {
    let limit = params
        .limit
        .unwrap_or(DEFAULT_TOPIC_COUNT)
        .clamp(1, MAX_TOPIC_COUNT);
    let total: i64 = connection
        .query_row(
            "SELECT count(*) FROM (SELECT DISTINCT json_each.value FROM cards, json_each(cards.topics))",
            [],
            |row| row.get(0),
        )
        .map_err(sqlite_error)?;
    let mut statement = connection
        .prepare(
            "SELECT json_each.value AS topic, count(*) AS count
               FROM cards, json_each(cards.topics)
              GROUP BY topic
              ORDER BY count DESC, topic ASC
              LIMIT ?1",
        )
        .map_err(sqlite_error)?;
    let topics = statement
        .query_map([i64::from(limit)], |row| {
            Ok(TopicCount {
                topic: row.get(0)?,
                count: row.get(1)?,
            })
        })
        .and_then(|rows| rows.collect::<rusqlite::Result<Vec<TopicCount>>>())
        .map_err(sqlite_error)?;
    Ok(TopicList { topics, total })
}

/// The versions of one card: the stored card first, then the snapshots an
/// automatic update kept, newest first, stopping before the frame budget fills.
pub fn revisions(connection: &Connection, params: RevisionsParams) -> ApiResult<CardRevisions> {
    check_chars("id", &params.id, 128)?;
    let card = load(connection, &params.id)?;
    let limit = params
        .limit
        .unwrap_or(DEFAULT_REVISIONS)
        .clamp(1, MAX_REVISIONS) as usize;
    let mut revisions = vec![CardRevision {
        revision: card.revision,
        title: card.title.clone(),
        summary: card.summary.clone(),
        body: card.body.clone(),
        topics: card.topics.clone(),
        edited: card.edited,
        created_at: card.updated_at,
    }];
    let budget = MAX_FRAME_BYTES.saturating_sub(FRAME_HEADROOM);
    let mut used = encoded_len(&revisions[0]);
    let mut statement = connection
        .prepare(
            "SELECT revision, title, summary, body, topics, edited, created_at
               FROM card_history WHERE card_id = ?1
              ORDER BY revision DESC, created_at DESC, id DESC",
        )
        .map_err(sqlite_error)?;
    let history = statement
        .query_map([&params.id], |row| {
            Ok(CardRevision {
                revision: row.get(0)?,
                title: row.get(1)?,
                summary: row.get(2)?,
                body: row.get(3)?,
                topics: decode_list(&row.get::<_, String>(4)?),
                edited: row.get::<_, i64>(5)? != 0,
                created_at: row.get(6)?,
            })
        })
        .and_then(|rows| rows.collect::<rusqlite::Result<Vec<CardRevision>>>())
        .map_err(sqlite_error)?;
    for revision in history {
        if revisions.len() >= limit {
            break;
        }
        let size = encoded_len(&revision);
        if used + size > budget {
            break;
        }
        used += size;
        revisions.push(revision);
    }
    Ok(CardRevisions {
        id: params.id,
        revisions,
    })
}

fn encoded_len(revision: &CardRevision) -> usize {
    serde_json::to_string(revision).map_or(0, |text| text.len())
}

/// Joins two topic or alias lists, keeping the kept card's order first and
/// capping the result at the topic limit.
fn union_terms(kept: &[String], merged: &[String]) -> Vec<String> {
    let mut union: Vec<String> = Vec::new();
    for value in kept.iter().chain(merged.iter()) {
        if union.len() >= MAX_TOPICS {
            break;
        }
        if !union.iter().any(|seen| seen == value) {
            union.push(value.clone());
        }
    }
    union
}

/// Checks a merge override. A merge reports bad text as `invalid_params`: it is
/// a two-card decision the caller can fix, not a single oversized field.
fn merge_text(field: &str, value: &str, max: usize) -> ApiResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(ApiError::invalid(format!("{field} 不能为空")));
    }
    let length = trimmed.chars().count();
    if length > max {
        return Err(ApiError::invalid(format!(
            "{field} 超过 {max} 个字符（{length}）"
        )));
    }
    Ok(trimmed.to_string())
}

/// Joins two cards into the kept one. Everything runs in one `IMMEDIATE`
/// transaction, so a rejected merge leaves both cards exactly as they were.
pub fn merge(connection: &mut Connection, params: MergeParams) -> ApiResult<MergedCards> {
    check_chars("id", &params.keep_id, 128)?;
    check_chars("id", &params.merge_id, 128)?;
    if params.keep_id.trim().is_empty() || params.merge_id.trim().is_empty() {
        return Err(ApiError::invalid("合并需要两张卡片"));
    }
    if params.keep_id == params.merge_id {
        return Err(ApiError::invalid("不能把一张卡片合并到它自己"));
    }
    let title = match &params.title {
        Some(title) => Some(merge_text("title", title, MAX_TITLE_CHARS)?),
        None => None,
    };
    let summary = match &params.summary {
        Some(summary) => {
            let summary = summary.trim();
            if summary.chars().count() > MAX_SUMMARY_CHARS {
                return Err(ApiError::invalid(format!(
                    "summary 超过 {MAX_SUMMARY_CHARS} 个字符"
                )));
            }
            Some(summary.to_string())
        }
        None => None,
    };
    let body = match &params.body {
        Some(body) => {
            if body.chars().count() > MAX_BODY_CHARS {
                return Err(ApiError::invalid(format!(
                    "body 超过 {MAX_BODY_CHARS} 个字符"
                )));
            }
            Some(body.clone())
        }
        None => None,
    };
    let now = now_ms();
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| {
            ApiError::storage(format!("cannot start the merge transaction: {error}"))
        })?;
    let keep = load(&transaction, &params.keep_id)?;
    let merged = load(&transaction, &params.merge_id)?;
    if keep.revision != params.keep_revision || merged.revision != params.merge_revision {
        return Err(ApiError::new(
            Code::SourceChanged,
            "卡片已被修改，请重新对比后再合并",
        ));
    }
    let title = title.unwrap_or_else(|| keep.title.clone());
    let summary = summary.unwrap_or_else(|| keep.summary.clone());
    let body_source = if body.is_some() { "request" } else { "keep" };
    let body = body.unwrap_or_else(|| keep.body.clone());
    let topics = encode_list(&union_terms(&keep.topics, &merged.topics))?;
    let aliases = encode_list(&union_terms(&keep.aliases, &merged.aliases))?;
    let favorite = keep.favorite || merged.favorite;
    let revision = keep.revision + 1;
    // Both current versions are snapshotted before anything changes. A merge of
    // two cards nobody edited has no history rows of its own, so without this the
    // texts being replaced would be gone after the commit.
    snapshot(&transaction, &keep, "合并前保留：保留卡片当前版本", now)?;
    snapshot(&transaction, &merged, "合并前保留：被合并卡片当前版本", now)?;
    transaction
        .execute(
            "UPDATE cards SET title = ?2, summary = ?3, body = ?4, topics = ?5, aliases = ?6, edited = 1,
             favorite = ?7, fingerprint = ?8, revision = ?9, updated_at = ?10 WHERE id = ?1",
            params![
                params.keep_id,
                title,
                summary,
                body,
                topics,
                aliases,
                i64::from(favorite),
                fingerprint_of(&body),
                revision,
                now
            ],
        )
        .map_err(sqlite_error)?;
    transaction
        .execute(
            "INSERT OR IGNORE INTO card_sources (card_id, source_id, created_at)
             SELECT ?1, source_id, created_at FROM card_sources WHERE card_id = ?2",
            params![params.keep_id, params.merge_id],
        )
        .map_err(sqlite_error)?;
    transaction
        .execute(
            "DELETE FROM card_sources WHERE card_id = ?1",
            [&params.merge_id],
        )
        .map_err(sqlite_error)?;
    let mut statement = transaction
        .prepare(
            "SELECT id, from_id, to_id, kind, origin FROM card_relations WHERE from_id = ?1 OR to_id = ?1",
        )
        .map_err(sqlite_error)?;
    let edges = statement
        .query_map([&params.merge_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>())
        .map_err(sqlite_error)?;
    drop(statement);
    for (id, from, to, kind, origin) in edges {
        let from = if from == params.merge_id {
            params.keep_id.clone()
        } else {
            from
        };
        let to = if to == params.merge_id {
            params.keep_id.clone()
        } else {
            to
        };
        // `contrast` is symmetric, so its endpoints are ordered the way
        // `relation.add` orders them: the repointed edge then lands on the row
        // that already exists instead of sitting next to its mirror image.
        let (from, to) = if kind == "contrast" && from > to {
            (to, from)
        } else {
            (from, to)
        };
        // A relation that now starts and ends on the kept card no longer says
        // anything.
        if from == to {
            transaction
                .execute("DELETE FROM card_relations WHERE id = ?1", [&id])
                .map_err(sqlite_error)?;
            continue;
        }
        let existing: Option<(String, String)> = transaction
            .query_row(
                "SELECT id, origin FROM card_relations
                  WHERE from_id = ?1 AND to_id = ?2 AND kind = ?3 AND id != ?4",
                params![from, to, kind, id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(sqlite_error)?;
        let keep_moving = match existing {
            None => true,
            Some((other_id, other_origin)) => {
                if other_origin == "manual" || origin == "model" {
                    transaction
                        .execute("DELETE FROM card_relations WHERE id = ?1", [&id])
                        .map_err(sqlite_error)?;
                    false
                } else {
                    // The moved hand-drawn relation outranks the stored model one.
                    transaction
                        .execute("DELETE FROM card_relations WHERE id = ?1", [&other_id])
                        .map_err(sqlite_error)?;
                    true
                }
            }
        };
        if keep_moving {
            transaction
                .execute(
                    "UPDATE card_relations SET from_id = ?2, to_id = ?3, updated_at = ?4 WHERE id = ?1",
                    params![id, from, to, now],
                )
                .map_err(sqlite_error)?;
        }
    }
    // Repointing can leave the same symmetric pair in both directions, and a
    // database written before the ordering was enforced can hold both. One row
    // per pair survives.
    dedupe_contrast(&transaction, &params.keep_id, now)?;
    // The merged card's snapshots move with it; the revision offset keeps the
    // numbers unique and their order intact, so every old version stays readable.
    transaction
        .execute(
            "UPDATE card_history SET card_id = ?2, revision = revision + ?3 WHERE card_id = ?1",
            params![params.merge_id, params.keep_id, revision],
        )
        .map_err(sqlite_error)?;
    transaction
        .execute(
            "DELETE FROM cards_fts WHERE card_id = ?1",
            [&params.merge_id],
        )
        .map_err(sqlite_error)?;
    transaction
        .execute("DELETE FROM cards WHERE id = ?1", [&params.merge_id])
        .map_err(sqlite_error)?;
    let sources: i64 = transaction
        .query_row(
            "SELECT count(*) FROM card_sources WHERE card_id = ?1",
            [&params.keep_id],
            |row| row.get(0),
        )
        .map_err(sqlite_error)?;
    let relations: i64 = transaction
        .query_row(
            "SELECT count(*) FROM card_relations WHERE from_id = ?1 OR to_id = ?1",
            [&params.keep_id],
            |row| row.get(0),
        )
        .map_err(sqlite_error)?;
    let card = load(&transaction, &params.keep_id)?;
    reindex(&transaction, &params.keep_id)?;
    crate::util::ensure_not_cancelled()?;
    transaction
        .commit()
        .map_err(|error| ApiError::storage(format!("cannot commit the merge: {error}")))?;
    Ok(MergedCards {
        card,
        removed_id: params.merge_id,
        sources,
        relations,
        body_source,
        preview: preview_of(&body),
    })
}

/// The head of a body, cut on a character boundary and marked when it goes on.
fn preview_of(body: &str) -> String {
    const PREVIEW_CHARS: usize = 200;
    let mut preview: String = body.chars().take(PREVIEW_CHARS).collect();
    if body.chars().count() > PREVIEW_CHARS {
        preview.push('…');
    }
    preview
}

/// Records the card's current version, unless that revision is already in its
/// history. Called before a merge replaces text, so neither side of the merge
/// loses what it said.
fn snapshot(transaction: &Transaction<'_>, card: &Card, reason: &str, now: i64) -> ApiResult<()> {
    transaction
        .execute(
            "INSERT INTO card_history
                (id, card_id, revision, title, summary, body, topics, edited, reason, created_at)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
              WHERE NOT EXISTS (
                SELECT 1 FROM card_history WHERE card_id = ?2 AND revision = ?3
              )",
            params![
                new_id("his"),
                card.id,
                card.revision,
                card.title,
                card.summary,
                card.body,
                encode_list(&card.topics)?,
                i64::from(card.edited),
                reason,
                now
            ],
        )
        .map_err(sqlite_error)?;
    Ok(())
}

/// `contrast` is symmetric, so one pair can exist twice, once in each direction.
/// One row survives: the hand-drawn edge when there is one, otherwise the older
/// row. It keeps the first basis either of them carried, and its endpoints end up
/// ordered the way every other contrast edge is.
fn dedupe_contrast(transaction: &Transaction<'_>, card_id: &str, now: i64) -> ApiResult<()> {
    let rows: Vec<(String, String, String, String, String)> = {
        let mut statement = transaction
            .prepare(
                "SELECT id, from_id, to_id, origin, evidence FROM card_relations
                  WHERE kind = 'contrast' AND (from_id = ?1 OR to_id = ?1)
                  ORDER BY created_at, id",
            )
            .map_err(sqlite_error)?;
        statement
            .query_map([card_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>())
            .map_err(sqlite_error)?
    };
    let mut winners: BTreeMap<(String, String), (String, String, String)> = BTreeMap::new();
    let mut losers: Vec<String> = Vec::new();
    for (id, from, to, origin, evidence) in rows {
        let pair = if from <= to {
            (from.clone(), to.clone())
        } else {
            (to.clone(), from.clone())
        };
        match winners.get_mut(&pair) {
            None => {
                winners.insert(pair, (id, origin, evidence));
            }
            Some(winner) => {
                if origin == "manual" && winner.1 != "manual" {
                    let deduced = std::mem::replace(&mut winner.0, id);
                    winner.1 = origin;
                    losers.push(deduced);
                } else {
                    losers.push(id);
                }
                if winner.2.is_empty() {
                    winner.2 = evidence;
                }
            }
        }
    }
    for id in losers {
        transaction
            .execute("DELETE FROM card_relations WHERE id = ?1", [&id])
            .map_err(sqlite_error)?;
    }
    for ((from, to), (id, _, evidence)) in winners {
        // The guard leaves a pair that already points the right way, and already
        // carries a basis, untouched.
        transaction
            .execute(
                "UPDATE card_relations SET from_id = ?2, to_id = ?3, evidence = ?4, updated_at = ?5
                  WHERE id = ?1 AND (from_id != ?2 OR to_id != ?3 OR evidence != ?4)",
                params![id, from, to, evidence, now],
            )
            .map_err(sqlite_error)?;
    }
    Ok(())
}

/// One card as Markdown, with its sources listed so the text can be read away
/// from the app. Rust builds it: the renderer never invents the note body.
pub fn export(connection: &Connection, params: ExportParams) -> ApiResult<CardExport> {
    check_chars("id", &params.id, 128)?;
    let card = load(connection, &params.id)?;
    let mut statement = connection
        .prepare(
            "SELECT s.kind, s.title, s.origin_ref, s.state
               FROM card_sources cs JOIN sources s ON s.id = cs.source_id
              WHERE cs.card_id = ?1
              ORDER BY s.created_at, s.id",
        )
        .map_err(sqlite_error)?;
    let sources = statement
        .query_map([&params.id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>())
        .map_err(sqlite_error)?;
    let mut markdown = String::new();
    markdown.push_str(&format!("# {}\n\n", card.title));
    markdown.push_str(&format!("- 类型：{}\n", card.kind));
    markdown.push_str(&format!(
        "- 主题：{}\n",
        if card.topics.is_empty() {
            "（无）".to_string()
        } else {
            card.topics.join("、")
        }
    ));
    markdown.push_str(&format!("- 版本：{}\n\n", card.revision));
    let summary = card.summary.trim();
    if !summary.is_empty() {
        markdown.push_str(summary);
        markdown.push_str("\n\n");
    }
    let body = card.body.trim();
    if !body.is_empty() {
        markdown.push_str(body);
        markdown.push_str("\n\n");
    }
    markdown.push_str("## 来源\n\n");
    if sources.is_empty() {
        markdown.push_str("（无）\n");
    }
    for (kind, title, origin_ref, state) in sources {
        markdown.push_str(&format!("- {kind} · {title} · {origin_ref} · {state}\n"));
    }
    let filename = export_filename(&card.id, &card.title);
    Ok(CardExport {
        id: card.id,
        filename,
        markdown,
    })
}

/// A file name a desktop file picker accepts on every platform.
fn export_filename(id: &str, title: &str) -> String {
    let mut name = String::new();
    for character in title.chars() {
        if name.chars().count() >= 60 {
            break;
        }
        let safe = !character.is_control()
            && !matches!(
                character,
                '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            );
        name.push(if safe { character } else { '_' });
    }
    let name = name.trim().trim_end_matches('.').trim();
    if name.is_empty() {
        format!("{id}.md")
    } else {
        format!("{name}.md")
    }
}
