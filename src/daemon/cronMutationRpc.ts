/**
 * B1 (原 plan Q4c)：Daemon-routed cron mutations.
 *
 * Frame 協議（WS 單行 JSON）：
 *
 * client → daemon：
 *   { type: 'cron.mutation', requestId, projectId, op, ...payload }
 *
 *   op ∈ { 'create' | 'update' | 'pause' | 'resume' | 'delete' }
 *
 *   create payload:
 *     { cron, prompt, recurring, name?, scheduleSpec?, preRunScript?,
 *       modelOverride?, retry?, condition?, catchupMax?, notify? }
 *
 *   update payload:
 *     { id, patch: { cron?, prompt?, name?, recurring?, scheduleSpec?,
 *                    retry?, condition?, catchupMax?, notify?,
 *                    preRunScript?, modelOverride? } }
 *     — fields present in patch with `undefined` are removed from the task.
 *     — fields NOT in patch are left untouched.
 *
 *   pause payload:  { id }
 *   resume payload: { id }
 *   delete payload: { ids: string[] }
 *
 * daemon → client (same requestId)：
 *   { type: 'cron.mutationResult', requestId, ok, error?, taskId?, task? }
 *
 * daemon → all same-project clients (broadcast after success)：
 *   { type: 'cron.tasksChanged', projectId }
 *
 * 不走 scheduler 直接 reload — 檔案寫入後 chokidar watcher 會在數百 ms 內捕獲
 * 觸發 scheduler load。broadcast 是給 attached REPL 刷 /cron UI 用的。
 */

import {
  addCronTask,
  type CronTask,
  removeCronTasks,
  updateCronTask,
} from '../utils/cronTasks.js'

export interface CronMutationContext {
  /** Project cwd — passed to addCronTask/updateCronTask/removeCronTasks as `dir`. */
  projectRoot: string
  projectId: string
}

type Patchable = Partial<
  Pick<
    CronTask,
    | 'cron'
    | 'prompt'
    | 'name'
    | 'recurring'
    | 'scheduleSpec'
    | 'retry'
    | 'condition'
    | 'catchupMax'
    | 'notify'
    | 'preRunScript'
    | 'modelOverride'
  >
>

// Keys the client is allowed to mutate via update. Keeping this as a list
// rather than mapped-over Patchable because runtime needs actual string keys
// (Patchable is compile-time only).
const UPDATABLE_KEYS = [
  'cron',
  'prompt',
  'name',
  'recurring',
  'scheduleSpec',
  'retry',
  'condition',
  'catchupMax',
  'notify',
  'preRunScript',
  'modelOverride',
] as const

export type CronMutationRequest = {
  type: 'cron.mutation'
  requestId: string
  projectId?: string
} & (
  | {
      op: 'create'
      cron: string
      prompt: string
      recurring: boolean
      name?: string
      scheduleSpec?: { kind: 'cron' | 'nl'; raw: string }
      preRunScript?: string
      modelOverride?: string
      retry?: CronTask['retry']
      condition?: CronTask['condition']
      catchupMax?: number
      notify?: CronTask['notify']
    }
  | {
      op: 'update'
      id: string
      patch: Patchable
    }
  | { op: 'pause'; id: string }
  | { op: 'resume'; id: string }
  | { op: 'delete'; ids: string[] }
)

export type CronMutationResult = {
  type: 'cron.mutationResult'
  requestId: string
  ok: boolean
  error?: string
  taskId?: string
  task?: CronTask | null
}

export type CronTasksChangedBroadcast = {
  type: 'cron.tasksChanged'
  projectId: string
}

export function isCronMutationRequest(m: unknown): m is CronMutationRequest {
  if (!m || typeof m !== 'object') return false
  const r = m as Record<string, unknown>
  if (r.type !== 'cron.mutation') return false
  if (typeof r.requestId !== 'string') return false
  const op = r.op
  if (op === 'create') {
    return (
      typeof r.cron === 'string' &&
      typeof r.prompt === 'string' &&
      typeof r.recurring === 'boolean'
    )
  }
  if (op === 'update') {
    return typeof r.id === 'string' && !!r.patch && typeof r.patch === 'object'
  }
  if (op === 'pause' || op === 'resume') return typeof r.id === 'string'
  if (op === 'delete') return Array.isArray(r.ids)
  return false
}

function applyPatch(t: CronTask, patch: Patchable): CronTask {
  const next: CronTask = { ...t }
  for (const key of UPDATABLE_KEYS) {
    if (!(key in patch)) continue
    const v = patch[key]
    if (v === undefined) {
      // Explicit clear
      delete (next as Record<string, unknown>)[key]
    } else {
      ;(next as Record<string, unknown>)[key] = v
    }
  }
  return next
}

export async function handleCronMutation(
  req: CronMutationRequest,
  ctx: CronMutationContext,
): Promise<CronMutationResult> {
  const reply = (partial: Partial<CronMutationResult>): CronMutationResult => ({
    type: 'cron.mutationResult',
    requestId: req.requestId,
    ok: false,
    ...partial,
  })

  try {
    if (req.op === 'create') {
      const id = await addCronTask(
        req.cron,
        req.prompt,
        req.recurring,
        true, // durable — daemon always writes to disk
        undefined, // agentId — no teammate routing
        {
          name: req.name,
          modelOverride: req.modelOverride,
          preRunScript: req.preRunScript,
          scheduleSpec: req.scheduleSpec,
        },
      )
      // Note: addCronTask helper doesn't accept retry/condition/catchupMax/
      // notify yet — those are Wave 3 advanced fields that ride in via
      // updateCronTask after creation.
      const hasAdvanced =
        req.retry !== undefined ||
        req.condition !== undefined ||
        req.catchupMax !== undefined ||
        req.notify !== undefined
      if (hasAdvanced) {
        await updateCronTask(
          id,
          t =>
            applyPatch(t, {
              retry: req.retry,
              condition: req.condition,
              catchupMax: req.catchupMax,
              notify: req.notify,
            }),
          ctx.projectRoot,
        )
      }
      return { ...reply({}), ok: true, taskId: id }
    }

    if (req.op === 'update') {
      const updated = await updateCronTask(
        req.id,
        t => applyPatch(t, req.patch),
        ctx.projectRoot,
      )
      if (!updated) {
        return reply({ error: `Task not found: ${req.id}` })
      }
      return { ...reply({}), ok: true, task: updated }
    }

    if (req.op === 'pause') {
      const updated = await updateCronTask(
        req.id,
        t => ({ ...t, state: 'paused', pausedAt: new Date().toISOString() }),
        ctx.projectRoot,
      )
      if (!updated) return reply({ error: `Task not found: ${req.id}` })
      return { ...reply({}), ok: true, task: updated }
    }

    if (req.op === 'resume') {
      const updated = await updateCronTask(
        req.id,
        t => {
          const { pausedAt: _p, ...rest } = t
          return { ...rest, state: 'scheduled' }
        },
        ctx.projectRoot,
      )
      if (!updated) return reply({ error: `Task not found: ${req.id}` })
      return { ...reply({}), ok: true, task: updated }
    }

    if (req.op === 'delete') {
      await removeCronTasks(req.ids, ctx.projectRoot)
      return { ...reply({}), ok: true }
    }

    // Exhaustive check — TypeScript narrows `op` but we fall through defensively.
    return reply({ error: `Unknown op: ${(req as { op?: string }).op}` })
  } catch (err) {
    return reply({ error: (err as Error).message })
  }
}
