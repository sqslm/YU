//! Stage 3: turning a stable pending task into knowledge cards.
//!
//! The queue owns *what* may be extracted; this module owns *how*. It plans a
//! bounded batch from stored metadata alone, so the main process never has to push
//! a whole group of material through the pipe: `extract.next` returns the exact
//! character ranges it wants, `extract.run` receives only those slices plus the
//! whole-body fingerprint that identifies the version they came from. Drafts are
//! parsed strictly against that batch, compared with existing cards in a single
//! call, and applied in one transaction that re-checks the claim, the channel
//! configuration, the source versions and the target card revisions.

use std::collections::{BTreeMap, BTreeSet};

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
use crate::util::{check_chars, ensure_not_cancelled, new_id, now_ms};

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
/// Topics kept on one card after a merge.
const MAX_MERGED_TOPICS: usize = 32;

const SYSTEM_PROMPT: &str = "你是知识提炼器。只输出一个 JSON 对象，不要输出解释或多余文字。\n\
规则：\n\
1. 只从给定来源中提炼可复用的知识，最多 3 张卡片；没有可复用内容就返回 {\"cards\":[],\"reason\":\"…\"}。\n\
2. kind 只能是 concept（概念与原理）、method（方法与清单）、question（问题与解释）、decision（方案与决策）、comparison（对比与辨析）、reading（阅读与资料）、review（经验与复盘）。\n\
3. 每张卡片形如 {\"kind\":\"concept\",\"title\":\"…\",\"summary\":\"…\",\"body\":\"…\",\"topics\":[\"…\"],\"aliases\":[\"…\"],\"sources\":[{\"sourceId\":\"…\",\"segment\":0}],\"reason\":\"…\"}。\n\
4. cards 字段必须存在；没有可复用内容时写成空数组，不要省略。\n\
5. body 目标 300～800 字，写结论、适用条件、关键机制、取舍理由、反例和待验证问题；不要堆空模板。\n\
6. 必须能在正文里区分：原材料陈述、对话结论、模型推导、待验证内容。未联网核验不得写成已核实事实。\n\
7. 不写个人身份、凭据、联系方式；不把资料作者的观点写成用户自己的立场。\n\
8. sources 只能引用本批次给出的 sourceId 与该来源在本批次出现的 segment，不能编造或引用未给出的分段。问候、确认、纯操作回执等没有复用价值时返回空数组。";

const COMPARE_PROMPT: &str = "你是知识库去重器。只输出一个 JSON 对象，形如 \
{\"decisions\":[{\"index\":0,\"action\":\"new|reference|merge|propose\",\"targetCardId\":\"card_…\",\"reason\":\"…\"}]}。\n\
规则：\n\
- 对每个草稿 index 必须给出且只给出一条判断。\n\
- new：与候选都不同，需要新卡片；此时不需要 targetCardId。\n\
- reference：同一结论，只是补充来源，正文不必改动；必须给出 targetCardId。\n\
- merge：同一结论且候选缺本批的细节，可以合并（只在候选未被人工编辑时才会被采用）；必须给出 targetCardId。\n\
- propose：结论冲突、前提不同、候选已人工编辑或依据不足，交给人工判断，保留原卡片；必须给出 targetCardId。\n\
- 适用条件或反例不同不算同一知识；标题相似不算同一知识。targetCardId 只能取自候选列表，不能引用草稿自身。";

/// One source of the claimed task, as stored.
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

/// One character range the main process must read for this batch.
#[derive(Debug, Clone)]
struct Planned {
    source_id: String,
    version: String,
    index: usize,
    start: usize,
    end: usize,
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
    pub items: Vec<RunItem>,
    #[serde(rename = "profileId")]
    pub profile_id: Option<String>,
    pub effort: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RunItem {
    #[serde(rename = "sourceId")]
    pub source_id: String,
    pub version: String,
    pub fingerprint: String,
    pub segment: i64,
    pub start: i64,
    pub end: i64,
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
    revision: i64,
}

/// A parsed draft card, already validated against the batch.
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

/// One comparison decision: draft index, action, optional target and its reason.
type Decision = (usize, String, Option<String>, String);

fn lock(store: &Store) -> ApiResult<std::sync::MutexGuard<'_, Connection>> {
    store
        .knowledge
        .lock()
        .map_err(|_| ApiError::new(Code::Internal, "the knowledge database is unavailable"))
}

