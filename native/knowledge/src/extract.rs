//! Stage 3: turning a stable pending task into knowledge cards.
//!
//! The queue owns *what* may be extracted; this module owns *how*. It validates
//! the material the main process read back out of the real stores, splits it into
//! bounded segments, asks the model once for drafts (and at most once more to
//! compare them with existing cards), then writes cards, sources, progress and the
//! task state in a single transaction. No database lock is held across a model
//! call, and nothing is written before the target cards are re-checked.

use std::collections::BTreeSet;

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::cards;
use crate::link::{Link, ModelRequest};
use crate::protocol::{
    ApiError, ApiResult, Code, MAX_BODY_CHARS, MAX_SUMMARY_CHARS, MAX_TITLE_CHARS,
};
use crate::queue;
use crate::store::{CARD_KINDS, Store};
use crate::util::{check_chars, ensure_not_cancelled, new_id, now_ms, sha256_hex};

/// Characters of source material one model call may carry.
pub const MAX_BATCH_CHARS: usize = 12_000;
/// Characters of one segment. A longer source is split instead of truncated.
pub const MAX_SEGMENT_CHARS: usize = 12_000;
/// Characters repeated from the previous segment so a sentence is not cut in two.
pub const SEGMENT_OVERLAP: usize = 500;
pub const MAX_CANDIDATES: usize = 8;
pub const MAX_CANDIDATE_CHARS: usize = 6_000;
pub const MAX_CARDS: usize = 3;
pub const MAX_TOKENS: u32 = 8_192;
/// A card shorter than this carries no reusable knowledge.
const MIN_BODY_CHARS: usize = 30;

const SYSTEM_PROMPT: &str = "你是知识提炼器。只输出一个 JSON 对象，不要输出解释或多余文字。\n\
规则：\n\
1. 只从给定来源中提炼可复用的知识，最多 3 张卡片；没有可复用内容就返回空数组。\n\
2. kind 只能是 concept（概念与原理）、method（方法与清单）、question（问题与解释）、decision（方案与决策）、comparison（对比与辨析）、reading（阅读与资料）、review（经验与复盘）。\n\
3. 每张卡片形如 {\"kind\":\"concept\",\"title\":\"…\",\"summary\":\"…\",\"body\":\"…\",\"topics\":[\"…\"],\"aliases\":[\"…\"],\"sources\":[{\"sourceId\":\"…\",\"segment\":0}],\"reason\":\"…\"}。\n\
4. body 目标 300～800 字，写结论、适用条件、关键机制、取舍理由、反例和待验证问题；不要堆空模板。\n\
5. 必须能在正文里区分：原材料陈述、对话结论、模型推导、待验证内容。未联网核验不得写成已核实事实。\n\
6. 不写个人身份、凭据、联系方式；不把资料作者的观点写成用户自己的立场。\n\
7. sources 只能引用给定来源的 sourceId 与 segment，不能编造。问候、确认、纯操作回执等没有复用价值时返回 {\"cards\":[],\"reason\":\"…\"}。";

const COMPARE_PROMPT: &str = "你是知识库去重器。只输出一个 JSON 对象，形如 \
{\"decisions\":[{\"index\":0,\"action\":\"new|reference|merge|propose\",\"targetCardId\":\"card_…\",\"reason\":\"…\"}]}。\n\
规则：\n\
- new：与候选都不同，需要新卡片。\n\
- reference：同一结论，只是补充来源，正文不必改动。\n\
- merge：同一结论且候选缺本批的细节，可以合并（只在候选未被人工编辑时才会被采用）。\n\
- propose：结论冲突、前提不同、候选已人工编辑或依据不足，交给人工判断，保留原卡片。\n\
- 适用条件或反例不同不算同一知识；标题相似不算同一知识。targetCardId 只能取自候选列表。";

/// What `extract.next` hands to the main process.
#[derive(Debug)]
struct ClaimedSource {
    source_id: String,
    version: String,
    fingerprint: String,
    kind: String,
    origin_ref: String,
    scope: String,
    title: String,
    size: i64,
}

/// One segment of material, as sent to the model.
#[derive(Debug, Clone)]
struct Segment {
    source_id: String,
    version: String,
    index: usize,
    text: String,
}

