import { PagedList } from '../Pagination'
import { useMemo, useRef, useState, type ChangeEvent } from 'react'
import { Box, Button, Checkbox, IconButton, InputBase, Tooltip, Typography } from '@mui/material'
import {
  addTerm,
  countByTab,
  filterDictionary,
  mergeTerms,
  parseCsv,
  removeTerms,
  type CsvRow,
  type DictionaryTab
} from '@shared/dictionary'
import {
  MAX_DICTIONARY_ENTRIES,
  MAX_DICTIONARY_TERM,
  SUGGESTION_THRESHOLD
} from '@shared/defaults'
import { formatHitCount } from '@shared/count'
import { acceptSuggestion, ignoreSuggestion, pickSuggestions } from '@shared/suggestions'
import type { Replacement, Settings, Suggestion } from '@shared/types'
import { IconPlus, IconSearch, IconTrash } from '../icons'
import i18n from '../../i18n'

interface DictionaryProps {
  settings: Settings
  patch: (value: Partial<Settings>) => void
}

/** One preview of a picked CSV file, before anything is written to settings. */
interface ImportPreview {
  fileName: string
  /** Rows that will actually be added (already de-duplicated against the list). */
  rows: CsvRow[]
  /** Every data row the parser recognised, including the ones it rejected. */
  total: number
  /** Rows skipped because the dictionary already holds that spelling. */
  duplicates: number
  /** Rows the parser could not use (empty first cell, over-long term). */
  invalid: number
  /** How many of `invalid` were only rejected for being too long. */
  overlong: number
  /** Valid rows left out because the dictionary is at its cap. */
  truncated: number
}

/** Suggestions live in settings but are not a dictionary tab: they are a queue. */
type TabId = DictionaryTab | 'suggestions'

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'all', label: i18n.t('所有') },
  { id: 'auto', label: i18n.t('自动') },
  { id: 'manual', label: i18n.t('手动') },
  { id: 'suggestions', label: i18n.t('建议') }
]

/** Local guard so a huge file cannot freeze the renderer before parsing. */
const MAX_CSV_BYTES = 5 * 1024 * 1024

/** Selection keys are the spelling, so an inline edit never desyncs them. */
function selectKey(from: string): string {
  return from.trim().toLocaleLowerCase()
}

/** Pill / inline-editor styling shared by the draft row and every entry row. */
const inputSx = {
  flex: 1,
  minWidth: 0,
  height: 30,
  px: 1.25,
  borderRadius: '8px',
  fontSize: 12.5,
  color: 'text.primary',
  bgcolor: 'action.hover',
  border: 1,
  borderColor: 'divider',
  '& input::placeholder': { color: 'text.disabled', opacity: 1 }
} as const

const cardSx = {
  p: 1.75,
  borderRadius: '10px',
  bgcolor: 'background.paper',
  border: 1,
  borderColor: 'divider',
  display: 'flex',
  alignItems: 'center',
  gap: 1
} as const

const searchBoxSx = {
  display: 'flex',
  alignItems: 'center',
  gap: 0.75,
  height: 30,
  px: 1,
  borderRadius: '8px',
  bgcolor: 'action.hover',
  border: 1,
  borderColor: 'divider'
} as const

const originSx = {
  flex: '0 0 auto',
  height: 18,
  px: 0.75,
  display: 'grid',
  placeItems: 'center',
  borderRadius: 99,
  fontSize: 9.5,
  color: 'text.secondary',
  bgcolor: 'action.hover',
  border: 1,
  borderColor: 'divider'
} as const

/**
 * The hit counter. It sits next to the origin chip and stays readable at a
 * glance: a rule nobody ever hits has to look different from one that fires
 * every other sentence, so zero is grey and the rest use the accent colour.
 */
const hitsSx = {
  flex: '0 0 auto',
  // Wide enough for "999k" but never wider than it needs to be: the badge grows
  // with its content instead of reserving room for the largest possible number.
  minWidth: 22,
  height: 18,
  px: 0.75,
  fontSize: 10.5,
  lineHeight: 1,
  display: 'grid',
  placeItems: 'center',
  borderRadius: 99,
  fontVariantNumeric: 'tabular-nums',
  color: 'text.secondary',
  bgcolor: 'transparent',
  border: 1,
  borderColor: 'divider'
} as const

