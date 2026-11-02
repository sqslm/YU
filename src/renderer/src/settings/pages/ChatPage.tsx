import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Divider, IconButton, InputAdornment, List, ListItemButton, Menu, MenuItem, Stack, TextField, Tooltip, Typography } from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import CreateNewFolderOutlined from '@mui/icons-material/CreateNewFolderOutlined'
import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded'
import MenuOpenRounded from '@mui/icons-material/MenuOpenRounded'
import MenuRounded from '@mui/icons-material/MenuRounded'
import MoreHorizRounded from '@mui/icons-material/MoreHorizRounded'
import SendRounded from '@mui/icons-material/SendRounded'
import SettingsOutlined from '@mui/icons-material/SettingsOutlined'
import StopRounded from '@mui/icons-material/StopRounded'
import SearchRounded from '@mui/icons-material/SearchRounded'
import AttachFileRounded from '@mui/icons-material/AttachFileRounded'
import CloseRounded from '@mui/icons-material/CloseRounded'
import GraphicEqRounded from '@mui/icons-material/GraphicEqRounded'
import DescriptionOutlined from '@mui/icons-material/DescriptionOutlined'
import type { ChatDetail, ChatGroup, ChatIndex, ChatThread } from '@shared/chat'
import { CHAT_ATTACHMENT_BYTES, CHAT_ATTACHMENT_LIMIT, CHAT_ATTACHMENT_TOTAL, CHAT_FILE_ACCEPT } from '@shared/chat'
import type { Settings } from '@shared/types'
import type { LocalRecord } from '@shared/workspace'
import { stripSourceTail } from '@shared/sourceText'
import { MarkdownView } from '../../card/MarkdownView'
import i18n from '../../i18n'
import { registerGameModePreparation } from '../gameModePreparation'
import { useTranslation } from 'react-i18next'