#[derive(Debug, Deserialize)]
pub struct RunParams {
    #[serde(rename = "groupId")]
    pub group_id: String,
    pub claim: String,
    pub sources: Vec<InputSource>,
    #[serde(rename = "profileId")]
    pub profile_id: Option<String>,
    pub effort: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct InputSource {
    #[serde(rename = "sourceId")]
    pub source_id: String,
    pub version: String,
    pub text: String,
}

#[derive(Debug, Deserialize)]
pub struct FailParams {
    #[serde(rename = "groupId")]
    pub group_id: String,
    pub claim: String,
    pub code: String,
    pub reason: Option<String>,
}

/// Candidates offered to the comparison call.
struct Candidate {
    id: String,
    title: String,
    summary: String,
    body: String,
}

/// A parsed draft card, already validated.
struct Draft {
    kind: String,
    title: String,
    summary: String,
    body: String,
    topics: Vec<String>,
    aliases: Vec<String>,
    sources: Vec<(String, usize)>,
    reason: String,
}

fn lock(store: &Store) -> ApiResult<std::sync::MutexGuard<'_, Connection>> {
    store
        .knowledge
        .lock()
        .map_err(|_| ApiError::new(Code::Internal, "the knowledge database is unavailable"))
}

fn sqlite(error: rusqlite::Error) -> ApiError {
    ApiError::storage(format!("knowledge database error: {error}"))
}

