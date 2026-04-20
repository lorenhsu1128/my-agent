/**
 * M-DISCORD-1.1：ProjectRegistry — 單 daemon 內活多個 ProjectRuntime 的管理層。
 *
 * 設計（見 plan file `m-discord-jaunty-valiant.md`）：
 *   - Registry 本身只管生命週期（Map + idleSweeper + lastActivity + REPL attach 計數）
 *   - ProjectRuntime 的實際 bootstrap（context / sessionHandle / broker / cron /
 *     permissionRouter）由 runtime factory 建；factory 可 inject 讓測試 stub heavy deps
 *   - `loadProject(cwd)` lazy：第一次呼叫才 build；同 projectId 重入回同一 instance
 *   - Idle unload 策略：`hasAttachedRepl(projectId)` 為 true → 永遠不 unload；全部 REPL
 *     離線才開始計 idleMs（預設 30min）
 *   - 並行：真實 turn 序列化由 daemonTurnMutex 負責；registry 只做 metadata
 *
 * 不含：
 *   - Discord routing（M-DISCORD-3）
 *   - WS client ↔ project 關聯（M-DISCORD-2 在 clientRegistry 擴欄位）
 *   - 實際 bootstrap wiring（M-DISCORD-1.4 在 daemonCli 接上）
 */
import { randomUUID } from 'crypto'
import { sanitizePath } from '../utils/path.js'
import type { DaemonSessionContext } from './sessionBootstrap.js'
import type { DaemonSessionHandle } from './sessionWriter.js'
import type { SessionBroker } from './sessionBroker.js'
import type { PermissionRouter } from './permissionRouter.js'
import type { CronWiringHandle } from './cronWiring.js'

export interface ProjectRuntime {
  readonly projectId: string
  readonly cwd: string
  readonly context: DaemonSessionContext
  readonly sessionHandle: DaemonSessionHandle
  readonly broker: SessionBroker
  readonly permissionRouter: PermissionRouter
  readonly cron: CronWiringHandle
  /** Unix ms — 最近一次 input submit 或 REPL attach/detach 發生時間 */
  lastActivityAt: number
  /** 目前 attached 的 REPL client id（可能多個 — 多 REPL 同 project） */
  readonly attachedReplIds: Set<string>
  /** true = runtime 正被使用中，不可 unload（REPL attach 或 turn 跑中） */
  hasAttachedRepl(): boolean
  /** 標記使用中（submit / attach / turn-start 都要叫） */
  touch(): void
  attachRepl(clientId: string): void
  detachRepl(clientId: string): void
  /** 釋放所有資源：cron stop → broker dispose → context dispose → sessionHandle dispose */
  dispose(): Promise<void>
}

export interface ProjectRuntimeFactoryOptions {
  cwd: string
  projectId: string
}

/**
 * Runtime factory：產出一個完整 bootstrap 好的 ProjectRuntime。
 * Registry 不關心細節；test 可 inject 假 factory。真實 factory 在 M-DISCORD-1.4
 * （`createDefaultProjectRuntimeFactory`，會組 bootstrapDaemonContext + beginDaemonSession
 * + createSessionBroker + createPermissionRouter + startDaemonCronWiring）。
 */
export type ProjectRuntimeFactory = (
  opts: ProjectRuntimeFactoryOptions,
) => Promise<ProjectRuntime>

export interface ProjectRegistryOptions {
  factory: ProjectRuntimeFactory
  /** Idle timeout（ms）— REPL 全離線後，這麼久沒活動才 unload。預設 30min。 */
  idleMs?: number
  /** idleSweeper tick 間隔（ms）。預設 60s。 */
  sweepIntervalMs?: number
  /** 時鐘注入（測試用） */
  now?: () => number
  /** Unload callback（Discord / 通知用） */
  onUnload?: (projectId: string, reason: 'idle' | 'manual' | 'shutdown') => void
  /** Load callback（日誌 / 通知用） */
  onLoad?: (projectId: string) => void
  /** Sweep 錯誤 log（測試可靜音） */
  onSweepError?: (projectId: string, err: unknown) => void
}

export interface ProjectRegistry {
  /**
   * Load or get existing ProjectRuntime for cwd。
   * 冪等：同 cwd 重入回同一 instance（lastActivity 刷新）。
   */
  loadProject(cwd: string): Promise<ProjectRuntime>
  getProject(projectId: string): ProjectRuntime | null
  getProjectByCwd(cwd: string): ProjectRuntime | null
  listProjects(): ProjectRuntime[]
  /** 手動 unload — 不管 idle / attach 狀態。sweep 看 idle。 */
  unloadProject(projectId: string): Promise<boolean>
  touchActivity(projectId: string): void
  /** 強制 sweep 一次（測試用）。回傳被 unload 的 projectId 列表。 */
  sweepIdle(): Promise<string[]>
  /** Shutdown：unload 所有 runtime，停 sweeper。 */
  dispose(): Promise<void>
}

/** cwd → 穩定的 projectId（沿用 sanitizePath 與 getProjectDir 同口徑）。 */
export function projectIdFromCwd(cwd: string): string {
  return sanitizePath(cwd)
}

const DEFAULT_IDLE_MS = 30 * 60 * 1000
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000

