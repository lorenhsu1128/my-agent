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
import type { CronScheduler } from '../utils/cronScheduler.js'
import type { CronTask } from '../utils/cronTasks.js'

export interface CronWiringHandle {
  readonly scheduler: CronScheduler | null
  stop(): void
}

export interface CronWiringOptions {
  broker: SessionBroker
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
  })
  scheduler.start()

  return {
    scheduler,
    stop: () => scheduler.stop(),
  }
}
