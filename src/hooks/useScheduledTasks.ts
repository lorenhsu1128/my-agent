import { useEffect, useRef } from 'react'
import {
  useAppState,
  useAppStateStore,
  useSetAppState,
} from '../state/AppState.js'
import { isTerminalTaskStatus } from '../Task.js'
import {
  findTeammateTaskByAgentId,
  injectUserMessageToTeammate,
} from '../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import { isDaemonAliveSync } from '../daemon/pidFile.js'
import { isKairosCronEnabled } from '../tools/ScheduleCronTool/prompt.js'
import type { Message } from '../types/message.js'
import {
  augmentPromptWithPreRun,
  runPreRunScript,
} from '../utils/cronPreRunScript.js'
import { getCronJitterConfig } from '../utils/cronJitterConfig.js'
import { createCronScheduler } from '../utils/cronScheduler.js'
import { type CronTask, removeCronTasks } from '../utils/cronTasks.js'
import { logForDebugging } from '../utils/debug.js'
import { enqueuePendingNotification } from '../utils/messageQueueManager.js'
import { createScheduledTaskFireMessage } from '../utils/messages.js'
import { spawnInProcessTeammate } from '../utils/swarm/spawnInProcess.js'
import { WORKLOAD_CRON } from '../utils/workloadContext.js'

type Props = {
  isLoading: boolean
  /**
   * When true, bypasses the isLoading gate so tasks can enqueue while a
   * query is streaming rather than deferring to the next 1s check tick
   * after the turn ends. Assistant mode no longer forces --proactive
   * (#20425) so isLoading drops between turns like a normal REPL — this
   * bypass is now a latency nicety, not a starvation fix. The prompt is
   * enqueued at 'later' priority either way and drains between turns.
   */
  assistantMode?: boolean
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>
}

/**
 * REPL wrapper for the cron scheduler. Mounts the scheduler once and tears
 * it down on unmount. Fired prompts go into the command queue as 'later'
 * priority, which the REPL drains via useCommandQueue between turns.
 *
 * Scheduler core (timer, file watcher, fire logic) lives in cronScheduler.ts
 * so SDK/-p mode can share it — see print.ts for the headless wiring.
 */
