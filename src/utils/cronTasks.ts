// Scheduled prompts, stored in <project>/.my-agent/scheduled_tasks.json.
//
// Tasks come in two flavors:
//   - One-shot (recurring: false/undefined) — fire once, then auto-delete.
//   - Recurring (recurring: true) — fire on schedule, reschedule from now,
//     persist until explicitly deleted via CronDelete or auto-expire after
//     a configurable limit (DEFAULT_CRON_JITTER_CONFIG.recurringMaxAgeMs).
//
// File format:
//   { "tasks": [{ id, cron, prompt, createdAt, recurring?, permanent? }] }

import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { mkdir, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  addSessionCronTask,
  getProjectRoot,
  getSessionCronTasks,
  removeSessionCronTasks,
} from '../bootstrap/state.js'
import { computeNextCronRun, parseCronExpression } from './cron.js'
import { appendHistoryEntry } from './cronHistory.js'
import { logForDebugging } from './debug.js'
import { isFsInaccessible } from './errors.js'
import { getFsImplementation } from './fsOperations.js'
import { safeParseJSON } from './json.js'
import { logError } from './log.js'
import { jsonStringify } from './slowOperations.js'

export type CronTask = {
  id: string
  /** 5-field cron string (local time) — validated on write, re-validated on read. */
  cron: string
  /** Prompt to enqueue when the task fires. */
  prompt: string
  /** Epoch ms when the task was created. Anchor for missed-task detection. */
  createdAt: number
  /**
   * Epoch ms of the most recent fire. Written back by the scheduler after
   * each recurring fire so next-fire computation survives process restarts.
   * The scheduler anchors first-sight from `lastFiredAt ?? createdAt` — a
   * never-fired task uses createdAt (correct for pinned crons like
   * `30 14 27 2 *` whose next-from-now is next year); a fired-before task
   * reconstructs the same `nextFireAt` the prior process had in memory.
   * Never set for one-shots (they're deleted on fire).
   */
  lastFiredAt?: number
  /** When true, the task reschedules after firing instead of being deleted. */
  recurring?: boolean
  /**
   * When true, the task is exempt from recurringMaxAgeMs auto-expiry.
   * System escape hatch for assistant mode's built-in tasks (catch-up/
   * morning-checkin/dream) — the installer's writeIfMissing() skips existing
   * files so re-install can't recreate them. Not settable via CronCreateTool;
   * only written directly to scheduled_tasks.json by src/assistant/install.ts.
   */
  permanent?: boolean
  /**
   * Runtime-only flag. false → session-scoped (never written to disk).
   * File-backed tasks leave this undefined; writeCronTasks strips it so
   * the on-disk shape stays { id, cron, prompt, createdAt, lastFiredAt?, recurring?, permanent? }.
   */
  durable?: boolean
  /**
   * Runtime-only. When set, the task was created by an in-process teammate.
   * The scheduler routes fires to that teammate's queue instead of the main
   * REPL's. Never written to disk (teammate crons are always session-only).
   */
  agentId?: string
  // -- Wave 1 extensions (Hermes port) — all optional, backward-compat safe --
  /** Friendly label for list / UI. Falls back to first line of prompt. */
  name?: string
  /**
   * How many times a recurring task should fire before self-removing.
   * `times: null` = forever (default, matches pre-Wave-1 behavior).
   * `completed` is bumped on every successful fire (markJobRun).
   * Not used for one-shots (they delete on fire regardless).
   */
  repeat?: { times: number | null; completed: number }
  /** Result of the last fire — set by markJobRun. Observability only. */
  lastStatus?: 'ok' | 'error'
  /** Error message from last fire, if lastStatus==='error'. Redacted via secretScan before write. */
  lastError?: string
  /**
   * Lifecycle state. `scheduled` = normal; `completed` = one-shot already
   * fired (kept briefly for list before delete, or for repeat-limit reached);
   * `paused` = CronPause applied; scheduler skips this task until CronResume.
   * Absent = 'scheduled' (backward-compat).
   */
  state?: 'scheduled' | 'paused' | 'completed'
  /**
   * Wave 2 — per-job model override. When set, a fire spawns a fresh
   * in-process teammate with this model (via spawnInProcessTeammate config)
   * and delivers the prompt there instead of the REPL command queue.
   * `provider` / `baseUrl` overrides are NOT supported at this layer —
   * spawnInProcessTeammate only accepts `model`, and provider/baseUrl are
   * session-wide env vars. Ignored for teammate crons (agentId already
   * routes there). Ignored when kairos teammate infra is unavailable.
   */
  modelOverride?: string
  /**
   * Wave 2 — pre-run command. Executed via shell before each fire; stdout
   * (after secret redaction) is prepended to the prompt as a `## Context`
   * block. Stderr/exit-code are swallowed but logged. Use for data
   * collection ("what's in my inbox right now?") feeding the prompt.
   * Runs with a 10s timeout; failures don't block the fire — prompt runs
   * without the extra context.
   */
  preRunScript?: string
  /**
   * Wave 2 — ISO-8601 timestamp when CronPause was applied. Purely
   * informational; resume computes next fire from now regardless.
   */
  pausedAt?: string
  // -- Wave 3 extensions (cron 6 大功能) — 全 optional，舊 task undefined 時行為與 Wave 2 一致 --
  /**
   * 原始排程輸入（自然語言或 cron 字串）。`cron` 欄位永遠存翻譯後的 5-field
   * 字串供 scheduler 用；`scheduleSpec.raw` 留人類輸入原文供 list / edit 顯示。
   * `kind: 'cron'` 表 raw 就是 cron 字串；`kind: 'nl'` 表 raw 是自然語言、
   * 由 cronNlParser 翻譯成 `cron` 欄位。
   */
  scheduleSpec?: { kind: 'cron' | 'nl'; raw: string }
  /**
   * 通知投遞偏好。fire 完成 / 失敗 / skip / retry 時走這裡決定通知到哪。
   * - tui: 'always' = 每次 fire 都 toast；'failure-only' = 只在失敗時；'off' = 完全不通知
   * - discord: 'home' = 走 homeChannelId；'project' = 走 per-project binding（無則 fallback home）；'off' = 不發
   * - desktop: OS notification（沿用 notification-session-end.sh 模式），預設 false
   * undefined 視同 `{ tui: 'always', discord: 'off' }`。
   */
  notify?: CronNotifyConfig
  /**
   * Run history 設定。寫入 `.my-agent/cron/history/{id}.jsonl` append-only。
   * `keepRuns` = 保留最舊的幾筆，超過 truncate；預設 50。
   */
  history?: { keepRuns: number }
  /**
   * 失敗重試設定。`maxAttempts` 含首次（3 = 首次 + 2 重試）。
   * `backoffMs` 為基礎值，retry n 次走 exponential `backoffMs * 2^(n-1)`。
   * `failureMode` 由 wizard 蒐集，決定 fire 結果如何被判定為失敗。
   * `attemptCount` 為 runtime 計數，由 cronWiring 寫回；daemon restart 時若 >0
   * 視同放棄並 reset 0、走下一次 schedule（pending setTimeout 跨不過 process）。
   */
  retry?: {
    maxAttempts: number
    backoffMs: number
    failureMode: FailureMode
    attemptCount: number
  }
  /**
   * fire 前 gate。不通過則 emit `skipped` 不更新 lastFiredAt 也不算 retry，
   * 下次 schedule 仍會看到並再次評估。`shell` 走既有 runPreRunScript 機制
   * （10s timeout，看 exit code）；`fileChanged` 比 mtime 與 lastFiredAt。
   */
  condition?: CronCondition
  /**
   * Catch-up 上限：daemon 起時對 recurring task 計算錯過 fire 次數，
   * 補跑 `min(actualMissed, catchupMax)` 次。0 = 完全不補；1（預設）=
   * 只補最近一次，與 Wave 2 隱性行為相容；N = 累積型任務適用。
   */
  catchupMax?: number
}

