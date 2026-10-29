import { expect, it } from 'vitest'
import { WORKFLOW_STEP_TOOLS, type WorkflowTool } from './workflow'
import { workflowToolGroups } from './workflow-tool-groups'
it('groups every supported operation exactly once, retaining unknown future operations under Other', () => {
  const tools = [...WORKFLOW_STEP_TOOLS, 'future_tool'].map(name => ({ name, parameters: {}, description: '' })) as WorkflowTool[]
  const groups = workflowToolGroups(tools), names = groups.flatMap(group => group.tools.map(tool => tool.name))
  expect(names.sort()).toEqual(tools.map(tool => tool.name).sort())
  expect(groups.find(group => group.name === '其他操作')?.tools[0].name).toBe('future_tool')
})