export function useScheduledTasks({
  isLoading,
  assistantMode = false,
  setMessages,
}: Props): void {
  // Latest-value ref so the scheduler's isLoading() getter doesn't capture
  // a stale closure. The effect mounts once; isLoading changes every turn.
  const isLoadingRef = useRef(isLoading)
  isLoadingRef.current = isLoading

  const store = useAppStateStore()
  const setAppState = useSetAppState()
  // daemon mode 變化（例如 /daemon detach 後 daemon 關了）需要 re-evaluate
  // 下面 isDaemonAliveSync() gate — mode 進入 effect dep array 觸發重跑。
  const daemonMode = useAppState(s => s.daemonMode)

  useEffect(() => {
    // Runtime gate checked here (not at the hook call site) so the hook
    // stays unconditionally mounted — rules-of-hooks forbid wrapping the
    // call in a dynamic condition. getFeatureValue_CACHED_WITH_REFRESH
    // reads from disk; the 5-min TTL fires a background refetch but the
    // effect won't re-run on value flip (assistantMode is the only dep),
    // so this guard alone is launch-grain. The mid-session killswitch is
    // the isKilled option below — check() polls it every tick.
    if (!isKairosCronEnabled()) return
    // M-DAEMON-4.5：daemon 活著就由 daemon 獨占跑 cron，REPL 跳過避免雙跑。
    // 同步 pidfile + process.kill(pid,0) + 30s heartbeat gate；未開 daemon
    // 或已停都會 return false，REPL 仍照跑。
    if (isDaemonAliveSync()) {
      logForDebugging(
        '[ScheduledTasks] daemon detected, REPL cron skipped (owned by daemon)',
      )
      return
    }

    // System-generated — hidden from queue preview and transcript UI.
    // In brief mode, executeForkedSlashCommand runs as a background
    // subagent and returns no visible messages. In normal mode,
    // isMeta is only propagated for plain-text prompts (via
    // processTextPrompt); slash commands like /context:fork do not
    // forward isMeta, so their messages remain visible in the
    // transcript. This is acceptable since normal mode is not the
    // primary use case for scheduled tasks.
    const enqueueForLead = (prompt: string) =>
      enqueuePendingNotification({
        value: prompt,
        mode: 'prompt',
        priority: 'later',
        isMeta: true,
        // Threaded through to cc_workload= in the billing-header
        // attribution block so the API can serve cron-initiated requests
        // at lower QoS when capacity is tight. No human is actively
        // waiting on this response.
        workload: WORKLOAD_CRON,
      })

    // Wave 2: session-local map of cron-id → teammate-task-id, used only
    // when a cron has modelOverride. First fire spawns a teammate; later
    // fires inject into it. Cleared on unmount (Map dies with closure).
    const modelOverrideTeammates = new Map<string, string>()

    // Promise chain per cron id so two fires of the same task can't race
    // (fires are rare but preRunScript is async and a long second fire
    // could overtake a short first). Not global — each id gets its own
    // ordered lane.
    const fireLanes = new Map<string, Promise<void>>()
    function runLane(id: string, job: () => Promise<void>): void {
      const prev = fireLanes.get(id) ?? Promise.resolve()
      const next = prev.catch(() => undefined).then(job)
      fireLanes.set(id, next)
      void next.finally(() => {
        if (fireLanes.get(id) === next) fireLanes.delete(id)
      })
    }

    async function deliver(task: CronTask, prompt: string): Promise<void> {
      // 1) Existing teammate-routed cron (session-only, set at CronCreate
      //    by a teammate context). Pre-existing path, preserved intact.
      if (task.agentId) {
        const teammate = findTeammateTaskByAgentId(
          task.agentId,
          store.getState().tasks,
        )
        if (teammate && !isTerminalTaskStatus(teammate.status)) {
          injectUserMessageToTeammate(teammate.id, prompt, setAppState)
          return
        }
        logForDebugging(
          `[ScheduledTasks] teammate ${task.agentId} gone, removing orphaned cron ${task.id}`,
        )
        void removeCronTasks([task.id])
        return
      }
      // 2) modelOverride: first fire spawns a dedicated teammate with the
      //    requested model; later fires reuse it. spawnInProcessTeammate
      //    accepts `model` but not provider/baseUrl — those are session-wide.
      if (task.modelOverride) {
        const existingId = modelOverrideTeammates.get(task.id)
        const existing = existingId
          ? store.getState().tasks[existingId]
          : undefined
        if (existing && !isTerminalTaskStatus(existing.status)) {
          injectUserMessageToTeammate(existing.id, prompt, setAppState)
          return
        }
        const result = await spawnInProcessTeammate(
          {
            name: `cron-${task.id}`,
            teamName: 'cron',
            prompt,
            planModeRequired: false,
            model: task.modelOverride,
          },
          { setAppState },
        )
        if (result.success && result.taskId) {
          modelOverrideTeammates.set(task.id, result.taskId)
          return
        }
        logForDebugging(
          `[ScheduledTasks] spawnInProcessTeammate failed for ${task.id}: ${result.error}; falling back to REPL queue`,
        )
        // Fallthrough to default REPL path.
      }
      // 3) Default: announce in transcript and enqueue to REPL.
      const msg = createScheduledTaskFireMessage(
        `Running scheduled task (${formatCronFireTime(new Date())})`,
      )
      setMessages(prev => [...prev, msg])
      enqueueForLead(prompt)
    }

    async function handleFire(task: CronTask): Promise<void> {
      let prompt = task.prompt
      if (task.preRunScript) {
        const result = await runPreRunScript(task.preRunScript)
        prompt = augmentPromptWithPreRun(prompt, result)
      }
      await deliver(task, prompt)
    }

    const scheduler = createCronScheduler({
      // Missed-task surfacing (onFire fallback). Teammate crons are always
      // session-only (durable:false) so they never appear in the missed list,
      // which is populated from disk at scheduler startup — this path only
      // handles team-lead durable crons.
      onFire: enqueueForLead,
      // Normal fires receive the full CronTask so we can route by agentId,
      // apply preRunScript, or spawn a modelOverride teammate.
      onFireTask: task => runLane(task.id, () => handleFire(task)),
      isLoading: () => isLoadingRef.current,
      assistantMode,
      getJitterConfig: getCronJitterConfig,
      isKilled: () => !isKairosCronEnabled(),
    })
    scheduler.start()
    return () => scheduler.stop()
    // assistantMode is stable for the session lifetime; store/setAppState are
    // stable refs from useSyncExternalStore; setMessages is a stable useCallback.
    // daemonMode 進入 dep 讓 /daemon detach 後 REPL cron 重新評估（attached 時
    // 由 daemon 獨占跑，standalone 時 REPL 接手）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistantMode, daemonMode])
}

function formatCronFireTime(d: Date): string {
  return d
    .toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
    .replace(/,? at |, /, ' ')
    .replace(/ ([AP]M)/, (_, ampm) => ampm.toLowerCase())
}