export function createProjectRegistry(
  opts: ProjectRegistryOptions,
): ProjectRegistry {
  const factory = opts.factory
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS
  const sweepInterval = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS
  const now = opts.now ?? (() => Date.now())

  const runtimes = new Map<string, ProjectRuntime>()
  // 同 cwd 並行 loadProject 時的去重 — 避免 factory 重入跑兩次
  const loading = new Map<string, Promise<ProjectRuntime>>()

  let disposed = false
  let sweeperHandle: ReturnType<typeof setInterval> | null = null

  const startSweeper = (): void => {
    if (sweeperHandle !== null || disposed) return
    sweeperHandle = setInterval(() => {
      void sweepIdle().catch(() => undefined)
    }, sweepInterval)
    // Node 允許 unref 讓 interval 不擋 event loop 結束
    if (typeof sweeperHandle === 'object' && sweeperHandle !== null) {
      const h = sweeperHandle as unknown as { unref?: () => void }
      h.unref?.()
    }
  }

  const stopSweeper = (): void => {
    if (sweeperHandle !== null) {
      clearInterval(sweeperHandle)
      sweeperHandle = null
    }
  }

  const loadProject = async (cwd: string): Promise<ProjectRuntime> => {
    if (disposed) throw new Error('ProjectRegistry disposed')
    const projectId = projectIdFromCwd(cwd)
    const existing = runtimes.get(projectId)
    if (existing) {
      existing.lastActivityAt = now()
      return existing
    }
    const inflight = loading.get(projectId)
    if (inflight) return inflight

    const p = (async () => {
      try {
        const runtime = await factory({ cwd, projectId })
        runtime.lastActivityAt = now()
        runtimes.set(projectId, runtime)
        opts.onLoad?.(projectId)
        startSweeper()
        return runtime
      } finally {
        loading.delete(projectId)
      }
    })()
    loading.set(projectId, p)
    return p
  }

  const getProject = (projectId: string): ProjectRuntime | null =>
    runtimes.get(projectId) ?? null

  const getProjectByCwd = (cwd: string): ProjectRuntime | null =>
    getProject(projectIdFromCwd(cwd))

  const listProjects = (): ProjectRuntime[] => Array.from(runtimes.values())

  const unloadProject = async (
    projectId: string,
    reason: 'idle' | 'manual' | 'shutdown' = 'manual',
  ): Promise<boolean> => {
    const r = runtimes.get(projectId)
    if (!r) return false
    runtimes.delete(projectId)
    try {
      await r.dispose()
    } catch {
      // dispose 失敗不影響 registry 一致性
    }
    opts.onUnload?.(projectId, reason)
    if (runtimes.size === 0) stopSweeper()
    return true
  }

  const touchActivity = (projectId: string): void => {
    const r = runtimes.get(projectId)
    if (r) r.lastActivityAt = now()
  }

  const sweepIdle = async (): Promise<string[]> => {
    if (disposed) return []
    const cutoff = now() - idleMs
    const toUnload: string[] = []
    for (const [id, r] of runtimes) {
      if (r.hasAttachedRepl()) continue
      if (r.lastActivityAt < cutoff) toUnload.push(id)
    }
    const result: string[] = []
    for (const id of toUnload) {
      try {
        const ok = await unloadProject(id, 'idle')
        if (ok) result.push(id)
      } catch (e) {
        opts.onSweepError?.(id, e)
      }
    }
    return result
  }

  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    stopSweeper()
    const ids = Array.from(runtimes.keys())
    for (const id of ids) {
      try {
        await unloadProject(id, 'shutdown')
      } catch {
        // ignore
      }
    }
  }

  return {
    loadProject,
    getProject,
    getProjectByCwd,
    listProjects,
    unloadProject: id => unloadProject(id, 'manual'),
    touchActivity,
    sweepIdle,
    dispose,
  }
}

/**
 * 測試 helper：建一個最小可用的 fake ProjectRuntime。
 * 真實 factory 由 M-DISCORD-1.4 組，走 bootstrapDaemonContext + createSessionBroker 等。
 */
export function createFakeProjectRuntime(opts: {
  projectId?: string
  cwd?: string
  onDispose?: () => void | Promise<void>
}): ProjectRuntime {
  const projectId = opts.projectId ?? `fake-${randomUUID().slice(0, 8)}`
  const cwd = opts.cwd ?? process.cwd()
  const attachedReplIds = new Set<string>()
  const runtime: ProjectRuntime = {
    projectId,
    cwd,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    context: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sessionHandle: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    broker: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    permissionRouter: {} as any,
    cron: { scheduler: null, stop: () => {} },
    lastActivityAt: Date.now(),
    attachedReplIds,
    hasAttachedRepl: () => attachedReplIds.size > 0,
    touch: () => {
      runtime.lastActivityAt = Date.now()
    },
    attachRepl: (clientId: string) => {
      attachedReplIds.add(clientId)
      runtime.lastActivityAt = Date.now()
    },
    detachRepl: (clientId: string) => {
      attachedReplIds.delete(clientId)
      runtime.lastActivityAt = Date.now()
    },
    dispose: async () => {
      await opts.onDispose?.()
    },
  }
  return runtime
}
