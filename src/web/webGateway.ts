/**
 * M-WEB-5：WebGateway — daemon 內 ProjectRegistry 的第二消費者，
 * 把所有 ProjectRuntime 事件轉譯成 web frame 廣播給 browser tabs。
 *
 * 與 DiscordGateway 平行存在；mirror `src/discord/gateway.ts` + `replMirror.ts`
 * 的整合 pattern：
 *
 *   1. registry.onLoad(runtime) → ensurePerProjectListeners(runtime)
 *      - broker.queue.on('state' | 'turnStart' | 'turnEnd' | 'runnerEvent') 訂閱
 *      - permissionRouter.onPending / onResolved 訂閱
 *      - cron.events.on('cronFireEvent') 訂閱
 *      - 廣播 project.added 給所有 web tab
 *   2. registry.onUnload(info) → 拆 listeners + 廣播 project.removed
 *   3. wsServer.onMessage(session, frame) → 解析 → 路由：
 *      - input.submit → runtime.broker.queue.submit({source: 'web', clientId})
 *      - input.interrupt → runtime.broker.queue.dispose? 暫無 public abort；用 force submit interactive 讓 runner 中斷
 *      - permission.respond → runtime.permissionRouter.handleResponse(clientId, frame)
 *      - permission.modeSet → runtime.context.toolPermissionContext.setMode + broadcast
 *      - mutation → translator + 對應 daemon RPC handler 直接呼叫
 *
 * 不負責：
 *   - WebSocket 接受 / heartbeat（wsServer 處理）
 *   - REST routes（restRoutes.ts，下一個 commit）
 */
import type { ProjectRegistry, ProjectRuntime } from '../daemon/projectRegistry.js'
import type { CronFireEvent } from '../daemon/cronWiring.js'
import type {
  RunnerEventWrapper,
  TurnEndEvent as DaemonTurnEnd,
  TurnStartEvent as DaemonTurnStart,
  QueueState,
} from '../daemon/inputQueue.js'
import type { BrowserSession, BrowserSessionRegistry } from './browserSession.js'
import type { ServerEvent, ClientFrame } from './webTypes.js'
import {
  parseClientFrame,
  permissionPendingToWeb,
  permissionResolvedToWeb,
  projectToWebInfo,
  runnerEventToWeb,
  turnEndToWeb,
  turnStartToWeb,
} from './translator.js'
import { logForDebugging } from '../utils/debug.js'

export interface WebGatewayOptions {
  registry: ProjectRegistry
  browserSessions: BrowserSessionRegistry
  /** 注入給 webRpc / TUI 顯示 status 用（M-WEB-7）。 */
  onStatusChange?: (running: boolean) => void
}

export interface WebGatewayHandle {
  /** 把 wsServer 的 onMessage 接到此 callback。 */
  handleClientMessage(session: BrowserSession, frame: unknown): void
  /** 把 wsServer 的 onConnect 接到此 callback；會送目前的 project list 給該 session。 */
  handleClientConnect(session: BrowserSession): void
  /** 列出所有 ProjectRuntime 為 web info（給 REST /api/projects 用）。 */
  listProjects(): import('./webTypes.js').WebProjectInfo[]
  /** Daemon 廣播 web.statusChanged 給所有連線的 tab。 */
  broadcastStatusChange(payload: {
    running: boolean
    port?: number
    bindHost?: string
  }): void
  dispose(): void
}

interface PerRuntimeUnsub {
  detachFns: Array<() => void>
}

function jsonStringify(payload: ServerEvent): string {
  return JSON.stringify(payload)
}

