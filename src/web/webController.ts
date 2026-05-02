/**
 * M-WEB-7：WebServerController — 在 daemon process 內統一管理 web HTTP server
 * + WS server + WebGateway 三件組件的生命週期。
 *
 * 由 daemonCli 在啟動時建立、註冊到 ProjectRegistry。`/web start/stop` 透過
 * webRpc 呼叫此 controller 的方法。
 */
import type { ProjectRegistry } from '../daemon/projectRegistry.js'
import {
  startHttpServer,
  type HttpServerHandle,
} from './httpServer.js'
import { createWebWsServer, type WebWsServerHandle } from './wsServer.js'
import { createWebGateway, type WebGatewayHandle } from './webGateway.js'
import { createRestRoutes } from './restRoutes.js'
import type { WebConfig } from '../webConfig/schema.js'
import { logForDebugging } from '../utils/debug.js'

export interface WebServerStatus {
  running: boolean
  port?: number
  bindHost?: string
  urls?: string[]
  startedAt?: number
  inDevProxyMode?: boolean
  /** 連接的 browser tab 數量。 */
  connectedClients?: number
  /** 啟動失敗時的錯誤訊息。 */
  lastError?: string
}

export interface WebServerControllerOptions {
  registry: ProjectRegistry
  config: WebConfig
  /** 取最新 config（避免閉包凍結；每次 start 重讀）。 */
  reloadConfig?: () => WebConfig
  /** 注入測試用的 startHttpServer（可 stub）。 */
  startHttpServerImpl?: typeof startHttpServer
  /** Logger。 */
  log?: (msg: string) => void
  /** M-WEB-CLOSEOUT-10：Discord admin controller（未提供則 /api/discord/* 回 503）。 */
  getDiscordController?: () =>
    | import('../discord/discordController.js').DiscordController
    | null
  /**
   * M-WEB-PARITY-9：當 web 改 permission mode 時，廣播給 daemon thin client
   * （REPL/Discord）— daemonCli 在 enableServer 時注入，內部走 directConnectServer.
   * broadcast `permissionModeChanged`。未注入則只更新 daemon state + web 端，
   * TUI 收不到。
   */
  notifyPermissionModeToThinClients?: (
    projectId: string,
    mode: string,
  ) => void
}

export interface WebServerController {
  start(): Promise<WebServerStatus>
  stop(): Promise<WebServerStatus>
  status(): WebServerStatus
  isRunning(): boolean
  /** 釋放所有資源（daemon shutdown）。 */
  dispose(): Promise<void>
}

export function createWebServerController(
  opts: WebServerControllerOptions,
): WebServerController {
  const log =
    opts.log ?? ((m: string) => logForDebugging(`[web-controller] ${m}`))
  const startImpl = opts.startHttpServerImpl ?? startHttpServer

  let httpHandle: HttpServerHandle | null = null
  let wsHandle: WebWsServerHandle | null = null
  let gateway: WebGatewayHandle | null = null
  let startedAt: number | null = null
  let lastError: string | undefined

  async function start(): Promise<WebServerStatus> {
    if (httpHandle) {
      log('start: already running, no-op')
      return status()
    }
    const cfg = opts.reloadConfig?.() ?? opts.config
    log(
      `start: host=${cfg.bindHost} port=${cfg.port} dev=${cfg.devProxyUrl ? 'yes' : 'no'}`,
    )
    try {
      const ws = createWebWsServer({
        heartbeatIntervalMs: cfg.heartbeatIntervalMs,
        onMessage: (session, msg) => gateway?.handleClientMessage(session, msg),
        onConnect: session => gateway?.handleClientConnect(session),
        onDisconnect: session => {
          log(`browser disconnect ${session.id}`)
        },
      })
      const gw = createWebGateway({
        registry: opts.registry,
        browserSessions: ws.registry,
        notifyPermissionModeToThinClients: opts.notifyPermissionModeToThinClients,
      })
      const rest = createRestRoutes({
        registry: opts.registry,
        broadcastToProject: (projectId, payload) => {
          // M-WEB-PARITY-3：REST mutation 廣播也帶 seq，跟 daemon event 同 ring。
          ws.registry.broadcastWithSeq(
            payload as Record<string, unknown>,
            projectId,
          )
        },
        broadcastAll: payload => {
          ws.registry.broadcastAll(JSON.stringify(payload))
        },
        getDiscordController: opts.getDiscordController,
      })
      const http = await startImpl({
        host: cfg.bindHost,
        port: cfg.port,
        maxPortProbes: cfg.maxPortProbes,
        devProxyUrl: cfg.devProxyUrl,
        websocketHandler: ws.websocketHandler,
        fetchHandler: req => rest.handle(req),
        log,
      })
      httpHandle = http
      wsHandle = ws
      gateway = gw
      startedAt = Date.now()
      lastError = undefined
      gw.broadcastStatusChange({
        running: true,
        port: http.port,
        bindHost: http.host,
      })
      log(`started at ${http.host}:${http.port}`)
      return status()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      lastError = msg
      log(`start failed: ${msg}`)
      // 清理可能 partial create 的 ws
      if (wsHandle) wsHandle.stop()
      if (gateway) gateway.dispose()
      httpHandle = null
      wsHandle = null
      gateway = null
      throw e
    }
  }

  async function stop(): Promise<WebServerStatus> {
    if (!httpHandle) {
      log('stop: not running')
      return status()
    }
    log('stop')
    try {
      gateway?.broadcastStatusChange({ running: false })
    } catch {
      // ignore
    }
    try {
      await httpHandle.stop()
    } catch {
      // ignore
    }
    try {
      wsHandle?.stop()
    } catch {
      // ignore
    }
    try {
      gateway?.dispose()
    } catch {
      // ignore
    }
    httpHandle = null
    wsHandle = null
    gateway = null
    startedAt = null
    return status()
  }

  function status(): WebServerStatus {
    if (!httpHandle) {
      return { running: false, lastError }
    }
    return {
      running: true,
      port: httpHandle.port,
      bindHost: httpHandle.host,
      urls: httpHandle.listAccessibleUrls(),
      startedAt: startedAt ?? undefined,
      inDevProxyMode: httpHandle.inDevProxyMode,
      connectedClients: wsHandle?.registry.size() ?? 0,
    }
  }

  function isRunning(): boolean {
    return httpHandle !== null
  }

  async function dispose(): Promise<void> {
    await stop()
  }

  return { start, stop, status, isRunning, dispose }
}