/** Wave 3 — Notification 投遞偏好。詳見 CronTask.notify。 */
export type CronNotifyConfig = {
  tui: 'always' | 'failure-only' | 'off'
  discord: 'home' | 'project' | 'off'
  desktop?: boolean
}

/** Wave 3 — fire 結果如何被判定為失敗。由 wizard 蒐集。 */
export type FailureMode =
  | { kind: 'turn-error' }
  | { kind: 'pre-run-exit' }
  | { kind: 'output-regex'; pattern: string; flags?: string }
  | { kind: 'output-missing'; pattern: string }
  | { kind: 'composite'; modes: FailureMode[]; logic: 'any' | 'all' }

/** Wave 3 — fire 前 gate。 */
export type CronCondition =
  | { kind: 'shell'; spec: string }
  | { kind: 'lastRunOk' }
  | { kind: 'lastRunFailed' }
  | { kind: 'fileChanged'; path: string }

type CronFile = { tasks: CronTask[] }

const CRON_FILE_REL = join('.my-agent', 'scheduled_tasks.json')

/**
 * Path to the cron file. `dir` defaults to getProjectRoot() — pass it
 * explicitly from contexts that don't run through main.tsx (e.g. the Agent
 * SDK daemon, which has no bootstrap state).
 */
export function getCronFilePath(dir?: string): string {
  return join(dir ?? getProjectRoot(), CRON_FILE_REL)
}

/**
 * Read and parse .my-agent/scheduled_tasks.json. Returns an empty task list if the file
 * is missing, empty, or malformed. Tasks with invalid cron strings are
 * silently dropped (logged at debug level) so a single bad entry never
 * blocks the whole file.
 */
