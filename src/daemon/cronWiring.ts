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
import { EventEmitter } from 'events'
import type { SessionBroker } from './sessionBroker.js'
import { evaluateCondition } from '../utils/cronCondition.js'
import {
  classifyFireResult,
  computeBackoffMs,
  extractRunnerOutputText,
  type FireOutcomeInputs,
} from '../utils/cronFailureClassifier.js'
import type { CronScheduler } from '../utils/cronScheduler.js'
import {
  enumerateMissedFires,
  readCronTasks,
  selectCatchUpFires,
  writeCronTasks,
  type CronTask,
} from '../utils/cronTasks.js'
import { logForDebugging } from '../utils/debug.js'

/**
 * Wave 3 — cron fire lifecycle event. Emitted at each meaningful transition:
 *   fired     — submit() was called; prompt is in-flight on the queue
 *   completed — turnEnd with reason='done' + classifier said ok
 *   failed    — attempts exhausted OR non-retry task ended with error
 *   retrying  — attempt finished but retry is scheduled
 *   skipped   — condition gate blocked the fire, submit suppressed
 *
 * Consumers: WS broadcast (TUI toast/badge) and Discord mirror subscribe
 * via `CronWiringHandle.events.on('cronFireEvent', handler)`.
 */
export type CronFireStatus =
  | 'fired'
  | 'completed'
  | 'failed'
  | 'retrying'
  | 'skipped'

export type CronFireEvent = {
  type: 'cronFireEvent'
  taskId: string
  taskName?: string
  schedule: string
  status: CronFireStatus
  startedAt: number
  finishedAt?: number
  durationMs?: number
  /** Populated when status in { failed, retrying, skipped }. Already redacted / truncated. */
  errorMsg?: string
  /** 1-indexed attempt number (retries only). */
  attempt?: number
  /** Reason string for skipped fires (e.g. 'shell-exit-1', 'file-missing'). */
  skipReason?: string
  source: 'cron'
}

export interface CronWiringHandle {
  readonly scheduler: CronScheduler | null
  readonly events: EventEmitter
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
  const events = new EventEmitter()
  events.setMaxListeners(32)