fn sqlite(error: rusqlite::Error) -> ApiError {
    ApiError::storage(format!("knowledge database error: {error}"))
}

/// Picks one runnable task, claims it and plans a bounded batch. Tasks with no
/// unprocessed segment left are completed here instead of being claimed, so one
/// wake can walk the whole backlog.
pub fn next(store: &Store) -> ApiResult<Value> {
    let connection = lock(store)?;
    let enabled = queue::enabled(&connection);
    let paused = queue::paused(&connection);
    if !enabled || paused {
        return Ok(json!({
            "enabled": enabled,
            "paused": paused,
            "group": Value::Null,
            "nextDueAt": Value::Null,
        }));
    }
    let now = now_ms();
    loop {
        let picked = pick(&connection, now)?;
        let Some(group_id) = picked else {
            let due: Option<i64> = connection
                .query_row(
                    "SELECT MIN(stable_at) FROM queue_groups
                     WHERE state = 'stabilizing' AND stable_at > ?1",
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
                "UPDATE queue_groups SET state = 'working', claim = ?2, error = NULL, updated_at = ?3
                 WHERE id = ?1",
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
        let sources = claimed_sources(&connection, &group_id)?;
        let items = plan_batch(&connection, &sources)?;
        if items.is_empty() {
            connection
                .execute(
                    "UPDATE queue_groups SET state = 'completed', claim = NULL,
                     reason = '没有新的分段需要提炼', updated_at = ?2 WHERE id = ?1 AND claim = ?3",
                    params![group_id, now, claim],
                )
                .map_err(sqlite)?;
            continue;
        }
        let group = match planned_group(
            &group_id, &claim, &channel, &title, &scope, &sources, &items,
        ) {
            Ok(Some(group)) => group,
            // Nothing to do after all: the claim goes back without pretending the
            // group finished.
            Ok(None) => {
                release_claim(&connection, &group_id, &claim, now)?;
                continue;
            }
            Err(error) => {
                // A plan that cannot be serialized must not leave a claim behind.
                release_claim(&connection, &group_id, &claim, now)?;
                return Err(error);
            }
        };
        return Ok(json!({
            "enabled": true,
            "paused": false,
            "nextDueAt": Value::Null,
            "group": group,
        }));
    }
}

/// Puts a claimed group back exactly as it was, so a failed plan never strands it.
fn release_claim(connection: &Connection, group_id: &str, claim: &str, now: i64) -> ApiResult<()> {
    connection
        .execute(
            "UPDATE queue_groups SET state = 'ready', claim = NULL, updated_at = ?3
             WHERE id = ?1 AND claim = ?2",
            params![group_id, claim, now],
        )
        .map_err(sqlite)?;
    Ok(())
}

/// Builds the group description, packed by real UTF-8 bytes.
///
/// A group can hold hundreds of sources with long titles, scopes and origins. The
/// frame limit is a transport fact, not a business rule, so the plan is cut to fit
/// it: only the sources the kept items need are described, and the next call
/// continues from the progress this batch leaves behind.
fn planned_group(
    group_id: &str,
    claim: &str,
    channel: &str,
    title: &str,
    scope: &str,
    sources: &[ClaimedSource],
    items: &[Planned],
) -> ApiResult<Option<Value>> {
    let mut budget = crate::protocol::RESULT_BUDGET_BYTES.saturating_sub(HEADROOM_BYTES);
    let envelope = serde_json::to_string(&json!({
        "groupId": group_id,
        "channel": channel,
        "title": title,
        "scope": scope,
        "claim": claim,
        "sources": Value::Array(Vec::new()),
        "items": Value::Array(Vec::new()),
    }))
    .map_err(|error| ApiError::new(Code::Internal, format!("读取计划无法序列化：{error}")))?;
    budget = budget.saturating_sub(envelope.len());
    let mut kept_sources: Vec<Value> = Vec::new();
    let mut kept_items: Vec<Value> = Vec::new();
    let mut described: BTreeSet<&str> = BTreeSet::new();
    for item in items {
        let item_json = json!({
            "sourceId": item.source_id,
            "version": item.version,
            "segment": item.index,
            "start": item.start,
            "end": item.end,
        });
        let mut cost = serde_json::to_string(&item_json)
            .map_err(serialize_error)?
            .len()
            + 1;
        let mut source_json = None;
        if !described.contains(item.source_id.as_str()) {
            let source = sources
                .iter()
                .find(|source| source.source_id == item.source_id)
                .ok_or_else(|| ApiError::new(Code::Internal, "读取计划引用了未知来源"))?;
            let value = json!({
                "sourceId": source.source_id,
                "version": source.version,
                "fingerprint": source.fingerprint,
                "kind": source.kind,
                "originRef": source.origin_ref,
                "scope": source.scope,
                "title": source.title,
                "size": source.size,
                "segments": segment_bounds(source.size.max(0) as usize).len(),
            });
            cost += serde_json::to_string(&value)
                .map_err(serialize_error)?
                .len()
                + 1;
            source_json = Some(value);
        }
        if cost > budget {
            if kept_items.is_empty() {
                // Even one item does not fit: say so instead of returning a plan the
                // caller cannot use. The claim is released by the caller.
                return Err(ApiError::new(
                    Code::TooLarge,
                    "来源描述超过单帧预算，无法给出可用的读取计划",
                ));
            }
            break;
        }
        budget -= cost;
        if let Some(value) = source_json {
            described.insert(item.source_id.as_str());
            kept_sources.push(value);
        }
        kept_items.push(item_json);
    }
    if kept_items.is_empty() {
        return Ok(None);
    }
    Ok(Some(json!({
        "groupId": group_id,
        "channel": channel,
        "title": title,
        "scope": scope,
        "claim": claim,
        "sources": kept_sources,
        "items": kept_items,
    })))
}

fn serialize_error(error: serde_json::Error) -> ApiError {
    ApiError::new(Code::Internal, format!("读取计划无法序列化：{error}"))
}

/// The first runnable group whose channel is still allowed.
fn pick(connection: &Connection, now: i64) -> ApiResult<Option<String>> {
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
    Ok(candidates
        .into_iter()
        .find(|(_, channel)| queue::channel_enabled(connection, channel))
        .map(|(id, _)| id))
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

fn done_segments(
    connection: &Connection,
    source_id: &str,
    version: &str,
) -> ApiResult<BTreeSet<usize>> {
    let mut statement = connection
        .prepare(
            "SELECT segment FROM extract_progress
             WHERE source_id = ?1 AND version = ?2 AND state = 'done'",
        )
        .map_err(sqlite)?;
    let rows = statement
        .query_map(params![source_id, version], |row| row.get::<_, i64>(0))
        .map_err(sqlite)?
        .collect::<Result<Vec<i64>, _>>()
        .map_err(sqlite)?;
    Ok(rows.into_iter().map(|value| value as usize).collect())
}

/// The unprocessed segments of this task, packed into one character budget. The
/// ranges are derived from the stored character count, so no material is needed
/// to plan a batch.
fn plan_batch(connection: &Connection, sources: &[ClaimedSource]) -> ApiResult<Vec<Planned>> {
    let mut out = Vec::new();
    let mut budget = 0usize;
    for source in sources {
        let done = done_segments(connection, &source.source_id, &source.version)?;
        for (index, (start, end)) in segment_bounds(source.size.max(0) as usize)
            .into_iter()
            .enumerate()
        {
            if done.contains(&index) {
                continue;
            }
            let chars = end - start;
            if !out.is_empty() && budget + chars > MAX_BATCH_CHARS {
                return Ok(out);
            }
            budget += chars;
            out.push(Planned {
                source_id: source.source_id.clone(),
                version: source.version.clone(),
                index,
                start,
                end,
            });
        }
    }
    Ok(out)
}

/// Slack kept under the frame budget for the envelope the caller adds around the
/// plan: the plan is serialized twice (measured, then sent inside a result frame).
const HEADROOM_BYTES: usize = 4_096;

/// True when the card moved past the revision the comparison was made against.
fn moved_under_us(candidates: &[Candidate], id: &str, revision: i64) -> bool {
    match candidates.iter().find(|candidate| candidate.id == id) {
        Some(candidate) => candidate.revision != revision,
        // The card was not in the candidate list this batch offered: the decision
        // cannot be re-endorsed either.
        None => true,
    }
}

/// Turns the slices the main process read into the segments of this batch, after
/// proving they belong to the version the task was claimed for.
fn verified_segments(
    connection: &Connection,
    params: &RunParams,
    claimed: &[ClaimedSource],
) -> ApiResult<Vec<Segment>> {
    if params.items.is_empty() {
        return Err(ApiError::new(Code::InvalidParams, "本批没有待提炼分段"));
    }
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for item in &params.items {
        let source = claimed
            .iter()
            .find(|source| source.source_id == item.source_id)
            .ok_or_else(|| {
                ApiError::new(
                    Code::SourceChanged,
                    format!("来源 {} 不在本批次中", item.source_id),
                )
            })?;
        if source.version != item.version {
            return Err(ApiError::new(Code::SourceChanged, "来源版本已变化"));
        }
        if source.fingerprint != item.fingerprint {
            return Err(ApiError::new(Code::SourceChanged, "来源正文指纹不符"));
        }
        if item.segment < 0 || item.start < 0 || item.end < item.start {
            return Err(ApiError::new(Code::InvalidParams, "分段范围不合法"));
        }
        let index = item.segment as usize;
        let bounds = segment_bounds(source.size.max(0) as usize);
        let (start, end) = *bounds
            .get(index)
            .ok_or_else(|| ApiError::new(Code::InvalidParams, "分段索引超出范围"))?;
        if start != item.start as usize || end != item.end as usize {
            return Err(ApiError::new(Code::InvalidParams, "分段范围与来源不符"));
        }
        let chars = item.text.chars().count();
        if chars != end - start {
            return Err(ApiError::new(Code::InvalidParams, "分段正文长度不符"));
        }
        if !seen.insert((item.source_id.clone(), index)) {
            return Err(ApiError::new(Code::InvalidParams, "同一分段被重复提交"));
        }
        if done_segments(connection, &item.source_id, &item.version)?.contains(&index) {
            return Err(ApiError::new(
                Code::SourceChanged,
                "该分段已处理，重放不会再次提炼",
            ));
        }
        out.push(Segment {
            source_id: item.source_id.clone(),
            version: item.version.clone(),
            index,
            text: item.text.clone(),
        });
        let _ = (start, end);
    }
    Ok(out)
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

/// The source ids and segment indexes that were really part of this batch.
fn batch_sources(batch: &[Segment]) -> BTreeMap<String, BTreeSet<usize>> {
    let mut allowed: BTreeMap<String, BTreeSet<usize>> = BTreeMap::new();
    for segment in batch {
        allowed
            .entry(segment.source_id.clone())
            .or_default()
            .insert(segment.index);
    }
    allowed
}

fn parse_drafts(answer: &str, batch: &[Segment]) -> ApiResult<(Vec<Draft>, String)> {
    let allowed = batch_sources(batch);
    let value: Value = serde_json::from_str(strip_fence(answer)).map_err(|error| {
        ApiError::new(Code::InvalidOutput, format!("提炼结果不是 JSON：{error}"))
    })?;
    let object = value
        .as_object()
        .ok_or_else(|| ApiError::new(Code::InvalidOutput, "提炼结果不是对象"))?;
    if let Some(reason) = object.get("reason")
        && !reason.is_string()
    {
        return Err(ApiError::new(Code::InvalidOutput, "reason 必须是字符串"));
    }
    let reason = object
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    // A missing list is an invalid answer, not "no knowledge": treating it as
    // empty would silently skip the material for good.
    let cards = match object.get("cards") {
        Some(Value::Array(items)) => items.clone(),
        Some(_) => return Err(ApiError::new(Code::InvalidOutput, "cards 必须是数组")),
        None => return Err(ApiError::new(Code::InvalidOutput, "提炼结果缺少 cards")),
    };
    if cards.len() > MAX_CARDS {
        return Err(ApiError::new(Code::InvalidOutput, "单批卡片数量超过上限"));
    }
    let mut drafts = Vec::new();
    for item in cards {
        let draft = parse_draft(&item, &allowed)?;
        if !drafts
            .iter()
            .any(|existing: &Draft| existing.body == draft.body)
        {
            drafts.push(draft);
        }
    }
    Ok((drafts, reason))
}

fn parse_draft(value: &Value, allowed: &BTreeMap<String, BTreeSet<usize>>) -> ApiResult<Draft> {
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
        Some(Value::Array(items)) if !items.is_empty() => {
            for item in items {
                let source_id = item
                    .get("sourceId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| ApiError::new(Code::InvalidOutput, "来源引用缺少 sourceId"))?;
                let segment = item
                    .get("segment")
                    .and_then(Value::as_i64)
                    .ok_or_else(|| ApiError::new(Code::InvalidOutput, "来源引用缺少 segment"))?;
                if segment < 0 {
                    return Err(ApiError::new(Code::InvalidOutput, "来源分段号不合法"));
                }
                let index = segment as usize;
                let known = allowed
                    .get(source_id)
                    .ok_or_else(|| ApiError::new(Code::InvalidOutput, "引用了本批次之外的来源"))?;
                if !known.contains(&index) {
                    return Err(ApiError::new(
                        Code::InvalidOutput,
                        "引用了本批次未给出的分段",
                    ));
                }
                sources.push((source_id.to_string(), index));
            }
        }
        Some(Value::Array(_)) => {
            return Err(ApiError::new(Code::InvalidOutput, "卡片没有引用任何来源"));
        }
        Some(_) => return Err(ApiError::new(Code::InvalidOutput, "sources 必须是数组")),
        None => return Err(ApiError::new(Code::InvalidOutput, "卡片缺少 sources")),
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
            revision: row.get(4)?,
        })
    };
    let mut statement = connection
        .prepare(
            "SELECT DISTINCT c.id, c.title, c.summary, c.body, c.revision
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
                    "SELECT c.id, c.title, c.summary, c.body, c.revision FROM cards c
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

/// Candidate text under one shared character budget for the whole batch.
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

/// One comparison call for the whole batch, so the model budget stays at one
/// extraction plus one comparison.
fn decide_all(
    link: &Link,
    parent: &str,
    params: &RunParams,
    drafts: &[Draft],
    candidates: &[Candidate],
    exact: &[Option<String>],
) -> ApiResult<Vec<Decision>> {
    let mut cards_text = String::new();
    let mut asked = Vec::new();
    for (index, draft) in drafts.iter().enumerate() {
        if exact[index].is_some() {
            continue;
        }
        asked.push(index);
        cards_text.push_str(&format!(
            "\n--- 草稿 {index}\n标题：{}\n摘要：{}\n正文：{}\n",
            draft.title, draft.summary, draft.body
        ));
    }
    if asked.is_empty() || candidates.is_empty() {
        return Ok(Vec::new());
    }
    let body = format!(
        "本批草稿：{cards_text}\n候选卡片：{}",
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
    let mut out: Vec<Decision> = Vec::new();
    let mut covered = BTreeSet::new();
    for decision in decisions {
        let index = decision
            .get("index")
            .and_then(Value::as_i64)
            .ok_or_else(|| ApiError::new(Code::InvalidOutput, "去重结果缺少 index"))?;
        if index < 0 || index as usize >= drafts.len() {
            return Err(ApiError::new(Code::InvalidOutput, "去重结果的 index 越界"));
        }
        let index = index as usize;
        if exact[index].is_some() {
            return Err(ApiError::new(
                Code::InvalidOutput,
                "去重结果包含了精确重复的草稿",
            ));
        }
        if !asked.contains(&index) {
            return Err(ApiError::new(Code::InvalidOutput, "去重结果重复或缺失"));
        }
        if !covered.insert(index) {
            return Err(ApiError::new(
                Code::InvalidOutput,
                "去重结果重复提交同一草稿",
            ));
        }
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
        match (action.as_str(), &target) {
            ("new", _) => {}
            (_, None) => {
                return Err(ApiError::new(
                    Code::InvalidOutput,
                    "去重动作缺少 targetCardId",
                ));
            }
            (_, Some(id)) if !allowed.contains(id.as_str()) => {
                return Err(ApiError::new(
                    Code::InvalidOutput,
                    "去重结果引用了候选之外的卡片",
                ));
            }
            _ => {}
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
    if covered.len() != asked.len() {
        return Err(ApiError::new(
            Code::InvalidOutput,
            "去重结果没有覆盖本批全部草稿",
        ));
    }
    Ok(out)
}

/// Runs one extraction batch. The store lock is taken only for planning and for
/// applying, never while a model call is in flight.
pub fn run(store: &Store, link: &Link, parent: &str, params: RunParams) -> ApiResult<Value> {
    let (claimed, batch) = {
        let connection = lock(store)?;
        let (state, claim, channel): (String, Option<String>, String) = connection
            .query_row(
                "SELECT state, claim, channel FROM queue_groups WHERE id = ?1",
                params![params.group_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
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
        if !queue::enabled(&connection) || queue::paused(&connection) {
            return Err(ApiError::new(Code::Cancelled, "采集已暂停"));
        }
        if !queue::channel_enabled(&connection, &channel) {
            return Err(ApiError::new(Code::Cancelled, "该来源通道已关闭"));
        }
        let claimed = claimed_sources(&connection, &params.group_id)?;
        let batch = verified_segments(&connection, &params, &claimed)?;
        (claimed, batch)
    };

    let answer = link.request_model(ModelRequest {
        parent_id: parent,
        profile_id: params.profile_id.as_deref().unwrap_or(""),
        effort: params.effort.as_deref().unwrap_or("high"),
        messages: &json!([
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": format!("请提炼以下材料。\n{}", material_block(&batch, &claimed))},
        ]),
        max_tokens: Some(MAX_TOKENS),
    })?;
    let (drafts, reason) = parse_drafts(&answer, &batch)?;

    // Candidates and the single comparison call, both without holding the lock
    // across the model request.
    let mut exact: Vec<Option<String>> = Vec::new();
    let mut candidates: Vec<Candidate> = Vec::new();
    if !drafts.is_empty() {
        let connection = lock(store)?;
        let mut seen = BTreeSet::new();
        for draft in &drafts {
            let fingerprint = cards::fingerprint_of(&draft.body);
            let found = exact_card(&connection, &fingerprint)?;
            if found.is_none() {
                let source_ids: Vec<String> =
                    draft.sources.iter().map(|(id, _)| id.clone()).collect();
                for candidate in candidates_for(&connection, draft, &source_ids)? {
                    if candidates.len() >= MAX_CANDIDATES {
                        break;
                    }
                    if seen.insert(candidate.id.clone()) {
                        candidates.push(candidate);
                    }
                }
            }
            exact.push(found);
        }
    }
    let decisions = decide_all(link, parent, &params, &drafts, &candidates, &exact)?;

    let mut connection = lock(store)?;
    apply(
        &mut connection,
        &params,
        &batch,
        &drafts,
        &decisions,
        &exact,
        &candidates,
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

/// Whether a source version was retracted by `card.delete` or an exclusion.
fn excluded(connection: &Connection, source_id: &str, version: &str) -> ApiResult<bool> {
    let key = format!("{source_id}:{version}");
    let count: i64 = connection
        .query_row(
            "SELECT count(*) FROM exclusions WHERE kind = 'source_version' AND key = ?1",
            params![key],
            |row| row.get(0),
        )
        .map_err(sqlite)?;
    Ok(count > 0)
}

/// Until the claim is checked and the sources re-read, nothing may be written.
#[allow(clippy::too_many_arguments)]
fn apply(
    connection: &mut Connection,
    params: &RunParams,
    batch: &[Segment],
    drafts: &[Draft],
    decisions: &[Decision],
    exact: &[Option<String>],
    candidates: &[Candidate],
    reason: &str,
) -> ApiResult<Value> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite)?;
    let now = now_ms();
    let (state, claim, channel): (String, Option<String>, String) = transaction
        .query_row(
            "SELECT state, claim, channel FROM queue_groups WHERE id = ?1",
            params![params.group_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
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
    // Configuration and pause are re-read here: a switch turned off or a pause
    // pressed while the model was answering must not let the batch land.
    if !queue::enabled(&transaction) || queue::paused(&transaction) {
        return Err(ApiError::new(Code::Cancelled, "采集已暂停"));
    }
    if !queue::channel_enabled(&transaction, &channel) {
        return Err(ApiError::new(Code::Cancelled, "该来源通道已关闭"));
    }

    // Every source of this batch must still be active, unchanged, still linked to
    // this task and not retracted.
    for item in &params.items {
        let row: Option<(String, String, String, i64)> = transaction
            .query_row(
                "SELECT s.state, s.version, s.fingerprint,
                        (SELECT count(*) FROM queue_items i WHERE i.group_id = ?3 AND i.source_id = s.id)
                 FROM sources s WHERE s.id = ?1",
                params![item.source_id, item.version, params.group_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(sqlite)?;
        let Some((source_state, version, fingerprint, linked)) = row else {
            return Err(ApiError::new(Code::SourceChanged, "来源已不存在"));
        };
        if source_state != "active" {
            return Err(ApiError::new(Code::SourceChanged, "来源已失效"));
        }
        if version != item.version || fingerprint != item.fingerprint {
            return Err(ApiError::new(Code::SourceChanged, "来源版本已变化"));
        }
        if linked == 0 {
            return Err(ApiError::new(Code::SourceChanged, "来源已不属于该任务"));
        }
        if excluded(&transaction, &item.source_id, &item.version)? {
            return Err(ApiError::new(Code::SourceChanged, "来源已被排除"));
        }
    }

    let mut created = Vec::new();
    let mut proposals = Vec::new();
    let mut skipped = 0usize;
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
        let mut retracted = false;
        for (source_id, _) in &draft.sources {
            let version: String = transaction
                .query_row(
                    "SELECT version FROM sources WHERE id = ?1",
                    params![source_id],
                    |row| row.get(0),
                )
                .map_err(sqlite)?;
            if excluded(&transaction, source_id, &version)? {
                retracted = true;
                break;
            }
        }
        if retracted {
            // The user deleted the knowledge this draft would recreate.
            skipped += 1;
            continue;
        }
        // An exact content match wins over whatever the comparison call said: the
        // same conclusion is never written twice, it only gains sources.
        let exact_id = match &exact[index] {
            Some(id) => Some(id.clone()),
            None => exact_card(&transaction, &fingerprint)?,
        };
        if let Some(id) = exact_id {
            // The judgement is only valid for the card it was made against: a card
            // deleted or rewritten while the model was answering must not silently
            // gain sources from an old comparison.
            let current: Option<String> = transaction
                .query_row(
                    "SELECT fingerprint FROM cards WHERE id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(sqlite)?;
            match current {
                Some(fingerprint_now) if fingerprint_now == fingerprint => {
                    attach(&transaction, &id, &source_ids, now)?;
                    created.push(json!({"cardId": id, "action": "reference"}));
                    continue;
                }
                Some(_) => {
                    return Err(ApiError::new(
                        Code::SourceChanged,
                        "目标卡片在提炼期间已变化",
                    ));
                }
                None => {
                    return Err(ApiError::new(
                        Code::SourceChanged,
                        "目标卡片在提炼期间已删除",
                    ));
                }
            }
        }
        let known = |id: &str| -> ApiResult<Option<(i64, i64)>> {
            transaction
                .query_row(
                    "SELECT revision, edited FROM cards WHERE id = ?1",
                    params![id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(sqlite)
        };
        let target = match target {
            Some(id) => match known(&id)? {
                Some(_) => Some(id),
                // The comparison named a card that no longer exists. Falling back to
                // `new` would write a card the model never judged.
                None => {
                    return Err(ApiError::new(
                        Code::SourceChanged,
                        "目标卡片在提炼期间已删除",
                    ));
                }
            },
            None => None,
        };
        match (action, target) {
            ("reference", Some(id)) => {
                let (revision, _) = known(&id)?.expect("checked above");
                if moved_under_us(candidates, &id, revision) {
                    return Err(ApiError::new(
                        Code::SourceChanged,
                        "目标卡片在提炼期间已更新",
                    ));
                }
                attach(&transaction, &id, &source_ids, now)?;
                created.push(json!({"cardId": id, "action": "reference"}));
            }
            ("merge", Some(id)) => {
                let (revision, edited) = known(&id)?.expect("checked above");
                let seen_revision = candidates
                    .iter()
                    .find(|candidate| candidate.id == id)
                    .map(|candidate| candidate.revision);
                let moved = matches!(seen_revision, Some(seen) if seen != revision);
                if edited != 0 || moved {
                    let why = if edited != 0 {
                        "目标卡片已被人工编辑"
                    } else {
                        "目标卡片在提炼期间已更新"
                    };
                    if suggest(
                        &transaction,
                        draft,
                        &id,
                        revision,
                        "propose",
                        why,
                        &source_ids,
                        now,
                    )? {
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
                    // A merge adds detail; it never replaces what the card already
                    // established. The snapshot keeps the previous revision visible.
                    let merged = merge_body(&body, &draft.body);
                    let merged_fingerprint = cards::fingerprint_of(&merged);
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
                                if title.trim().is_empty() { draft.title.clone() } else { title },
                                if summary.trim().is_empty() { draft.summary.clone() } else { summary },
                                merged,
                                merged_list(&transaction, &id, "topics", &draft.topics)?,
                                merged_list(&transaction, &id, "aliases", &draft.aliases)?,
                                merged_fingerprint,
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
                let (revision, _) = known(&id)?.expect("checked above");
                // The same rule as a merge: a suggestion may only be anchored to the
                // revision the model actually judged, never to a newer one.
                if moved_under_us(candidates, &id, revision) {
                    return Err(ApiError::new(
                        Code::SourceChanged,
                        "目标卡片在提炼期间已更新",
                    ));
                }
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
            // A judgement that named a card but lost it must never become a `new`
            // card: there is nothing left to justify the write.
            (action, None) if action != "new" => {
                return Err(ApiError::new(
                    Code::InvalidOutput,
                    format!("判断 {action} 缺少可用的目标卡片"),
                ));
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

    let updated = transaction
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
    if updated == 0 {
        return Err(ApiError::new(
            Code::SourceChanged,
            "任务已被其他批次占用或已结束",
        ));
    }
    ensure_not_cancelled()?;
    transaction.commit().map_err(sqlite)?;

    Ok(json!({
        "groupId": params.group_id,
        "state": state,
        "cards": created,
        "proposals": proposals,
        "skipped": skipped,
        "noKnowledge": drafts.is_empty(),
        "reason": reason,
        "remaining": remaining,
        "segments": batch.len(),
    }))
}

/// Appends the new detail instead of replacing what the card already said.
fn merge_body(existing: &str, incoming: &str) -> String {
    let old = existing.trim();
    let new = incoming.trim();
    if old.is_empty() {
        return new.to_string();
    }
    if new.is_empty() || old.contains(new) {
        return old.to_string();
    }
    format!("{old}\n\n{new}")
}

fn merged_list(
    transaction: &rusqlite::Transaction<'_>,
    card_id: &str,
    column: &str,
    extra: &[String],
) -> ApiResult<String> {
    let current: String = transaction
        .query_row(
            &format!("SELECT {column} FROM cards WHERE id = ?1"),
            params![card_id],
            |row| row.get(0),
        )
        .map_err(sqlite)?;
    let mut values: Vec<String> = serde_json::from_str(&current).unwrap_or_default();
    for value in extra {
        if !values.iter().any(|existing| existing == value) {
            values.push(value.clone());
        }
    }
    values.truncate(MAX_MERGED_TOPICS);
    Ok(serde_json::to_string(&values).unwrap_or_else(|_| "[]".into()))
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
        // A cancelled batch was stopped by a control operation (switch, channel,
        // pause, game mode, deletion): the task stays runnable and continues with
        // the same bodies once the control is lifted.
        "cancelled" | "paused" => "ready",
        // The body itself is gone or changed: only a real re-read helps.
        "source_changed" | "needs_reread" => "needs_reread",
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