export async function readCronTasks(dir?: string): Promise<CronTask[]> {
  const fs = getFsImplementation()
  let raw: string
  try {
    raw = await fs.readFile(getCronFilePath(dir), { encoding: 'utf-8' })
  } catch (e: unknown) {
    if (isFsInaccessible(e)) return []
    logError(e)
    return []
  }

  const parsed = safeParseJSON(raw, false)
  if (!parsed || typeof parsed !== 'object') return []
  const file = parsed as Partial<CronFile>
  if (!Array.isArray(file.tasks)) return []

  const out: CronTask[] = []
  for (const t of file.tasks) {
    if (
      !t ||
      typeof t.id !== 'string' ||
      typeof t.cron !== 'string' ||
      typeof t.prompt !== 'string' ||
      typeof t.createdAt !== 'number'
    ) {
      logForDebugging(
        `[ScheduledTasks] skipping malformed task: ${jsonStringify(t)}`,
      )
      continue
    }
    if (!parseCronExpression(t.cron)) {
      logForDebugging(
        `[ScheduledTasks] skipping task ${t.id} with invalid cron '${t.cron}'`,
      )
      continue
    }
    out.push({
      id: t.id,
      cron: t.cron,
      prompt: t.prompt,
      createdAt: t.createdAt,
      ...(typeof t.lastFiredAt === 'number'
        ? { lastFiredAt: t.lastFiredAt }
        : {}),
      ...(t.recurring ? { recurring: true } : {}),
      ...(t.permanent ? { permanent: true } : {}),
      ...(typeof t.name === 'string' ? { name: t.name } : {}),
      ...(t.repeat &&
      typeof t.repeat.times !== 'undefined' &&
      typeof t.repeat.completed === 'number'
        ? {
            repeat: {
              times:
                typeof t.repeat.times === 'number' ? t.repeat.times : null,
              completed: t.repeat.completed,
            },
          }
        : {}),
      ...(t.lastStatus === 'ok' || t.lastStatus === 'error'
        ? { lastStatus: t.lastStatus }
        : {}),
      ...(typeof t.lastError === 'string' ? { lastError: t.lastError } : {}),
      ...(t.state === 'scheduled' ||
      t.state === 'paused' ||
      t.state === 'completed'
        ? { state: t.state }
        : {}),
      ...(typeof t.modelOverride === 'string'
        ? { modelOverride: t.modelOverride }
        : {}),
      ...(typeof t.preRunScript === 'string'
        ? { preRunScript: t.preRunScript }
        : {}),
      ...(typeof t.pausedAt === 'string' ? { pausedAt: t.pausedAt } : {}),
    })
  }
  return out
}

/**
 * Sync check for whether the cron file has any valid tasks. Used by
 * cronScheduler.start() to decide whether to auto-enable. One file read.
 */
export function hasCronTasksSync(dir?: string): boolean {
  let raw: string
  try {
    // eslint-disable-next-line custom-rules/no-sync-fs -- called once from cronScheduler.start()
    raw = readFileSync(getCronFilePath(dir), 'utf-8')
  } catch {
    return false
  }
  const parsed = safeParseJSON(raw, false)
  if (!parsed || typeof parsed !== 'object') return false
  const tasks = (parsed as Partial<CronFile>).tasks
  return Array.isArray(tasks) && tasks.length > 0
}

/**
 * Overwrite .my-agent/scheduled_tasks.json with the given tasks. Creates .my-agent/ if
 * missing. Empty task list writes an empty file (rather than deleting) so
 * the file watcher sees a change event on last-task-removed.
 */
export async function writeCronTasks(
  tasks: CronTask[],
  dir?: string,
): Promise<void> {
  const root = dir ?? getProjectRoot()
  // Windows + bun：對已存在目錄 `recursive: true` 仍會 throw EEXIST（跟 Node
  // 規範相反）。`mode: EEXIST` 忽略掉即可；其他錯誤（EACCES / ENOSPC）才 rethrow。
  try {
    await mkdir(join(root, '.my-agent'), { recursive: true })
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e
  }
  // Strip runtime-only flags — `durable` (session-only marker) and `agentId`
  // (teammate route) never belong on disk. Everything on disk is durable,
  // non-teammate by definition.
  const body: CronFile = {
    tasks: tasks.map(
      ({ durable: _durable, agentId: _agentId, ...rest }) => rest,
    ),
  }
  // Atomic write: stage to .tmp + rename, so a crash mid-write can't leave
  // a half-written jobs file. Matches Hermes `save_jobs` tempfile+os.replace.
  const finalPath = getCronFilePath(root)
  const tmpPath = `${finalPath}.${randomUUID().slice(0, 8)}.tmp`
  const payload = jsonStringify(body, null, 2) + '\n'
  try {
    await writeFile(tmpPath, payload, 'utf-8')
    await rename(tmpPath, finalPath)
  } catch (e) {
    // Best-effort cleanup; ignore secondary failure.
    try {
      const fs = getFsImplementation()
      await fs.unlink(tmpPath)
    } catch {
      /* ignore */
    }
    throw e
  }
}

/**
 * Append a task. Returns the generated id. Caller is responsible for having
 * already validated the cron string (the tool does this via validateInput).
 *
 * When `durable` is false the task is held in process memory only
 * (bootstrap/state.ts) — it fires on schedule this session but is never
 * written to .my-agent/scheduled_tasks.json and dies with the process. The
 * scheduler merges session tasks into its tick loop directly, so no file
 * change event is needed.
 */
