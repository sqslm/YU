//! Knowledge cards: shared storage, editing and search.
//!
//! All seven card kinds share one table and one editing path; the kind only
//! groups and filters. Extraction strategy per kind arrives in a later stage.

use rusqlite::{Connection, Row, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

use crate::protocol::{
    ApiError, ApiResult, Code, MAX_BODY_CHARS, MAX_QUERY_CHARS, MAX_SUMMARY_CHARS, MAX_TITLE_CHARS,
    fit_page,
};
use crate::store::CARD_KINDS;
use crate::util::{check_chars, new_id, now_ms, page, require_text};

const CARD_SELECT: &str = "SELECT c.id, c.kind, c.title, c.summary, c.body, c.topics, c.aliases, c.edited, c.created_at, c.updated_at,
       (SELECT group_concat(source_id) FROM card_sources WHERE card_id = c.id) AS source_ids
  FROM cards c";

/// A listing never carries the body: eleven legal cards of 200,000 characters
/// would otherwise exceed one frame and fail the whole page. `length(c.body)`
/// tells a caller whether there is a body worth fetching.
const CARD_LIST_SELECT: &str = "SELECT c.id, c.kind, c.title, c.summary, c.topics, c.aliases, c.edited, c.created_at, c.updated_at,
       length(c.body) AS body_chars,
       (SELECT group_concat(source_id) FROM card_sources WHERE card_id = c.id) AS source_ids
  FROM cards c";

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
    pub edited: bool,
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
    pub edited: bool,
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
    #[serde(default)]
    pub edited: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListParams {
    #[serde(default)]
    pub kind: Option<String>,
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
    pub offset: Option<u32>,
    #[serde(default)]
    pub limit: Option<u32>,
}

fn sqlite_error(error: rusqlite::Error) -> ApiError {
    ApiError::storage(format!("card statement failed: {error}"))
}

fn decode_list(text: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(text).unwrap_or_default()
}

fn map(row: &Row<'_>) -> rusqlite::Result<Card> {
    let topics: String = row.get(5)?;
    let aliases: String = row.get(6)?;
    let source_ids: Option<String> = row.get(10)?;
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
        edited: row.get::<_, i64>(7)? != 0,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
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
            "INSERT INTO cards (id, kind, title, summary, body, topics, aliases, edited, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
            params![
                id,
                params.kind,
                title,
                params.summary,
                params.body,
                topics,
                aliases,
                i64::from(params.edited),
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
    let edited = params.edited.unwrap_or(true);
    let now = now_ms();
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| {
            ApiError::storage(format!("cannot start the card transaction: {error}"))
        })?;
    transaction
        .execute(
            "UPDATE cards SET title = ?2, summary = ?3, body = ?4, topics = ?5, aliases = ?6, edited = ?7, updated_at = ?8 WHERE id = ?1",
            params![params.id, title, summary, body, topics, aliases, i64::from(edited), now],
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
    crate::util::ensure_not_cancelled()?;
    transaction
        .commit()
        .map_err(|error| ApiError::storage(format!("cannot commit the card delete: {error}")))?;
    Ok(true)
}

pub fn get(connection: &Connection, id: &str) -> ApiResult<Card> {
    check_chars("id", id, 128)?;
    load(connection, id)
}

pub fn list(connection: &Connection, params: ListParams) -> ApiResult<CardPage> {
    let (offset, limit) = page(params.offset, params.limit);
    let filter = match params.kind.as_deref() {
        None | Some("") => None,
        Some(kind) => {
            check_kind(kind)?;
            Some(kind.to_string())
        }
    };
    let total: i64 = match filter.as_deref() {
        Some(kind) => connection
            .query_row(
                "SELECT count(*) FROM cards WHERE kind = ?1",
                [kind],
                |row| row.get(0),
            )
            .map_err(sqlite_error)?,
        None => connection
            .query_row("SELECT count(*) FROM cards", [], |row| row.get(0))
            .map_err(sqlite_error)?,
    };
    let sql = format!(
        "{CARD_LIST_SELECT} WHERE (?1 IS NULL OR c.kind = ?1) ORDER BY c.updated_at DESC, c.id LIMIT ?2 OFFSET ?3"
    );
    let mut statement = connection.prepare(&sql).map_err(sqlite_error)?;
    let rows = statement
        .query_map(
            params![filter, i64::from(limit), i64::from(offset)],
            map_summary,
        )
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
    check_chars("query", &params.query, MAX_QUERY_CHARS)?;
    let query = params.query.trim().to_string();
    let (offset, limit) = page(params.offset, params.limit);
    if query.is_empty() {
        return list(
            connection,
            ListParams {
                kind: None,
                offset: Some(offset),
                limit: Some(limit),
            },
        );
    }
    if query.chars().count() < 3 {
        let pattern = like_pattern(&query);
        let total: i64 = connection
            .query_row(
                "SELECT count(*) FROM cards c WHERE c.title LIKE ?1 ESCAPE '\\' OR c.summary LIKE ?1 ESCAPE '\\'
                 OR c.body LIKE ?1 ESCAPE '\\' OR c.topics LIKE ?1 ESCAPE '\\' OR c.aliases LIKE ?1 ESCAPE '\\'",
                [&pattern],
                |row| row.get(0),
            )
            .map_err(sqlite_error)?;
        let sql = format!(
            "{CARD_LIST_SELECT} WHERE c.title LIKE ?1 ESCAPE '\\' OR c.summary LIKE ?1 ESCAPE '\\'
             OR c.body LIKE ?1 ESCAPE '\\' OR c.topics LIKE ?1 ESCAPE '\\' OR c.aliases LIKE ?1 ESCAPE '\\'
             ORDER BY CASE WHEN c.title LIKE ?1 ESCAPE '\\' OR c.aliases LIKE ?1 ESCAPE '\\'
                OR c.topics LIKE ?1 ESCAPE '\\' THEN 0 ELSE 1 END, c.updated_at DESC, c.id
             LIMIT ?2 OFFSET ?3"
        );
        let mut statement = connection.prepare(&sql).map_err(sqlite_error)?;
        let rows = statement
            .query_map(
                params![pattern, i64::from(limit), i64::from(offset)],
                map_summary,
            )
            .map_err(sqlite_error)?
            .collect::<rusqlite::Result<Vec<CardSummary>>>()
            .map_err(sqlite_error)?;
        let (items, has_more, next_offset) = fit_page(rows, total, offset);
        return Ok(CardPage {
            items,
            total,
            offset,
            limit,
            has_more,
            next_offset,
        });
    }
    let phrase = fts_phrase(&query);
    let total: i64 = connection
        .query_row(
            "SELECT count(*) FROM cards_fts WHERE cards_fts MATCH ?1",
            [&phrase],
            |row| row.get(0),
        )
        .map_err(sqlite_error)?;
    let sql = format!(
        "{CARD_LIST_SELECT} JOIN cards_fts ON cards_fts.card_id = c.id
         WHERE cards_fts MATCH ?1
         ORDER BY bm25(cards_fts, 0.0, 10.0, 4.0, 1.0, 8.0, 8.0), c.updated_at DESC, c.id
         LIMIT ?2 OFFSET ?3"
    );
    let mut statement = connection.prepare(&sql).map_err(sqlite_error)?;
    let rows = statement
        .query_map(
            params![phrase, i64::from(limit), i64::from(offset)],
            map_summary,
        )
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
