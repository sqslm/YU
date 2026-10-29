import { useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, ButtonBase, Chip, CircularProgress, Stack, TextField, Typography } from '@mui/material'
import type { AccountView, Settings } from '@shared/types'
import type { AssistantTurn } from '@shared/assistant'
import { onboardingCapabilities, onboardingExamples } from '@shared/onboarding'
import { AccountForm } from '../AccountForm'
import { ProvidersSection } from '../sections/Providers'
import { WakeWordSection } from '../sections/WakeWordSection'
import { MicrophoneCheck } from './MicrophoneCheck'
import { useVoiceQuestion } from '../../card/useVoiceQuestion'
import { MarkdownView } from '../../card/MarkdownView'
import { registerGameModePreparation } from '../gameModePreparation'
import i18n from '../../i18n'

const LABELS = { welcome: '欢迎使用语', mic: '选择麦克风', models: '配置模型', wake: '自定义唤醒词', try: '统一入口体验', account: '登录账号' }
type Step = keyof typeof LABELS
export function Onboarding({ settings, patch, saving, saveError, onRetry, onDone }: {
  settings: Settings; patch(delta: Partial<Settings>): void; saving: boolean; saveError: string; onRetry(): void; onDone(): Promise<void>
}): JSX.Element {
  const t = i18n.t.bind(i18n)
  const errorText = (error: unknown): string => t((error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, ''))
  const [step, setStep] = useState<Step>('welcome'), [localPresent, setLocalPresent] = useState(false), [account, setAccount] = useState<AccountView | null>(null)
  const [exampleId, setExampleId] = useState(''), [draft, setDraft] = useState(''), [result, setResult] = useState<AssistantTurn | null>(null)
  const [working, setWorking] = useState(false), [finishing, setFinishing] = useState(false), [error, setError] = useState('')
  const request = useRef(0)
  const voice = useVoiceQuestion(text => { setDraft(text); setResult(null) }, window.api.onboarding)
  const capabilities = onboardingCapabilities(settings, localPresent), examples = onboardingExamples(settings, localPresent)
  const steps: Step[] = ['welcome', 'mic', 'models', 'wake', ...(examples.length ? ['try' as const] : []), 'account']
  const index = steps.indexOf(step), example = examples.find(item => item.id === exampleId) ?? examples[0]
  const stop = (): void => { request.current++; voice.cancel(); void window.api.onboarding.cancel(); setWorking(false) }
  useEffect(() => {
    let active = true
    void window.api.localAsr.status().then(status => { if (active) setLocalPresent(status.present) }).catch(() => { if (active) setLocalPresent(false) })
    return () => { active = false }
  }, [step, settings.localAsr.enabled, settings.localAsr.modelId, settings.localAsr.modelDir])
  useEffect(() => { let active = true; void window.api.account.status().then(value => { if (active) setAccount(value) }).catch(() => {}); return () => { active = false } }, [])
  useEffect(() => {
    const hide = (): void => { if (document.hidden) stop() }
    const offGame = registerGameModePreparation(async () => { stop(); return true })
    document.addEventListener('visibilitychange', hide)
    return () => { stop(); offGame(); document.removeEventListener('visibilitychange', hide) }
  }, [])
  useEffect(() => { if (step === 'try' && !examples.length) setStep('models') }, [step, examples.length])
  const changeStep = (next: Step): void => { if (!finishing) { stop(); setError(''); setStep(next) } }
  const finish = async (): Promise<void> => {
    if (finishing) return
    stop(); setFinishing(true); setError('')
    try { await onDone() } catch (error) { setError(errorText(error)); setFinishing(false) }
  }
  const run = async (): Promise<void> => {
    if (!draft.trim() || working || voice.recording || voice.working || !capabilities.text) return
    const token = ++request.current; setWorking(true); setError(''); setResult(null)
    try { const turn = await window.api.onboarding.run(draft); if (request.current === token) setResult(turn) }
    catch (error) { if (request.current === token) setError(errorText(error)) }
    finally { if (request.current === token) setWorking(false) }
  }
  return <Box data-onboarding sx={{ position: 'absolute', inset: 0, zIndex: 20, display: 'grid', placeItems: 'center', bgcolor: 'rgba(12,14,18,.8)', backdropFilter: 'blur(6px)' }}>
    <Box sx={{ width: 1040, maxWidth: '94vw', height: 710, maxHeight: '90vh', display: 'flex', flexDirection: 'column', bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 3, overflow: 'hidden' }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ px: 3, py: 2, borderBottom: 1, borderColor: 'divider' }}>
        <Box><Typography variant="h6">{t('语，与你常在')}</Typography><Typography variant="caption" color="text.secondary">{t('几步完成设置，之后都能在设置中调整。')}</Typography></Box>
        <Button data-onboarding-skip disabled={finishing} onClick={() => void finish()}>{t('跳过引导')}</Button>
      </Stack>
      <Box sx={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <Stack component="nav" aria-label={t('新手引导')} spacing={0.5} sx={{ width: 170, flexShrink: 0, p: 1.5, borderRight: 1, borderColor: 'divider', display: { xs: 'none', sm: 'flex' } }}>
          {steps.map((item, i) => <ButtonBase key={item} disabled={finishing} onClick={() => changeStep(item)} sx={{ py: 1.5, px: 1, gap: 1, justifyContent: 'flex-start', textAlign: 'left', borderRadius: 1.5, bgcolor: step === item ? 'action.selected' : 'transparent', color: step === item ? 'primary.main' : 'text.secondary' }}><Typography variant="caption">{i + 1}</Typography><Typography variant="body2">{t(LABELS[item])}</Typography></ButtonBase>)}
          <Typography variant="caption" color="text.secondary" sx={{ pt: 2 }}>{t('所有步骤均可跳过，不要求登录账号。')}</Typography>
        </Stack>
        <Box sx={{ p: 3, flex: 1, minWidth: 0, overflow: 'auto' }}>
          <Typography variant="caption" color="text.secondary">{t('第 {{current}} 步，共 {{total}} 步', { current: Math.max(1, index + 1), total: steps.length })}</Typography>
          <Typography variant="h6" sx={{ mt: 0.5, mb: 2.5 }}>{t(LABELS[step])}</Typography>
          {(error || saveError || voice.error) && <Alert severity="error" sx={{ mb: 2 }} action={saveError ? <Button onClick={onRetry}>{t('重试保存')}</Button> : undefined}>{error || saveError || voice.error}</Alert>}
          {step === 'welcome' && <Stack spacing={3}>
            <Typography sx={{ fontSize: 20, fontWeight: 600 }}>{t('从一句话开始，处理输入与日常事务。')}</Typography>
            <Typography color="text.secondary">{t('语可以帮你听写、润色、翻译，也能管理提醒、待办和日程。接下来先选麦克风、连接模型，再从同一个入口试一试。')}</Typography>
            <Alert severity="info">{t('数据在本机保存。使用云模型时，识别或处理内容会发送给你配置的服务，并可能产生费用。')}</Alert>
            <Typography variant="body2" color="text.secondary">{t('快捷键和语音唤醒都能打开语音入口；语音唤醒默认关闭，由你选择是否启用。')}</Typography>
          </Stack>}
          {step === 'mic' && <MicrophoneCheck settings={settings} patch={patch} />}
          {step === 'models' && <Stack spacing={2}>
            <Typography color="text.secondary">{t('ASR 负责听懂，LLM 负责理解和处理，TTS 负责朗读。可使用本地服务或自己的提供商账号。')}</Typography>
            <Alert severity="info">{t('先添加并启用连接，再使用连接测试。保存配置不代表连接已验证；功能示例会按已配置的能力显示。')}</Alert>
            <ProvidersSection settings={settings} patch={patch} saving={saving} saveError={saveError} />
          </Stack>}
          {step === 'wake' && <Stack spacing={2}>
            <Typography color="text.secondary">{t('可设置喜欢的唤醒词，并录制几遍进行本地学习。唤醒麦克风与听写麦克风可以分别选择。')}</Typography>
            <WakeWordSection settings={settings} patch={patch} saving={saving} />
          </Stack>}
          {step === 'try' && <Stack spacing={2}>
            <Typography color="text.secondary">{t('选择示例，点击语音输入读出来，或直接编辑文字。识别后先核对，再点击执行，所有功能都走这一个入口。')}</Typography>
            <Stack direction="row" useFlexGap spacing={1} sx={{ flexWrap: 'wrap' }}>{examples.map(item => <Chip key={item.id} clickable color={item.id === example?.id ? 'primary' : 'default'} variant={item.id === example?.id ? 'filled' : 'outlined'} label={t(item.title)} onClick={() => { stop(); setExampleId(item.id); setDraft(t(item.text)); setResult(null); setError('') }} />)}</Stack>
            {example && <Box sx={{ p: 2, border: 1, borderColor: 'divider', borderRadius: 2 }}><Typography variant="caption" color="text.secondary">{t('可以这样说')}</Typography><Typography sx={{ mt: 0.5 }}>{t(example.text)}</Typography><Button size="small" onClick={() => { setDraft(t(example.text)); setResult(null) }}>{t('填入这句话')}</Button></Box>}
            {example?.createsData && <Alert severity="info">{t('执行会创建真实的提醒、待办或日程，你可以在对应页面查看、修改或删除。')}</Alert>}
            <TextField multiline minRows={3} fullWidth label={t('统一体验入口')} value={draft} inputProps={{ maxLength: 2000, 'data-onboarding-playground': true }} onChange={event => setDraft(event.target.value)} disabled={working || voice.recording || voice.working} />
            <Stack direction="row" spacing={1}>
              <Button variant={voice.recording ? 'contained' : 'outlined'} disabled={!capabilities.voice || working || saving || Boolean(saveError) || voice.working} onClick={voice.toggle}>{t(voice.recording ? '结束录音' : voice.working ? '正在识别…' : '语音输入')}</Button>
              {capabilities.text && example?.id !== 'dictation' && <Button variant="contained" disabled={!draft.trim() || working || saving || Boolean(saveError) || voice.recording || voice.working} onClick={() => void run()}>{working ? <CircularProgress size={18} /> : t('执行这句话')}</Button>}
              {example?.id === 'dictation' && <Button disabled={!draft.trim() || voice.recording || voice.working} onClick={() => void window.api.app.copyText(draft)}>{t('复制转写')}</Button>}
              {(working || voice.recording || voice.working) && <Button onClick={stop}>{t('停止')}</Button>}
            </Stack>
            {!capabilities.voice && <Typography variant="caption" color="text.secondary">{t('尚未配置语音识别，可先用文字体验，或返回模型步骤配置 ASR。')}</Typography>}
            {!capabilities.text && <Typography variant="caption" color="text.secondary">{t('当前可体验语音转写。配置 LLM 后会出现润色、翻译和任务示例。')}</Typography>}
            {working && <Typography role="status">{t('正在处理这句话，请稍候…')}</Typography>}
            {result && <Box sx={{ p: 2, border: 1, borderColor: result.state === 'error' ? 'error.main' : 'divider', borderRadius: 2 }}><Typography variant="subtitle2" sx={{ mb: 1 }}>{t(result.state === 'error' ? '处理未完成' : '实际处理结果')}</Typography><MarkdownView text={result.answer} /></Box>}
            <Typography variant="caption" color="text.secondary">{t('体验对话不读取或学习长期记忆；明确执行的任务仍会保存。')}</Typography>
          </Stack>}
          {step === 'account' && <Stack spacing={2}>
            <Typography color="text.secondary">{t('账号用于连接你的服务和同步，本地功能不要求登录。也可以稍后在设置中登录。')}</Typography>
            {account ? <Alert severity="success">{t('已登录 {{email}}', { email: account.email })}</Alert> : <AccountForm dense server={settings.syncServerUrl} onServerChange={syncServerUrl => patch({ syncServerUrl })} onSignedIn={setAccount} />}
          </Stack>}
        </Box>
      </Box>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 3, py: 1.5, borderTop: 1, borderColor: 'divider' }}>
        <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>{t('配置会自动保存；可从概览页重新打开引导。')}</Typography>
        {index > 0 && <Button data-onboarding-back onClick={() => changeStep(steps[index - 1])}>{t('上一步')}</Button>}
        <Button data-onboarding-next variant="contained" disabled={finishing || saving} onClick={() => index === steps.length - 1 ? void finish() : changeStep(steps[index + 1])}>{t(index === steps.length - 1 ? '完成设置' : '下一步')}</Button>
      </Stack>
    </Box>
  </Box>
}