export type AddCronTaskExtras = {
  /** Optional friendly label; falls back to first line of prompt in UI. */
  name?: string
  /**
   * Recurring repeat cap. `null` (default) = forever — the historical
   * behavior. Positive integer = fire that many times then self-delete.
   * Ignored for one-shots (they always delete on first fire).
   */
  repeatTimes?: number | null
  /** Per-job model override (Wave 2). See CronTask.modelOverride. */
  modelOverride?: string
  /** Pre-run shell command (Wave 2). See CronTask.preRunScript. */
  preRunScript?: string
}

export async function addCronTask(
  cron: string,
  prompt: string,
  recurring: boolean,
  durable: boolean,
  agentId?: string,
  extras?: AddCronTaskExtras,
): Promise<string> {
  // Short ID — 8 hex chars is plenty for MAX_JOBS=50, avoids slice/prefix
  // juggling between the tool layer (shows short IDs) and disk.
  const id = randomUUID().slice(0, 8)
  const task: CronTask = {
    id,
    cron,
    prompt,
    createdAt: Date.now(),
    ...(recurring ? { recurring: true } : {}),
    ...(extras?.name ? { name: extras.name } : {}),
    ...(recurring && extras && extras.repeatTimes !== undefined
      ? { repeat: { times: extras.repeatTimes, completed: 0 } }
      : {}),
    ...(extras?.modelOverride
      ? { modelOverride: extras.modelOverride }
      : {}),
    ...(extras?.preRunScript ? { preRunScript: extras.preRunScript } : {}),
  }
  if (!durable) {
    addSessionCronTask({ ...task, ...(agentId ? { agentId } : {}) })
    return id
  }
  const tasks = await readCronTasks()
  tasks.push(task)
  await writeCronTasks(tasks)
  return id
}

/**
 * Remove tasks by id. No-op if none match (e.g. another session raced us).
 * Used for both fire-once cleanup and explicit CronDelete.
 *
 * When called with `dir` undefined (REPL path), also sweeps the in-memory
 * session store — the caller doesn't know which store an id lives in.
 * Daemon callers pass `dir` explicitly; they have no session, and the
 * `dir !== undefined` guard keeps this function from touching bootstrap
 * state on that path (tests enforce this).
 */
export async function removeCronTasks(
  ids: string[],
  dir?: string,
): Promise<void> {
  if (ids.length === 0) return
  // Sweep session store first. If every id was accounted for there, we're
  // done — skip the file read entirely. removeSessionCronTasks is a no-op
  // (returns 0) on miss, so pre-existing durable-delete paths fall through
  // without allocating.
  if (dir === undefined && removeSessionCronTasks(ids) === ids.length) {
    return
  }
  const idSet = new Set(ids)
  const tasks = await readCronTasks(dir)
  const remaining = tasks.filter(t => !idSet.has(t.id))
  if (remaining.length === tasks.length) return
  await writeCronTasks(remaining, dir)
}

/**
 * Stamp `lastFiredAt` on the given recurring tasks and write back. Batched
 * so N fires in one scheduler tick = one read-modify-write, not N. Only
 * touches file-backed tasks — session tasks die with the process, no point
 * persisting their fire time. No-op if none of the ids match (task was
 * deleted between fire and write — e.g. user ran CronDelete mid-tick).
 *
 * Scheduler lock means at most one process calls this; chokidar picks up
 * the write and triggers a reload which re-seeds `nextFireAt` from the
 * just-written `lastFiredAt` — idempotent (same computation, same answer).
 */
export async function markCronTasksFired(
  ids: string[],
  firedAt: number,
  dir?: string,
): Promise<void> {
  if (ids.length === 0) return
  const idSet = new Set(ids)
  const tasks = await readCronTasks(dir)
  let changed = false
  for (const t of tasks) {
    if (idSet.has(t.id)) {
      t.lastFiredAt = firedAt
      changed = true
    }
  }
  if (!changed) return
  await writeCronTasks(tasks, dir)
}

/**
 * File-backed tasks + session-only tasks, merged. Session tasks get
 * `durable: false` so callers can distinguish them. File tasks are
 * returned as-is (durable undefined → truthy).
 *
 * Only merges when `dir` is undefined — daemon callers (explicit `dir`)
 * have no session store to merge with.
 */
export async function listAllCronTasks(dir?: string): Promise<CronTask[]> {
  const fileTasks = await readCronTasks(dir)
  if (dir !== undefined) return fileTasks
  const sessionTasks = getSessionCronTasks().map(t => ({
    ...t,
    durable: false as const,
  }))
  return [...fileTasks, ...sessionTasks]
}

/**
 * Next fire time in epoch ms for a cron string, strictly after `fromMs`.
 * Returns null if invalid or no match in the next 366 days.
 */
export function nextCronRunMs(cron: string, fromMs: number): number | null {
  const fields = parseCronExpression(cron)
  if (!fields) return null
  const next = computeNextCronRun(fields, new Date(fromMs))
  return next ? next.getTime() : null
}

