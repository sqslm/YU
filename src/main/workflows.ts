/**
 * Saved workflows on disk (`<userData>/workflows.json`).
 *
 * JSON, not SQLite, for the same reasons as `calendar.ts`: dozens of rows, never
 * millions, and "把工作流备份出来" has to stay one hand-editable file.
 *
 * Persistence follows `settings.ts` and `calendar.ts`: write a sibling temp file,
 * then `renameSync`, so a crash mid-write leaves the previous document intact
 * instead of half a JSON object. A file we cannot parse is moved aside, never
 * overwritten — it may be the only copy of the user's workflows.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { mt } from '@shared/mainI18n'
import {
  MAX_WORKFLOWS,
  MAX_WORKFLOW_STEPS,
  WORKFLOW_STEP_TOOLS,
  activeWorkflows,
  normalizeWorkflowName,
  normalizeWorkflowSteps,
  type Workflow,
  type WorkflowInput,
  type WorkflowStep
} from '@shared/workflow'

const VERSION = 1

interface WorkflowFile {
  version: number
  workflows: Workflow[]
}

/**
 * Load-time whitelist for one stored step, or `null` when it must be dropped.
 *
 * `workflows.json` is a plain file the user can edit, so a structural check is not
 * enough: a hand-written `open_search` step really opened a browser on replay.
 * Anything outside `WORKFLOW_STEP_TOOLS` never reaches the registry, and a missing
 * or malformed `args` reads as the empty object the tool then validates itself.
 */
function sanitizeStep(value: unknown): WorkflowStep | null {
  if (!value || typeof value !== 'object') return null
  const step = value as Partial<WorkflowStep>
  if (typeof step.tool !== 'string' || !WORKFLOW_STEP_TOOLS.includes(step.tool)) return null
  const label = typeof step.label === 'string' && step.label.trim() ? step.label : step.tool
  const args = step.args && typeof step.args === 'object' && !Array.isArray(step.args)
    ? step.args as Record<string, unknown> : {}
  return { tool: step.tool, args, label, ...(step.when !== undefined ? { when: step.when } : {}), ...(step.otherwise !== undefined ? { otherwise: step.otherwise } : {}) }
}

/** `null` when the row has no usable step left, so `load` can drop the whole row. */
function sanitizeWorkflow(value: unknown): Workflow | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Partial<Workflow>
  if (typeof row.id !== 'string' || !row.id.length
    || typeof row.name !== 'string'
    || !Array.isArray(row.steps) || !row.steps.length
    || !Number.isFinite(row.createdAt) || !Number.isFinite(row.updatedAt) || !Number.isFinite(row.runs)
    || (row.archivedAt !== undefined && !Number.isFinite(row.archivedAt))
    || (row.lastRunAt !== undefined && !Number.isFinite(row.lastRunAt))) return null
  const steps = row.steps.map(sanitizeStep).filter((step): step is WorkflowStep => step !== null)
  if (!steps.length) return null
  if (steps.length !== row.steps.length) {
    console.warn(`[workflows] dropped ${row.steps.length - steps.length} step(s) outside the allowlist from ${row.id}`)
  }
  // Validate the preserved branches and result references together. A damaged
  // condition must never turn a conditional write into an unconditional step.
  try { return { ...row as Workflow, steps: normalizeWorkflowSteps(steps.slice(0, MAX_WORKFLOW_STEPS)) } }
  catch { return null }
}

/**
 * Backup stamp as `yyyyMMddHHmmss` in local time: no ':' means Windows accepts
 * the name, and sorting the copies reads as chronological.
 */
