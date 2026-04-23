/**
 * M-DAEMON-4.5：Daemon cron wiring。
 *
 * `src/utils/cronScheduler.ts` 本身已可獨立跑；此模組負責：
 *   1. 在 daemon 啟動時建立 scheduler、wire `onFireTask` 到 `broker.queue.submit`
 *   2. 套 preRunScript 增強 prompt
 *   3. Gate：仍尊重 `feature('AGENT_TRIGGERS')` + `isKairosCronEnabled()`（Q1=a）
 *   4. `isLoading: () => false`（Q2=b）— cron 永遠 submit，queue 自己用 background
 *      intent 排 FIFO 尾，不會中斷 interactive
 *
 * 不處理（M-DAEMON-7+）：
 *   - Teammate routing（agentId / modelOverride）— 需要 daemon 內的 teammate/swarm
 *     infra；目前 daemon 的 AppState.tasks 空，只做 default enqueue
 *   - Missed-task notification UI — daemon 沒有使用者面板，missed 仍會直接 fire
 */
import type { SessionBroker } from './sessionBroker.js'
import { evaluateCondition } from '../utils/cronCondition.js'
import type { CronScheduler } from '../utils/cronScheduler.js'
import {
  enumerateMissedFires,
  readCronTasks,
  selectCatchUpFires,
  writeCronTasks,
  type CronTask,
} from '../utils/cronTasks.js'
import { logForDebugging } from '../utils/debug.js'

export interface CronWiringHandle {
  readonly scheduler: CronScheduler | null
  stop(): void
}

export interface CronWiringOptions {
  broker: SessionBroker
  /**
   * Project cwd — 會當作 `createCronScheduler` 的 `dir` 傳入，讓 scheduler 走
   * daemon path（立即 enable，不靠 bootstrap state flag）。
   *
   * 必填：`bootstrapDaemonContext` 的 finally 會把 `STATE.projectRoot` 還原
   * 成 daemon 啟動前的值（M-CWD-FIX sandbox），此時 scheduler 若沒 `dir`
   * 就會讀到錯的 project root，`hasCronTasksSync()` 永遠 false，`enablePoll`
   * 的 flag 永遠翻不起來 → 永遠不 fire。
   */
  cwd: string
  /** 覆寫 gate（測試用）。預設讀 `isKairosCronEnabled`。 */
  isEnabled?: () => boolean
  /** 覆寫 module 載入（測試 inject fake scheduler）。 */
  modules?: {
    createCronScheduler: typeof import('../utils/cronScheduler.js').createCronScheduler
    getCronJitterConfig: typeof import('../utils/cronJitterConfig.js').getCronJitterConfig
    runPreRunScript: typeof import('../utils/cronPreRunScript.js').runPreRunScript
    augmentPromptWithPreRun: typeof import('../utils/cronPreRunScript.js').augmentPromptWithPreRun
  }
}

/**
 * 啟動 daemon 端的 cron scheduler。未啟用（gate 關 / feature off）時回傳
 * no-op handle。
 */