/**
 * Cron scheduler tuning knobs. Sourced at runtime from the
 * `tengu_kairos_cron_config` GrowthBook JSON config (see cronJitterConfig.ts)
 * so ops can adjust behavior fleet-wide without shipping a client build.
 * Defaults here preserve the pre-config behavior exactly.
 */
export type CronJitterConfig = {
  /** Recurring-task forward delay as a fraction of the interval between fires. */
  recurringFrac: number
  /** Upper bound on recurring forward delay regardless of interval length. */
  recurringCapMs: number
  /** One-shot backward lead: maximum ms a task may fire early. */
  oneShotMaxMs: number
  /**
   * One-shot backward lead: minimum ms a task fires early when the minute-mod
   * gate matches. 0 = taskIds hashing near zero fire on the exact mark. Raise
   * this to guarantee nobody lands on the wall-clock boundary.
   */
  oneShotFloorMs: number
  /**
   * Jitter fires landing on minutes where `minute % N === 0`. 30 → :00/:30
   * (the human-rounding hotspots). 15 → :00/:15/:30/:45. 1 → every minute.
   */
  oneShotMinuteMod: number
  /**
   * Recurring tasks auto-expire this many ms after creation (unless marked
   * `permanent`). Cron is the primary driver of multi-day sessions (p99
   * uptime 61min → 53h post-#19931), and unbounded recurrence lets Tier-1
   * heap leaks compound indefinitely. The default (7 days) covers "check
   * my PRs every hour this week" workflows while capping worst-case
   * session lifetime. Permanent tasks (assistant mode's catch-up/
   * morning-checkin/dream) never age out — they can't be recreated if
   * deleted because install.ts's writeIfMissing() skips existing files.
   *
   * `0` = unlimited (tasks never auto-expire).
   */
  recurringMaxAgeMs: number
}

export const DEFAULT_CRON_JITTER_CONFIG: CronJitterConfig = {
  recurringFrac: 0.1,
  recurringCapMs: 15 * 60 * 1000,
  oneShotMaxMs: 90 * 1000,
  oneShotFloorMs: 0,
  oneShotMinuteMod: 30,
  recurringMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
}

/**
 * taskId is an 8-hex-char UUID slice (see {@link addCronTask}) → parse as
 * u32 → [0, 1). Stable across restarts, uniformly distributed across the
 * fleet. Non-hex ids (hand-edited JSON) fall back to 0 = no jitter.
 */
function jitterFrac(taskId: string): number {
  const frac = parseInt(taskId.slice(0, 8), 16) / 0x1_0000_0000
  return Number.isFinite(frac) ? frac : 0
}

/**
 * Same as {@link nextCronRunMs}, plus a deterministic per-task delay to
 * avoid a thundering herd when many sessions schedule the same cron string
 * (e.g. `0 * * * *` → everyone hits inference at :00).
 *
 * The delay is proportional to the current gap between fires
 * ({@link CronJitterConfig.recurringFrac}, capped at
 * {@link CronJitterConfig.recurringCapMs}) so at defaults an hourly task
 * spreads across [:00, :06) but a per-minute task only spreads by a few
 * seconds.
 *
 * Only used for recurring tasks. One-shot tasks use
 * {@link oneShotJitteredNextCronRunMs} (backward jitter, minute-gated).
 */
export function jitteredNextCronRunMs(
  cron: string,
  fromMs: number,
  taskId: string,
  cfg: CronJitterConfig = DEFAULT_CRON_JITTER_CONFIG,
): number | null {
  const t1 = nextCronRunMs(cron, fromMs)
  if (t1 === null) return null
  const t2 = nextCronRunMs(cron, t1)
  // No second match in the next year (e.g. pinned date) → nothing to
  // proportion against, and near-certainly not a herd risk. Fire on t1.
  if (t2 === null) return t1
  const jitter = Math.min(
    jitterFrac(taskId) * cfg.recurringFrac * (t2 - t1),
    cfg.recurringCapMs,
  )
  return t1 + jitter
}

/**
 * Same as {@link nextCronRunMs}, minus a deterministic per-task lead time
 * when the fire time lands on a minute boundary matching
 * {@link CronJitterConfig.oneShotMinuteMod}.
 *
 * One-shot tasks are user-pinned ("remind me at 3pm") so delaying them
 * breaks the contract — but firing slightly early is invisible and spreads
 * the inference spike from everyone picking the same round wall-clock time.
 * At defaults (mod 30, max 90 s, floor 0) only :00 and :30 get jitter,
 * because humans round to the half-hour.
 *
 * During an incident, ops can push `tengu_kairos_cron_config` with e.g.
 * `{oneShotMinuteMod: 15, oneShotMaxMs: 300000, oneShotFloorMs: 30000}` to
 * spread :00/:15/:30/:45 fires across a [t-5min, t-30s] window — every task
 * gets at least 30 s of lead, so nobody lands on the exact mark.
 *
 * Checks the computed fire time rather than the cron string so
 * `0 15 * * *`, step expressions, and `0,30 9 * * *` all get jitter
 * when they land on a matching minute. Clamped to `fromMs` so a task created
 * inside its own jitter window doesn't fire before it was created.
 */
