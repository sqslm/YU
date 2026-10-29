import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, InputAdornment, List, ListItemButton, Menu, MenuItem, Stack, TextField, Tooltip, Typography } from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import MoreHorizRounded from '@mui/icons-material/MoreHorizRounded'
import SendRounded from '@mui/icons-material/SendRounded'
import StopRounded from '@mui/icons-material/StopRounded'
import SearchRounded from '@mui/icons-material/SearchRounded'
import AttachFileRounded from '@mui/icons-material/AttachFileRounded'
import CloseRounded from '@mui/icons-material/CloseRounded'
import DescriptionOutlined from '@mui/icons-material/DescriptionOutlined'
import type { ChatDetail, ChatGroup, ChatIndex, ChatThread } from '@shared/chat'
import { CHAT_ATTACHMENT_BYTES, CHAT_ATTACHMENT_LIMIT, CHAT_ATTACHMENT_TOTAL, CHAT_FILE_ACCEPT } from '@shared/chat'
import { MarkdownView } from '../../card/MarkdownView'
import i18n from '../../i18n'
import { registerGameModePreparation } from '../gameModePreparation'
import { useTranslation } from 'react-i18next'

function messageOf(error: unknown): string { return i18n.t((error instanceof Error ? error.message : String(error)).replace(/^Error: /, '').replace(/^Error invoking remote method '[^']+': Error: /, '')) }
interface PendingFile { id: string; file: File; preview?: string }

export function ChatPage({ onModels }: { onModels(): void }): JSX.Element {
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
  const create = async (group: string | null = null): Promise<void> => {
    setError('')
    try { const row = await window.api.chat.create(group); choose(row.id); setDetail(row); await refresh() }
    catch (error) { setError(messageOf(error)) }
  }
  const send = async (): Promise<void> => {
    const text = draft.trim()
    if ((!text && !pendingFiles.length) || index.busyThreadId || saving) return
    setError(''); setSaving(true)
    let restoreKey = draftKey
    try {
      let id = selected
      if (!id) { const row = await window.api.chat.create(); id = row.id; restoreKey = id; choose(id); setDetail(row) }
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
  const groups: Array<ChatGroup | null> = [null, ...index.groups]
  return <Box data-chat-page sx={{ display: 'flex', height: '100%', minHeight: 0, overflow: 'hidden', borderTop: 1, borderColor: 'divider' }}>
    <Box component="nav" aria-label={t('对话与分组')} sx={{ width: { xs: 180, lg: 230 }, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: 1, borderColor: 'divider', p: 1.5, gap: 1 }}>
      <Button startIcon={<AddRounded />} variant="outlined" onClick={() => void create()}>{t('新对话')}</Button>
      <TextField size="small" placeholder={t('搜索对话')} value={query} onChange={event => setQuery(event.target.value)} InputProps={{ startAdornment: <InputAdornment position="start"><SearchRounded sx={{ fontSize: 17 }} /></InputAdornment> }} />
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {groups.map(group => <Box key={group?.id ?? 'ungrouped'} sx={{ mb: 1.5 }}>
          <Stack direction="row" alignItems="center"><Typography sx={{ flex: 1, fontSize: 11, color: 'text.secondary', pl: 1, overflowWrap: 'anywhere' }}>{group?.name ?? t('未分组')}</Typography>
            {group && <IconButton size="small" aria-label={t('分组操作')} onClick={event => { setMenu({ element: event.currentTarget, group }); setMoving(false) }}><MoreHorizRounded fontSize="small" /></IconButton>}</Stack>
          <List dense disablePadding>
            {index.threads.filter(row => row.groupId === (group?.id ?? null) && row.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(thread => <Box key={thread.id} sx={{ display: 'flex', alignItems: 'center', borderRadius: 1, bgcolor: selected === thread.id ? 'action.selected' : undefined, '&:hover': { bgcolor: 'action.hover' } }}>
              <ListItemButton selected={false} onClick={() => choose(thread.id)} sx={{ py: 1, minWidth: 0, borderRadius: 1 }}><Typography title={thread.title} sx={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{index.busyThreadId === thread.id ? '● ' : ''}{thread.title === '新对话' ? t(thread.title) : thread.title}</Typography></ListItemButton>
              <IconButton size="small" aria-label={t('对话操作')} onClick={event => { setMenu({ element: event.currentTarget, thread }); setMoving(false) }}><MoreHorizRounded sx={{ fontSize: 16 }} /></IconButton>
            </Box>)}
          </List>
        </Box>)}
      </Box>
      <Button size="small" startIcon={<AddRounded />} onClick={() => setEdit({ action: 'group-create', name: '' })}>{t('新建分组')}</Button>
    </Box>
    <Box onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true) } }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false) }} onDrop={event => { event.preventDefault(); setDragging(false); addFiles(Array.from(event.dataTransfer.files)) }} sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', outline: dragging ? '2px dashed' : 'none', outlineColor: 'primary.main', outlineOffset: -3 }}>
      <Stack direction="row" alignItems="center" sx={{ px: 3, py: 1.5, borderBottom: 1, borderColor: 'divider', gap: 1 }}><Typography sx={{ fontSize: 15, fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{detail ? detail.title === '新对话' ? t(detail.title) : detail.title : t('语')}</Typography>{detail?.memoryTemporary && <Typography variant="caption" color="text.secondary">{t('本对话不读写长期记忆')}</Typography>}<Button size="small" onClick={onModels}>{t('模型设置')}</Button></Stack>
      {error && <Alert severity="error" onClose={() => setError('')} action={<Button color="inherit" size="small" onClick={() => { setError(''); void refresh() }}>{t('刷新')}</Button>}>{error.replace(/^Error: /, '')}</Alert>}
      <Box ref={scroll} onScroll={event => { const el = event.currentTarget; nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }} sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: { xs: 2, lg: 4 }, py: 2.5 }}>
        {detail && detail.total > detail.messages.length && <Button fullWidth size="small" onClick={() => { nearBottom.current = false; limitRef.current += 100; setLimit(limitRef.current) }}>{t('加载更早消息')}</Button>}
        {!detail?.messages.length && <Box sx={{ maxWidth: 560, mx: 'auto', pt: '12vh' }}><Typography sx={{ fontSize: 30, fontWeight: 650, mb: 1.5 }}>{t('和语聊聊')}</Typography><Typography color="text.secondary" sx={{ lineHeight: 1.8, fontSize: 13 }}>{loading ? t('正在读取对话…') : t('提问、梳理想法，或一起解决问题。对话保存在本机，可按分组整理。')}</Typography></Box>}
        {detail?.messages.map(message => <Box key={message.id} data-chat-message={message.role} sx={{ maxWidth: 760, mx: 'auto', mb: 3, display: 'flex', flexDirection: 'column', alignItems: message.role === 'user' ? 'flex-end' : 'stretch' }}>
          <Typography sx={{ fontSize: 10.5, color: 'text.secondary', mb: .8 }}>{t(message.role === 'user' ? '你' : '语')}</Typography>
          {!!message.attachments?.length && <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mb: 1 }}>{message.attachments.map(file => <Button key={file.id} variant="outlined" size="small" title={file.name} onClick={() => { void window.api.chat.attachment(detail.id, file.id).then(setPreview).catch(error => setError(messageOf(error))) }} sx={{ textTransform: 'none', maxWidth: 220, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: .5 }}>
            {file.thumbnail && <Box component="img" src={file.thumbnail} alt={file.name} sx={{ height: 65, maxWidth: 160, objectFit: 'contain' }} />}
            <Typography variant="caption" noWrap sx={{ maxWidth: '100%' }}>{file.name}</Typography><Typography variant="caption" color="text.secondary">{Math.max(1, Math.round(file.size / 1024))} KB{file.truncated ? ` · ${t('部分内容')}` : ''}</Typography>
          </Button>)}</Stack>}
          {message.role === 'user' ? <Box sx={{ bgcolor: 'action.hover', borderRadius: '12px 12px 3px 12px', p: '10px 14px', maxWidth: '90%', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 13 }}>{message.text}</Box>
            : <Box sx={{ fontSize: 13, lineHeight: 1.8, overflowWrap: 'anywhere', '& [data-card-markdown]': { color: 'text.primary' }, '& [data-card-markdown] :not(a):not(button)': { color: 'inherit' } }}><MarkdownView text={message.text || t('正在思考…')} sources={message.sources} streaming={message.state === 'working'} onCopyCode={text => { void window.api.app.copyText(text) }} /></Box>}
          {message.state === 'error' && <Typography color="error" variant="caption">{t('本轮回答失败，可重新发送')}</Typography>}
          {message.state === 'cancelled' && <Typography color="text.secondary" variant="caption">{t('生成已停止')}</Typography>}
          {message.role === 'assistant' && message.state === 'done' && <Button size="small" sx={{ alignSelf: 'flex-start', fontSize: 11, color: 'text.secondary', px: 0 }} onClick={() => void window.api.app.copyText(message.text)}>{t('复制回答')}</Button>}
        </Box>)}
      </Box>
      <Box sx={{ px: { xs: 2, lg: 4 }, pb: 2, pt: 1 }}>
        {!!pendingFiles.length && <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mb: 1 }}>{pendingFiles.map(item => <Stack key={item.id} direction="row" alignItems="center" sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, p: .5, maxWidth: 220 }}>
          <Button size="small" title={item.file.name} onClick={() => { if (item.preview) setPreview({ name: item.file.name, url: item.preview }); else void item.file.slice(0, 20000).text().then(text => setPreview({ name: item.file.name, text: /\.(?:pdf|docx|xlsx|pptx|odt|ods|odp)$/i.test(item.file.name) ? t('发送时提取正文；扫描版或加密文档暂不支持。') : text })) }} sx={{ minWidth: 0, textTransform: 'none', gap: .75 }}>
            {item.preview ? <Box component="img" src={item.preview} alt="" sx={{ width: 36, height: 36, objectFit: 'cover', borderRadius: .5 }} /> : <DescriptionOutlined fontSize="small" />}<Typography variant="caption" noWrap sx={{ maxWidth: 120 }}>{item.file.name}</Typography>
          </Button><IconButton disabled={saving} size="small" aria-label={t('移除附件') + ': ' + item.file.name} onClick={() => removeFile(item)}><CloseRounded sx={{ fontSize: 16 }} /></IconButton>
        </Stack>)}</Stack>}
        {status && index.busyThreadId === selected && <Typography variant="caption" color="text.secondary">{status}</Typography>}
        {index.busyThreadId && index.busyThreadId !== selected && <Button size="small" onClick={() => choose(index.busyThreadId)}>{t('另一个对话正在生成，点击查看')}</Button>}
        <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 1, bgcolor: 'background.paper', display: 'flex', alignItems: 'flex-end', gap: 1 }}>
          <input ref={picker} type="file" accept={CHAT_FILE_ACCEPT} multiple hidden onChange={event => { addFiles(Array.from(event.target.files ?? [])); event.target.value = '' }} />
          <Tooltip title={t('添加文件或图片')}><span><IconButton aria-label={t('添加文件或图片')} disabled={saving} onClick={() => picker.current?.click()}><AttachFileRounded /></IconButton></span></Tooltip>
          <TextField fullWidth multiline maxRows={5} variant="standard" placeholder={t('和语说点什么…')} value={draft} inputProps={{ maxLength: 12000 }} InputProps={{ disableUnderline: true }}
            onChange={event => setDrafts(previous => ({ ...previous, [draftKey]: event.target.value }))}
            onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send() } }} sx={{ px: 1, '& textarea': { fontSize: 13 } }} />
          {index.busyThreadId ? <Tooltip title={t('停止生成')}><IconButton aria-label={t('停止生成')} onClick={() => void window.api.chat.cancel()}><StopRounded /></IconButton></Tooltip>
            : <Tooltip title={t('发送消息')}><span><IconButton color="primary" aria-label={t('发送消息')} disabled={(!draft.trim() && !pendingFiles.length) || saving} onClick={() => void send()}><SendRounded /></IconButton></span></Tooltip>}
        </Box><Typography sx={{ fontSize: 10, color: 'text.secondary', mt: .75 }}>{t('可拖入文件或图片 · 每次 5 个，每个 10 MiB · 图片需视觉模型')}</Typography><Typography sx={{ fontSize: 10, color: 'text.secondary', mt: .25 }} title={t('对话与附件保存在安装目录，文件内容仅作为本轮参考，不自动记为个人事实。')}>{t('Enter 发送 · Shift+Enter 换行 · 新对话互不串联')}</Typography>
      </Box>
    </Box>
    <Dialog open={Boolean(preview)} onClose={() => setPreview(null)} fullWidth maxWidth="sm"><DialogTitle sx={{ overflowWrap: 'anywhere' }}>{preview?.name}</DialogTitle><DialogContent>{preview?.url ? <Box component="img" src={preview.url} alt={preview.name} sx={{ maxWidth: '100%', maxHeight: '60vh', display: 'block', mx: 'auto' }} /> : <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{preview?.text}</Typography>}</DialogContent><DialogActions><Button onClick={() => setPreview(null)}>{t('关闭')}</Button></DialogActions></Dialog>
    <Menu anchorEl={menu?.element} open={Boolean(menu)} onClose={() => setMenu(null)}>
      {moving ? [<MenuItem key="none" onClick={() => { void window.api.chat.edit({ action: 'move', id: menu!.thread!.id, groupId: null }).then(refresh).catch(error => setError(messageOf(error))); setMenu(null) }}>{t('未分组')}</MenuItem>, ...index.groups.map(group => <MenuItem key={group.id} onClick={() => { void window.api.chat.edit({ action: 'move', id: menu!.thread!.id, groupId: group.id }).then(refresh).catch(error => setError(messageOf(error))); setMenu(null) }}>{group.name}</MenuItem>)]
        : menu?.thread ? [<MenuItem key="rename" onClick={() => { setEdit({ action: 'rename', id: menu.thread!.id, name: menu.thread!.title }); setMenu(null) }}>{t('重命名')}</MenuItem>, <MenuItem key="move" onClick={() => setMoving(true)}>{t('移至分组')}</MenuItem>, <MenuItem key="delete" onClick={() => { setRemove({ action: 'delete', id: menu.thread!.id, name: menu.thread!.title }); setMenu(null) }}>{t('删除对话')}</MenuItem>]
          : menu?.group ? [<MenuItem key="new" onClick={() => { void create(menu.group!.id); setMenu(null) }}>{t('在分组中新建对话')}</MenuItem>, <MenuItem key="rename" onClick={() => { setEdit({ action: 'group-rename', id: menu.group!.id, name: menu.group!.name }); setMenu(null) }}>{t('重命名分组')}</MenuItem>, <MenuItem key="delete" onClick={() => { setRemove({ action: 'group-delete', id: menu.group!.id, name: menu.group!.name }); setMenu(null) }}>{t('删除分组')}</MenuItem>] : null}
    </Menu>
    <Dialog open={Boolean(edit)} onClose={() => { if (!saving) setEdit(null) }} fullWidth maxWidth="xs"><DialogTitle>{t(edit?.action === 'group-create' ? '新建分组' : '重命名')}</DialogTitle><DialogContent><TextField autoFocus fullWidth margin="dense" label={t('名称')} value={edit?.name ?? ''} inputProps={{ maxLength: 80 }} onChange={event => setEdit(previous => previous ? { ...previous, name: event.target.value } : null)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) void saveName() }} /></DialogContent><DialogActions><Button disabled={saving} onClick={() => setEdit(null)}>{t('取消')}</Button><Button disabled={saving || !edit?.name.trim()} onClick={() => void saveName()}>{t('保存')}</Button></DialogActions></Dialog>
    <Dialog open={Boolean(remove)} onClose={() => setRemove(null)}><DialogTitle>{t(remove?.action === 'group-delete' ? '删除分组' : '删除对话')}</DialogTitle><DialogContent><Typography>{remove?.name}</Typography><Typography variant="body2" color="text.secondary">{t(remove?.action === 'group-delete' ? '分组中的对话会移到未分组，不会删除对话。' : '此对话的消息将从本机删除，无法撤销。')}</Typography></DialogContent><DialogActions><Button onClick={() => setRemove(null)}>{t('取消')}</Button><Button color="error" onClick={() => { if (remove) void window.api.chat.edit(remove).then(() => { setRemove(null); return refresh() }).catch(error => setError(messageOf(error))) }}>{t('删除')}</Button></DialogActions></Dialog>
  </Box>
}
