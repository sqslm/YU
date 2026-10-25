/**
 * The four tools behind "repeat these steps for me".
 *
 * A workflow is replayed, not planned: `run_workflow` calls the tools in the
 * saved order and reports what each one actually returned. No model is consulted
 * in between, so the receipt can be trusted and the same workflow costs the same
 * whether it has two steps or eight.
 *
 * Two things are deliberate:
 *
 * 1. A failed step stops the run. Later steps usually depend on the earlier
 *    answer (search, then read the first hit), so continuing would report
 *    successes that mean nothing.
 * 2. `recordRun` is written even when a step fails: "I tried it" is the fact that
 *    keeps the run counter honest, and the store ignores ids that vanished
 *    mid-run.
 */
import { mt } from '@shared/mainI18n'
import {
  WORKFLOW_STEP_TOOLS,
  describeWorkflow,
  normalizeWorkflowName,
  normalizeWorkflowSteps,
  bindWorkflowArgs, workflowCondition,
  type Workflow,
  type WorkflowStep
} from '@shared/workflow'
import type { ToolContext, ToolDefinition, ToolOutcome } from './registry'

export const WORKFLOW_TOOLS = ['save_workflow', 'list_workflows', 'run_workflow', 'manage_workflow'] as const

export type WorkflowToolName = typeof WORKFLOW_TOOLS[number]

/** The slice of `WorkflowStore` the tools need; the store itself satisfies it. */
export interface WorkflowTools {
  list(): Workflow[]
  active(): Workflow[]
  get(id: string): Workflow | undefined
  save(input: { name: string; steps: WorkflowStep[] }, id?: string): Workflow
  archive(id: string): void
  restore(id: string): void
  recordRun(id: string): void
}

interface Field {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object'
  description: string
  enum?: readonly string[]
  // Only `steps` uses a structured item shape: describing it is what stops the
  // model from inventing a shape of its own, and the validator itself only
  // checks that the value is an array (or a JSON string holding one).
  items?: { type: 'string' | 'object'; properties?: Record<string, Field>; required?: string[] }
  maxItems?: number
}

interface Schema {
  description: string
  properties: Record<string, Field>
  required?: string[]
}

const string = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const ok = (summary: string, data: Record<string, unknown>): ToolOutcome => ({
  ok: true,
  summary,
  data: { ...data, ok: true }
})

/**
 * Finds the workflow a tool call means. Both an id and a name are accepted
 * because the model sees names in the list but the UI holds ids, and asking the
 * user to translate between them is the tool's job, not theirs.
 */
function resolve(api: WorkflowTools, args: Record<string, unknown>): Workflow {
  const id = string(args.id)
  if (id) {
    const found = api.get(id)
    if (!found) throw new Error(mt('工作流不存在'))
    return found
  }
  const name = normalizeWorkflowName(args.name)
  const found = api.list().find(row => row.name === name)
  if (!found) throw new Error(mt('工作流不存在'))
  return found
}

function stepSummary(workflow: Workflow, results: Array<{ label: string; ok: boolean }>): string {
  return mt('{{name}}：{{steps}}', {
    name: workflow.name,
    steps: results.map(row => `${row.ok ? '✓' : '✗'} ${row.label}`).join(' → ')
  })
}

