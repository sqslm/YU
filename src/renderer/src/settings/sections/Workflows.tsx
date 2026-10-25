import { useCallback, useEffect, useState } from 'react'
import { Box, Button, Stack, Typography } from '@mui/material'
import type { Workflow } from '@shared/workflow'
import { describeWorkflow } from '@shared/workflow'
import { SettingsGroup, SettingsHint } from './General'
import i18n from '../../i18n'

/**
 * Saved workflows, read-only except for archiving.
 *
 * There is no editor here on purpose: a workflow is described in the sentence
 * that creates it ("every Monday, check the calendar, build the briefing and read
 * it out"), and a form that builds one step at a time would be a worse way to say
 * the same thing. What the page owes the user is proof of what was saved and a
 * way to take one out of the picker without destroying it.
 */

function runsLabel(workflow: Workflow): string {
  if (!workflow.runs) return i18n.t('还没运行过')
  const when = workflow.lastRunAt ? new Date(workflow.lastRunAt).toLocaleString() : ''
  return when ? i18n.t('已运行 {{count}} 次 · 最近 {{when}}', { count: workflow.runs, when }) : i18n.t('已运行 {{count}} 次', { count: workflow.runs })
}

export function WorkflowsSection(): JSX.Element {
  const [rows, setRows] = useState<Workflow[]>([])
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)

  const load = useCallback(async () => {
    try {
      setRows(await window.api.workflow.list())
      setNotice(null)
    } catch (error) {
      setNotice({ error: true, text: String(error) })
    }
  }, [])

  useEffect(() => { void load() }, [load])
  useEffect(() => window.api.workflow.onChanged(() => { void load() }), [load])

  const manage = async (id: string, action: 'archive' | 'restore'): Promise<void> => {
    try {
      const next = await window.api.workflow.manage(id, action)
      if (next) setRows(next)
    } catch (error) {
      setNotice({ error: true, text: String(error) })
    }
  }

  return (
    <SettingsGroup icon="⚡" title={i18n.t('工作流')} hint={i18n.t('把固定的几步存成一个名字，之后一句话重放，不再经过模型')}>
      <Box sx={{ px: 2, py: 1.5 }}>
        <Stack spacing={1}>
          <Typography sx={{ fontSize: 13, color: 'text.secondary', lineHeight: 1.6 }}>
            {i18n.t('对语说「以后我说早间检查，就依次查今天的日程、生成简报、读出来」，它会把这几步存成工作流。重放时每一步都按保存的参数执行，结果逐条汇报。')}
          </Typography>
          {notice && (
            <Typography sx={{ fontSize: 12, color: notice.error ? 'error.main' : 'text.secondary' }}>{notice.text}</Typography>
          )}
          {rows.length === 0 && (
            <Typography sx={{ fontSize: 12.5, color: 'text.secondary', lineHeight: 1.6 }}>
              {i18n.t('还没有保存过工作流。在输入框里描述一次你常做的几步操作，回答卡上会给出保存结果。')}
            </Typography>
          )}
          {rows.map(row => (
            <Box key={row.id} sx={{ display: 'flex', alignItems: 'center', gap: 2, p: 1.5, border: 1, borderColor: 'divider', borderRadius: 1.25, opacity: row.archivedAt ? 0.55 : 1 }}>
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography sx={{ fontSize: 13, fontWeight: 650, lineHeight: 1.4 }}>{row.name}</Typography>
                <Typography sx={{ fontSize: 11.5, color: 'text.secondary', overflowWrap: 'anywhere' }}>{describeWorkflow(row)}</Typography>
                <Box component="details" sx={{fontSize:11,mt:1}}><summary>{i18n.t('查看步骤、条件与参数')}</summary><Box component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(row.steps,null,2)}</Box></Box>
                <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>{row.archivedAt ? i18n.t('已归档') : runsLabel(row)}</Typography>
              </Box>
              <Button size="small" onClick={() => void manage(row.id, row.archivedAt ? 'restore' : 'archive')}>
                {row.archivedAt ? i18n.t('恢复') : i18n.t('归档')}
              </Button>
            </Box>
          ))}
        </Stack>
      </Box>
      <SettingsHint>
        {i18n.t('运行方式：在对话框里说「运行早间检查」，或直接问「我有哪些工作流」。归档只是从列表里收起来，随时能恢复。')}
      </SettingsHint>
    </SettingsGroup>
  )
}
