import { useEffect, useState } from 'react'
import { Alert, Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, MenuItem, Stack, Switch, TextField, Typography } from '@mui/material'
import type { Settings } from '@shared/types'
import { ENTITY_TYPES, type EntityInput, type EntityTerm, type EntityType } from '@shared/entities'
import { asrEnhancementCapability } from '@shared/asr-enhancement'
import { ENTITY_SOURCES, type EntitySourceId } from '@shared/entity-sources'
import { SettingsGroup, SettingsRow } from './General'
import { registerGameModePreparation } from '../gameModePreparation'
import i18n from '../../i18n'

const LABELS: Record<EntityType, string> = { person: '人物', work: '影视与文学作品', game: '游戏', technology: '软件与技术术语', model: 'AI 模型', product: '品牌和产品', place: '地理名称', custom: '自定义名称' }
const blank = (): EntityInput => ({ canonical: '', aliases: [], related: [], domain: '', source: 'manual', type: 'custom', verified: false, enabled: true })
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /u, '')
const split = (value: string): string[] => value.split(/[,，\n]/u).map(word => word.trim()).filter(Boolean)

export function EntityEnhancement({ settings, patch }: { settings: Settings; patch: (delta: Partial<Settings>) => void }): JSX.Element {
  const t = i18n.t.bind(i18n)
  const [open, setOpen] = useState(false), [rows, setRows] = useState<EntityTerm[]>([]), [query, setQuery] = useState('')
  const [draft, setDraft] = useState<EntityInput | null>(null), [id, setId] = useState<string | undefined>()
  const [aliases, setAliases] = useState(''), [related, setRelated] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [removing, setRemoving] = useState<EntityTerm | null>(null)
  const [sources, setSources] = useState<EntitySourceId[]>(ENTITY_SOURCES.map(source => source.id))
  useEffect(() => draft ? registerGameModePreparation(async () => false) : undefined, [Boolean(draft)])
  const load = async (): Promise<void> => { setRows(await window.api.entities.list()) }
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true); setError(''); setNotice('')
    try { await action() } catch (error) { setError(t(message(error))) } finally { setBusy(false) }
  }
  const edit = (row?: EntityTerm): void => { setDraft(row ? { ...row } : blank()); setId(row?.id); setAliases(row?.aliases.join('，') ?? ''); setRelated(row?.related.join('，') ?? '') }
  const profiles = settings.chains.asr.map(id => settings.profiles.find(profile => profile.id === id)).filter(profile => profile?.enabled)
  const found = rows.filter(row => [row.canonical, row.domain, ...row.aliases].join(' ').toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  return <SettingsGroup title={t('语音识别增强')}>
    <SettingsRow label={t('智能专有名词增强')} description={t('根据当前场景选取少量词条；候选交给现有模型判断，不作为全局替换规则。')}>
      <Switch size="small" checked={settings.speechEnhancement} onChange={event => patch({ speechEnhancement: event.target.checked })} inputProps={{ 'aria-label': t('智能专有名词增强') }} />
    </SettingsRow>
    <Box sx={{ px: 2, pb: 2 }}>
      <Typography variant="caption" color="text.secondary">{t('启用后，相关词条可能发送给当前配置的 ASR 或 LLM；不自动采集私人历史，不建立长期记忆。')}</Typography>
      {settings.pipelineMode === 'multimodal' ? <Typography variant="body2">{t('音频直达模式沿用现有请求，不增加 ASR 或纠错调用。')}</Typography> : <>
        {settings.localAsr.enabled && <Typography variant="body2">{t('内置本地 ASR：当前不支持原生热词；可在已有 LLM 润色中提供候选。')}</Typography>}
        {profiles.map(profile => profile && <Typography key={profile.id} variant="body2">{profile.name} · {t(asrEnhancementCapability(profile) === 'none' ? '原生增强未验证，仅提供 LLM 候选' : '支持 ASR 上下文与 LLM 候选')}</Typography>)}
        {!settings.localAsr.enabled && !profiles.length && <Typography variant="body2">{t('请先配置 ASR 模型')}</Typography>}
      </>}
      <Button size="small" sx={{ mt: 1 }} onClick={() => { setOpen(true); void run(load) }}>{t('管理专有名词词库')}</Button>
    </Box>
    <Dialog open={open} maxWidth="md" fullWidth onClose={() => { if (!busy) setOpen(false) }} data-entity-library>
      <DialogTitle>{t('专有名词词库')}</DialogTitle>
      <DialogContent>
        <Box sx={{ bgcolor: 'action.hover', p: 2, borderRadius: 1, mb: 2 }}>
          <Typography fontWeight={600}>{t('公共词库')}</Typography>
          <Typography variant="body2" color="text.secondary">{t('由开源社区维护，直接下载到本机。再次导入只补充新词，不覆盖你的编辑或启停状态。')}</Typography>
          {ENTITY_SOURCES.map(source => <Box key={source.id}>
            <FormControlLabel control={<Checkbox size="small" disabled={busy} checked={sources.includes(source.id)} onChange={event => setSources(previous => event.target.checked ? [...previous, source.id] : previous.filter(id => id !== source.id))} />} label={t(source.name)} />
            <Typography variant="caption" color="text.secondary">{t(source.description)} · {source.license}</Typography>
          </Box>)}
          <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
            <Button variant="contained" size="small" disabled={busy || !sources.length} onClick={() => void run(async () => { const count = await window.api.entities.importPublic(sources); await load(); setNotice(t('公共词库已更新，新增 {{n}} 个词条。', { n: count })) })}>{t(busy ? '处理中…' : '一键导入 / 更新')}</Button>
            <Button size="small" href="https://github.com/gaboolic/rime-frost" target="_blank" rel="noreferrer">{t('白霜拼音来源与许可证')}</Button>
            <Button size="small" href="https://github.com/thunlp/THUOCL" target="_blank" rel="noreferrer">{t('清华词库来源与许可证')}</Button>
          </Stack>
          <Typography variant="caption" color="text.secondary">{t('公共词表不保证覆盖最新人名或作品，也不含可靠的演员与作品关联；不会强制按同音词替换。下载时不发送录音、历史或密钥。')}</Typography>
        </Box>
        <Stack direction="row" spacing={1} sx={{ mb: 2, mt: 1 }}>
          <TextField size="small" fullWidth label={t('搜索名称、别名或领域')} value={query} onChange={event => setQuery(event.target.value)} />
          <Button disabled={busy} onClick={() => edit()}>{t('添加')}</Button>
          <Button disabled={busy} onClick={() => void run(async () => { const count = await window.api.entities.import(); if (count === null) return; await load(); setNotice(t('已导入 {{n}} 个新词条；已有词条保持原样。', { n: count })) })}>{t('导入')}</Button>
          <Button disabled={busy} onClick={() => void run(async () => { if (await window.api.entities.export()) setNotice(t('词库已导出')) })}>{t('导出')}</Button>
        </Stack>
        {error && <Alert severity="error" sx={{ mb: 1 }}>{error}</Alert>}{notice && <Alert severity="info" sx={{ mb: 1 }}>{notice}</Alert>}
        {!rows.length && <Typography color="text.secondary">{t('尚无词条。手动添加常用名称或导入 JSON 词库。')}</Typography>}
        {found.slice(0, 200).map(row => <Stack key={row.id} direction="row" spacing={1} alignItems="center" sx={{ py: 1, borderBottom: 1, borderColor: 'divider' }}>
          <Checkbox checked={row.enabled} disabled={busy} inputProps={{ 'aria-label': t('启用 {{name}}', { name: row.canonical }) }} onChange={event => void run(async () => { await window.api.entities.save({ ...row, enabled: event.target.checked }, row.id); await load() })} />
          <Box sx={{ flex: 1, minWidth: 0 }}><Typography sx={{ overflowWrap: 'anywhere' }}>{row.canonical}</Typography><Typography variant="caption" color="text.secondary">{t(LABELS[row.type])} · {row.domain} · {row.aliases.join('，')}</Typography></Box>
          <Button disabled={busy} onClick={() => edit(row)}>{t('编辑')}</Button><Button disabled={busy} onClick={() => setRemoving(row)}>{t('删除')}</Button>
        </Stack>)}
        {found.length > 200 && <Typography variant="caption">{t('结果较多，显示前 200 项，请搜索缩小范围。')}</Typography>}
      </DialogContent>
      <DialogActions><Button disabled={busy} onClick={() => void run(load)}>{t('刷新')}</Button><Button disabled={busy} onClick={() => setOpen(false)}>{t('关闭')}</Button></DialogActions>
    </Dialog>
    <Dialog open={Boolean(draft)} maxWidth="sm" fullWidth onClose={() => { if (!busy) setDraft(null) }}>
      <DialogTitle>{t(id ? '编辑词条' : '添加词条')}</DialogTitle>
      {draft && <DialogContent><Stack spacing={2} sx={{ pt: 1 }}>
        <TextField label={t('标准名称')} value={draft.canonical} onChange={event => setDraft({ ...draft, canonical: event.target.value })} inputProps={{ maxLength: 80 }} />
        <TextField select label={t('类别')} value={draft.type} onChange={event => setDraft({ ...draft, type: event.target.value as EntityType })}>{ENTITY_TYPES.map(type => <MenuItem key={type} value={type}>{t(LABELS[type])}</MenuItem>)}</TextField>
        <TextField label={t('别名或常见误写（逗号分隔）')} value={aliases} onChange={event => setAliases(event.target.value)} multiline maxRows={4} />
        <TextField label={t('领域（留空表示常用词）')} helperText={t('可填“技术”“编程”或相关应用名称；只有匹配场景时才作为 ASR 预先热词。')} value={draft.domain} onChange={event => setDraft({ ...draft, domain: event.target.value })} inputProps={{ maxLength: 80 }} />
        <TextField label={t('关联名称（逗号分隔）')} value={related} onChange={event => setRelated(event.target.value)} />
        <TextField label={t('来源或核实依据')} value={draft.source} onChange={event => setDraft({ ...draft, source: event.target.value })} inputProps={{ maxLength: 300 }} />
        <FormControlLabel control={<Checkbox checked={draft.verified} onChange={event => setDraft({ ...draft, verified: event.target.checked })} />} label={t('已核实名称与关联')} />
        {error && <Alert severity="error">{error}</Alert>}
      </Stack></DialogContent>}
      <DialogActions><Button disabled={busy} onClick={() => setDraft(null)}>{t('取消')}</Button><Button variant="contained" disabled={busy || !draft?.canonical.trim()} onClick={() => void run(async () => { await window.api.entities.save({ ...draft!, aliases: split(aliases), related: split(related) }, id); await load(); setDraft(null) })}>{t('保存')}</Button></DialogActions>
    </Dialog>
    <Dialog open={Boolean(removing)} onClose={() => { if (!busy) setRemoving(null) }}><DialogTitle>{t('删除词条')} · {removing?.canonical}</DialogTitle><DialogActions><Button disabled={busy} onClick={() => setRemoving(null)}>{t('取消')}</Button><Button disabled={busy} color="error" onClick={() => void run(async () => { await window.api.entities.remove(removing!.id); await load(); setRemoving(null) })}>{t('删除')}</Button></DialogActions></Dialog>
  </SettingsGroup>
}