async function runWorkflow(
  api: WorkflowTools,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolOutcome> {
  const workflow = resolve(api, args)
  if (workflow.archivedAt !== undefined) throw new Error(mt('这个工作流已归档，先恢复再运行'))
  // Authorization is decided per step. The old code unioned every step's tool into
  // the round's allowlist, so a saved `web_search` step ran in a turn where the
  // user had said "don't go online", and a narrow turn could reach tools it was
  // never granted. `ctx.allowedTools` is the only grant this round has, so a tool
  // it does not name is refused; the step's own tool is added just for the replay
  // so the inner registry gate sees the same round plus that one step.
  const granted = ctx.allowedTools
  // Imported lazily: `registry` imports this module for its definitions, and a
  // top-level import back would be a cycle at load time.
  const { runTool } = await import('./registry')
  const results: Array<{ label: string; tool: string; ok: boolean; summary: string }> = []
  const actual: Array<Record<string,unknown>|undefined> = []
  let steps:WorkflowStep[]
  try { steps=normalizeWorkflowSteps(workflow.steps) }
  catch(error){
    const step=workflow.steps.find(item=>!WORKFLOW_STEP_TOOLS.includes(item.tool))??workflow.steps[0]
    const summary=error instanceof Error?error.message:String(error)
    api.recordRun(workflow.id)
    return {ok:false,summary,data:{ok:false,workflowId:workflow.id,steps:[{label:step?.label,tool:step?.tool,ok:false,summary}],stoppedAt:step?.label}}
  }
  for (const [index, saved] of steps.entries()) {
    let step: Pick<WorkflowStep,'tool'|'args'|'label'> = saved
    if(saved.when && !workflowCondition(saved.when, actual)){
      if(saved.otherwise)step=saved.otherwise
      else { results.push({label:saved.label,tool:saved.tool,ok:true,summary:mt('条件不满足，已跳过')});actual.push(undefined);continue }
    }
    ctx.log(`[workflow] ${workflow.name}: ${step.tool}`)
    // A hand-edited store must not reach a non-step tool even if the load-time
    // filter was bypassed, so the whitelist is asserted again right before use.
    if (!WORKFLOW_STEP_TOOLS.includes(step.tool)) {
      results.push({ label: step.label, tool: step.tool, ok: false, summary: mt('这一步的工具不在允许范围内：{{tool}}', { tool: step.tool }) })
      break
    }
    if (granted && !granted.includes(step.tool)) {
      results.push({ label: step.label, tool: step.tool, ok: false, summary: mt('第 {{step}} 步未获本轮授权', { step: index + 1 }) })
      break
    }
    const stepCtx: ToolContext = { ...ctx, workflowReplay: true, allowedTools: [...(granted ?? []), step.tool] }
    let outcome:ToolOutcome
    try { outcome = await runTool(step.tool, bindWorkflowArgs(step.args,actual), stepCtx) }
    catch(error){outcome={ok:false,summary:String(error instanceof Error?error.message:error),data:{ok:false}}}
    actual.push(outcome.data)
    results.push({ label: step.label, tool: step.tool, ok: outcome.ok, summary: outcome.summary })
    if (!outcome.ok) break
  }
  api.recordRun(workflow.id)
  const failed = results.find(row => !row.ok)
  const summary = stepSummary(workflow, results)
  if (failed) {
    return {
      ok: false,
      summary: mt('{{summary}}；第 {{step}} 步失败：{{reason}}', {
        summary,
        step: failed.label,
        reason: failed.summary
      }),
      data: { ok: false, workflowId: workflow.id, steps: results, stoppedAt: failed.label }
    }
  }
  // The summary is assembled above, not translated: it is already user-facing.
  return ok(summary, { workflowId: workflow.id, steps: results, results:actual })
}

const schemas: Record<WorkflowToolName, Schema> = {
  save_workflow: {
    description:
      'Save an ordered list of tool calls under a name the user says out loud, so it can be replayed later without a model. Steps run in the given order and each step is one tool call.',
    properties: {
      name: { type: 'string', description: 'The name the user will say, e.g. 早上例行检查' },
      steps: {
        type: 'array',
        // A bare `{type: 'object'}` left the shape to the model's imagination and
        // it answered with a JSON string instead of an array. Spelling out the
        // item shape is what makes the documented call the easy call.
        items: {
          type: 'object',
          properties: {
            tool: { type: 'string', enum: WORKFLOW_STEP_TOOLS as unknown as string[], description: 'Tool to call for this step' },
            args: { type: 'object', description: 'Arguments for that tool, as the tool itself documents them' },
            label: { type: 'string', description: 'Short human label, e.g. 读今天的日程' }
            ,when: {type:'object',description:'Optional condition {ref:"1.total",op:"exists"|"eq"|"gt"|"lt"|"contains",value:0}. Ref is a 1-based prior step and dot path into its actual data. False skips this step unless otherwise is supplied.'},
            otherwise:{type:'object',description:'Optional false branch {tool,args,label}. Only allowlisted tools; no nesting.'}
          },
          required: ['tool']
        },
        maxItems: 8,
        description:
          'Ordered steps, each {"tool": "<tool name>", "args": {...}, "label": "<short human label>"}. Allowed tools: ' +
          WORKFLOW_STEP_TOOLS.join(', ') + '. Any args value may be {"$ref":"1.items.0.id"} to bind a prior actual result. Only earlier steps, no expressions or scripts. Conditions use when and otherwise.'
      },
      id: { type: 'string', description: 'Existing workflow id when replacing one instead of creating a new one' }
    },
    required: ['name', 'steps']
  },
  list_workflows: {
    description: 'List the saved workflows, with their steps, run counts and last run time.',
    properties: {
      query: { type: 'string', description: 'Only workflows whose name, step label or tool matches this text' },
      include_archived: { type: 'boolean', description: 'Also list archived workflows' }
    }
  },
  run_workflow: {
    description:
      'Run a saved workflow now. Steps execute in order with no model in between; a failing step stops the run and is reported as failed.',
    properties: {
      name: { type: 'string', description: 'The workflow name' },
      id: { type: 'string', description: 'The workflow id, when it is already known' }
    }
  },
  manage_workflow: {
    description: 'Archive, restore or delete a saved workflow by name or id.',
    properties: {
      action: { type: 'string', enum: ['archive', 'restore', 'delete'], description: 'What to do with it' },
      name: { type: 'string', description: 'The workflow name' },
      id: { type: 'string', description: 'The workflow id' }
    },
    required: ['action']
  }
}

async function run(name: WorkflowToolName, args: Record<string, unknown>, api: WorkflowTools, ctx: ToolContext): Promise<ToolOutcome> {
  if (name === 'save_workflow') {
    const steps = normalizeWorkflowSteps(args.steps)
    const workflowName = normalizeWorkflowName(args.name)
    const id = string(args.id)
    const saved = api.save({ name: workflowName, steps }, id || undefined)
    return ok(mt('工作流已保存：{{name}}', { name: saved.name }), {
      id: saved.id,
      name: saved.name,
      detail: describeWorkflow(saved)
    })
  }
  if (name === 'list_workflows') {
    const query = string(args.query).toLowerCase()
    const rows = (args.include_archived === true ? api.list() : api.active()).filter(row => {
      if (!query) return true
      const haystack = [row.name, ...row.steps.flatMap(step => [step.label, step.tool])].join(' ').toLowerCase()
      return haystack.includes(query)
    })
    if (!rows.length) return ok(mt('还没有保存过工作流'), { items: [], total: 0 })
    return ok(mt('找到 {{count}} 个工作流', { count: rows.length }), {
      items: rows.slice(0, 10).map(row => ({
        id: row.id,
        name: row.name,
        detail: describeWorkflow(row),
        runs: row.runs,
        lastRunAt: row.lastRunAt ?? null,
        archived: row.archivedAt !== undefined
      })),
      total: rows.length
    })
  }
  if (name === 'run_workflow') return runWorkflow(api, args, ctx)
  const action = string(args.action)
  const workflow = resolve(api, args)
  if (action === 'archive') {
    api.archive(workflow.id)
    return ok(mt('工作流已归档：{{name}}', { name: workflow.name }), { id: workflow.id })
  }
  if (action === 'restore') {
    api.restore(workflow.id)
    return ok(mt('工作流已恢复：{{name}}', { name: workflow.name }), { id: workflow.id })
  }
  if (action === 'delete') {
    // Deleting is refused on purpose: a replay is the one thing a user cannot
    // reconstruct from memory, while archiving keeps it recoverable.
    throw new Error(mt('已拒绝不可逆删除；可以先归档，随时能恢复'))
  }
  throw new Error(mt('工具参数无效：{{name}}', { name: 'action' }))
}

export const WORKFLOW_DEFINITIONS: ToolDefinition[] = WORKFLOW_TOOLS.map(name => ({
  name,
  description: schemas[name].description,
  normalizeArguments: name === 'save_workflow' ? args => args.steps === undefined ? args : { ...args, steps: normalizeWorkflowSteps(args.steps) } : undefined,
  parameters: {
    type: 'object',
    properties: schemas[name].properties,
    required: schemas[name].required ?? [],
    additionalProperties: false
  },
  run: async (args, ctx) => {
    if (!ctx.workflow || !ctx.allowedTools?.includes(name)) throw new Error(mt('本次任务未授权此工具：{{name}}', { name }))
    const schema = schemas[name]
    for (const key of schema.required ?? []) if (!(key in args)) throw new Error(mt('工具参数无效：{{name}}', { name: key }))
    for (const [key, value] of Object.entries(args)) {
      const field = Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined
      // Arrays also accept a JSON string: the model double-encodes nested
      // structures often enough that rejecting it costs the user a whole round
      // trip, and the normalizer reads the string anyway. Length is left to the
      // normalizer so "too many steps" can say so instead of "参数无效".
      const validType = field?.type === 'array'
        ? Array.isArray(value) || typeof value === 'string'
        : typeof value === field?.type
      if (!field || !validType || (field.enum && !field.enum.includes(value as string))) {
        throw new Error(mt('工具参数无效：{{name}}', { name: key }))
      }
    }
    return run(name, args, ctx.workflow, ctx)
  }
}))