export function oneShotJitteredNextCronRunMs(
  cron: string,
  fromMs: number,
  taskId: string,
  cfg: CronJitterConfig = DEFAULT_CRON_JITTER_CONFIG,
): number | null {
  const t1 = nextCronRunMs(cron, fromMs)
  if (t1 === null) return null
  // Cron resolution is 1 minute → computed times always have :00 seconds,
  // so a minute-field check is sufficient to identify the hot marks.
  // getMinutes() (local), not getUTCMinutes(): cron is evaluated in local
  // time, and "user picked a round time" means round in *their* TZ. In
  // half-hour-offset zones (India UTC+5:30) local :00 is UTC :30 — the
  // UTC check would jitter the wrong marks.
  if (new Date(t1).getMinutes() % cfg.oneShotMinuteMod !== 0) return t1
  // floor + frac * (max - floor) → uniform over [floor, max). With floor=0
  // this reduces to the original frac * max. With floor>0, even a taskId
  // hashing to 0 gets `floor` ms of lead — nobody fires on the exact mark.
  const lead =
    cfg.oneShotFloorMs +
    jitterFrac(taskId) * (cfg.oneShotMaxMs - cfg.oneShotFloorMs)
  // t1 > fromMs is guaranteed by nextCronRunMs (strictly after), so the
  // max() only bites when the task was created inside its own lead window.
  return Math.max(t1 - lead, fromMs)
}

/**
 * A task is "missed" when its next scheduled run (computed from createdAt)
 * is in the past. Surfaced to the user at startup. Works for both one-shot
 * and recurring tasks — a recurring task whose window passed while Claude
 * was down is still "missed".
 */
export function findMissedTasks(tasks: CronTask[], nowMs: number): CronTask[] {
  return tasks.filter(t => {
    const next = nextCronRunMs(t.cron, t.createdAt)
    return next !== null && next < nowMs
  })
}

// ===========================================================================
// Wave 1 — Hermes-inspired helpers
// ===========================================================================

/**
 * Parse a user-supplied schedule string into a 5-field cron expression +
 * recurring flag. Accepts:
 *   - Plain 5-field cron: "*\/5 * * * *" (passed through).
 *   - Duration: "30m" / "2h" / "1d" — one-shot, fires once at (now + duration).
 *   - Interval: "every 30m" / "every 2h" — recurring. Divisor must fit the
 *     containing unit (60 for minutes, 24 for hours) or an error is thrown.
 *   - ISO timestamp: "2026-04-20T14:30" — one-shot at that minute/hour/dom/month.
 *
 * Returns `{ cron, recurring, display }`. `display` is a human-friendly echo
 * of the original input for result messages.
 *
 * Throws Error with a helpful message for unsupported inputs — callers
 * (CronCreateTool.validateInput) convert to ValidationResult.
 */
export type ParsedSchedule = {
  cron: string
  recurring: boolean
  display: string
}

const DURATION_RE = /^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i

function parseDurationMinutes(s: string): number | null {
  const m = s.trim().match(DURATION_RE)
  if (!m) return null
  const n = parseInt(m[1]!, 10)
  const unit = m[2]!.toLowerCase()[0] // m / h / d
  const mult = unit === 'm' ? 1 : unit === 'h' ? 60 : 1440
  return n * mult
}

