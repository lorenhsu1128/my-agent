/**
 * M-DISCORD-1.4：Default ProjectRuntimeFactory — 把 bootstrapDaemonContext +
 * beginDaemonSession + createSessionBroker + createPermissionRouter +
 * startDaemonCronWiring 串成一個完整 ProjectRuntime。
 *
 * 這層做的事：
 *   1. bootstrap 出 DaemonSessionContext（tools / commands / MCP / AppState）
 *   2. 宣告 session JSONL 的獨占寫入（`.daemon.lock` per-projectDir）
 *   3. 建 permissionRouter，然後用 brokerRef 拿到 current turn 資訊
 *   4. 建 QueryEngineRunner，再用 wrapRunnerWithProjectCwd 套 mutex + chdir
 *   5. 建 SessionBroker（吃 wrapped runner）
 *   6. 啟動 cron（gate 檢查後才真的起）
 *   7. 包成 ProjectRuntime 給 ProjectRegistry 用
 *
 * 只處理「一個 project」的事；多 project 路由是 ProjectRegistry 的職責。
 * Cross-project 互斥由傳入的 mutex 負責（整個 daemon 共享一把）。
 */
import {
  bootstrapDaemonContext,
  type DaemonSessionContext,
} from './sessionBootstrap.js'
import { beginDaemonSession } from './sessionWriter.js'
import { createQueryEngineRunner } from './queryEngineRunner.js'
import { createSessionBroker, type SessionBroker } from './sessionBroker.js'
import {
  createPermissionRouter,
  type PermissionRouter,
} from './permissionRouter.js'
import { startDaemonCronWiring, type CronWiringHandle } from './cronWiring.js'
import {
  wrapRunnerWithProjectCwd,
  type DaemonTurnMutex,
} from './daemonTurnMutex.js'
import type { ProjectRuntime, ProjectRuntimeFactory } from './projectRegistry.js'
import type { DirectConnectServerHandle } from '../server/directConnectServer.js'

export interface DefaultProjectRuntimeFactoryDeps {
  server: DirectConnectServerHandle
  mutex: DaemonTurnMutex
  /** Daemon 啟動時的 process.cwd()，withProjectCwd 還原時的底 */
  baseCwd: string
  /** Bootstrap 額外選項（allowedTools / disallowedTools / permissionMode 等） */
  bootstrapOptions?: Omit<
    Parameters<typeof bootstrapDaemonContext>[0],
    'cwd'
  >
  /** 測試可 inject 假 bootstrap（跳過 MCP 等重依賴） */
  bootstrap?: typeof bootstrapDaemonContext
  /** 若要關 cron（測試）可 inject 假 wire，或直接傳 noopCronWiring。 */
  cronWire?: typeof startDaemonCronWiring
}

export function createDefaultProjectRuntimeFactory(
  deps: DefaultProjectRuntimeFactoryDeps,
): ProjectRuntimeFactory {
  const bootstrap = deps.bootstrap ?? bootstrapDaemonContext
  const cronWire = deps.cronWire ?? startDaemonCronWiring
  return async ({ cwd, projectId }): Promise<ProjectRuntime> => {
    let context: DaemonSessionContext | null = null
    let sessionHandle: ReturnType<typeof beginDaemonSession> | null = null
    let broker: SessionBroker | null = null
    let cron: CronWiringHandle | null = null
    let permissionRouter: PermissionRouter | null = null

    try {
      context = await bootstrap({
        cwd,
        ...(deps.bootstrapOptions ?? {}),
      })
      sessionHandle = beginDaemonSession({ cwd })

      const brokerRef: { current: SessionBroker | null } = { current: null }
      permissionRouter = createPermissionRouter({
        server: deps.server,
        resolveSourceClientId: () =>
          brokerRef.current?.queue.currentInput?.clientId ?? null,
        resolveCurrentInputId: () =>
          brokerRef.current?.queue.currentInput?.id ?? null,
      })

      const rawRunner = createQueryEngineRunner({
        context,
        canUseTool: permissionRouter.canUseTool,
      })
      const wrappedRunner = wrapRunnerWithProjectCwd(rawRunner, {
        mutex: deps.mutex,
        projectId,
        cwd,
        baseCwd: deps.baseCwd,
      })

      broker = createSessionBroker({
        server: deps.server,
        context,
        runner: wrappedRunner,
        sessionHandle,
      })
      brokerRef.current = broker

      cron = cronWire({ broker })
    } catch (e) {
      // Bootstrap 失敗路徑：盡可能 cleanup 已建好的 resources
      try {
        cron?.stop()
      } catch {
        // ignore
      }
      try {
        permissionRouter?.cancelAll('factory-failed')
      } catch {
        // ignore
      }
      try {
        await broker?.dispose()
      } catch {
        // ignore
      }
      try {
        sessionHandle?.dispose()
      } catch {
        // ignore
      }
      try {
        await context?.dispose()
      } catch {
        // ignore
      }
      throw e
    }

    const attachedReplIds = new Set<string>()
    const runtime: ProjectRuntime = {
      projectId,
      cwd,
      context,
      sessionHandle,
      broker,
      permissionRouter,
      cron,
      lastActivityAt: Date.now(),
      attachedReplIds,
      hasAttachedRepl: (): boolean => attachedReplIds.size > 0,
      touch: (): void => {
        runtime.lastActivityAt = Date.now()
      },
      attachRepl: (clientId: string): void => {
        attachedReplIds.add(clientId)
        runtime.lastActivityAt = Date.now()
      },
      detachRepl: (clientId: string): void => {
        attachedReplIds.delete(clientId)
        runtime.lastActivityAt = Date.now()
      },
      dispose: async (): Promise<void> => {
        try {
          cron?.stop()
        } catch {
          // ignore
        }
        try {
          permissionRouter?.cancelAll('runtime-disposed')
        } catch {
          // ignore
        }
        try {
          await broker?.dispose()
        } catch {
          // ignore
        }
        try {
          sessionHandle?.dispose()
        } catch {
          // ignore
        }
        try {
          await context?.dispose()
        } catch {
          // ignore
        }
      },
    }
    return runtime
  }
}
