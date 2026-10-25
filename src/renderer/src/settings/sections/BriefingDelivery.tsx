import MailOutline from '@mui/icons-material/MailOutline'
import { useEffect, useState } from 'react'
import { Alert, Box, Button, Stack, Switch, TextField, Typography } from '@mui/material'
import type { Settings } from '@shared/types'
import type { BriefingDeliveryReceipt } from '@shared/briefingDelivery'
import { SettingsGroup, SettingsRow, SettingsHint } from './General'
import i18n from '../../i18n'

export function BriefingDeliverySection({settings,patch}:{settings:Settings;patch:(value:Partial<Settings>)=>void}):JSX.Element {
  const [draft,setDraft]=useState(settings.briefingDelivery),[receipts,setReceipts]=useState<BriefingDeliveryReceipt[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const signature=JSON.stringify(settings.briefingDelivery)
  useEffect(()=>setDraft(settings.briefingDelivery),[signature])
  useEffect(()=>{
    const load=():void=>{void window.api.life.briefingDeliveryHistory().then(setReceipts).catch(error=>setError(String(error)))}
    load();return window.api.life.onBriefingDelivery(load)
  },[])
  const send=async():Promise<void>=>{
    setBusy(true);setError('')
    try{await window.api.life.sendBriefing();setReceipts(await window.api.life.briefingDeliveryHistory())}catch(error){setError(String(error))}finally{setBusy(false)}
  }
  return <SettingsGroup icon={<MailOutline fontSize="small"/>} title={i18n.t('简报邮件与手机推送')}>
    <SettingsHint>{i18n.t('每天生成简报时投递到已开启的渠道。邮件使用 Resend，需要已验证的发件域名；手机安装 ntfy 并订阅相同服务和主题。公共主题可能被他人订阅，请使用私有主题与访问令牌。')}</SettingsHint>
    <SettingsRow label={i18n.t('邮件投递')}><Switch checked={draft.email.enabled} onChange={(_,enabled)=>setDraft({...draft,email:{...draft.email,enabled}})}/></SettingsRow>
    <Stack spacing={1} sx={{px:2,pb:2}}>
      <TextField type="password" size="small" label="Resend API Key" value={draft.email.apiKey} onChange={e=>setDraft({...draft,email:{...draft.email,apiKey:e.target.value}})}/>
      <TextField size="small" label={i18n.t('发件邮箱（已验证域名）')} value={draft.email.from} onChange={e=>setDraft({...draft,email:{...draft.email,from:e.target.value}})}/>
      <TextField size="small" label={i18n.t('收件邮箱')} value={draft.email.to} onChange={e=>setDraft({...draft,email:{...draft.email,to:e.target.value}})}/>
    </Stack>
    <SettingsRow label={i18n.t('手机推送')}><Switch checked={draft.push.enabled} onChange={(_,enabled)=>setDraft({...draft,push:{...draft.push,enabled}})}/></SettingsRow>
    <Stack spacing={1} sx={{px:2,pb:2}}>
      <TextField size="small" label={i18n.t('ntfy HTTPS 服务')} value={draft.push.baseUrl} onChange={e=>setDraft({...draft,push:{...draft.push,baseUrl:e.target.value}})}/>
      <TextField size="small" label={i18n.t('ntfy 主题')} value={draft.push.topic} onChange={e=>setDraft({...draft,push:{...draft.push,topic:e.target.value}})}/>
      <TextField type="password" size="small" label={i18n.t('ntfy 访问令牌（可选）')} value={draft.push.apiKey} onChange={e=>setDraft({...draft,push:{...draft.push,apiKey:e.target.value}})}/>
      <Stack direction="row" spacing={1}><Button onClick={()=>patch({briefingDelivery:draft})}>{i18n.t('保存')}</Button><Button disabled={busy} onClick={()=>void send()}>{i18n.t('立即投递当前简报')}</Button></Stack>
      {error&&<Alert severity="error">{error}</Alert>}
      <Typography variant="caption" color="text.secondary">{i18n.t('先保存配置再投递；服务已受理表示获得消息 ID，不代表收件人已收到或阅读。')}</Typography>
      {receipts.slice(-12).reverse().map(row=><Box key={row.id} sx={{fontSize:12,overflowWrap:'anywhere'}}>
        {new Date(row.at).toLocaleString()} · {row.channel} · {row.target} · {i18n.t(({sending:'投递中',accepted:'服务已受理',failed:'投递失败',unknown:'送达状态未知'})[row.status])}
        {row.providerId&&` · ${row.providerId}`}{row.error&&<Typography variant="caption" color="error.main" display="block">{i18n.t(row.error)}</Typography>}
      </Box>)}
    </Stack>
  </SettingsGroup>
}