function stamp(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/** Names are compared the way the user reads them: case and spacing are noise. */
function nameKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

function cloneWorkflow(row: Workflow): Workflow {
  return { ...row, steps: row.steps.map(step => ({ ...step, args: { ...step.args } })) }
}

export class WorkflowStore {
  private workflows: Workflow[] = []
  /** Path of the preserved unreadable document, when the last load found one. */
  private damagedCopy: string | null = null

  constructor(private readonly file: string, private readonly now: () => number = Date.now) {
    this.load()
  }

  /** Where an unparseable file was moved to, so the UI can say nothing was lost. */
  damagedPath(): string | null {
    return this.damagedCopy
  }

  /** Every row, archived included, in creation order. */
  list(): Workflow[] {
    return this.workflows.map(cloneWorkflow)
  }

  active(): Workflow[] {
    return activeWorkflows(this.workflows).map(cloneWorkflow)
  }

  get(id: string): Workflow | undefined {
    const row = this.find(id)
    return row ? cloneWorkflow(row) : undefined
  }

  /**
   * Create or amend a workflow.
   *
   * An amend keeps `createdAt`, `runs` and `lastRunAt`: those describe the
   * workflow's history, not this edit. `archivedAt` is kept too, because editing
   * a step of an archived workflow must not silently put it back in the picker —
   * `restore` is what does that.
   */
  save(input: WorkflowInput, id?: string): Workflow {
    const existing = id ? this.find(id) : undefined
    if (id && !existing) throw new Error(mt('工作流不存在'))
    const name = normalizeWorkflowName(input?.name)
    const steps = normalizeWorkflowSteps(input?.steps)
    const key = nameKey(name)
    const clash = this.workflows.find(row => row.id !== existing?.id && nameKey(row.name) === key)
    if (clash) throw new Error(mt('已经有一个同名工作流：{{name}}', { name }))
    // Only live rows occupy a slot: the limit message tells the user to archive,
    // and archived rows counting would make that advice a dead end.
    if (!existing && activeWorkflows(this.workflows).length >= MAX_WORKFLOWS) {
      throw new Error(mt('工作流数量已达上限（{{count}} 个），请先归档不再需要的', { count: MAX_WORKFLOWS }))
    }
    const at = this.now()
    const workflow: Workflow = {
      id: existing?.id ?? randomUUID(),
      name,
      steps,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
      runs: existing?.runs ?? 0,
      ...(existing?.lastRunAt === undefined ? {} : { lastRunAt: existing.lastRunAt }),
      ...(existing?.archivedAt === undefined ? {} : { archivedAt: existing.archivedAt })
    }
    if (existing) this.workflows = this.workflows.map(row => row.id === workflow.id ? workflow : row)
    else this.workflows.push(workflow)
    this.flush()
    return cloneWorkflow(workflow)
  }

  /**
   * Hide a workflow from the pickers while keeping its data.
   *
   * Touches only `archivedAt`, never `updatedAt`: archiving is bookkeeping, not an
   * edit, and it must not reorder a list the user is looking at.
   */
  archive(id: string): void {
    const row = this.find(id)
    if (!row) throw new Error(mt('工作流不存在'))
    if (row.archivedAt !== undefined) return
    this.workflows = this.workflows.map(item => item.id === id ? { ...item, archivedAt: this.now() } : item)
    this.flush()
  }

  restore(id: string): void {
    const row = this.find(id)
    if (!row) throw new Error(mt('工作流不存在'))
    if (row.archivedAt === undefined) return
    if (activeWorkflows(this.workflows).length >= MAX_WORKFLOWS) {
      throw new Error(mt('工作流数量已达上限（{{count}} 个），请先归档不再需要的', { count: MAX_WORKFLOWS }))
    }
    this.workflows = this.workflows.map(item => {
      if (item.id !== id) return item
      const { archivedAt: _dropped, ...rest } = item
      return rest
    })
    this.flush()
  }

  /**
   * Delete a row outright.
   *
   * Only for self-tests: the tool layer archives instead, so a user who deletes
   * something by voice can still get it back.
   */
  remove(id: string): void {
    const before = this.workflows.length
    this.workflows = this.workflows.filter(row => row.id !== id)
    if (this.workflows.length !== before) this.flush()
  }

  /**
   * Count one real replay.
   *
   * Touches only `runs` and `lastRunAt`: a run is not an edit, so the list keeps
   * its order. A missing id is ignored rather than thrown because the row can be
   * removed while a long step is still executing, and that race must not turn a
   * completed run into an error the user sees.
   */
  recordRun(id: string): void {
    const row = this.find(id)
    if (!row) return
    const at = this.now()
    this.workflows = this.workflows.map(item => item.id === id ? { ...item, runs: item.runs + 1, lastRunAt: at } : item)
    this.flush()
  }

  /** Atomic: temp sibling then rename, so a crash cannot truncate the document. */
  flush(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.tmp`
    const payload: WorkflowFile = { version: VERSION, workflows: this.workflows }
    writeFileSync(temp, JSON.stringify(payload, null, 2), 'utf8')
    renameSync(temp, this.file)
  }

  private find(id: string): Workflow | undefined {
    return this.workflows.find(row => row.id === id)
  }

  private load(): void {
    this.workflows = []
    if (!existsSync(this.file)) return
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<WorkflowFile>
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.workflows)) {
        throw new Error('unexpected workflow document shape')
      }
      // Filtering per row beats rejecting the whole document: one hand-edited step
      // should not cost the user every workflow they saved.
      const kept: Workflow[] = []
      for (const row of parsed.workflows) {
        const clean = sanitizeWorkflow(row)
        if (clean) kept.push(clean)
        else console.warn('[workflows] dropped a workflow row with no allowlisted step')
      }
      // The 50-row limit applies to live rows, not to archived data. Truncating
      // the combined list here would erase the tail on the next save.
      this.workflows = kept
    } catch (error) {
      // The file vanished between the exists check and the read: that is an empty
      // store, not a damaged one worth quarantining.
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return
      this.quarantine(error)
    }
  }

  /** Moves an unparseable file aside instead of overwriting bytes we cannot read. */
  private quarantine(error: unknown): void {
    const broken = join(dirname(this.file), `${basename(this.file).replace(/\.json$/i, '')}.broken-${stamp(this.now())}.json`)
    try {
      renameSync(this.file, broken)
      this.damagedCopy = broken
      console.error(`[workflows] damaged file kept at ${broken}`)
    } catch (renameError) {
      // A locked or read-only file still must not stop the app from starting.
      this.damagedCopy = null
      console.error('[workflows] cannot keep damaged workflow file:', renameError, error)
    }
    this.workflows = []
  }
}