  if (!gate()) {
    return { scheduler: null, events, stop: () => {} }
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
      return { scheduler: null, events, stop: () => {} }
    }
  }

  const { broker } = opts
  const submit = (prompt: string): string => {
    return broker.queue.submit(prompt, {
      clientId: 'daemon-cron',
      source: 'cron',
      intent: 'background',
    })
  }

  // Wave 3 — retry watcher. When a task has retry config, we capture
  // runnerEvent text + turnEnd by inputId, then resolve to the classifier.
  // Map<inputId, { task, attempt, output[], resolve }>.
  type RetryWatch = {
    task: CronTask
    attempt: number
    chunks: string[]
    preRunFailed: boolean
    resolve: (r: { reason: string; error?: string; output: string }) => void
  }
  const retryWatch = new Map<string, RetryWatch>()
  broker.queue.on('runnerEvent', e => {
    const w = retryWatch.get(e.input.id)
    if (!w) return
    if (e.event.type === 'output') {
      const text = extractRunnerOutputText(e.event.payload)
      if (text) w.chunks.push(text)
    }
  })
  broker.queue.on('turnEnd', e => {
    const w = retryWatch.get(e.input.id)
    if (!w) return
    retryWatch.delete(e.input.id)
    w.resolve({
      reason: e.reason,
      error: e.error,
      output: w.chunks.join(''),
    })
  })

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

  const emit = (e: CronFireEvent): void => {
    try {
      events.emit('cronFireEvent', e)
    } catch (err) {
      logForDebugging(
        `[cronWiring] emit failed: ${(err as Error).message}`,
      )
    }
  }
  const baseEvent = (task: CronTask, startedAt: number): CronFireEvent => ({
    type: 'cronFireEvent',
    taskId: task.id,
    ...(task.name ? { taskName: task.name } : {}),
    schedule: task.cron,
    status: 'fired',
    startedAt,
    source: 'cron',
  })

  const handleFire = async (task: CronTask, attempt = 1): Promise<void> => {
    const startedAt = Date.now()
    // Wave 3 — condition gate. When the gate blocks, we suppress submit()
    // but the scheduler still treats this as a fire (lastFiredAt advances)
    // so we don't tick-loop re-evaluate every second. Re-check happens on
    // the next normal schedule. Event status='skipped' informs UI/Discord.
    if (attempt === 1 && task.condition) {
      const cond = await evaluateCondition(task)
      if (!cond.pass) {
        logForDebugging(
          `[cronWiring] skipping ${task.id} — condition '${task.condition.kind}' blocked: ${cond.reason}`,
        )
        emit({
          ...baseEvent(task, startedAt),
          status: 'skipped',
          skipReason: cond.reason,
          finishedAt: Date.now(),
          durationMs: Date.now() - startedAt,
        })
        return
      }
    }
    let prompt = task.prompt
    let preRunFailed = false
    // preRunScript runs once per fire, not per retry (it's data collection,
    // re-running wastes resources; the prompt stays the same across retries).
    if (attempt === 1 && task.preRunScript && mods!.runPreRunScript) {
      try {
        const result = await mods!.runPreRunScript(task.preRunScript)
        preRunFailed = !result.ok
        prompt = mods!.augmentPromptWithPreRun(prompt, result)
      } catch {
        preRunFailed = true
        // preRunScript 失敗也送原始 prompt，不吞掉 fire。
      }
    }

    // No retry config → fire-and-forget (legacy path). Emit 'fired' only —
    // without retry watcher we can't observe turnEnd to emit 'completed' /
    // 'failed'. TUI/Discord mirror will show the fire; final status follows
    // from sessionBroker's turnEnd broadcast.
    if (!task.retry || task.retry.maxAttempts <= 1) {
      submit(prompt)
      emit({ ...baseEvent(task, startedAt), status: 'fired' })
      return
    }
    // Retry path — emit 'fired' on first attempt only.
    if (attempt === 1) {
      emit({ ...baseEvent(task, startedAt), status: 'fired' })
    }

    // Retry path — submit, observe turnEnd, classify, maybe setTimeout retry.
    const maxAttempts = task.retry.maxAttempts
    const inputId = submit(prompt)
    const outcome = await new Promise<FireOutcomeInputs>(resolve => {
      retryWatch.set(inputId, {
        task,
        attempt,
        chunks: [],
        preRunFailed,
        resolve: r =>
          resolve({
            turnReason: r.reason,
            turnError: r.error,
            output: r.output,
            preRunFailed,
          }),
      })
    })
    const verdict = classifyFireResult(outcome, task.retry.failureMode)
    const finishedAt = Date.now()
    const base = baseEvent(task, startedAt)
    if (verdict === 'ok') {
      logForDebugging(
        `[cronWiring] ${task.id} attempt ${attempt}/${maxAttempts} ok`,
      )
      emit({
        ...base,
        status: 'completed',
        finishedAt,
        durationMs: finishedAt - startedAt,
        attempt,
      })
      return
    }
    if (attempt >= maxAttempts) {
      logForDebugging(
        `[cronWiring] ${task.id} exhausted retries (${maxAttempts} attempts); giving up`,
      )
      emit({
        ...base,
        status: 'failed',
        finishedAt,
        durationMs: finishedAt - startedAt,
        attempt,
        ...(outcome.turnError
          ? { errorMsg: outcome.turnError.slice(0, 500) }
          : {}),
      })
      return
    }
    const backoff = computeBackoffMs(task.retry.backoffMs, attempt)
    logForDebugging(
      `[cronWiring] ${task.id} attempt ${attempt} failed; retrying in ${backoff}ms`,
    )
    emit({
      ...base,
      status: 'retrying',
      finishedAt,
      durationMs: finishedAt - startedAt,
      attempt,
      ...(outcome.turnError
        ? { errorMsg: outcome.turnError.slice(0, 500) }
        : {}),
    })
    setTimeout(() => {
      runLane(task.id, () => handleFire(task, attempt + 1))
    }, backoff).unref()
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
    events,
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