function messageOf(error: unknown): string { return i18n.t((error instanceof Error ? error.message : String(error)).replace(/^Error: /, '').replace(/^Error invoking remote method '[^']+': Error: /, '')) }
interface PendingFile { id: string; file: File; preview?: string }
/**
 * Thinking-effort choices for one conversation.
 *
 * `''` ("默认") is deliberately distinct from `null`: null means "never chosen", which the main
 * process resolves to thinking-on (高). Both are offered because a model that rejects `reasoning_effort`
 * altogether still needs an escape hatch.
 */
const EFFORTS = [{ value: 'off', label: '关闭' }, { value: 'low', label: '低' }, { value: 'high', label: '高' }, { value: 'max', label: '最高' }, { value: '', label: '默认' }] as const
function effortLabel(value: string | null): string { return (EFFORTS.find(item => item.value === (value ?? 'high')) ?? EFFORTS[2]).label }
function stored<T>(key: string, fallback: T): T { try { const raw = localStorage.getItem(key); return raw === null ? fallback : JSON.parse(raw) as T } catch { return fallback } }
function remember(key: string, value: unknown): void { try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage can be unavailable; the toggle still works for this session */ } }
/** Enabled LLM profiles in `chains.llm` order, unlisted ones appended — the order the main process fails over through. */
function llmChoices(settings: Settings): Array<{ id: string; label: string }> {
  const order = settings.chains.llm ?? []
  const rank = (id: string): number => { const at = order.indexOf(id); return at < 0 ? order.length : at }
  return settings.profiles.filter(profile => profile.kind === 'llm' && profile.enabled).sort((a, b) => rank(a.id) - rank(b.id)).map(profile => ({ id: profile.id, label: (profile.model || profile.name).trim() || profile.id }))
}

export function ChatPage({ onModels, onOpenRecord }: { onModels(): void; onOpenRecord(record: LocalRecord): Promise<void> }): JSX.Element {
  const { t } = useTranslation()
  const [index, setIndex] = useState<ChatIndex>({ threads: [], groups: [], busyThreadId: null })
  const [selected, setSelected] = useState<string | null>(null), selectedRef = useRef<string | null>(null)
  const [detail, setDetail] = useState<ChatDetail | null>(null), [drafts, setDrafts] = useState<Record<string, string>>({})
  const [files, setFiles] = useState<Record<string, PendingFile[]>>({}), [dragging, setDragging] = useState(false)
  const picker = useRef<HTMLInputElement>(null), objectUrls = useRef(new Set<string>())
  const [preview, setPreview] = useState<{ name: string; url?: string; text?: string } | null>(null)
  useEffect(() => () => { for (const url of objectUrls.current) URL.revokeObjectURL(url) }, [])
  const [query, setQuery] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(true), [status, setStatus] = useState('')
  const [menu, setMenu] = useState<{ element: HTMLElement; thread?: ChatThread; group?: ChatGroup } | null>(null)
  const [edit, setEdit] = useState<{ action: 'rename' | 'group-create' | 'group-rename'; id?: string; name: string } | null>(null)
  const [remove, setRemove] = useState<{ action: 'delete' | 'group-delete'; id: string; name: string } | null>(null)
  const [moving, setMoving] = useState(false), [saving, setSaving] = useState(false)
  const [limit, setLimit] = useState(100), limitRef = useRef(100), ticket = useRef(0), scroll = useRef<HTMLDivElement>(null), nearBottom = useRef(true)
  // Layout state lives in localStorage: which groups are folded and whether the rail is open are
  // window habits, not conversation data, so they never round-trip through the main process.
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>(() => stored<string[]>('chat.groups.collapsed', []))
  const [navOpen, setNavOpen] = useState<boolean>(() => !stored<boolean>('chat.nav.collapsed', false))
  const [models, setModels] = useState<Array<{ id: string; label: string }>>([])
  const [draftModel, setDraftModel] = useState<{ profileId: string | null; effort: string } | null>(null), [modelMenu, setModelMenu] = useState<HTMLElement | null>(null)
  const toggleNav = (): void => setNavOpen(open => { remember('chat.nav.collapsed', open); return !open })
  const toggleGroup = (key: string): void => setCollapsedGroups(previous => { const next = previous.includes(key) ? previous.filter(item => item !== key) : [...previous, key]; remember('chat.groups.collapsed', next); return next })
  const loadModels = useCallback(async (): Promise<void> => {
    try { setModels(llmChoices(await window.api.settings.get())) } catch { /* an unreadable list must not block chatting: the menu then offers the settings entry */ }
  }, [])
  useEffect(() => { void loadModels() }, [loadModels])
  const choose = (id: string | null): void => { setError(''); selectedRef.current = id; setSelected(id); limitRef.current = 100; setLimit(100); nearBottom.current = true }
  const refresh = useCallback(async (): Promise<void> => {
    const request = ++ticket.current
    try {
      const next = await window.api.chat.list()
      if (ticket.current !== request) return
      setIndex(next)
      let id = selectedRef.current
      if (id && !next.threads.some(row => row.id === id)) { id = next.threads[0]?.id ?? null; selectedRef.current = id; setSelected(id) }
      const row = id ? await window.api.chat.get(id, limitRef.current) : null
      if (ticket.current === request) setDetail(row)
    } catch (error) { if (ticket.current === request) setError(messageOf(error)) }
    finally { if (ticket.current === request) setLoading(false) }
  }, [])
  useEffect(() => {
    void refresh()
    const off = window.api.chat.onEvent(event => {
      if (event.type === 'changed') { setStatus(''); void refresh(); return }
      if (event.threadId !== selectedRef.current) return
      setStatus(event.status)
      setDetail(previous => previous?.id === event.threadId ? { ...previous, messages: previous.messages.map(message => message.id === event.messageId ? { ...message, text: event.text } : message) } : previous)
    })
    return () => { ++ticket.current; off() }
  }, [refresh])
  useEffect(() => { void refresh() }, [selected, limit, refresh])
  useEffect(() => { if (nearBottom.current) scroll.current?.scrollTo({ top: scroll.current.scrollHeight }) }, [detail?.messages, status])
  useEffect(() => registerGameModePreparation(async () => !index.busyThreadId && !Object.values(drafts).some(text => text.trim()) && !Object.values(files).some(items => items.length)), [drafts, files, index.busyThreadId])
  const draftKey = selected ?? 'new', draft = drafts[draftKey] ?? ''
  const pendingFiles = files[draftKey] ?? []
  const addFiles = (incoming: File[]): void => {
    if (saving) return
    const all = [...pendingFiles.map(item => item.file), ...incoming]
    if (all.length > CHAT_ATTACHMENT_LIMIT) { setError(t('每条消息最多添加 5 个附件')); return }
    if (incoming.some(file => !file.size || file.size > CHAT_ATTACHMENT_BYTES)) { setError(t('每个附件需为非空文件，且不超过 10 MiB')); return }
    if (all.reduce((size, file) => size + file.size, 0) > CHAT_ATTACHMENT_TOTAL) { setError(t('一条消息的附件总大小不能超过 25 MiB')); return }
    if (incoming.some(file => !CHAT_FILE_ACCEPT.split(',').includes('.' + file.name.split('.').at(-1)?.toLowerCase()))) { setError(t('此文件格式暂不支持，请选择图片、PDF、Office 新格式或文本文件')); return }
    const next = incoming.map(file => {
      const preview = /\.(?:png|jpe?g|webp|gif|bmp|avif)$/i.test(file.name) ? URL.createObjectURL(file) : undefined
      if (preview) objectUrls.current.add(preview)
      return { id: crypto.randomUUID(), file, preview }
    })
    setFiles(previous => ({ ...previous, [draftKey]: [...(previous[draftKey] ?? []), ...next] })); setError('')
  }
  const removeFile = (item: PendingFile): void => {
    if (item.preview) { URL.revokeObjectURL(item.preview); objectUrls.current.delete(item.preview) }
    setFiles(previous => ({ ...previous, [draftKey]: previous[draftKey].filter(file => file.id !== item.id) }))
  }
  // A model picked before the thread exists is parked in `draftModel` and written right after
  // `create()`, so the very first answer already runs on the chosen model.
  const adoptDraftModel = async (id: string): Promise<void> => {
    if (!draftModel) return
    await window.api.chat.edit({ action: 'model', id, profileId: draftModel.profileId, effort: draftModel.effort })
    setDraftModel(null)
  }
  const create = async (group: string | null = null): Promise<void> => {
    setError('')
    try { const row = await window.api.chat.create(group); await adoptDraftModel(row.id); choose(row.id); setDetail(row); await refresh() }
    catch (error) { setError(messageOf(error)) }
  }
  const send = async (): Promise<void> => {
    const text = draft.trim()
    if ((!text && !pendingFiles.length) || index.busyThreadId || saving) return
    setError(''); setSaving(true)
    let restoreKey = draftKey
    try {
      let id = selected
      if (!id) { const row = await window.api.chat.create(); id = row.id; restoreKey = id; await adoptDraftModel(id); choose(id); setDetail(row) }
      const attachments = await Promise.all(pendingFiles.map(async item => ({ name: item.file.name, bytes: new Uint8Array(await item.file.arrayBuffer()) })))
      setDrafts(previous => ({ ...previous, [draftKey]: '' })); nearBottom.current = true
      await window.api.chat.send(id, text, attachments)
      setFiles(previous => ({ ...previous, [draftKey]: [] }))
      for (const item of pendingFiles) if (item.preview) { URL.revokeObjectURL(item.preview); objectUrls.current.delete(item.preview) }
      await refresh()
    } catch (error) {
      setError(messageOf(error))
      setDrafts(previous => { const next = { ...previous, [restoreKey]: previous[restoreKey] || text }; if (restoreKey !== draftKey) delete next[draftKey]; return next })
      if (restoreKey !== draftKey) setFiles(previous => { const next = { ...previous, [restoreKey]: previous[draftKey] ?? [] }; delete next[draftKey]; return next })
    }
    finally { setSaving(false) }
  }
  const saveName = async (): Promise<void> => {
    if (!edit?.name.trim() || saving) return
    setError('')
    setSaving(true)
    try { await window.api.chat.edit(edit as Parameters<typeof window.api.chat.edit>[0]); setEdit(null); await refresh() }
    catch (error) { setError(messageOf(error)) }
    finally { setSaving(false) }
  }
  const current = detail && detail.id === selected ? detail : null
  const currentProfileId = current ? current.profileId ?? null : draftModel?.profileId ?? null
  const currentEffort = (current ? current.effort : draftModel?.effort) ?? 'high'
  const currentLabel = currentProfileId ? models.find(model => model.id === currentProfileId)?.label : models[0]?.label
  const modelTitle = models.length ? `${currentLabel ?? t('已停用的模型')} · ${t(effortLabel(currentEffort))}` : t('未配置模型')
  const applyModel = (profileId: string | null, effort: string): void => {
    setModelMenu(null)
    if (!selected) { setDraftModel({ profileId, effort }); return }
    void window.api.chat.edit({ action: 'model', id: selected, profileId, effort }).then(refresh).catch(error => setError(messageOf(error)))
  }
  // 未分组 is a real section, and it belongs at the bottom like an inbox — the folders the user
  // took the trouble to name should be the first thing they see.
  const groups: Array<ChatGroup | null> = [...index.groups, null]
  const needle = query.toLocaleLowerCase()
  const matches = (thread: ChatThread): boolean => thread.title.toLocaleLowerCase().includes(needle)
  const shown = index.threads.filter(matches)
  return <Box data-chat-page sx={{ display: 'flex', height: '100%', minHeight: 0, overflow: 'hidden', borderTop: 1, borderColor: 'divider' }}>
    <Box component="nav" aria-label={t('对话与分组')} aria-hidden={!navOpen} sx={{ width: navOpen ? { xs: 180, lg: 230 } : 0, flexShrink: 0, bgcolor: 'background.paper', overflow: 'hidden', borderRight: 1, borderColor: navOpen ? 'divider' : 'transparent', transition: 'width .22s ease' }}>
      {/* Fixed-width inner column so the rail slides instead of reflowing its contents; hidden it
          also leaves the tab order, which is why visibility rather than opacity is used. */}
      <Box sx={{ width: { xs: 180, lg: 230 }, height: '100%', display: 'flex', flexDirection: 'column', p: 2, gap: 2, visibility: navOpen ? 'visible' : 'hidden' }}>
        <Stack direction="row" alignItems="center" gap={.5}>
          <Button variant="contained" startIcon={<AddRounded sx={{ fontSize: 18 }} />} onClick={() => void create()} sx={{ flex: 1, minWidth: 0, justifyContent: 'flex-start', borderRadius: 2, fontSize: 12.5, fontWeight: 600, py: 1, textTransform: 'none' }}>{t('新对话')}</Button>
          <Tooltip title={t('新建分组')}><span><IconButton size="small" aria-label={t('新建分组')} onClick={() => setEdit({ action: 'group-create', name: '' })}><CreateNewFolderOutlined sx={{ fontSize: 18 }} /></IconButton></span></Tooltip>
        </Stack>
        <TextField size="small" placeholder={t('搜索对话')} value={query} onChange={event => setQuery(event.target.value)} InputProps={{ startAdornment: <InputAdornment position="start"><SearchRounded sx={{ fontSize: 17 }} /></InputAdornment> }} />
        <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {!index.threads.length && <Typography sx={{ px: 1, py: 2, fontSize: 11.5, lineHeight: 1.7, color: 'text.secondary' }}>{loading ? t('正在读取对话…') : t('还没有对话，点上面的「新对话」开始')}</Typography>}
          {!!index.threads.length && !shown.length && <Typography sx={{ px: 1, py: 2, fontSize: 11.5, color: 'text.secondary' }}>{t('没有匹配的对话')}</Typography>}
          {!!index.threads.length && groups.map(group => {
            const key = group?.id ?? 'ungrouped', rows = index.threads.filter(row => row.groupId === (group?.id ?? null)), folded = collapsedGroups.includes(key)
            return <Box key={key} sx={{ mb: 1 }}>
              <Stack direction="row" alignItems="center" sx={{ '&:hover .group-more': { opacity: 1 }, '&:focus-within .group-more': { opacity: 1 } }}>
                <ListItemButton aria-expanded={!folded} onClick={() => toggleGroup(key)} sx={{ py: .25, px: .5, minWidth: 0, borderRadius: 1, gap: .5 }}>
                  <ExpandMoreRounded sx={{ fontSize: 16, color: 'text.secondary', transition: 'transform .16s ease', transform: folded ? 'rotate(-90deg)' : 'none' }} />
                  <Typography noWrap sx={{ flex: 1, minWidth: 0, fontSize: 11, fontWeight: 600, color: 'text.secondary', letterSpacing: .3 }}>{group?.name ?? t('未分组')}</Typography>
                  <Typography sx={{ fontSize: 10.5, color: 'text.secondary', opacity: .75 }}>{rows.length}</Typography>
                </ListItemButton>
                {group && <IconButton className="group-more" size="small" aria-label={t('分组操作')} onClick={event => { setMenu({ element: event.currentTarget, group }); setMoving(false) }} sx={{ opacity: 0, transition: 'opacity .15s', '&:focus-visible': { opacity: 1 } }}><MoreHorizRounded sx={{ fontSize: 16 }} /></IconButton>}
              </Stack>
              {!folded && <List dense disablePadding>
                {rows.filter(matches).map(thread => <Box key={thread.id} sx={{ display: 'flex', alignItems: 'center', '&:hover .row-more': { opacity: 1 }, '&:focus-within .row-more': { opacity: 1 } }}>
                  <ListItemButton selected={thread.id === selected} onClick={() => choose(thread.id)} sx={{ py: .5, px: .75, minWidth: 0, borderRadius: 1.5, gap: .5 }}>
                    {index.busyThreadId === thread.id && <Box component="span" aria-label={t('正在生成')} sx={{ color: 'primary.main', fontSize: 8, lineHeight: 1 }}>●</Box>}
                    <Typography noWrap sx={{ minWidth: 0, fontSize: 12.5, fontWeight: thread.id === selected ? 600 : 400 }}>{thread.title === '新对话' ? t(thread.title) : thread.title}</Typography>
                  </ListItemButton>
                  <IconButton className="row-more" size="small" aria-label={t('对话操作')} onClick={event => { setMenu({ element: event.currentTarget, thread }); setMoving(false) }} sx={{ opacity: 0, transition: 'opacity .15s', '&:focus-visible': { opacity: 1 }, mr: .25 }}><MoreHorizRounded sx={{ fontSize: 16 }} /></IconButton>
                </Box>)}
              </List>}
            </Box>
          })}
        </Box>
      </Box>
    </Box>
    <Box onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true) } }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false) }} onDrop={event => { event.preventDefault(); setDragging(false); addFiles(Array.from(event.dataTransfer.files)) }} sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', outline: dragging ? '2px dashed' : 'none', outlineColor: 'primary.main', outlineOffset: -3 }}>
      {/* The rail toggle sits in the content header, not in the rail — otherwise collapsing it would
          take away the only control that brings it back. */}
      <Stack direction="row" alignItems="center" sx={{ px: { xs: 1.5, lg: 3 }, py: 1.5, borderBottom: 1, borderColor: 'divider', gap: 1 }}>
        <Tooltip title={t(navOpen ? '收起对话列表' : '展开对话列表')}><IconButton size="small" aria-label={t(navOpen ? '收起对话列表' : '展开对话列表')} aria-expanded={navOpen} onClick={toggleNav}>{navOpen ? <MenuOpenRounded fontSize="small" /> : <MenuRounded fontSize="small" />}</IconButton></Tooltip>
        <Typography sx={{ fontSize: 15, fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{detail ? detail.title === '新对话' ? t(detail.title) : detail.title : t('语')}</Typography>
        {detail?.memoryTemporary && <Typography variant="caption" color="text.secondary">{t('本对话不读写长期记忆')}</Typography>}
        <Tooltip title={t('对话的模型与思考强度')}><Button size="small" onClick={event => { setModelMenu(event.currentTarget); void loadModels() }} endIcon={<ExpandMoreRounded sx={{ fontSize: 16 }} />} sx={{ minWidth: 0, maxWidth: 260, py: .25, px: 1.25, borderRadius: 999, border: 1, borderColor: 'divider', color: 'text.secondary', fontSize: 11.5, textTransform: 'none', '& .MuiButton-endIcon': { ml: .25 } }}><Typography noWrap sx={{ fontSize: 11.5 }}>{modelTitle}</Typography></Button></Tooltip>
        <Tooltip title={t('模型设置')}><IconButton size="small" aria-label={t('模型设置')} onClick={onModels}><SettingsOutlined fontSize="small" /></IconButton></Tooltip>
      </Stack>
      {error && <Alert severity="error" onClose={() => setError('')} action={<Button color="inherit" size="small" onClick={() => { setError(''); void refresh() }}>{t('刷新')}</Button>}>{error.replace(/^Error: /, '')}</Alert>}
      <Box ref={scroll} onScroll={event => { const el = event.currentTarget; nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }} sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: { xs: 2, lg: 4 }, py: 2.5 }}>
        {detail && detail.total > detail.messages.length && <Button fullWidth size="small" onClick={() => { nearBottom.current = false; limitRef.current += 100; setLimit(limitRef.current) }}>{t('加载更早消息')}</Button>}
        {!detail?.messages.length && <Box sx={{ maxWidth: 460, mx: 'auto', pt: { xs: '5vh', lg: '9vh' }, textAlign: 'center' }}>
          <Box aria-hidden sx={{ width: 64, height: 64, mx: 'auto', mb: 3, display: 'grid', placeItems: 'center', color: 'primary.main', bgcolor: 'action.selected', border: 1, borderColor: 'divider', borderRadius: '20px' }}><GraphicEqRounded sx={{ fontSize: 30 }} /></Box>
          <Typography component="h1" sx={{ fontSize: { xs: 28, lg: 36 }, fontWeight: 500, letterSpacing: -1, mb: 1.5 }}>{t('和语聊聊')}<Box component="span" sx={{ color: 'primary.main' }}>.</Box></Typography>
          <Typography color="text.secondary" role={loading ? 'status' : undefined} sx={{ lineHeight: 2, fontSize: 13, maxWidth: 350, mx: 'auto' }}>{loading ? t('正在读取对话…') : t('提问、梳理想法，或一起解决问题。对话保存在本机，可按分组整理。')}</Typography>
        </Box>}
        {detail?.messages.map(message => <Box key={message.id} data-chat-message={message.role} sx={{ maxWidth: 760, mx: 'auto', mb: 3, display: 'flex', flexDirection: 'column', alignItems: message.role === 'user' ? 'flex-end' : 'stretch' }}>
          <Typography sx={{ fontSize: 10.5, color: 'text.secondary', mb: .8 }}>{t(message.role === 'user' ? '你' : '语')}</Typography>
          {!!message.attachments?.length && <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mb: 1 }}>{message.attachments.map(file => <Button key={file.id} variant="outlined" size="small" title={file.name} onClick={() => { void window.api.chat.attachment(detail.id, file.id).then(setPreview).catch(error => setError(messageOf(error))) }} sx={{ textTransform: 'none', maxWidth: 220, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: .5 }}>
            {file.thumbnail && <Box component="img" src={file.thumbnail} alt={file.name} sx={{ height: 65, maxWidth: 160, objectFit: 'contain' }} />}
            <Typography variant="caption" noWrap sx={{ maxWidth: '100%' }}>{file.name}</Typography><Typography variant="caption" color="text.secondary">{Math.max(1, Math.round(file.size / 1024))} KB{file.truncated ? ` · ${t('部分内容')}` : ''}</Typography>
          </Button>)}</Stack>}
          {message.role === 'user' ? <Box sx={{ bgcolor: 'action.selected', border: 1, borderColor: 'divider', borderRadius: '16px 16px 4px 16px', p: '12px 18px', maxWidth: '90%', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 14 }}>{message.text}</Box>
            : <Box sx={theme => ({ fontSize: 14, lineHeight: 1.9, overflowWrap: 'anywhere', '--answer-text': theme.palette.text.primary, '--answer-muted': theme.palette.text.secondary, '--answer-accent': theme.palette.primary.main, '--answer-line': theme.palette.divider, '--answer-fill': theme.palette.action.hover })}><MarkdownView text={(message.sources?.length ? stripSourceTail(message.text) : message.text) || t('正在思考…')} sources={message.sources} streaming={message.state === 'working'} onCopyCode={text => { void window.api.app.copyText(text) }} /></Box>}
          {!!message.records?.length && <Stack direction="row" gap={.5} flexWrap="wrap">{message.records.map(record => <Button size="small" variant="outlined" key={`${record.kind}:${record.id}`} onClick={() => void onOpenRecord(record).catch(error => setError(messageOf(error)))}>{t('查看原记录')} · {record.title || record.id}</Button>)}</Stack>}
          {message.state === 'error' && <Typography color="error" variant="caption">{t('本轮回答失败，可重新发送')}</Typography>}
          {message.state === 'cancelled' && <Typography color="text.secondary" variant="caption">{t('生成已停止')}</Typography>}
          {message.role === 'assistant' && message.state === 'done' && <Button size="small" sx={{ alignSelf: 'flex-start', fontSize: 11, color: 'text.secondary', px: 0 }} onClick={() => void window.api.app.copyText(message.text)}>{t('复制回答')}</Button>}
        </Box>)}
      </Box>
      <Box sx={{ px: { xs: 2, lg: 4 }, pb: 2.5, pt: 1, width: '100%', maxWidth: 840, mx: 'auto' }}>
        {!!pendingFiles.length && <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mb: 1 }}>{pendingFiles.map(item => <Stack key={item.id} direction="row" alignItems="center" sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, p: .5, maxWidth: 220 }}>
          <Button size="small" title={item.file.name} onClick={() => { if (item.preview) setPreview({ name: item.file.name, url: item.preview }); else void item.file.slice(0, 20000).text().then(text => setPreview({ name: item.file.name, text: /\.(?:pdf|docx|xlsx|pptx|odt|ods|odp)$/i.test(item.file.name) ? t('发送时提取正文；扫描版或加密文档暂不支持。') : text })) }} sx={{ minWidth: 0, textTransform: 'none', gap: .75 }}>
            {item.preview ? <Box component="img" src={item.preview} alt="" sx={{ width: 36, height: 36, objectFit: 'cover', borderRadius: .5 }} /> : <DescriptionOutlined fontSize="small" />}<Typography variant="caption" noWrap sx={{ maxWidth: 120 }}>{item.file.name}</Typography>
          </Button><IconButton disabled={saving} size="small" aria-label={t('移除附件') + ': ' + item.file.name} onClick={() => removeFile(item)}><CloseRounded sx={{ fontSize: 16 }} /></IconButton>
        </Stack>)}</Stack>}
        {status && index.busyThreadId === selected && <Typography variant="caption" color="text.secondary">{status}</Typography>}
        {index.busyThreadId && index.busyThreadId !== selected && <Button size="small" onClick={() => choose(index.busyThreadId)}>{t('另一个对话正在生成，点击查看')}</Button>}
        <Box sx={{ border: 1, borderColor: 'divider', borderRadius: '16px', p: 1.5, bgcolor: 'background.paper', display: 'flex', alignItems: 'flex-end', gap: 1, boxShadow: '0 4px 20px rgba(20,40,28,.04)', transition: 'border-color .16s ease, box-shadow .16s ease', '&:focus-within': { borderColor: 'primary.main', boxShadow: theme => `0 0 0 3px ${theme.palette.action.selected}` } }}>
          <input ref={picker} type="file" accept={CHAT_FILE_ACCEPT} multiple hidden onChange={event => { addFiles(Array.from(event.target.files ?? [])); event.target.value = '' }} />
          <Tooltip title={t('添加文件或图片')}><span><IconButton aria-label={t('添加文件或图片')} disabled={saving} onClick={() => picker.current?.click()}><AttachFileRounded /></IconButton></span></Tooltip>
          <TextField fullWidth multiline maxRows={5} variant="standard" placeholder={t('和语说点什么…')} value={draft} inputProps={{ maxLength: 12000 }} InputProps={{ disableUnderline: true }}
            onChange={event => setDrafts(previous => ({ ...previous, [draftKey]: event.target.value }))}
            onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send() } }} sx={{ px: 1, '& textarea': { fontSize: 13 } }} />
          {index.busyThreadId ? <Tooltip title={t('停止生成')}><IconButton aria-label={t('停止生成')} onClick={() => void window.api.chat.cancel()}><StopRounded /></IconButton></Tooltip>
            : <Tooltip title={t('发送消息')}><span><IconButton color="primary" aria-label={t('发送消息')} disabled={(!draft.trim() && !pendingFiles.length) || saving} onClick={() => void send()} sx={{ bgcolor: 'primary.main', color: 'primary.contrastText', '&:hover': { bgcolor: 'primary.dark', color: 'primary.contrastText' }, '&.Mui-disabled': { bgcolor: 'action.hover', color: 'text.disabled' } }}><SendRounded sx={{ fontSize: 20 }} /></IconButton></span></Tooltip>}
        </Box><Typography sx={{ fontSize: 10, color: 'text.secondary', mt: .75 }}>{t('可拖入文件或图片 · 每次 5 个，每个 10 MiB · 图片需视觉模型')}</Typography><Typography sx={{ fontSize: 10, color: 'text.secondary', mt: .25 }} title={t('对话与附件保存在安装目录，文件内容仅作为本轮参考，不自动记为个人事实。')}>{t('Enter 发送 · Shift+Enter 换行 · 新对话互不串联')}</Typography>
      </Box>
    </Box>
    <Dialog open={Boolean(preview)} onClose={() => setPreview(null)} fullWidth maxWidth="sm"><DialogTitle sx={{ overflowWrap: 'anywhere' }}>{preview?.name}</DialogTitle><DialogContent>{preview?.url ? <Box component="img" src={preview.url} alt={preview.name} sx={{ maxWidth: '100%', maxHeight: '60vh', display: 'block', mx: 'auto' }} /> : <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{preview?.text}</Typography>}</DialogContent><DialogActions><Button onClick={() => setPreview(null)}>{t('关闭')}</Button></DialogActions></Dialog>
    <Menu anchorEl={modelMenu} open={Boolean(modelMenu)} onClose={() => setModelMenu(null)} slotProps={{ paper: { sx: { minWidth: 240, maxHeight: 460 } } }}>
      <Typography sx={{ px: 2, pt: .75, pb: .25, fontSize: 11, fontWeight: 600, color: 'text.secondary' }}>{t('对话模型')}</Typography>
      {models.length ? [<MenuItem key="follow" selected={!currentProfileId} onClick={() => applyModel(null, currentEffort)}>{t('跟随默认（第一个 LLM）')}</MenuItem>,
        ...models.map(model => <MenuItem key={model.id} selected={currentProfileId === model.id} onClick={() => applyModel(model.id, currentEffort)}>{model.label}</MenuItem>)]
        : <Box sx={{ px: 2, py: .5 }}><Typography sx={{ fontSize: 11.5, color: 'text.secondary', lineHeight: 1.6 }}>{t('请先在设置里配置 LLM')}</Typography><Button size="small" onClick={() => { setModelMenu(null); onModels() }} sx={{ mt: .5 }}>{t('前往模型设置')}</Button></Box>}
      <Divider sx={{ my: .75 }} />
      <Typography sx={{ px: 2, pt: .25, pb: .25, fontSize: 11, fontWeight: 600, color: 'text.secondary' }}>{t('思考强度')}</Typography>
      {EFFORTS.map(item => <MenuItem key={item.value || 'auto'} selected={currentEffort === item.value} onClick={() => applyModel(currentProfileId, item.value)}>{t(item.label)}</MenuItem>)}
    </Menu>
    <Menu anchorEl={menu?.element} open={Boolean(menu)} onClose={() => setMenu(null)}>
      {moving ? [<MenuItem key="none" onClick={() => { void window.api.chat.edit({ action: 'move', id: menu!.thread!.id, groupId: null }).then(refresh).catch(error => setError(messageOf(error))); setMenu(null) }}>{t('未分组')}</MenuItem>, ...index.groups.map(group => <MenuItem key={group.id} onClick={() => { void window.api.chat.edit({ action: 'move', id: menu!.thread!.id, groupId: group.id }).then(refresh).catch(error => setError(messageOf(error))); setMenu(null) }}>{group.name}</MenuItem>)]
        : menu?.thread ? [<MenuItem key="rename" onClick={() => { setEdit({ action: 'rename', id: menu.thread!.id, name: menu.thread!.title }); setMenu(null) }}>{t('重命名')}</MenuItem>, <MenuItem key="move" onClick={() => setMoving(true)}>{t('移至分组')}</MenuItem>, <MenuItem key="delete" onClick={() => { setRemove({ action: 'delete', id: menu.thread!.id, name: menu.thread!.title }); setMenu(null) }}>{t('删除对话')}</MenuItem>]
          : menu?.group ? [<MenuItem key="new" onClick={() => { void create(menu.group!.id); setMenu(null) }}>{t('在分组中新建对话')}</MenuItem>, <MenuItem key="rename" onClick={() => { setEdit({ action: 'group-rename', id: menu.group!.id, name: menu.group!.name }); setMenu(null) }}>{t('重命名分组')}</MenuItem>, <MenuItem key="delete" onClick={() => { setRemove({ action: 'group-delete', id: menu.group!.id, name: menu.group!.name }); setMenu(null) }}>{t('删除分组')}</MenuItem>] : null}
    </Menu>
    <Dialog open={Boolean(edit)} onClose={() => { if (!saving) setEdit(null) }} fullWidth maxWidth="xs"><DialogTitle>{t(edit?.action === 'group-create' ? '新建分组' : '重命名')}</DialogTitle><DialogContent><TextField autoFocus fullWidth margin="dense" label={t('名称')} value={edit?.name ?? ''} inputProps={{ maxLength: 80 }} onChange={event => setEdit(previous => previous ? { ...previous, name: event.target.value } : null)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) void saveName() }} /></DialogContent><DialogActions><Button disabled={saving} onClick={() => setEdit(null)}>{t('取消')}</Button><Button disabled={saving || !edit?.name.trim()} onClick={() => void saveName()}>{t('保存')}</Button></DialogActions></Dialog>
    <Dialog open={Boolean(remove)} onClose={() => setRemove(null)}><DialogTitle>{t(remove?.action === 'group-delete' ? '删除分组' : '删除对话')}</DialogTitle><DialogContent><Typography>{remove?.name}</Typography><Typography variant="body2" color="text.secondary">{t(remove?.action === 'group-delete' ? '分组中的对话会移到未分组，不会删除对话。' : '此对话的消息将从本机删除，无法撤销。')}</Typography></DialogContent><DialogActions><Button onClick={() => setRemove(null)}>{t('取消')}</Button><Button color="error" onClick={() => { if (remove) void window.api.chat.edit(remove).then(() => { setRemove(null); return refresh() }).catch(error => setError(messageOf(error))) }}>{t('删除')}</Button></DialogActions></Dialog>
  </Box>
}