export function createWebGateway(opts: WebGatewayOptions): WebGatewayHandle {
  const { registry, browserSessions } = opts
  const perRuntime = new Map<string, PerRuntimeUnsub>()

  function broadcastToProject(projectId: string, evt: ServerEvent): void {
    browserSessions.broadcast(jsonStringify(evt), projectId)
  }
  function broadcastToAll(evt: ServerEvent): void {
    browserSessions.broadcastAll(jsonStringify(evt))
  }

  function attachRuntimeListeners(runtime: ProjectRuntime): void {
    if (perRuntime.has(runtime.projectId)) return
    const detachFns: Array<() => void> = []

    const onState = (state: QueueState) => {
      broadcastToProject(runtime.projectId, {
        type: 'state',
        projectId: runtime.projectId,
        state,
      })
    }
    const onTurnStart = (e: DaemonTurnStart) => {
      broadcastToProject(runtime.projectId, turnStartToWeb(runtime.projectId, e))
    }
    const onTurnEnd = (e: DaemonTurnEnd) => {
      broadcastToProject(runtime.projectId, turnEndToWeb(runtime.projectId, e))
    }
    const onRunnerEvent = (w: RunnerEventWrapper) => {
      broadcastToProject(runtime.projectId, runnerEventToWeb(runtime.projectId, w))
    }
    runtime.broker.queue.on('state', onState)
    runtime.broker.queue.on('turnStart', onTurnStart)
    runtime.broker.queue.on('turnEnd', onTurnEnd)
    runtime.broker.queue.on('runnerEvent', onRunnerEvent)
    detachFns.push(() => runtime.broker.queue.off('state', onState as never))
    detachFns.push(() =>
      runtime.broker.queue.off('turnStart', onTurnStart as never),
    )
    detachFns.push(() => runtime.broker.queue.off('turnEnd', onTurnEnd as never))
    detachFns.push(() =>
      runtime.broker.queue.off('runnerEvent', onRunnerEvent as never),
    )

    // permissionRouter
    const unsubPending = runtime.permissionRouter.onPending(info => {
      broadcastToProject(
        runtime.projectId,
        permissionPendingToWeb({
          projectId: runtime.projectId,
          toolUseID: info.toolUseID,
          toolName: info.meta.toolName,
          input: info.meta.toolInput,
          riskLevel: info.meta.riskLevel,
          description: info.meta.description,
          affectedPaths: info.meta.affectedPaths,
        }),
      )
    })
    const unsubResolved = runtime.permissionRouter.onResolved(info => {
      broadcastToProject(
        runtime.projectId,
        permissionResolvedToWeb({
          projectId: runtime.projectId,
          toolUseID: info.toolUseID,
          // 這裡 router 沒回傳 decision/by；resolved frame 主要用來清 modal，
          // 實際 decision 透過 turn.event 內 ToolResult 顯示
          decision: 'allow',
          by: 'unknown',
        }),
      )
    })
    detachFns.push(unsubPending, unsubResolved)

    // cron events
    const onCronFire = (event: CronFireEvent) => {
      if (event.status !== 'fired') return
      broadcastToProject(runtime.projectId, {
        type: 'cron.fired',
        projectId: runtime.projectId,
        taskId: event.taskId,
        ts: event.startedAt,
      })
    }
    runtime.cron.events.on('cronFireEvent', onCronFire)
    detachFns.push(() => runtime.cron.events.off('cronFireEvent', onCronFire))

    perRuntime.set(runtime.projectId, { detachFns })

    // 廣播 project.added 給所有 tab
    broadcastToAll({
      type: 'project.added',
      project: projectToWebInfo(runtime),
    })
  }

  function detachRuntimeListeners(projectId: string): void {
    const entry = perRuntime.get(projectId)
    if (!entry) return
    for (const fn of entry.detachFns) {
      try {
        fn()
      } catch {
        // ignore
      }
    }
    perRuntime.delete(projectId)
  }

  // Hook into registry lifecycle
  const unsubLoad = registry.onLoad(runtime => {
    try {
      attachRuntimeListeners(runtime)
    } catch (e) {
      logForDebugging(
        `[web-gateway] attach failed for ${runtime.projectId}: ${e instanceof Error ? e.message : String(e)}`,
        { level: 'warn' },
      )
    }
  })
  const unsubUnload = registry.onUnload(({ projectId, reason }) => {
    detachRuntimeListeners(projectId)
    broadcastToAll({
      type: 'project.removed',
      projectId,
      reason,
    })
  })

  // 已 load 的 runtime 也要 attach（gateway 啟動時可能 registry 已有 runtime）
  for (const r of registry.listProjects()) {
    attachRuntimeListeners(r)
  }

  // ---------------------------------------------------------------------------
  // Inbound message routing
  // ---------------------------------------------------------------------------
  function handleClientMessage(session: BrowserSession, raw: unknown): void {
    const parsed = parseClientFrame(raw)
    if (!parsed.ok) {
      session.send(
        JSON.stringify({
          type: 'error',
          code: 'BAD_FRAME',
          message: parsed.reason,
        }),
      )
      return
    }
    routeFrame(session, parsed.frame)
  }

  function routeFrame(session: BrowserSession, frame: ClientFrame): void {
    switch (frame.type) {
      case 'subscribe':
      case 'ping':
        // wsServer 已處理（這裡其實不會收到 — 防禦）
        return
      case 'input.submit': {
        const runtime = registry.getProject(frame.projectId)
        if (!runtime) {
          session.send(
            JSON.stringify({
              type: 'error',
              code: 'PROJECT_NOT_FOUND',
              message: `project ${frame.projectId} not loaded`,
            }),
          )
          return
        }
        runtime.touch()
        runtime.broker.queue.submit(frame.text, {
          clientId: session.id,
          source: 'web',
          intent: frame.intent ?? 'interactive',
        })
        return
      }
      case 'input.interrupt': {
        // queue 沒有 public interrupt API；重複 interactive submit 會搶占 turn。
        // Phase 2 會加 broker.interrupt() public API；這裡先回 error。
        session.send(
          JSON.stringify({
            type: 'error',
            code: 'NOT_IMPLEMENTED',
            message:
              'input.interrupt 將於 M-WEB-12 接上；目前可送新 interactive 訊息搶占當前 turn',
          }),
        )
        return
      }
      case 'permission.respond': {
        const runtime = registry.getProject(frame.projectId)
        if (!runtime) {
          session.send(
            JSON.stringify({
              type: 'error',
              code: 'PROJECT_NOT_FOUND',
              message: `project ${frame.projectId} not loaded`,
            }),
          )
          return
        }
        const handled = runtime.permissionRouter.handleResponse(session.id, {
          type: 'permissionResponse',
          toolUseID: frame.toolUseID,
          decision: frame.decision,
          updatedInput: frame.updatedInput,
        })
        if (!handled) {
          session.send(
            JSON.stringify({
              type: 'error',
              code: 'NO_PENDING_PERMISSION',
              message: `no pending permission for ${frame.toolUseID}`,
            }),
          )
        }
        return
      }
      case 'permission.modeSet': {
        // M-WEB-13 才接上 toolPermissionContext.setMode + 廣播 permission.modeChanged
        session.send(
          JSON.stringify({
            type: 'error',
            code: 'NOT_IMPLEMENTED',
            message: 'permission.modeSet will be wired in M-WEB-13',
          }),
        )
        return
      }
      case 'mutation': {
        // M-WEB-14+ 才接 cron / memory / llamacpp daemon RPC
        session.send(
          JSON.stringify({
            type: 'mutation.result',
            requestId: frame.requestId,
            ok: false,
            error: 'mutation routing not yet implemented (Phase 3)',
          }),
        )
        return
      }
    }
  }

  function handleClientConnect(session: BrowserSession): void {
    // 送目前 project list（每個都當 project.added 推一次，browser store 收到 unique projectId 自動 dedupe）
    const projects = registry.listProjects()
    for (const r of projects) {
      session.send(
        JSON.stringify({
          type: 'project.added',
          project: projectToWebInfo(r),
        } satisfies ServerEvent),
      )
    }
  }

  function listProjects(): ReturnType<typeof projectToWebInfo>[] {
    return registry.listProjects().map(projectToWebInfo)
  }

  function broadcastStatusChange(payload: {
    running: boolean
    port?: number
    bindHost?: string
  }): void {
    broadcastToAll({
      type: 'web.statusChanged',
      running: payload.running,
      port: payload.port,
      bindHost: payload.bindHost,
    })
    opts.onStatusChange?.(payload.running)
  }

  function dispose(): void {
    unsubLoad()
    unsubUnload()
    for (const projectId of [...perRuntime.keys()]) {
      detachRuntimeListeners(projectId)
    }
  }

  return {
    handleClientMessage,
    handleClientConnect,
    listProjects,
    broadcastStatusChange,
    dispose,
  }
}