export function parseSchedule(input: string): ParsedSchedule {
  const raw = input.trim()
  if (!raw) throw new Error('Empty schedule')

  // 5-field cron: delegate to the existing validator.
  const parts = raw.split(/\s+/)
  if (parts.length === 5 && parseCronExpression(raw)) {
    return { cron: raw, recurring: true, display: raw }
  }

  // "every N<unit>"
  const lower = raw.toLowerCase()
  if (lower.startsWith('every ')) {
    const tail = raw.slice(6).trim()
    const mins = parseDurationMinutes(tail)
    if (mins === null) {
      throw new Error(
        `Invalid interval '${raw}'. Use 'every 5m', 'every 2h', or 'every 1d'.`,
      )
    }
    if (mins < 1) throw new Error(`Interval must be >= 1 minute: '${raw}'`)
    if (mins < 60) {
      if (60 % mins !== 0) {
        throw new Error(
          `Interval '${tail}' doesn't divide an hour evenly — use one of: 1m, 2m, 3m, 4m, 5m, 6m, 10m, 12m, 15m, 20m, 30m, or a plain cron like '*/${mins} * * * *'.`,
        )
      }
      return {
        cron: `*/${mins} * * * *`,
        recurring: true,
        display: `every ${mins}m`,
      }
    }
    if (mins < 1440) {
      const hours = mins / 60
      if (!Number.isInteger(hours) || 24 % hours !== 0) {
        throw new Error(
          `Interval '${tail}' doesn't divide a day evenly — use one of: 1h, 2h, 3h, 4h, 6h, 8h, 12h, or a plain cron.`,
        )
      }
      return {
        cron: `0 */${hours} * * *`,
        recurring: true,
        display: `every ${hours}h`,
      }
    }
    // 1 day or more — only 1d supported as a nice form; longer → use cron.
    if (mins === 1440) {
      return { cron: '0 0 * * *', recurring: true, display: 'every 1d' }
    }
    throw new Error(
      `Interval > 1 day not supported as DSL; use a cron expression.`,
    )
  }

  // ISO timestamp (has 'T' or looks like YYYY-MM-DD).
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const d = new Date(raw)
    if (Number.isNaN(d.getTime())) {
      throw new Error(`Invalid ISO timestamp: '${raw}'`)
    }
    if (d.getTime() <= Date.now()) {
      throw new Error(`Timestamp '${raw}' is in the past.`)
    }
    const cron = `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`
    return {
      cron,
      recurring: false,
      display: `once at ${d.toLocaleString()}`,
    }
  }

  // Plain duration like "30m" → one-shot at (now + duration).
  const mins = parseDurationMinutes(raw)
  if (mins !== null) {
    if (mins < 1) throw new Error(`Duration must be >= 1 minute: '${raw}'`)
    const when = new Date(Date.now() + mins * 60_000)
    const cron = `${when.getMinutes()} ${when.getHours()} ${when.getDate()} ${when.getMonth() + 1} *`
    return { cron, recurring: false, display: `once in ${raw}` }
  }

  throw new Error(
    `Could not parse schedule '${raw}'. Supported:\n` +
      `  - Duration (one-shot): '30m', '2h', '1d'\n` +
      `  - Interval (recurring): 'every 5m', 'every 2h'\n` +
      `  - Cron: '0 9 * * *'\n` +
      `  - ISO timestamp: '2026-04-20T14:30'`,
  )
}

/**
 * Compute the catch-up grace window for a recurring task. Matches Hermes'
 * `_compute_grace_seconds`: half of the expected inter-fire period, clamped
 * between 2 minutes and 2 hours. If the task is stale by more than this
 * grace, the scheduler fast-forwards instead of firing a stale prompt.
 * Returns ms.
 */
const GRACE_MIN_MS = 2 * 60 * 1000
const GRACE_MAX_MS = 2 * 60 * 60 * 1000

export function computeGraceMs(cron: string, fromMs: number): number {
  const first = nextCronRunMs(cron, fromMs)
  if (first === null) return GRACE_MIN_MS
  const second = nextCronRunMs(cron, first)
  if (second === null) return GRACE_MIN_MS
  const halfPeriod = Math.floor((second - first) / 2)
  return Math.max(GRACE_MIN_MS, Math.min(halfPeriod, GRACE_MAX_MS))
}

/**
 * Preemptively advance `lastFiredAt` to `nowMs` before the fire callback
 * runs. Converts the file-backed recurring scheduler from at-least-once to
 * at-most-once: if the process crashes between this write and the fire,
 * first-sight on next boot re-seeds next fire from the just-written
 * lastFiredAt, so the task does NOT burst-fire. One-shots are left alone —
 * they should still retry if we crashed mid-fire.
 *
 * This is a pre-fire companion to markCronTasksFired (which runs post-fire
 * in batch). Calling both is fine; markCronTasksFired becomes idempotent.
 */
export async function advanceNextRun(
  id: string,
  nowMs: number,
  dir?: string,
): Promise<boolean> {
  const tasks = await readCronTasks(dir)
  let changed = false
  for (const t of tasks) {
    if (t.id !== id) continue
    if (!t.recurring) return false
    t.lastFiredAt = nowMs
    changed = true
    break
  }
  if (changed) await writeCronTasks(tasks, dir)
  return changed
}

/**
 * Record the outcome of a fire. Bumps `repeat.completed`, sets
 * `lastStatus` / `lastError`, and deletes the task if the repeat limit has
 * been reached. Silent no-op if the task no longer exists (e.g. user
 * deleted it mid-fire). Session tasks (durable: false) are not tracked
 * here — they're process-local and don't need disk bookkeeping.
 */
export async function markJobRun(
  id: string,
  success: boolean,
  error?: string,
  dir?: string,
): Promise<void> {
  const tasks = await readCronTasks(dir)
  let idx = -1
  for (let i = 0; i < tasks.length; i++) {
    if (tasks[i]!.id === id) {
      idx = i
      break
    }
  }
  if (idx < 0) return
  const t = tasks[idx]!
  t.lastStatus = success ? 'ok' : 'error'
  if (!success && error) {
    // Guard: cap length so an accidentally-huge error doesn't bloat jobs.json.
    t.lastError = error.length > 500 ? `${error.slice(0, 500)}...` : error
  } else {
    delete t.lastError
  }
  if (t.repeat && typeof t.repeat.times === 'number') {
    t.repeat.completed = (t.repeat.completed ?? 0) + 1
    if (t.repeat.completed >= t.repeat.times) {
      // Limit reached — delete, same as one-shot completion.
      tasks.splice(idx, 1)
      await writeCronTasks(tasks, dir)
      return
    }
  } else if (t.repeat) {
    t.repeat.completed = (t.repeat.completed ?? 0) + 1
  }
  await writeCronTasks(tasks, dir)
}

