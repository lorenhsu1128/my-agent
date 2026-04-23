// Wave 3 — fire-time gate evaluator.
//
// CronTask.condition controls whether a fire actually proceeds, distinct from
// preRunScript (which is data collection prepended to prompt). evaluateCondition
// returns false → cronWiring suppresses the submit() call. The scheduler still
// treats the tick as fired (lastFiredAt advances) to avoid tick-loop spam; the
// next normal schedule re-evaluates. Skipped fires surface as 'skipped' in run
// history once W3-6 wires emit.
//
// Four kinds:
//   shell           — exec via runPreRunScript shell; exit 0 ⇒ pass
//   lastRunOk       — task.lastStatus === 'ok' ⇒ pass (initial state ok ⇒ pass)
//   lastRunFailed   — task.lastStatus === 'error' ⇒ pass
//   fileChanged     — file mtime > task.lastFiredAt (or always pass on first fire)

import { stat } from 'fs/promises'
import type { CronCondition, CronTask } from './cronTasks.js'
import { logForDebugging } from './debug.js'
import { runPreRunScript } from './cronPreRunScript.js'

export type ConditionResult = {
  pass: boolean
  reason: string
}

/** Evaluate a CronTask's condition; safe-throws (returns pass=true on internal errors). */
export async function evaluateCondition(
  task: CronTask,
): Promise<ConditionResult> {
  if (!task.condition) return { pass: true, reason: 'no-condition' }
  const c = task.condition
  try {
    switch (c.kind) {
      case 'shell':
        return await evalShell(c)
      case 'lastRunOk':
        return evalLastStatus(task, 'ok')
      case 'lastRunFailed':
        return evalLastStatus(task, 'error')
      case 'fileChanged':
        return await evalFileChanged(c, task.lastFiredAt)
      default: {
        // Unknown kind — fail open so we don't permanently block the task.
        const k = (c as { kind: string }).kind
        logForDebugging(`[cronCondition] unknown kind '${k}', failing open`)
        return { pass: true, reason: `unknown-kind:${k}` }
      }
    }
  } catch (e) {
    logForDebugging(
      `[cronCondition] evaluator threw, failing open: ${(e as Error).message}`,
    )
    return { pass: true, reason: `error:${(e as Error).message}` }
  }
}

async function evalShell(
  c: Extract<CronCondition, { kind: 'shell' }>,
): Promise<ConditionResult> {
  const result = await runPreRunScript(c.spec)
  if (result.ok) return { pass: true, reason: 'shell-exit-0' }
  return { pass: false, reason: `shell-${result.error ?? 'fail'}` }
}

function evalLastStatus(
  task: CronTask,
  required: 'ok' | 'error',
): ConditionResult {
  const status = task.lastStatus
  // First fire (no lastStatus): treat as 'ok' so lastRunOk passes, lastRunFailed blocks.
  // Rationale: typical pattern is "only run if previous succeeded" — first run should
  // be allowed to establish baseline.
  if (!status) {
    const pass = required === 'ok'
    return {
      pass,
      reason: pass ? 'first-fire-default-ok' : 'first-fire-no-prior-error',
    }
  }
  return {
    pass: status === required,
    reason: `lastStatus=${status}`,
  }
}

async function evalFileChanged(
  c: Extract<CronCondition, { kind: 'fileChanged' }>,
  lastFiredAt: number | undefined,
): Promise<ConditionResult> {
  let st
  try {
    st = await stat(c.path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { pass: false, reason: 'file-missing' }
    }
    throw e
  }
  // First fire: pass if file exists at all.
  if (lastFiredAt === undefined) {
    return { pass: true, reason: 'first-fire-file-exists' }
  }
  const mtime = st.mtimeMs
  return {
    pass: mtime > lastFiredAt,
    reason: `mtime=${mtime} vs lastFiredAt=${lastFiredAt}`,
  }
}
