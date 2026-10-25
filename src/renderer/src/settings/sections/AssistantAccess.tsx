import { useState } from 'react'
import { Box, Button, Stack, Switch, TextField, Typography } from '@mui/material'
import type { Settings } from '@shared/types'
import { SettingsGroup, SettingsRow, SettingsNumber } from './General'
import i18n from '../../i18n'

export function AssistantAccessSection({settings,patch}:{settings:Settings;patch:(value:Partial<Settings>)=>void}):JSX.Element {
  const access=settings.assistantAccess
  const update=(value:Partial<typeof access>):void=>patch({assistantAccess:{...access,...value}})
  const [draft,setDraft]=useState<Record<string,string>>({})
  return <SettingsGroup icon="🔐" title={i18n.t('助手权限与索引')}>
    {(['allowedRoots','excludedPaths','excludedApps','disabledTools'] as const).map((key,index)=><Box key={key} sx={{p:2}}>
      <TextField fullWidth multiline minRows={2} size="small" label={i18n.t(['允许的文件目录（空为不额外限制）','排除的文件目录','排除上下文读取的应用（进程名或完整路径）','关闭的工具（工具名）'][index])}
        value={draft[key]??access[key].join('\n')} onChange={e=>setDraft({...draft,[key]:e.target.value})}/>
      <Button size="small" onClick={()=>{update({[key]:(draft[key]??access[key].join('\n')).split(/\r?\n/).map(line=>line.trim()).filter(Boolean)});setDraft(current=>{const next={...current};delete next[key];return next})}}>{i18n.t('保存')}</Button>
    </Box>)}
    <Typography variant="caption" color="text.secondary" sx={{px:2}}>{i18n.t('目录规则应用于文件读取与打开；应用排除阻止自动上下文和选区读取。手动截图仍需你确认选区。每行一项。')}</Typography>
    <SettingsRow label={i18n.t('Everything HTTP')}><Switch checked={access.everythingHttp} onChange={(_,checked)=>update({everythingHttp:checked})}/></SettingsRow>
    <SettingsRow label={i18n.t('Everything 本机端口')}><SettingsNumber min={1} max={65535} value={access.everythingPort} onChange={everythingPort=>update({everythingPort})}/></SettingsRow>
    <Box sx={{p:2}}><Stack direction="row" spacing={1}><TextField size="small" fullWidth label={i18n.t('Everything es.exe 路径（可选）')} value={draft.everythingCli??access.everythingCli} onChange={e=>setDraft({...draft,everythingCli:e.target.value})}/><Button onClick={()=>update({everythingCli:draft.everythingCli??access.everythingCli})}>{i18n.t('保存')}</Button></Stack></Box>
  </SettingsGroup>
}