/** One fire outcome to persist in a {@link markCronFiredBatch} call. */
export type CronFireRecord = {
  id: string
  firedAt: number
  success: boolean
  /** Only meaningful when `success === false`. Capped at 500 chars on write. */
  error?: string
}

/**
 * Batched post-fire persistence. Single read → apply lastFiredAt + lastStatus
 * + repeat.completed for every record → single write. Replaces the split
 * `markCronTasksFired` + per-task `markJobRun` call pair in the scheduler,
 * which raced when both ran concurrently against scheduled_tasks.json and
 * clobbered each other's fields. Repeat-limit deletion semantics match
 * {@link markJobRun}.
 */
export async function markCronFiredBatch(
  records: CronFireRecord[],
  dir?: string,
): Promise<void> {
  if (records.length === 0) return
  const tasks = await readCronTasks(dir)
  const byId = new Map<string, CronFireRecord>()
  for (const r of records) byId.set(r.id, r)
  const kept: CronTask[] = []
  let changed = false
  for (const t of tasks) {
    const r = byId.get(t.id)
    if (!r) {
      kept.push(t)
      continue
    }
    changed = true
    t.lastFiredAt = r.firedAt
    t.lastStatus = r.success ? 'ok' : 'error'
    if (!r.success && r.error) {
      t.lastError =
        r.error.length > 500 ? `${r.error.slice(0, 500)}...` : r.error
    } else {
      delete t.lastError
    }
    if (t.repeat) {
      t.repeat.completed = (t.repeat.completed ?? 0) + 1
      if (
        typeof t.repeat.times === 'number' &&
        t.repeat.completed >= t.repeat.times
      ) {
        // Limit reached — drop (same as one-shot completion).
        continue
      }
    }
    kept.push(t)
  }
  if (!changed) return
  await writeCronTasks(kept, dir)
  // Wave 3 — append history rows. Keep this after the write so disk state
  // for scheduled_tasks.json is committed before history sees the entry;
  // history failures must never block the fire path.
  await Promise.all(
    records.map(async r => {
      // Look up keepRuns from the (possibly removed) task; fall back to default.
      const t = tasks.find(x => x.id === r.id)
      try {
        await appendHistoryEntry(
          r.id,
          {
            ts: r.firedAt,
            status: r.success ? 'ok' : 'error',
            ...(r.error ? { errorMsg: r.error.slice(0, 500) } : {}),
          },
          { keepRuns: t?.history?.keepRuns, dir },
        )
      } catch (e) {
        logForDebugging(
          `[cronTasks] history append failed for ${r.id}: ${(e as Error).message}`,
        )
      }
    }),
  )
}

/**
 * Wave 2 — apply a partial update to a single task. The updater callback
 * receives the current task and returns the next one; returning the same
 * reference (or a shallow copy with no changes) results in no write.
 * Works across both file-backed and session-only tasks — callers pass
 * `dir` explicitly when operating on a daemon's working copy; omit for
 * REPL path where session tasks live in bootstrap state.
 *
 * Returns the updated task, or null if the id was not found.
 */
export async function updateCronTask(
  id: string,
  updater: (t: CronTask) => CronTask,
  dir?: string,
): Promise<CronTask | null> {
  // File-backed path.
  const tasks = await readCronTasks(dir)
  const idx = tasks.findIndex(t => t.id === id)
  if (idx >= 0) {
    const next = updater(tasks[idx]!)
    tasks[idx] = next
    await writeCronTasks(tasks, dir)
    return next
  }
  // Session store — only touched when dir is undefined (REPL path).
  if (dir === undefined) {
    const session = getSessionCronTasks()
    const sIdx = session.findIndex(t => t.id === id)
    if (sIdx >= 0) {
      const next = updater(session[sIdx]!)
      // bootstrap state exposes add/remove but not direct index mutation;
      // remove-then-add preserves ordering roughly (appended to end).
      removeSessionCronTasks([id])
      addSessionCronTask(next)
      return next
    }
  }
  return null
}

/**
 * Audit-log the fact that a task fired. Writes to
 * `<project>/.my-agent/cron/output/{id}/{ts}.md`. We don't have the model
 * response at enqueue time (REPL drains async), so the body is the prompt
 * + fire timestamp — enough to reconstruct "what fired when" after the
 * fact. Matches Hermes `save_job_output` on disk layout.
 */
export async function saveJobOutput(
  id: string,
  firedAtMs: number,
  content: string,
  dir?: string,
): Promise<string> {
  const root = dir ?? getProjectRoot()
  const outDir = join(root, '.my-agent', 'cron', 'output', id)
  await mkdir(outDir, { recursive: true })
  const d = new Date(firedAtMs)
  const pad = (n: number) => n.toString().padStart(2, '0')
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  const file = join(outDir, `${stamp}.md`)
  await writeFile(file, content, 'utf-8')
  return file
}