/** A read-only pair: long terms truncate instead of pushing the buttons away. */
const plainTermSx = {
  fontSize: 12.5,
  color: 'text.primary',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
} as const

/** What the tooltip says about where an entry came from. */
function originTitle(entry: Replacement): string {
  if (entry.origin !== 'auto') return i18n.t('手动添加')
  const hits = entry.hits ?? 0
  return hits > 0 ? `从您的编辑自动学习 · 已确认 ${hits} 次` : i18n.t('从您的编辑自动学习')
}

/**
 * Tooltip for the counter. A zero here is not an error — a rule can be added
 * before the word ever comes up — but it is the number that tells you which
 * rules to prune, so it explains exactly what it counts.
 */
/**
 * Hover text for the hit badge.
 *
 * The counter only moves when the rule's text appears in the transcript
 * character for character — matching is a plain string comparison, so a rule
 * written `debug harness` never counts for the recogniser's `Debug harness`.
 * Spelling that out here is the difference between "the counter is broken" and
 * "the rule needs different capitalisation", which is exactly the question the
 * badge invites.
 */
/**
 * Hover text for the hit badge: the exact number, nothing else.
 *
 * The badge itself is abbreviated past a thousand, so this is where the real
 * figure lives. Anything longer than "命中 1,234 次" turned into a paragraph and
 * hid the number it was supposed to explain.
 */
function hitsTitle(count: number): string {
  return count <= 0 ? i18n.t('还没命中过') : `命中 ${count} 次`
}

/**
 * One-line import summary. The leading count is every row the parser recognised
 * so it matches the file the user is looking at; each following clause says
 * where the rest of those rows went. A preview that silently drops rows is
 * worse than a loud one.
 */
function describePreview(preview: ImportPreview): string {
  const parts = [
    i18n.t('{{file}}：识别到 {{total}} 条，其中 {{valid}} 条有效，{{dup}} 条已存在', { file: preview.fileName, total: preview.total, valid: preview.rows.length, dup: preview.duplicates })
  ]
  if (preview.overlong > 0) {
    parts.push(i18n.t('{{n}} 条超过 {{max}} 个字符已跳过', { n: preview.overlong, max: MAX_DICTIONARY_TERM }))
  }
  const malformed = preview.invalid - preview.overlong
  if (malformed > 0) parts.push(i18n.t('{{n}} 行无法识别', { n: malformed }))
  if (preview.truncated > 0) parts.push(i18n.t('{{n}} 条超出容量未导入', { n: preview.truncated }))
  return parts.join('，')
}