/// Picks one runnable task and claims it. Nothing is claimed while collection is
/// off or paused, and a disabled channel is skipped rather than consumed.
pub fn next(store: &Store) -> ApiResult<Value> {
    let connection = lock(store)?;
    if !queue::enabled(&connection) || queue::paused(&connection) {
        return Ok(json!({
            "enabled": queue::enabled(&connection),
            "paused": queue::paused(&connection),
            "group": Value::Null,
            "nextDueAt": Value::Null,
        }));
    }
    let now = now_ms();
    let mut statement = connection
        .prepare(
            "SELECT id, channel FROM queue_groups
             WHERE state = 'ready' OR (state = 'stabilizing' AND stable_at <= ?1)
             ORDER BY priority ASC, stable_at ASC, updated_at ASC",
        )
        .map_err(sqlite)?;
    let candidates: Vec<(String, String)> = statement
        .query_map(params![now], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(sqlite)?
        .collect::<Result<_, _>>()
        .map_err(sqlite)?;
    drop(statement);

    let picked = candidates
        .into_iter()
        .find(|(_, channel)| queue::channel_enabled(&connection, channel));
    let Some((group_id, _)) = picked else {
        let due: Option<i64> = connection
            .query_row(
                "SELECT MIN(stable_at) FROM queue_groups WHERE state = 'stabilizing' AND stable_at > ?1",
                params![now],
                |row| row.get(0),
            )
            .map_err(sqlite)?;
        return Ok(
            json!({"enabled": true, "paused": false, "group": Value::Null, "nextDueAt": due}),
        );
    };

    let claim = new_id("clm");
    connection
        .execute(
            "UPDATE queue_groups SET state = 'working', claim = ?2, updated_at = ?3 WHERE id = ?1",
            params![group_id, claim, now],
        )
        .map_err(sqlite)?;
    let (channel, title, scope): (String, String, String) = connection
        .query_row(
            "SELECT channel, title, scope FROM queue_groups WHERE id = ?1",
            params![group_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(sqlite)?;
    let mut statement = connection
        .prepare(
            "SELECT s.id, s.version, s.fingerprint, s.kind, s.origin_ref, s.scope, s.title, s.size
             FROM queue_items i JOIN sources s ON s.id = i.source_id
             WHERE i.group_id = ?1 AND s.state = 'active'
             ORDER BY i.ordinal",
        )
        .map_err(sqlite)?;
    let sources: Vec<ClaimedSource> = statement
        .query_map(params![group_id], |row| {
            Ok(ClaimedSource {
                source_id: row.get(0)?,
                version: row.get(1)?,
                fingerprint: row.get(2)?,
                kind: row.get(3)?,
                origin_ref: row.get(4)?,
                scope: row.get(5)?,
                title: row.get(6)?,
                size: row.get(7)?,
            })
        })
        .map_err(sqlite)?
        .collect::<Result<_, _>>()
        .map_err(sqlite)?;
    drop(statement);

    Ok(json!({
        "enabled": true,
        "paused": false,
        "nextDueAt": Value::Null,
        "group": {
            "groupId": group_id,
            "channel": channel,
            "title": title,
            "scope": scope,
            "claim": claim,
            "sources": sources.iter().map(|source| json!({
                "sourceId": source.source_id,
                "version": source.version,
                "fingerprint": source.fingerprint,
                "kind": source.kind,
                "originRef": source.origin_ref,
                "scope": source.scope,
                "title": source.title,
                "size": source.size,
            })).collect::<Vec<_>>(),
        },
    }))
}

/// Characters per segment, with the repeated head of the previous one.
fn segment_bounds(chars: usize) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut start = 0;
    while start < chars {
        let end = (start + MAX_SEGMENT_CHARS).min(chars);
        out.push((start, end));
        if end >= chars {
            break;
        }
        start = end.saturating_sub(SEGMENT_OVERLAP);
    }
    if out.is_empty() {
        out.push((0, 0));
    }
    out
}

fn slice_chars(text: &str, start: usize, end: usize) -> String {
    text.chars().skip(start).take(end - start).collect()
}

fn done_segments(
    connection: &Connection,
    source_id: &str,
    version: &str,
) -> ApiResult<BTreeSet<usize>> {
    let mut statement = connection
        .prepare("SELECT segment FROM extract_progress WHERE source_id = ?1 AND version = ?2 AND state = 'done'")
        .map_err(sqlite)?;
    let rows = statement
        .query_map(params![source_id, version], |row| row.get::<_, i64>(0))
        .map_err(sqlite)?
        .collect::<Result<Vec<i64>, _>>()
        .map_err(sqlite)?;
    Ok(rows.into_iter().map(|value| value as usize).collect())
}

/// Every segment of the given material that has not been processed yet.
fn pending_segments(
    connection: &Connection,
    sources: &[InputSource],
    claimed: &[ClaimedSource],
) -> ApiResult<Vec<Segment>> {
    let mut out = Vec::new();
    for input in sources {
        let source = claimed
            .iter()
            .find(|item| item.source_id == input.source_id)
            .ok_or_else(|| {
                ApiError::new(
                    Code::SourceChanged,
                    format!("来源 {} 不在本批次中", input.source_id),
                )
            })?;
        if source.version != input.version {
            return Err(ApiError::new(Code::SourceChanged, "来源版本已变化"));
        }
        if sha256_hex(&input.text) != source.fingerprint {
            return Err(ApiError::new(Code::SourceChanged, "来源正文已变化"));
        }
        let chars: Vec<char> = input.text.chars().collect();
        let done = done_segments(connection, &input.source_id, &input.version)?;
        for (index, (start, end)) in segment_bounds(chars.len()).into_iter().enumerate() {
            if done.contains(&index) {
                continue;
            }
            out.push(Segment {
                source_id: input.source_id.clone(),
                version: input.version.clone(),
                index,
                text: slice_chars(&input.text, start, end),
            });
        }
    }
    Ok(out)
}

/// Packs segments into one batch that stays inside the character budget.
fn take_batch(segments: &[Segment], used: &mut BTreeSet<(String, String, usize)>) -> Vec<Segment> {
    let mut batch = Vec::new();
    let mut total = 0;
    for segment in segments {
        let key = (
            segment.source_id.clone(),
            segment.version.clone(),
            segment.index,
        );
        if used.contains(&key) {
            continue;
        }
        if !batch.is_empty() && total + segment.text.chars().count() > MAX_BATCH_CHARS {
            break;
        }
        total += segment.text.chars().count();
        used.insert(key);
        batch.push(segment.clone());
    }
    batch
}

fn material_block(batch: &[Segment], claimed: &[ClaimedSource]) -> String {
    let mut out = String::new();
    for segment in batch {
        let source = claimed
            .iter()
            .find(|item| item.source_id == segment.source_id);
        out.push_str(&format!(
            "\n--- 来源 {}（第 {} 段，{}）\n{}\n",
            segment.source_id,
            segment.index,
            source.map(|item| item.kind.as_str()).unwrap_or("text"),
            segment.text
        ));
    }
    out
}

/// Strips one JSON code fence if the model wrapped its answer in it.
fn strip_fence(answer: &str) -> &str {
    let trimmed = answer.trim();
    let Some(rest) = trimmed.strip_prefix("```") else {
        return trimmed;
    };
    let rest = rest.strip_prefix("json").unwrap_or(rest);
    let rest = rest.trim_start_matches(['\r', '\n']);
    match rest.rfind("```") {
        Some(end) => rest[..end].trim(),
        None => rest,
    }
}

fn parse_drafts(answer: &str, claimed: &[ClaimedSource]) -> ApiResult<(Vec<Draft>, String)> {
    let value: Value = serde_json::from_str(strip_fence(answer)).map_err(|error| {
        ApiError::new(Code::InvalidOutput, format!("提炼结果不是 JSON：{error}"))
    })?;
    let object = value
        .as_object()
        .ok_or_else(|| ApiError::new(Code::InvalidOutput, "提炼结果不是对象"))?;
    let reason = object
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let cards = match object.get("cards") {
        None => Vec::new(),
        Some(Value::Array(items)) => items.clone(),
        Some(_) => return Err(ApiError::new(Code::InvalidOutput, "cards 必须是数组")),
    };
    if cards.len() > MAX_CARDS {
        return Err(ApiError::new(Code::InvalidOutput, "单批卡片数量超过上限"));
    }
    let mut drafts = Vec::new();
    for item in cards {
        let draft = parse_draft(&item, claimed)?;
        if !drafts
            .iter()
            .any(|existing: &Draft| existing.body == draft.body)
        {
            drafts.push(draft);
        }
    }
    Ok((drafts, reason))
}

fn parse_draft(value: &Value, claimed: &[ClaimedSource]) -> ApiResult<Draft> {
    let object = value
        .as_object()
        .ok_or_else(|| ApiError::new(Code::InvalidOutput, "卡片必须是对象"))?;
    let text = |key: &str| -> ApiResult<String> {
        object
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| ApiError::new(Code::InvalidOutput, format!("卡片缺少 {key}")))
    };
    let kind = text("kind")?;
    if !CARD_KINDS.contains(&kind.as_str()) {
        return Err(ApiError::new(
            Code::InvalidOutput,
            format!("未知卡片类型：{kind}"),
        ));
    }
    let title = text("title")?;
    let summary = text("summary")?;
    let body = text("body")?;
    check_chars("title", &title, MAX_TITLE_CHARS)?;
    check_chars("summary", &summary, MAX_SUMMARY_CHARS)?;
    check_chars("body", &body, MAX_BODY_CHARS)?;
    if body.chars().count() < MIN_BODY_CHARS {
        return Err(ApiError::new(Code::InvalidOutput, "卡片正文过短"));
    }
    let list = |key: &str| -> ApiResult<Vec<String>> {
        match object.get(key) {
            None => Ok(Vec::new()),
            Some(Value::Array(items)) => items
                .iter()
                .map(|item| {
                    item.as_str().map(str::to_string).ok_or_else(|| {
                        ApiError::new(Code::InvalidOutput, format!("{key} 必须是字符串数组"))
                    })
                })
                .collect(),
            Some(_) => Err(ApiError::new(
                Code::InvalidOutput,
                format!("{key} 必须是数组"),
            )),
        }
    };
    let mut sources = Vec::new();
    match object.get("sources") {
        None => {}
        Some(Value::Array(items)) => {
            for item in items {
                let source_id = item
                    .get("sourceId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| ApiError::new(Code::InvalidOutput, "来源引用缺少 sourceId"))?;
                let segment = item.get("segment").and_then(Value::as_i64).unwrap_or(0);
                if !claimed.iter().any(|source| source.source_id == source_id) {
                    return Err(ApiError::new(Code::InvalidOutput, "引用了本批次之外的来源"));
                }
                sources.push((source_id.to_string(), segment.max(0) as usize));
            }
        }
        Some(_) => return Err(ApiError::new(Code::InvalidOutput, "sources 必须是数组")),
    }
    Ok(Draft {
        kind,
        title,
        summary,
        body,
        topics: list("topics")?,
        aliases: list("aliases")?,
        sources,
        reason: object
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    })
}

/// Cards that could be the same knowledge: same sources first, then full-text hits.
fn candidates_for(
    connection: &Connection,
    draft: &Draft,
    source_ids: &[String],
) -> ApiResult<Vec<Candidate>> {
    let mut out: Vec<Candidate> = Vec::new();
    let mut seen = BTreeSet::new();
    let push = |row: &rusqlite::Row<'_>| -> rusqlite::Result<Candidate> {
        Ok(Candidate {
            id: row.get(0)?,
            title: row.get(1)?,
            summary: row.get(2)?,
            body: row.get(3)?,
        })
    };
    let mut statement = connection
        .prepare(
            "SELECT DISTINCT c.id, c.title, c.summary, c.body
             FROM cards c JOIN card_sources cs ON cs.card_id = c.id
             WHERE cs.source_id IN (SELECT value FROM json_each(?1)) LIMIT ?2",
        )
        .map_err(sqlite)?;
    let linked = statement
        .query_map(
            params![
                serde_json::to_string(source_ids).unwrap_or_else(|_| "[]".into()),
                MAX_CANDIDATES as i64
            ],
            push,
        )
        .map_err(sqlite)?
        .collect::<Result<Vec<Candidate>, _>>()
        .map_err(sqlite)?;
    drop(statement);
    for candidate in linked {
        if seen.insert(candidate.id.clone()) {
            out.push(candidate);
        }
    }
    if out.len() < MAX_CANDIDATES {
        let needle = draft.title.trim();
        if needle.chars().count() >= 2 {
            let pattern = format!("%{}%", needle.replace(['%', '_'], ""));
            let mut statement = connection
                .prepare(
                    "SELECT c.id, c.title, c.summary, c.body FROM cards c
                     WHERE c.title LIKE ?1 OR c.aliases LIKE ?1 OR c.topics LIKE ?1 LIMIT ?2",
                )
                .map_err(sqlite)?;
            let found = statement
                .query_map(params![pattern, MAX_CANDIDATES as i64], push)
                .map_err(sqlite)?
                .collect::<Result<Vec<Candidate>, _>>()
                .map_err(sqlite)?;
            drop(statement);
            for candidate in found {
                if out.len() >= MAX_CANDIDATES {
                    break;
                }
                if seen.insert(candidate.id.clone()) {
                    out.push(candidate);
                }
            }
        }
    }
    Ok(out)
}

fn exact_card(connection: &Connection, fingerprint: &str) -> ApiResult<Option<String>> {
    connection
        .query_row(
            "SELECT id FROM cards WHERE fingerprint = ?1 LIMIT 1",
            params![fingerprint],
            |row| row.get(0),
        )
        .optional()
        .map_err(sqlite)
}

fn candidate_text(candidates: &[Candidate]) -> String {
    let mut out = String::new();
    let mut total = 0;
    for candidate in candidates {
        let body: String = candidate.body.chars().take(1_200).collect();
        let block = format!(
            "\n--- 候选 {}\n标题：{}\n摘要：{}\n正文：{}\n",
            candidate.id, candidate.title, candidate.summary, body
        );
        let size = block.chars().count();
        if total + size > MAX_CANDIDATE_CHARS {
            break;
        }
        total += size;
        out.push_str(&block);
    }
    out
}

/// One comparison decision: action, optional target card and its reason.
type Decision = (usize, String, Option<String>, String);

fn decide(
    link: &Link,
    parent: &str,
    params: &RunParams,
    draft: &Draft,
    candidates: &[Candidate],
) -> ApiResult<Vec<Decision>> {
    let body = format!(
        "草稿：\n标题：{}\n摘要：{}\n正文：{}\n\n候选卡片：{}",
        draft.title,
        draft.summary,
        draft.body,
        candidate_text(candidates)
    );
    let answer = link.request_model(ModelRequest {
        parent_id: parent,
        profile_id: params.profile_id.as_deref().unwrap_or(""),
        effort: params.effort.as_deref().unwrap_or("high"),
        messages: &json!([
            {"role": "system", "content": COMPARE_PROMPT},
            {"role": "user", "content": body},
        ]),
        max_tokens: Some(MAX_TOKENS),
    })?;
    let value: Value = serde_json::from_str(strip_fence(&answer)).map_err(|error| {
        ApiError::new(Code::InvalidOutput, format!("去重结果不是 JSON：{error}"))
    })?;
    let decisions = value
        .get("decisions")
        .and_then(Value::as_array)
        .ok_or_else(|| ApiError::new(Code::InvalidOutput, "去重结果缺少 decisions"))?;
    let allowed: BTreeSet<&str> = candidates.iter().map(|item| item.id.as_str()).collect();
    let mut out = Vec::new();
    for decision in decisions {
        let index = decision
            .get("index")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            .max(0) as usize;
        let action = decision
            .get("action")
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::new(Code::InvalidOutput, "去重结果缺少 action"))?
            .to_string();
        if !matches!(action.as_str(), "new" | "reference" | "merge" | "propose") {
            return Err(ApiError::new(
                Code::InvalidOutput,
                format!("未知去重动作：{action}"),
            ));
        }
        let target = decision
            .get("targetCardId")
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(id) = &target
            && !allowed.contains(id.as_str())
        {
            return Err(ApiError::new(
                Code::InvalidOutput,
                "去重结果引用了候选之外的卡片",
            ));
        }
        out.push((
            index,
            action,
            target,
            decision
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        ));
    }
    Ok(out)
}

