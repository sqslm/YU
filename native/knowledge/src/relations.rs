//! Card relations and the graph view.
//!
//! A relation is one directed edge between two cards. `contrast` is the only
//! symmetric kind, so its endpoints are ordered, which makes `(a, b)` and
//! `(b, a)` the same edge and one uniqueness rule cover both directions.

use rusqlite::types::Value;
use rusqlite::{
    Connection, OptionalExtension, Transaction, TransactionBehavior, params, params_from_iter,
};
use serde::{Deserialize, Serialize};

use crate::cards::{self, Filter, Plan, Where};
use crate::protocol::{ApiError, ApiResult};
use crate::store::RELATION_KINDS;
use crate::util::{check_chars, new_id, now_ms, page};

/// Longest quoted basis a model relation may carry.
const MAX_EVIDENCE_CHARS: usize = 500;
/// Nodes one graph query returns before the cap trims the view.
const MAX_NODES: u32 = 200;
/// One graph frame must stay well inside the 2 MiB protocol frame.
const GRAPH_BUDGET_BYTES: usize = 512 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddParams {
    pub from_id: String,
    pub to_id: String,
    pub kind: String,
    #[serde(default)]
    pub evidence: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveParams {
    pub id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListParams {
    pub card_id: String,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphParams {
    #[serde(default)]
    pub topic: Option<String>,
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub focus_id: Option<String>,
    #[serde(default)]
    pub depth: Option<u32>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Relation {
    pub id: String,
    pub from_id: String,
    pub to_id: String,
    pub kind: String,
    pub origin: String,
    pub evidence: String,
    pub created_at: i64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Removed {
    pub removed: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NeighbourCard {
    pub id: String,
    pub title: String,
    pub kind: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Neighbour {
    #[serde(flatten)]
    pub relation: Relation,
    /// The card at the other end of the relation.
    pub card: NeighbourCard,
    /// `out` when the listed card is the source of the relation.
    pub direction: &'static str,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RelationList {
    pub items: Vec<Neighbour>,
    pub total: i64,
}

/// A graph node carries metadata only: the body of a 200,000-character card
/// would blow the whole view away.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub topics: Vec<String>,
    pub favorite: bool,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Edge {
    pub id: String,
    pub from_id: String,
    pub to_id: String,
    pub kind: String,
    pub origin: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Graph {
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    /// Cards matching the filter, before any budget trimmed the view.
    pub total: i64,
    pub shown: usize,
    pub truncated: bool,
    #[serde(rename = "limitedBy")]
    pub limited_by: Option<&'static str>,
}

fn sqlite(error: rusqlite::Error) -> ApiError {
    ApiError::storage(format!("database error: {error}"))
}

fn check_kind(kind: &str) -> ApiResult<()> {
    if RELATION_KINDS.contains(&kind) {
        Ok(())
    } else {
        Err(ApiError::invalid(format!("unknown relation kind: {kind}")))
    }
}

fn check_evidence(evidence: &str) -> ApiResult<()> {
    if evidence.chars().count() > MAX_EVIDENCE_CHARS {
        return Err(ApiError::invalid(format!(
            "evidence 超过 {MAX_EVIDENCE_CHARS} 个字符"
        )));
    }
    Ok(())
}

/// Orders the endpoints of a symmetric kind, so both directions collapse onto
/// one edge and the unique index rejects the second one.
fn canonicalise(from: &str, to: &str, kind: &str) -> (String, String) {
    if kind == "contrast" && from > to {
        (to.to_string(), from.to_string())
    } else {
        (from.to_string(), to.to_string())
    }
}

fn read(row: &rusqlite::Row<'_>) -> rusqlite::Result<Relation> {
    Ok(Relation {
        id: row.get(0)?,
        from_id: row.get(1)?,
        to_id: row.get(2)?,
        kind: row.get(3)?,
        origin: row.get(4)?,
        evidence: row.get(5)?,
        created_at: row.get(6)?,
    })
}

fn find(
    transaction: &Transaction<'_>,
    from: &str,
    to: &str,
    kind: &str,
) -> ApiResult<Option<Relation>> {
    transaction
        .query_row(
            "SELECT id, from_id, to_id, kind, origin, evidence, created_at FROM card_relations
              WHERE from_id = ?1 AND to_id = ?2 AND kind = ?3",
            params![from, to, kind],
            read,
        )
        .optional()
        .map_err(sqlite)
}

/// Draws a relation by hand. A duplicate answers the row that already exists
/// instead of failing, so a double click is harmless.
pub fn add(connection: &mut Connection, params: AddParams) -> ApiResult<Relation> {
    check_chars("fromId", &params.from_id, 128)?;
    check_chars("toId", &params.to_id, 128)?;
    check_kind(&params.kind)?;
    if params.from_id.trim().is_empty() || params.to_id.trim().is_empty() {
        return Err(ApiError::invalid("关系需要两张卡片"));
    }
    if params.from_id == params.to_id {
        return Err(ApiError::invalid("卡片不能与自己建立关系"));
    }
    let evidence = params.evidence.unwrap_or_default();
    check_evidence(&evidence)?;
    let (from, to) = canonicalise(&params.from_id, &params.to_id, &params.kind);
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| {
            ApiError::storage(format!("cannot start the relation transaction: {error}"))
        })?;
    for id in [&from, &to] {
        let exists: i64 = transaction
            .query_row("SELECT count(*) FROM cards WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .map_err(sqlite)?;
        if exists == 0 {
            return Err(ApiError::not_found(format!("unknown card: {id}")));
        }
    }
    if let Some(relation) = find(&transaction, &from, &to, &params.kind)? {
        return Ok(relation);
    }
    let now = now_ms();
    let id = new_id("rel");
    transaction
        .execute(
            "INSERT INTO card_relations (id, from_id, to_id, kind, origin, evidence, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'manual', ?5, ?6, ?6)",
            params![id, from, to, params.kind, evidence, now],
        )
        .map_err(sqlite)?;
    let relation = find(&transaction, &from, &to, &params.kind)?;
    crate::util::ensure_not_cancelled()?;
    transaction
        .commit()
        .map_err(|error| ApiError::storage(format!("cannot commit the relation: {error}")))?;
    relation.ok_or_else(|| ApiError::storage("the relation vanished after the insert"))
}

/// Stores one relation the model proposed. A duplicate is ignored, so the same
/// answer twice never doubles an edge.
pub fn link_model(
    transaction: &Transaction<'_>,
    from: &str,
    to: &str,
    kind: &str,
    evidence: &str,
    now: i64,
) -> ApiResult<bool> {
    let (from, to) = canonicalise(from, to, kind);
    let inserted = transaction
        .execute(
            "INSERT OR IGNORE INTO card_relations
                (id, from_id, to_id, kind, origin, evidence, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'model', ?5, ?6, ?6)",
            params![new_id("rel"), from, to, kind, evidence, now],
        )
        .map_err(sqlite)?;
    Ok(inserted > 0)
}

/// Removes one relation by id.
pub fn remove(connection: &mut Connection, params: RemoveParams) -> ApiResult<Removed> {
    check_chars("id", &params.id, 128)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| {
            ApiError::storage(format!("cannot start the relation transaction: {error}"))
        })?;
    let removed = transaction
        .execute("DELETE FROM card_relations WHERE id = ?1", [&params.id])
        .map_err(sqlite)?;
    if removed == 0 {
        return Err(ApiError::not_found(format!(
            "unknown relation: {}",
            params.id
        )));
    }
    crate::util::ensure_not_cancelled()?;
    transaction
        .commit()
        .map_err(|error| ApiError::storage(format!("cannot commit the relation: {error}")))?;
    Ok(Removed { removed: true })
}

/// The relations of one card, with the card at the other end and which way the
/// relation points.
pub fn list(connection: &Connection, params: ListParams) -> ApiResult<RelationList> {
    check_chars("cardId", &params.card_id, 128)?;
    let exists: i64 = connection
        .query_row(
            "SELECT count(*) FROM cards WHERE id = ?1",
            [&params.card_id],
            |row| row.get(0),
        )
        .map_err(sqlite)?;
    if exists == 0 {
        return Err(ApiError::not_found(format!(
            "unknown card: {}",
            params.card_id
        )));
    }
    let (_, limit) = page(None, params.limit);
    let total: i64 = connection
        .query_row(
            "SELECT count(*) FROM card_relations WHERE from_id = ?1 OR to_id = ?1",
            [&params.card_id],
            |row| row.get(0),
        )
        .map_err(sqlite)?;
    let mut statement = connection
        .prepare(
            "SELECT r.id, r.from_id, r.to_id, r.kind, r.origin, r.evidence, r.created_at,
                    c.id, c.title, c.kind
               FROM card_relations r
               JOIN cards c ON c.id = CASE WHEN r.from_id = ?1 THEN r.to_id ELSE r.from_id END
              WHERE r.from_id = ?1 OR r.to_id = ?1
              ORDER BY r.created_at DESC, r.id
              LIMIT ?2",
        )
        .map_err(sqlite)?;
    let items = statement
        .query_map(params![params.card_id, i64::from(limit)], |row| {
            let relation = read(row)?;
            let direction = if relation.from_id == params.card_id {
                "out"
            } else {
                "in"
            };
            Ok(Neighbour {
                relation,
                card: NeighbourCard {
                    id: row.get(7)?,
                    title: row.get(8)?,
                    kind: row.get(9)?,
                },
                direction,
            })
        })
        .and_then(|rows| rows.collect::<rusqlite::Result<Vec<Neighbour>>>())
        .map_err(sqlite)?;
    Ok(RelationList { items, total })
}

/// The graph around a filter. Nodes are metadata only, every edge has both
/// endpoints inside the returned node set, and the whole view fits one frame.
pub fn graph(connection: &Connection, params: GraphParams) -> ApiResult<Graph> {
    let filter = Filter::new(None, params.topic.as_deref(), None)?;
    let plan = match params.query.as_deref() {
        Some(query) => cards::plan_for(query)?,
        None => Plan::All,
    };
    let limit = params.limit.unwrap_or(MAX_NODES).clamp(1, MAX_NODES);
    let total: i64 = {
        let mut counting = Where::new();
        let join = cards::plan_condition(&plan, &mut counting);
        filter.apply(&mut counting);
        connection
            .query_row(
                &format!("SELECT count(*) FROM cards c{join}{}", counting.sql()),
                params_from_iter(counting.values().iter()),
                |row| row.get(0),
            )
            .map_err(sqlite)?
    };
    let order = match plan {
        Plan::Fts(_) => "bm25(cards_fts, 0.0, 10.0, 4.0, 1.0, 8.0, 8.0), c.updated_at DESC, c.id",
        _ => "c.updated_at DESC, c.id",
    };
    let mut selected: Vec<String> = {
        let mut paging = Where::new();
        let join = cards::plan_condition(&plan, &mut paging);
        filter.apply(&mut paging);
        let limit_at = paging.bind(Value::Integer(i64::from(limit)));
        let mut statement = connection
            .prepare(&format!(
                "SELECT c.id FROM cards c{join}{} ORDER BY {order} LIMIT {limit_at}",
                paging.sql()
            ))
            .map_err(sqlite)?;
        statement
            .query_map(params_from_iter(paging.values().iter()), |row| {
                row.get::<_, String>(0)
            })
            .and_then(|rows| rows.collect::<rusqlite::Result<Vec<String>>>())
            .map_err(sqlite)?
    };
    // The focused card is always part of its own graph, so it takes the last
    // slot when the filter already filled the cap.
    if let Some(focus) = params.focus_id.as_deref().filter(|id| !id.is_empty()) {
        check_chars("focusId", focus, 128)?;
        if !selected.iter().any(|id| id == focus) {
            let exists: i64 = connection
                .query_row("SELECT count(*) FROM cards WHERE id = ?1", [focus], |row| {
                    row.get(0)
                })
                .map_err(sqlite)?;
            if exists == 0 {
                return Err(ApiError::not_found(format!("unknown card: {focus}")));
            }
            if selected.len() as u32 >= limit {
                selected.pop();
            }
            selected.push(focus.to_string());
        }
        let depth = params.depth.unwrap_or(1).clamp(1, 2);
        expand(connection, &mut selected, focus, depth, limit)?;
    }
    let mut nodes = load_nodes(connection, &selected)?;
    let mut byte_cut = false;
    loop {
        let ids: Vec<String> = nodes.iter().map(|node| node.id.clone()).collect();
        let edges = load_edges(connection, &ids)?;
        let truncated = (nodes.len() as i64) < total;
        let graph = Graph {
            nodes: nodes.clone(),
            edges,
            total,
            shown: nodes.len(),
            truncated,
            limited_by: if !truncated {
                None
            } else if byte_cut {
                Some("bytes")
            } else {
                Some("nodes")
            },
        };
        let size = serde_json::to_vec(&graph).map_or(0, |bytes| bytes.len());
        if size <= GRAPH_BUDGET_BYTES || nodes.len() <= 1 {
            return Ok(graph);
        }
        nodes.pop();
        byte_cut = true;
    }
}

/// Walks `depth` hops from `focus`, adding cards that the filter did not already
/// select, while the node cap allows.
fn expand(
    connection: &Connection,
    selected: &mut Vec<String>,
    focus: &str,
    depth: u32,
    limit: u32,
) -> ApiResult<()> {
    let mut frontier = vec![focus.to_string()];
    for _ in 0..depth {
        if selected.len() as u32 >= limit {
            return Ok(());
        }
        let mut next = Vec::new();
        for id in &frontier {
            let mut statement = connection
                .prepare(
                    "SELECT CASE WHEN from_id = ?1 THEN to_id ELSE from_id END
                       FROM card_relations WHERE from_id = ?1 OR to_id = ?1",
                )
                .map_err(sqlite)?;
            let neighbours = statement
                .query_map([id], |row| row.get::<_, String>(0))
                .and_then(|rows| rows.collect::<rusqlite::Result<Vec<String>>>())
                .map_err(sqlite)?;
            for neighbour in neighbours {
                if selected.len() as u32 >= limit {
                    return Ok(());
                }
                if !selected.iter().any(|seen| seen == &neighbour) {
                    selected.push(neighbour.clone());
                    next.push(neighbour);
                }
            }
        }
        if next.is_empty() {
            return Ok(());
        }
        frontier = next;
    }
    Ok(())
}

/// Reads the metadata of the selected cards, in the order the selection chose.
fn load_nodes(connection: &Connection, selected: &[String]) -> ApiResult<Vec<Node>> {
    let ids = serde_json::to_string(selected).map_err(|error| {
        ApiError::new(
            crate::protocol::Code::Internal,
            format!("cannot encode the ids: {error}"),
        )
    })?;
    let mut statement = connection
        .prepare(
            "SELECT id, title, kind, topics, favorite FROM cards
              WHERE id IN (SELECT value FROM json_each(?1))",
        )
        .map_err(sqlite)?;
    let rows = statement
        .query_map([&ids], |row| {
            Ok(Node {
                id: row.get(0)?,
                title: row.get(1)?,
                kind: row.get(2)?,
                topics: crate::cards::decode_list(&row.get::<_, String>(3)?),
                favorite: row.get::<_, i64>(4)? != 0,
            })
        })
        .and_then(|rows| rows.collect::<rusqlite::Result<Vec<Node>>>())
        .map_err(sqlite)?;
    let mut ordered = Vec::with_capacity(rows.len());
    for id in selected {
        if let Some(index) = rows.iter().position(|node| &node.id == id) {
            ordered.push(rows[index].clone());
        }
    }
    Ok(ordered)
}

/// Every edge with both endpoints in `ids`.
fn load_edges(connection: &Connection, ids: &[String]) -> ApiResult<Vec<Edge>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let list = serde_json::to_string(ids).map_err(|error| {
        ApiError::new(
            crate::protocol::Code::Internal,
            format!("cannot encode the ids: {error}"),
        )
    })?;
    let mut statement = connection
        .prepare(
            "SELECT id, from_id, to_id, kind, origin FROM card_relations
              WHERE from_id IN (SELECT value FROM json_each(?1))
                AND to_id IN (SELECT value FROM json_each(?1))
              ORDER BY created_at, id",
        )
        .map_err(sqlite)?;
    statement
        .query_map([&list], |row| {
            Ok(Edge {
                id: row.get(0)?,
                from_id: row.get(1)?,
                to_id: row.get(2)?,
                kind: row.get(3)?,
                origin: row.get(4)?,
            })
        })
        .and_then(|rows| rows.collect::<rusqlite::Result<Vec<Edge>>>())
        .map_err(sqlite)
}
