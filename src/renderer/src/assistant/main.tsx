import { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Alert, Box, Button, CssBaseline, Stack, TextField, ThemeProvider, Typography } from '@mui/material'
import { useTranslation } from 'react-i18next'
import type { AssistantState } from '@shared/assistant'
import { isSafeLink } from '@shared/links'
import { MarkdownView } from '../card/MarkdownView'
import { useSettings } from '../settings/useSettings'
import { makeTheme, onSystemThemeChange, resolveThemeMode } from '../settings/theme'
import { PaginationSettings, PagedList } from '../settings/Pagination'
import { applyUiLanguage } from '../i18n'

function Assistant(): JSX.Element {
  const { settings } = useSettings()
  const { t } = useTranslation()
  const [systemMode, setSystemMode] = useState(() => resolveThemeMode('system'))
  useEffect(() => onSystemThemeChange(() => setSystemMode(resolveThemeMode('system'))), [])
  const mode = settings?.themeMode === 'system' ? systemMode : settings?.themeMode ?? 'dark'
  const theme = useMemo(() => makeTheme(mode), [mode])
  useEffect(() => { if (settings) applyUiLanguage(settings.uiLanguage) }, [settings?.uiLanguage])
  const [state, setState] = useState<AssistantState>({ turns: [], busy: false, status: '' })
  const [phase, setPhase] = useState<'idle' | 'recording' | 'working'>('idle')
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const pinnedToBottom = useRef(true)
  const busy = state.busy || phase !== 'idle'
  const reportError = (err: unknown): void => setError(String(err instanceof Error ? err.message : err).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''))
  useEffect(() => {
    let alive = true
    const off = window.api.assistant.onChanged(value => { if (alive) setState(value) })
    const offActivity = window.api.assistant.onActivity(setPhase)
    const offFocus = window.api.assistant.onFocus(() => input.current?.focus())
    void window.api.assistant.state().then(value => { if (alive) setState(value) }).catch(reportError)
    void window.api.assistant.activity().then(setPhase).catch(reportError)
    input.current?.focus()
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); void window.api.assistant.hide() }
    }
    window.addEventListener('keydown', key)
    return () => { alive = false; off(); offActivity(); offFocus(); window.removeEventListener('keydown', key) }
  }, [])
  useEffect(() => { if (pinnedToBottom.current) content.current?.scrollTo({ top: content.current.scrollHeight }) }, [state])
  const send = async (): Promise<void> => {
    if (!draft.trim() || busy) return
    const text = draft
    setDraft(''); setError(''); pinnedToBottom.current = true
    try { await window.api.assistant.send(text) }
    catch (err) { setDraft(text); reportError(err) }
    input.current?.focus()
  }
  return <ThemeProvider theme={theme}><CssBaseline />
    <PaginationSettings.Provider value={{ size: settings?.listPageSize ?? 30, change: size => { void window.api.settings.update({ listPageSize: size }) } }}>
    <Box data-assistant-page sx={{ height: '100%', display: 'flex', flexDirection: 'column', bgcolor: 'background.default' }}>
      <Box sx={{ height: 40, flexShrink: 0, px: 2, display: 'flex', alignItems: 'center', WebkitAppRegion: 'drag' }}>
        <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>{t('AI 助手')} · 轻令（Qinly）</Typography>
      </Box>
      <Stack direction="row" spacing={0.5} sx={{ px: 1.5, pb: 0.75, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Button size="small" data-assistant-clear onClick={() => { void window.api.assistant.clear().catch(reportError); setDraft(''); setError(''); input.current?.focus() }}>{t('新对话')}</Button>
        {(['notes', 'reminders', 'settings'] as const).map((page, i) => <Button key={page} size="small" data-assistant-nav={page}
          onClick={() => { void window.api.assistant.navigate(page).catch(reportError) }}>{t(['随记', '提醒', 'nav.settings'][i])}</Button>)}
      </Stack>
      <Box ref={content} onScroll={() => { const el = content.current; if (el) pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60 }}
        sx={{ flex: 1, minHeight: 0, overflowY: 'auto', p: 2 }}>
        {state.turns.length === 0 && <Box data-assistant-empty sx={{ pt: 2 }}>
          <Typography sx={{ fontSize: 20, fontWeight: 600 }}>{t('有什么可以帮你？')}</Typography>
          <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 1 }}>{t('输入问题或点击录音，继续追问同一个话题。')}</Typography>
          <Stack direction="row" spacing={0.5} sx={{ mt: 2, flexWrap: 'wrap' }}>
            {['解释一下 KISS 原则', '计算 128 × 16', '今天有什么 AI 新闻'].map(text => <Button size="small" key={text} onClick={() => { setDraft(t(text)); input.current?.focus() }}>{t(text)}</Button>)}
          </Stack>
        </Box>}
        {state.turns.map(turn => <Box data-assistant-turn={turn.id} data-assistant-turn-state={turn.state} key={turn.id} sx={{ mb: 2.5 }}>
          <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 13, fontWeight: 600, mb: 1 }}>{turn.question}</Typography>
          <Box sx={{ color: turn.state === 'error' ? 'error.main' : 'text.primary', overflowWrap: 'anywhere',
            '& [data-card-markdown]': { fontSize: 13, lineHeight: 1.7 },
            '& [data-card-markdown] *': { color: 'inherit !important' },
            '& [data-card-markdown] a': { color: 'primary.main !important' },
            '& [data-card-markdown] pre': { bgcolor: 'action.hover !important', overflowX: 'auto' }
          }}><MarkdownView text={turn.answer} streaming={turn.state === 'working'} sources={turn.sources} /></Box>
          {turn.localResults?.map((result, index) => <Box data-local-result key={index} sx={{ mt: 1, p: 1, border: '1px solid', borderColor: 'divider', borderRadius: 1.5 }}>
            <Typography sx={{ fontSize: 12, color: result.ok ? 'text.secondary' : 'error.main', overflowWrap: 'anywhere' }}>{result.ok ? '✓' : '×'} {result.summary}</Typography>
            {result.detail && <Typography sx={{ fontSize: 10.5, color: 'text.disabled', mt: 0.5 }}>{result.detail}</Typography>}
            {!!result.items?.length && <PagedList name={`assistant-results-${turn.id}-${index}`}>
              {result.items.map((item, i) => <Box key={item.id} sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5 }}>
                <Box sx={{ flex: 1, minWidth: 0 }}><Typography sx={{ fontSize: 12, overflowWrap: 'anywhere' }}>{i + 1}. {item.name}</Typography>
                  <Typography sx={{ fontSize: 10.5, color: 'text.disabled', overflowWrap: 'anywhere' }}>{item.path}</Typography>
                  {item.modified && <Typography sx={{ fontSize: 10.5, color: 'text.disabled' }}>{new Date(item.modified).toLocaleString()} · {((item.bytes || 0) / 1024).toFixed(1)} KB</Typography>}
                </Box><Button size="small" disabled={busy} onClick={() => { setError(''); void window.api.assistant.openItem(item.id).catch(reportError) }}>{t('打开')}</Button>
              </Box>)}
            </PagedList>}
          </Box>)}
          {turn.sources.length > 0 && <PagedList name={`assistant-sources-${turn.id}`}>
            {turn.sources.map((source, i) => isSafeLink(source.url) ? <Typography key={String(i)} component="a" href={source.url} target="_blank" rel="noreferrer" sx={{ display: 'block', fontSize: 11, color: 'primary.main', overflowWrap: 'anywhere', mt: 0.5 }}>[{i + 1}] {source.title || source.url}</Typography> : null)}
          </PagedList>}
          <Stack direction="row" spacing={1} sx={{ mt: 0.5 }}>
            {!!turn.answer && <Button size="small" onClick={() => { void window.api.app.copyText(turn.answer).catch(reportError) }}>{t('复制')}</Button>}
            {turn.state === 'cancelled' && <Typography sx={{ fontSize: 11, color: 'text.secondary', alignSelf: 'center' }}>{t('已停止，回答可能不完整')}</Typography>}
          </Stack>
        </Box>)}
      </Box>
      <Box sx={{ p: 1.5, pt: 1, borderTop: '1px solid', borderColor: 'divider' }}>
        {error && <Alert severity="error" sx={{ mb: 1 }} onClose={() => setError('')}>{error}</Alert>}
        {busy && <Typography data-assistant-status aria-live="polite" sx={{ fontSize: 11.5, color: 'text.secondary', mb: 0.75 }}>{phase === 'recording' ? t('录音中，右 Alt 提交，Esc 取消') : state.status || t('识别处理中…')}</Typography>}
        <TextField data-assistant-input inputRef={input} autoFocus fullWidth multiline minRows={1} maxRows={4} value={draft}
          placeholder={t('向助手提问…')} slotProps={{ htmlInput: { maxLength: 10_000, 'aria-label': t('向助手提问…') } }}
          onChange={event => setDraft(event.target.value)} onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() }
          }} sx={{ '& textarea': { fontSize: 13 } }} />
        <Stack direction="row" spacing={1} sx={{ mt: 1, alignItems: 'center' }}>
          <Button data-assistant-record variant="outlined" size="small" disabled={busy && phase !== 'recording'} onClick={() => {
            setError(''); void window.api.assistant.record().then(ok => { if (!ok) setError(t('正在处理上一条，稍后再试')) }).catch(reportError)
          }}>{phase === 'recording' ? t('结束录音') : t('assistant.record')}</Button>
          {busy && <Button data-assistant-stop size="small" onClick={() => { void window.api.assistant.cancel().catch(reportError) }}>{t('停止')}</Button>}
          <Box sx={{ flex: 1 }} />
          <Button data-assistant-send variant="contained" size="small" disabled={busy || !draft.trim()} onClick={() => void send()}>{t('assistant.send')}</Button>
        </Stack>
        <Typography sx={{ fontSize: 10.5, color: 'text.disabled', mt: 1 }}>{t('请求会发送至配置的模型；不自动读取选区、剪贴板或截图。')}</Typography>
      </Box>
    </Box></PaginationSettings.Provider>
  </ThemeProvider>
}

createRoot(document.getElementById('root')!).render(<Assistant />)