/// Runs one extraction batch. The store lock is taken only for planning and for
/// applying, never while a model call is in flight.
pub fn run(store: &Store, link: &Link, parent: &str, params: RunParams) -> ApiResult<Value> {
    let plan = {
        let connection = lock(store)?;
        let (state, claim): (String, Option<String>) = connection
            .query_row(
                "SELECT state, claim FROM queue_groups WHERE id = ?1",
                params![params.group_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(sqlite)?
            .ok_or_else(|| ApiError::new(Code::NotFound, "任务不存在"))?;
        if state != "working" || claim.as_deref() != Some(params.claim.as_str()) {
            return Err(ApiError::new(
                Code::SourceChanged,
                "任务已被其他批次占用或已结束",
            ));
        }
        claimed_sources(&connection, &params.group_id)?
    };

    let segments = {
        let connection = lock(store)?;
        pending_segments(&connection, &params.sources, &plan)?
    };
    if segments.is_empty() {
        let mut connection = lock(store)?;
        return finish_empty(&mut connection, &params, "没有新的分段需要提炼");
    }
    let mut used = BTreeSet::new();
    let batch = take_batch(&segments, &mut used);
    let answer = link.request_model(ModelRequest {
        parent_id: parent,
        profile_id: params.profile_id.as_deref().unwrap_or(""),
        effort: params.effort.as_deref().unwrap_or("high"),
        messages: &json!([
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": format!("请提炼以下材料。\n{}", material_block(&batch, &plan))},
        ]),
        max_tokens: Some(MAX_TOKENS),
    })?;
    let (drafts, reason) = parse_drafts(&answer, &plan)?;

    // Candidates and the optional comparison call, both without holding the lock
    // across the model request.
    let mut decisions: Vec<Decision> = Vec::new();
    if !drafts.is_empty() {
        let prepared = {
            let connection = lock(store)?;
            let mut rows = Vec::new();
            for draft in &drafts {
                let fingerprint = cards::fingerprint_of(&draft.body);
                let exact = exact_card(&connection, &fingerprint)?;
                let source_ids: Vec<String> =
                    draft.sources.iter().map(|(id, _)| id.clone()).collect();
                let candidates = match &exact {
                    Some(_) => Vec::new(),
                    None => candidates_for(&connection, draft, &source_ids)?,
                };
                rows.push((fingerprint, exact, candidates));
            }
            rows
        };
        let needs_compare = prepared
            .iter()
            .any(|(_, exact, candidates)| exact.is_none() && !candidates.is_empty());
        if needs_compare {
            for (index, draft) in drafts.iter().enumerate() {
                let candidates = &prepared[index].2;
                if candidates.is_empty() {
                    continue;
                }
                decisions.extend(
                    decide(link, parent, &params, draft, candidates)?
                        .into_iter()
                        .map(|(_, action, target, why)| (index, action, target, why)),
                );
            }
        }
    }

    let mut connection = lock(store)?;
    apply(
        &mut connection,
        &params,
        &batch,
        &drafts,
        &decisions,
        &reason,
    )
}

fn claimed_sources(connection: &Connection, group_id: &str) -> ApiResult<Vec<ClaimedSource>> {
    let mut statement = connection
        .prepare(
            "SELECT s.id, s.version, s.fingerprint, s.kind, s.origin_ref, s.scope, s.title, s.size
             FROM queue_items i JOIN sources s ON s.id = i.source_id
             WHERE i.group_id = ?1 AND s.state = 'active' ORDER BY i.ordinal",
        )
        .map_err(sqlite)?;
    let rows = statement
        .query_map(params![group_id], |row| {
            Ok(ClaimedSource {
                source_id: row.get(0)?,
                version: row.get(1)?,
                fingerprint: row.get(2)?,
                kind: row.get(3)?,
                origin_ref: row.get(4)?,
                scope: row.get(5)?,
                title: row.get(6)?,
                size: row.get(7)?,
            })
        })
        .map_err(sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite)?;
    Ok(rows)
}

fn finish_empty(connection: &mut Connection, params: &RunParams, reason: &str) -> ApiResult<Value> {
    let now = now_ms();
    connection
        .execute(
            "UPDATE queue_groups SET state = 'completed', claim = NULL, reason = ?2, updated_at = ?3
             WHERE id = ?1 AND claim = ?4",
            params![params.group_id, reason, now, params.claim],
        )
        .map_err(sqlite)?;
    Ok(json!({
        "groupId": params.group_id,
        "state": "completed",
        "cards": Vec::<Value>::new(),
        "proposals": Vec::<Value>::new(),
        "noKnowledge": true,
        "reason": reason,
        "remaining": false,
    }))
}

#[allow(clippy::too_many_arguments)]
fn apply(
    connection: &mut Connection,
    params: &RunParams,
    batch: &[Segment],
    drafts: &[Draft],
    decisions: &[Decision],
    reason: &str,
) -> ApiResult<Value> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite)?;
    let now = now_ms();
    let (state, claim): (String, Option<String>) = transaction
        .query_row(
            "SELECT state, claim FROM queue_groups WHERE id = ?1",
            params![params.group_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(sqlite)?
        .ok_or_else(|| ApiError::new(Code::NotFound, "任务不存在"))?;
    if state != "working" || claim.as_deref() != Some(params.claim.as_str()) {
        return Err(ApiError::new(
            Code::SourceChanged,
            "任务已被其他批次占用或已结束",
        ));
    }

    let mut created = Vec::new();
    let mut proposals = Vec::new();
    for (index, draft) in drafts.iter().enumerate() {
        let decision = decisions.iter().find(|(at, _, _, _)| *at == index);
        let action = decision
            .map(|(_, action, _, _)| action.as_str())
            .unwrap_or("new");
        let target = decision.and_then(|(_, _, target, _)| target.clone());
        let why = decision
            .map(|(_, _, _, why)| why.clone())
            .unwrap_or_default();
        let fingerprint = cards::fingerprint_of(&draft.body);
        let source_ids: Vec<String> = draft.sources.iter().map(|(id, _)| id.clone()).collect();
        // An exact content match wins over whatever the comparison call said: the
        // same conclusion is never written twice, it only gains sources.
        if let Some(id) = exact_card(&transaction, &fingerprint)? {
            attach(&transaction, &id, &source_ids, now)?;
            created.push(json!({"cardId": id, "action": "reference"}));
            continue;
        }
        let target = match target {
            Some(id) => {
                let known: i64 = transaction
                    .query_row(
                        "SELECT count(*) FROM cards WHERE id = ?1",
                        params![id],
                        |row| row.get(0),
                    )
                    .map_err(sqlite)?;
                if known > 0 { Some(id) } else { None }
            }
            None => None,
        };
        match (action, target) {
            ("reference", Some(id)) => {
                attach(&transaction, &id, &source_ids, now)?;
                created.push(json!({"cardId": id, "action": "reference"}));
            }
            ("merge", Some(id)) => {
                let (revision, edited): (i64, i64) = transaction
                    .query_row(
                        "SELECT revision, edited FROM cards WHERE id = ?1",
                        params![id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .map_err(sqlite)?;
                if edited != 0 {
                    let written = suggest(
                        &transaction,
                        draft,
                        &id,
                        revision,
                        "propose",
                        "目标卡片已被人工编辑",
                        &source_ids,
                        now,
                    )?;
                    if written {
                        proposals.push(json!({"targetCardId": id, "action": "propose"}));
                    }
                } else {
                    let (title, summary, body): (String, String, String) = transaction
                        .query_row(
                            "SELECT title, summary, body FROM cards WHERE id = ?1",
                            params![id],
                            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                        )
                        .map_err(sqlite)?;
                    transaction
                        .execute(
                            "INSERT INTO card_history (id, card_id, revision, title, summary, body, reason, created_at)
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                            params![new_id("his"), id, revision, title, summary, body, why, now],
                        )
                        .map_err(sqlite)?;
                    transaction
                        .execute(
                            "UPDATE cards SET title = ?2, summary = ?3, body = ?4, topics = ?5, aliases = ?6,
                             fingerprint = ?7, revision = revision + 1, updated_at = ?8 WHERE id = ?1",
                            params![
                                id,
                                draft.title,
                                draft.summary,
                                draft.body,
                                serde_json::to_string(&draft.topics).unwrap_or_else(|_| "[]".into()),
                                serde_json::to_string(&draft.aliases).unwrap_or_else(|_| "[]".into()),
                                fingerprint,
                                now
                            ],
                        )
                        .map_err(sqlite)?;
                    attach(&transaction, &id, &source_ids, now)?;
                    cards::reindex(&transaction, &id)?;
                    created.push(json!({"cardId": id, "action": "merge"}));
                }
            }
            ("propose", Some(id)) => {
                let revision: i64 = transaction
                    .query_row(
                        "SELECT revision FROM cards WHERE id = ?1",
                        params![id],
                        |row| row.get(0),
                    )
                    .map_err(sqlite)?;
                let written = suggest(
                    &transaction,
                    draft,
                    &id,
                    revision,
                    "propose",
                    &why,
                    &source_ids,
                    now,
                )?;
                if written {
                    proposals.push(json!({"targetCardId": id, "action": "propose"}));
                }
            }
            _ => {
                let id = new_id("card");
                transaction
                    .execute(
                        "INSERT INTO cards (id, kind, title, summary, body, topics, aliases, edited, fingerprint, revision, created_at, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, 1, ?9, ?9)",
                        params![
                            id,
                            draft.kind,
                            draft.title,
                            draft.summary,
                            draft.body,
                            serde_json::to_string(&draft.topics).unwrap_or_else(|_| "[]".into()),
                            serde_json::to_string(&draft.aliases).unwrap_or_else(|_| "[]".into()),
                            fingerprint,
                            now
                        ],
                    )
                    .map_err(sqlite)?;
                attach(&transaction, &id, &source_ids, now)?;
                cards::reindex(&transaction, &id)?;
                created.push(json!({"cardId": id, "action": "new"}));
            }
        }
    }

    for segment in batch {
        transaction
            .execute(
                "INSERT INTO extract_progress (source_id, version, segment, state, group_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 'done', ?4, ?5, ?5)
                 ON CONFLICT(source_id, version, segment) DO UPDATE SET updated_at = excluded.updated_at",
                params![segment.source_id, segment.version, segment.index as i64, params.group_id, now],
            )
            .map_err(sqlite)?;
    }

    // A long source needs several batches: the task goes back to `ready` with a
    // cleared claim instead of claiming the whole source was done after its first
    // segment.
    let mut remaining = false;
    {
        let mut statement = transaction
            .prepare(
                "SELECT s.id, s.version, s.size FROM queue_items i JOIN sources s ON s.id = i.source_id
                 WHERE i.group_id = ?1",
            )
            .map_err(sqlite)?;
        let waiting: Vec<(String, String, i64)> = statement
            .query_map(params![params.group_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(sqlite)?
            .collect::<Result<_, _>>()
            .map_err(sqlite)?;
        drop(statement);
        for (source_id, version, size) in waiting {
            let total = segment_bounds(size.max(0) as usize).len() as i64;
            let done: i64 = transaction
                .query_row(
                    "SELECT COUNT(*) FROM extract_progress WHERE source_id = ?1 AND version = ?2 AND state = 'done'",
                    params![source_id, version],
                    |row| row.get(0),
                )
                .map_err(sqlite)?;
            if done < total {
                remaining = true;
                break;
            }
        }
    }
    let state = if remaining { "ready" } else { "completed" };

    transaction
        .execute(
            "UPDATE queue_groups SET state = ?2, claim = NULL, reason = ?3, updated_at = ?4
             WHERE id = ?1 AND claim = ?5",
            params![
                params.group_id,
                state,
                reason_or(reason, created.len()),
                now,
                params.claim
            ],
        )
        .map_err(sqlite)?;
    ensure_not_cancelled()?;
    transaction.commit().map_err(sqlite)?;

    Ok(json!({
        "groupId": params.group_id,
        "state": state,
        "cards": created,
        "proposals": proposals,
        "noKnowledge": drafts.is_empty(),
        "reason": reason,
        "remaining": remaining,
        "segments": batch.len(),
    }))
}

fn reason_or(reason: &str, cards: usize) -> String {
    if reason.is_empty() {
        format!("提炼完成，写入 {cards} 张卡片")
    } else {
        reason.to_string()
    }
}

fn attach(
    transaction: &rusqlite::Transaction<'_>,
    card_id: &str,
    source_ids: &[String],
    now: i64,
) -> ApiResult<()> {
    let mut seen = BTreeSet::new();
    for source_id in source_ids {
        if !seen.insert(source_id.clone()) {
            continue;
        }
        transaction
            .execute(
                "INSERT OR IGNORE INTO card_sources (card_id, source_id, created_at) VALUES (?1, ?2, ?3)",
                params![card_id, source_id, now],
            )
            .map_err(sqlite)?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn suggest(
    transaction: &rusqlite::Transaction<'_>,
    draft: &Draft,
    target: &str,
    revision: i64,
    action: &str,
    reason: &str,
    source_ids: &[String],
    now: i64,
) -> ApiResult<bool> {
    // Same conclusion proposed for the same card is written once: an open copy is
    // not duplicated and a rejected one stays rejected instead of coming back with
    // the next batch.
    let fingerprint = cards::fingerprint_of(&draft.body);
    let known: Option<String> = transaction
        .query_row(
            "SELECT state FROM suggestions WHERE target_card_id = ?1 AND fingerprint = ?2 ORDER BY created_at DESC LIMIT 1",
            params![target, fingerprint],
            |row| row.get(0),
        )
        .optional()
        .map_err(sqlite)?;
    if known.is_some() {
        return Ok(false);
    }
    transaction
        .execute(
            "INSERT INTO suggestions (id, kind, target_card_id, target_revision, action, draft, reason, source_ids, fingerprint, state, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'open', ?10, ?10)",
            params![
                new_id("sug"),
                draft.kind,
                target,
                revision,
                action,
                serde_json::to_string(&json!({
                    "kind": draft.kind,
                    "title": draft.title,
                    "summary": draft.summary,
                    "body": draft.body,
                    "topics": draft.topics,
                    "aliases": draft.aliases,
                    "sources": draft.sources,
                    "reason": draft.reason,
                }))
                .unwrap_or_default(),
                reason,
                serde_json::to_string(source_ids).unwrap_or_else(|_| "[]".into()),
                fingerprint,
                now
            ],
        )
        .map_err(sqlite)?;
    Ok(true)
}

/// Releases a claim after a failed batch. The task state follows the reported
/// code, so a provider failure is retryable while a removed source is not.
pub fn fail(store: &Store, params: FailParams) -> ApiResult<Value> {
    let connection = lock(store)?;
    let state = match params.code.as_str() {
        "cancelled" | "source_changed" => "needs_reread",
        "timeout" | "model_unavailable" | "invalid_output" | "internal" | "storage_error" => {
            "failed"
        }
        _ => "failed",
    };
    let reason = params.reason.unwrap_or_else(|| params.code.clone());
    let changed = connection
        .execute(
            "UPDATE queue_groups SET state = ?2, claim = NULL, error = ?3, updated_at = ?4
             WHERE id = ?1 AND claim = ?5",
            params![params.group_id, state, reason, now_ms(), params.claim],
        )
        .map_err(sqlite)?;
    if changed == 0 {
        return Err(ApiError::new(
            Code::SourceChanged,
            "任务已被其他批次占用或已结束",
        ));
    }
    Ok(json!({"groupId": params.group_id, "state": state}))
}