export function startDaemonCronWiring(
  opts: CronWiringOptions,
): CronWiringHandle {
  const gate =
    opts.isEnabled ??
    (() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const m =
          require('../tools/ScheduleCronTool/prompt.js') as typeof import('../tools/ScheduleCronTool/prompt.js')
        return m.isKairosCronEnabled()
      } catch {
        return false
      }
    })
  if (!gate()) {
    return { scheduler: null, stop: () => {} }
  }

  let mods = opts.modules
  if (!mods) {
    try {
      mods = {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        createCronScheduler: (
          require('../utils/cronScheduler.js') as typeof import('../utils/cronScheduler.js')
        ).createCronScheduler,
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        getCronJitterConfig: (
          require('../utils/cronJitterConfig.js') as typeof import('../utils/cronJitterConfig.js')
        ).getCronJitterConfig,
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        runPreRunScript: (
          require('../utils/cronPreRunScript.js') as typeof import('../utils/cronPreRunScript.js')
        ).runPreRunScript,
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        augmentPromptWithPreRun: (
          require('../utils/cronPreRunScript.js') as typeof import('../utils/cronPreRunScript.js')
        ).augmentPromptWithPreRun,
      }
    } catch {
      return { scheduler: null, stop: () => {} }
    }
  }

  const { broker } = opts
  const submit = (prompt: string): void => {
    broker.queue.submit(prompt, {
      clientId: 'daemon-cron',
      source: 'cron',
      intent: 'background',
    })
  }

  // 同 REPL useScheduledTasks：同 id 的多次 fire 走 promise lane 避免 race。
  const fireLanes = new Map<string, Promise<void>>()
  const runLane = (id: string, job: () => Promise<void>): void => {
    const prev = fireLanes.get(id) ?? Promise.resolve()
    const next = prev.catch(() => undefined).then(job)
    fireLanes.set(id, next)
    void next.finally(() => {
      if (fireLanes.get(id) === next) fireLanes.delete(id)
    })
  }

  const handleFire = async (task: CronTask): Promise<void> => {
    // Wave 3 — condition gate. When the gate blocks, we suppress submit()
    // but the scheduler still treats this as a fire (lastFiredAt advances)
    // so we don't tick-loop re-evaluate every second. Re-check happens on
    // the next normal schedule. The suppressed event will surface as
    // status='skipped' in run history once W3-6 wires emit().
    if (task.condition) {
      const cond = await evaluateCondition(task)
      if (!cond.pass) {
        logForDebugging(
          `[cronWiring] skipping ${task.id} — condition '${task.condition.kind}' blocked: ${cond.reason}`,
        )
        return
      }
    }
    let prompt = task.prompt
    if (task.preRunScript && mods!.runPreRunScript) {
      try {
        const result = await mods!.runPreRunScript(task.preRunScript)
        prompt = mods!.augmentPromptWithPreRun(prompt, result)
      } catch {
        // preRunScript 失敗也送原始 prompt，不吞掉 fire。
      }
    }
    submit(prompt)
  }

  const scheduler = mods.createCronScheduler({
    onFire: submit,
    onFireTask: task => runLane(task.id, () => handleFire(task)),
    // Q2=b：永遠 false，queue 靠 background intent 自己排。
    isLoading: () => false,
    getJitterConfig: mods.getCronJitterConfig,
    isKilled: () => !gate(),
    // 走 daemon path（立即 enable，不依賴 bootstrap state flag）。
    dir: opts.cwd,
  })

  // Wave 3 — explicit catch-up. Run BEFORE scheduler.start() so any
  // lastFiredAt advances we make are picked up by the first scheduler load.
  // Failures here are non-fatal (cron still starts, scheduler does its
  // implicit single fire-on-load).
  void applyCatchUpPolicy(opts.cwd, handleFire).catch(e =>
    logForDebugging(
      `[cronWiring] catch-up policy failed: ${(e as Error).message}`,
    ),
  )

  scheduler.start()

  return {
    scheduler,
    stop: () => scheduler.stop(),
  }
}

/**
 * Wave 3 — explicit catch-up driver. For each recurring task in
 * scheduled_tasks.json:
 *   - count missed fires between (lastFiredAt ?? createdAt, now]
 *   - apply task.catchupMax (default 1)
 *   - desired === 0 ⇒ stamp lastFiredAt = now (skip the implicit fire)
 *   - desired === 1 ⇒ no-op (scheduler's natural fire-on-load handles it)
 *   - desired  > 1 ⇒ submit (desired - 1) extra fires immediately, spaced
 *     by 2s jitter; scheduler still does the natural one
 *
 * Skipped tasks bypass condition gate (catch-up is "I want to backfill",
 * the gate is "is now a good moment" — these are independent concerns and
 * the user's explicit catch-up intent wins).
 */
async function applyCatchUpPolicy(
  cwd: string,
  fire: (task: CronTask) => Promise<void>,
): Promise<void> {
  const tasks = await readCronTasks(cwd)
  const now = Date.now()
  let mutated = false
  const extraFires: { task: CronTask; remaining: number }[] = []

  for (const t of tasks) {
    if (!t.recurring) continue
    const anchor = t.lastFiredAt ?? t.createdAt
    const missed = enumerateMissedFires(t.cron, anchor, now)
    if (missed === 0) continue
    const desired = selectCatchUpFires(t, missed)

    if (desired === 0) {
      // Skip-all mode: pre-stamp lastFiredAt so scheduler's first-load fire
      // sees nothing pending.
      t.lastFiredAt = now
      mutated = true
      logForDebugging(
        `[cronWiring] catch-up skip ${t.id}: ${missed} missed, catchupMax=0`,
      )
    } else if (desired > 1) {
      extraFires.push({ task: t, remaining: desired - 1 })
      logForDebugging(
        `[cronWiring] catch-up ${t.id}: ${missed} missed, will fire ${desired} (1 natural + ${desired - 1} extra)`,
      )
    } else {
      // desired === 1 — nothing to do, scheduler handles it.
      logForDebugging(
        `[cronWiring] catch-up ${t.id}: 1 fire (natural), ${missed} missed total`,
      )
    }
  }

  if (mutated) {
    try {
      await writeCronTasks(tasks, cwd)
    } catch (e) {
      logForDebugging(
        `[cronWiring] catch-up writeback failed: ${(e as Error).message}`,
      )
    }
  }

  // Spread extra fires with 2s spacing — scheduler tick is 1s, this gives
  // breathing room and respects InputQueue's background FIFO.
  let delay = 0
  for (const { task, remaining } of extraFires) {
    for (let i = 0; i < remaining; i++) {
      delay += 2000
      setTimeout(() => {
        void fire(task).catch(e =>
          logForDebugging(
            `[cronWiring] catch-up extra fire failed for ${task.id}: ${(e as Error).message}`,
          ),
        )
      }, delay).unref()
    }
  }
}