export function DictionaryPage({ settings, patch }: DictionaryProps): JSX.Element {
  const items = settings.replacements
  const pool = settings.suggestions
  const [tab, setTab] = useState<TabId>('all')
  const [query, setQuery] = useState('')
  const [draftFrom, setDraftFrom] = useState('')
  const [draftTo, setDraftTo] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [importError, setImportError] = useState('')
  /**
   * The inline field that currently has focus, with its own copy of what the
   * user has typed. Two reasons this exists instead of reading and writing the
   * settings value directly:
   *
   * 1. The persisted value is trimmed and an empty spelling is dropped by
   *    `normalizeReplacements`, so a half-typed or cleared word would be
   *    rewritten under the caret (and the row would vanish when the field went
   *    empty). The draft is what the caret edits; the store only ever sees the
   *    values it can hold.
   * 2. The row used to be keyed by its spelling, so every keystroke remounted
   *    the input and the caret disappeared after the first character.
   */
  const [editing, setEditing] = useState<{
    index: number
    field: 'from' | 'to'
    value: string
  } | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  // `filterDictionary` only understands dictionary tabs; the suggestion queue
  // has its own list, so the entry list just stays unfiltered behind it.
  const dictionaryTab: DictionaryTab = tab === 'suggestions' ? 'all' : tab
  const counts = useMemo(() => countByTab(items), [items])
  const rows = useMemo(
    () => filterDictionary(items, dictionaryTab, query),
    [items, dictionaryTab, query]
  )
  const selectedKeys = useMemo(() => new Set(selected), [selected])
  const pending = useMemo(() => pickSuggestions(pool), [pool])

  const full = items.length >= MAX_DICTIONARY_ENTRIES
  const draftFromTrimmed = draftFrom.trim()
  const draftTooLong = draftFromTrimmed.length > MAX_DICTIONARY_TERM
  const allVisibleSelected =
    rows.length > 0 && rows.every((row) => selectedKeys.has(selectKey(row.entry.from)))
  const anyVisibleSelected =
    !allVisibleSelected && rows.some((row) => selectedKeys.has(selectKey(row.entry.from)))

  const write = (next: Replacement[]): void => patch({ replacements: next })

  const addDraft = (): void => {
    if (!draftFromTrimmed || draftTooLong || full) return
    const to = draftTo.trim()
    // An empty target means "glossary only": the model learns the spelling but
    // the finished text is never rewritten (mode: 'hint').
    write(addTerm(items, draftFromTrimmed, { to: to || undefined, origin: 'manual' }))
    setDraftFrom('')
    setDraftTo('')
  }

  const removeOne = (from: string): void => {
    write(removeTerms(items, [from]))
    setSelected((current) => current.filter((key) => key !== selectKey(from)))
  }

  const updateOne = (index: number, delta: Partial<Replacement>): void => {
    write(
      items.map((item, i) => {
        if (i !== index) return item
        const next = { ...item, ...delta, updatedAt: Date.now() }
        // Typing a target turns a glossary hint into a real replacement, and
        // clearing it turns the pair back into a hint — an empty target with
        // mode 'replace' would delete the word instead of leaving it alone.
        if (delta.to !== undefined) next.mode = delta.to.trim() ? 'replace' : 'hint'
        return next
      })
    )
  }

  /** What the inline field shows: the draft while it has focus, the store otherwise. */
  const fieldValue = (index: number, field: 'from' | 'to', stored: string): string =>
    editing && editing.index === index && editing.field === field ? editing.value : stored

  /**
   * Keeps the caret on the draft and only ever writes values the store can
   * hold. `normalizeReplacements` drops an empty spelling, so writing one would
   * delete the row out from under the caret — the draft just shows the empty
   * field and the store keeps the last real word.
   */
  const editField = (index: number, field: 'from' | 'to', value: string): void => {
    setEditing({ index, field, value })
    const trimmed = value.trim()
    if (field === 'from' && !trimmed) return
    // The store trims, so "CS2 " and "CS2" are the same entry: skip the write.
    if (items[index]?.[field] === trimmed) return
    if (field === 'to') updateOne(index, { to: trimmed })
    else updateOne(index, { from: trimmed })
  }

  /** Leaving the field drops the draft: the store already matches it. */
  const endEdit = (): void => setEditing(null)

  const toggleRow = (key: string): void => {
    setSelected((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key]
    )
  }

  const toggleAll = (): void => {
    const visibleKeys = rows.map((row) => selectKey(row.entry.from))
    if (allVisibleSelected) {
      setSelected((current) => current.filter((key) => !visibleKeys.includes(key)))
      return
    }
    setSelected((current) => [...new Set([...current, ...visibleKeys])])
  }

  const deleteSelected = (): void => {
    if (selected.length === 0) return
    write(removeTerms(items, selected))
    setSelected([])
  }

  /**
   * Accepting is the only path from a suggestion into the real dictionary, so it
   * replaces any auto-learned row with the same spelling instead of going
   * through `addTerm` alone: that helper keeps an existing origin, which would
   * leave the word marked "learned from your edits" even though the user just
   * vouched for it by hand.
   */
  const acceptOne = (suggestion: Suggestion): void => {
    if (full) return
    const now = Date.now()
    const to = suggestion.to.trim()
    const others = items.filter((entry) => selectKey(entry.from) !== selectKey(suggestion.from))
    patch({
      replacements: addTerm(others, suggestion.from, {
        to: to || undefined,
        mode: to ? 'replace' : 'hint',
        origin: 'manual',
        now
      }),
      suggestions: acceptSuggestion(pool, suggestion.from, now)
    })
  }

  const ignoreOne = (suggestion: Suggestion): void => {
    patch({ suggestions: ignoreSuggestion(pool, suggestion.from, Date.now()) })
  }

  const onPickFile = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    // Clearing the value lets the same file be picked again after a cancel.
    event.target.value = ''
    if (!file) return
    setImportError('')
    if (file.size > MAX_CSV_BYTES) {
      setImportError(i18n.t('CSV 文件超过 5 MB，请拆分后再导入。'))
      return
    }
    void file.text().then(
      (text) => {
        const parsed = parseCsv(text)
        const existing = new Set(items.map((entry) => selectKey(entry.from)))
        const room = Math.max(0, MAX_DICTIONARY_ENTRIES - items.length)
        const fresh: CsvRow[] = []
        let duplicates = parsed.duplicates
        let truncated = parsed.truncated
        for (const row of parsed.rows) {
          const key = selectKey(row.from)
          if (existing.has(key)) {
            duplicates += 1
            continue
          }
          if (fresh.length >= room) {
            truncated += 1
            continue
          }
          fresh.push(row)
          existing.add(key)
        }
        setPreview({
          fileName: file.name,
          rows: fresh,
          // The file's own row count, so "识别到" always matches what the user
          // sees in their spreadsheet rather than only the importable subset.
          total: parsed.rows.length + parsed.duplicates + parsed.invalid + parsed.truncated,
          duplicates,
          invalid: parsed.invalid,
          overlong: parsed.overlong,
          truncated
        })
      },
      () => setImportError(i18n.t('无法读取该文件，请确认它是 UTF-8 文本 CSV。'))
    )
  }

  const confirmImport = (): void => {
    if (!preview) return
    if (preview.rows.length > 0) {
      // Rows carry their target, so a two-column file imports real mappings
      // instead of turning every pair into a glossary-only hint.
      write(mergeTerms(items, preview.rows, { origin: 'manual' }))
    }
    setPreview(null)
  }

  const emptyTitle = query.trim()
    ? i18n.t('没有匹配的规则')
    : tab === 'auto'
      ? i18n.t('还没有自动学习的规则')
      : tab === 'manual'
        ? i18n.t('还没有手动添加的规则')
        : i18n.t('还没有词汇')

  return (
    <Box sx={{ px: 4, py: 4 }}>
      {/*
        The 20px title and the 11.5px capacity counter are one text pair, so they
        share a baseline; the tab pills are controls and centre themselves.
      */}
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5, flexWrap: 'wrap' }}>
        <Typography sx={{ fontSize: 20, fontWeight: 600, letterSpacing: -0.3 }}>{i18n.t(i18n.t('纠正规则'))}</Typography>
        <Typography
          sx={{ fontSize: 11.5, color: full ? 'warning.main' : 'text.secondary' }}
          aria-label={i18n.t(i18n.t('纠正规则数量'))}
        >
          {items.length}/{MAX_DICTIONARY_ENTRIES}
        </Typography>
        <Box sx={{ ml: 'auto', display: 'flex', gap: 0.75, alignSelf: 'center' }}>
          {TABS.map((entry) => {
            const active = tab === entry.id
            const badge = entry.id === 'suggestions' ? pending.length : counts[entry.id]
            return (
              <Box
                key={entry.id}
                role="button"
                aria-pressed={active}
                onClick={() => setTab(entry.id)}
                sx={{
                  px: 1.5,
                  height: 26,
                  display: 'grid',
                  placeItems: 'center',
                  borderRadius: 99,
                  fontSize: 11.5,
                  cursor: 'pointer',
                  color: active ? 'text.primary' : 'text.secondary',
                  bgcolor: active ? 'action.selected' : 'transparent',
                  border: 1,
                  borderColor: active ? 'divider' : 'transparent',
                  fontWeight: active ? 600 : 400,
                  '&:hover': { color: 'text.primary' }
                }}
              >
                {entry.label} {badge}
              </Box>
            )
          })}
        </Box>
      </Box>

      <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 1 }}>
        {tab === 'suggestions'
          ? i18n.t('同样的改动累计出现 {{n}} 次才会出现在这里；采纳后才会作为术语交给模型，忽略则不再提示。', { n: SUGGESTION_THRESHOLD })
          : i18n.t('规则会作为术语表交给模型；右边填了内容还会做字面替换，留空只提示、不改文字。最右侧的数字是原文里出现它的次数。')}
      </Typography>

      {tab === 'suggestions' ? (
        <>
          {pending.length === 0 ? (
            <Box sx={{ mt: 6, textAlign: 'center' }}>
              <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
                {i18n.t('还没有待确认的建议')}
              </Typography>
              <Typography sx={{ fontSize: 11.5, mt: 0.5, color: 'text.disabled' }}>
                {i18n.t('插入文字后手动改同一处，改到第 {{n}} 次就会记在这里。', { n: SUGGESTION_THRESHOLD })}
              </Typography>
            </Box>
          ) : (
            <Box sx={{ mt: 2.5, display: 'flex', flexDirection: 'column', gap: 1 }}>
              <PagedList name="Dictionary-pending">{pending.map((suggestion) => (
                <Box key={selectKey(suggestion.from)} sx={cardSx}>
                  <Typography sx={plainTermSx}>{suggestion.from}</Typography>
                  <Typography sx={{ color: 'text.disabled', fontSize: 12 }}>→</Typography>
                  <Typography sx={{ ...plainTermSx, color: 'text.secondary' }}>
                    {suggestion.to.trim() || i18n.t('只提示，不改文字')}
                  </Typography>
                  <Tooltip title={i18n.t('已看到 {{n}} 次', { n: suggestion.count })}>
                    <Box sx={originSx}>{i18n.t('{{n}} 次', { n: suggestion.count })}</Box>
                  </Tooltip>
                  <Box sx={{ flex: 1 }} />
                  <Button
                    size="small"
                    variant="contained"
                    disabled={full}
                    aria-label={i18n.t('采纳建议 {{name}}', { name: suggestion.from })}
                    onClick={() => acceptOne(suggestion)}
                    sx={{ flex: '0 0 auto', fontSize: 12 }}
                  >
                    {i18n.t('采纳')}
                  </Button>
                  <Button
                    size="small"
                    variant="text"
                    aria-label={i18n.t('忽略建议 {{name}}', { name: suggestion.from })}
                    onClick={() => ignoreOne(suggestion)}
                    sx={{ flex: '0 0 auto', fontSize: 12, color: 'text.secondary' }}
                  >
                    {i18n.t('忽略')}
                  </Button>
                </Box>
              ))}</PagedList>
            </Box>
          )}
          {full && pending.length > 0 && (
            <Typography sx={{ fontSize: 11.5, color: 'warning.main', mt: 0.75 }}>
              {i18n.t('规则已满（{{max}} 条），删除一些规则后再采纳。', { max: MAX_DICTIONARY_ENTRIES })}
            </Typography>
          )}
        </>
      ) : (
        <>
          <Box sx={{ mt: 2, display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            <Box sx={searchBoxSx}>
              <Box sx={{ color: 'text.disabled', display: 'grid', placeItems: 'center' }}>
                <IconSearch size={14} />
              </Box>
              <InputBase
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={i18n.t(i18n.t('搜索规则'))}
                inputProps={{ 'aria-label': i18n.t('搜索规则') }}
                sx={{
                  fontSize: 12.5,
                  width: 170,
                  color: 'text.primary',
                  '& input::placeholder': { color: 'text.disabled', opacity: 1 }
                }}
              />
            </Box>
            <Box sx={{ flex: 1 }} />
            {selected.length > 0 && (
              <Button
                size="small"
                variant="text"
                startIcon={<IconTrash size={14} />}
                onClick={deleteSelected}
                sx={{ fontSize: 12, color: 'error.main', '&:hover': { bgcolor: 'action.hover' } }}
              >
                {i18n.t('删除所选 {{n}}', { n: selected.length })}
              </Button>
            )}
            <Tooltip
              title={
                full
                  ? i18n.t('规则已满，先删掉一些规则再导入')
                  : i18n.t('导入 CSV：一行一个词，或「原文,替换成」两列；也支持制表符和分号分隔')
              }
            >
              <Box component="span">
                <Button
                  size="small"
                  variant="outlined"
                  disabled={full}
                  onClick={() => fileRef.current?.click()}
                  sx={{ fontSize: 12 }}
                >
                  {i18n.t('导入 CSV')}
                </Button>
              </Box>
            </Tooltip>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              style={{ display: 'none' }}
              onChange={onPickFile}
            />
          </Box>

          <Box sx={{ ...cardSx, mt: 2.5 }}>
            <InputBase
              value={draftFrom}
              onChange={(event) => setDraftFrom(event.target.value)}
              placeholder={i18n.t(i18n.t('识别成什么（例如：复刻）'))}
              disabled={full}
              inputProps={{ 'aria-label': i18n.t('新增规则的原文') }}
              sx={inputSx}
            />
            <Typography sx={{ color: 'text.disabled', fontSize: 12 }}>→</Typography>
            <InputBase
              value={draftTo}
              onChange={(event) => setDraftTo(event.target.value)}
              placeholder={i18n.t(i18n.t('替换成什么（留空 = 只做术语提示）'))}
              disabled={full}
              inputProps={{ 'aria-label': i18n.t('新增规则的替换文字') }}
              sx={inputSx}
            />
            <Button
              size="small"
              variant="contained"
              startIcon={<IconPlus size={14} />}
              onClick={addDraft}
              disabled={!draftFromTrimmed || draftTooLong || full}
              sx={{ flex: '0 0 auto' }}
            >
              {i18n.t('新词')}
            </Button>
          </Box>

          {draftTooLong && (
            <Typography sx={{ fontSize: 11.5, color: 'warning.main', mt: 0.75 }}>
              {i18n.t('规则最多 {{max}} 个字符，当前 {{n}} 个。', { max: MAX_DICTIONARY_TERM, n: draftFromTrimmed.length })}
            </Typography>
          )}
          {full && (
            <Typography sx={{ fontSize: 11.5, color: 'warning.main', mt: 0.75 }}>
              {i18n.t('规则已满（{{max}} 条），删除一些规则后再添加。', { max: MAX_DICTIONARY_ENTRIES })}
            </Typography>
          )}
          {importError && (
            <Typography sx={{ fontSize: 11.5, color: 'error.main', mt: 0.75 }}>
              {importError}
            </Typography>
          )}

          {preview && (
            <Box
              sx={{ ...cardSx, mt: 1.5, flexDirection: 'column', alignItems: 'stretch', gap: 0.75 }}
            >
              <Typography sx={{ fontSize: 12.5 }}>{describePreview(preview)}</Typography>
              <Box sx={{ display: 'flex', gap: 1 }}>
                <Button
                  size="small"
                  variant="contained"
                  disabled={preview.rows.length === 0}
                  onClick={confirmImport}
                >
                  {i18n.t('确认导入')}
                </Button>
                <Button
                  size="small"
                  variant="text"
                  onClick={() => setPreview(null)}
                  sx={{ color: 'text.secondary' }}
                >
                  {i18n.t('取消')}
                </Button>
              </Box>
            </Box>
          )}

          {rows.length > 0 && (
            <Box sx={{ mt: 2, display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <Checkbox
                size="small"
                checked={allVisibleSelected}
                indeterminate={anyVisibleSelected}
                onChange={toggleAll}
                inputProps={{ 'aria-label': i18n.t('全选当前列表') }}
                sx={{ p: 0.5 }}
              />
              <Typography sx={{ fontSize: 11.5, color: 'text.secondary' }}>
                {i18n.t('{{n}} 条', { n: rows.length })}
                {selected.length > 0 ? ' · ' + i18n.t('已选 {{n}} 条', { n: selected.length }) : ''}
              </Typography>
            </Box>
          )}

          {rows.length === 0 ? (
            <Box sx={{ mt: 6, textAlign: 'center' }}>
              <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>{emptyTitle}</Typography>
              <Typography sx={{ fontSize: 11.5, mt: 0.5, color: 'text.disabled' }}>
                {i18n.t('添加专有名词、人名或产品名，让转写永远写对。')}
              </Typography>
            </Box>
          ) : (
            <Box
              sx={{
                mt: rows.length > 0 ? 1 : 2,
                display: 'flex',
                flexDirection: 'column',
                gap: 1
              }}
            >
              <PagedList name="Dictionary-rows" resetKey={`${query}|${tab}`}>{rows.map((row) => {
                const key = selectKey(row.entry.from)
                return (
                  <Box
                    /**
                     * Keyed by position, never by the spelling: that string
                     * changes on every keystroke, and a changed key remounts
                     * the row — which is what ate the caret after one letter.
                     */
                    key={row.index}
                    sx={{
                      px: 1.25,
                      py: 1.25,
                      borderRadius: '10px',
                      bgcolor: 'background.paper',
                      border: 1,
                      borderColor: 'divider',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 1
                    }}
                  >
                    <Checkbox
                      size="small"
                      checked={selectedKeys.has(key)}
                      onChange={() => toggleRow(key)}
                      inputProps={{ 'aria-label': i18n.t('选择 {{name}}', { name: row.entry.from }) }}
                      sx={{ p: 0.5 }}
                    />
                    <InputBase
                      value={fieldValue(row.index, 'from', row.entry.from)}
                      onChange={(event) => editField(row.index, 'from', event.target.value)}
                      onBlur={endEdit}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
                      }}
                      inputProps={{ 'aria-label': i18n.t('规则原文') }}
                      sx={inputSx}
                    />
                    <Typography sx={{ color: 'text.disabled', fontSize: 12 }}>→</Typography>
                    <InputBase
                      value={fieldValue(row.index, 'to', row.entry.to)}
                      onChange={(event) => editField(row.index, 'to', event.target.value)}
                      onBlur={endEdit}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
                      }}
                      placeholder={row.entry.mode === 'hint' ? i18n.t('只提示，不改文字') : i18n.t('替换成')}
                      inputProps={{ 'aria-label': i18n.t('规则替换文字') }}
                      sx={inputSx}
                    />
                    <Tooltip title={originTitle(row.entry)}>
                      <Box sx={originSx}>{row.entry.origin === 'auto' ? i18n.t('自动') : i18n.t('手动')}</Box>
                    </Tooltip>
                    <Tooltip title={hitsTitle(row.entry.hits ?? 0)}>
                      <Box
                        sx={{
                          ...hitsSx,
                          color: (row.entry.hits ?? 0) > 0 ? 'primary.light' : 'text.disabled',
                          borderColor: (row.entry.hits ?? 0) > 0 ? 'primary.dark' : 'divider'
                        }}
                        data-dict-hits={row.entry.hits ?? 0}
                        aria-label={i18n.t('命中 {{n}} 次', { n: row.entry.hits ?? 0 })}
                      >
                        {formatHitCount(row.entry.hits ?? 0)}
                      </Box>
                    </Tooltip>
                    <IconButton
                      size="small"
                      aria-label={i18n.t(i18n.t('删除规则'))}
                      onClick={() => removeOne(row.entry.from)}
                      sx={{
                        color: 'text.secondary',
                        '&:hover': { color: 'error.main', bgcolor: 'action.hover' }
                      }}
                    >
                      <IconTrash size={14} />
                    </IconButton>
                  </Box>
                )
              })}</PagedList>
            </Box>
          )}
        </>
      )}
    </Box>
  )
}
