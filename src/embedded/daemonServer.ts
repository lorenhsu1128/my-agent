/**
 * Embedded Daemon WS server — opt-in 讓外部 client（my-agent CLI / 第二個視窗 /
 * 整合工具）連入 AgentEmbedded 進程共用 LLM + tools + MCP。
 *
 * 與 daemonCli.ts `runDaemonStart()` 的關係：
 * - daemonCli 是 CLI entry，含完整 stdout/stderr 輸出 + 10+ RPC handlers
 *   （cron mutation / memory mutation / discord admin / web control / slash 等）
 * - 這裡是「最小化」版本：只給外部 client 對話能力（input/output + permission
 *   response routing + queryDaemonStatus），其餘 RPC 暫不支援
 * - 進階 RPC（Discord / Web admin / cron CRUD UI）留待 Phase 2/3 expand
 *
 * 重用：
 * - startDaemon() — WS server + pid.json + token + heartbeat + signal handlers
 * - createProjectRegistry + createDefaultProjectRuntimeFactory — bootstrap 完整
 *   ProjectRuntime（含獨立 context / broker / cron / permissionRouter）
 * - handleClientMessage / sendHelloFrame — broker 既有的 client message router
 *
 * 與 mascot AgentSession 的關係：
 * - 完全獨立。mascot session 走 EventEmitter（in-process），daemon WS 走真實
 *   WS 連線。兩者各自有自己的 ProjectRuntime + InputQueue + 對話歷史
 * - 共享 LLM singleton（llamacpp-embedded-adapter 的 TCQ-shim cache）→ 模型只
 *   載一次。MCP clients / AppState 不共享（為簡化 lifecycle；opt-in 成本）
 *
 * @see src/daemon/daemonCli.ts:121-711 `runDaemonStart` — daemon CLI 完整版
 */
import { startDaemon, type DaemonHandle } from '../daemon/daemonMain.js'
import {
  handleClientMessage,
  sendHelloFrame,
} from '../daemon/sessionBroker.js'
import { createDaemonTurnMutex } from '../daemon/daemonTurnMutex.js'
import {
  createProjectRegistry,
  type ProjectRegistry,
  type ProjectRuntime,
} from '../daemon/projectRegistry.js'
import { createDefaultProjectRuntimeFactory } from '../daemon/projectRuntimeFactory.js'
import {
  createDiscordSupervisor,
  type DiscordSupervisor,
} from '../discord/discordSupervisor.js'
import { isVisionEnabled } from '../llamacppConfig/loader.js'
import type { ClientInfo } from '../server/clientRegistry.js'
import type { PermissionMode } from '../types/permissions.js'

export interface EmbeddedDaemonServerOptions {
  /** 工作目錄（auto-load 為 default project） */
  cwd: string
  /** WS port；0 = OS 指派 */
  port?: number
  /** WS host；預設 127.0.0.1（loopback only） */
  host?: string
  /** Daemon pid.json / token / log 的存放根目錄；
   *  預設 `~/.virtual-assistant-desktop`（CLAUDE_CONFIG_DIR 已生效）。
   *  若想與外部 my-agent CLI 區隔，可指定不同子目錄避免 pid 衝突 */
  baseDir?: string
  /** my-agent 版本字串（寫入 pid.json，方便 status 查詢） */
  agentVersion?: string
  /** 是否註冊 process signal handler（SIGINT/SIGTERM/SIGBREAK）。
   *  Electron app 通常自己管 signal，預設 false 不註冊；CLI 模式才需要 */
  registerSignalHandlers?: boolean
}

export interface EmbeddedDaemonServerHandle {
  /** WS endpoint — `ws://host:port/sessions?token=...&source=...&cwd=...` */
  readonly url: string
  readonly host: string
  readonly port: number
  readonly token: string
  /** Default project 的 cwd（auto-load 的 project root） */
  readonly defaultProjectCwd: string
  /** 釋放所有資源：unload 所有 project runtime → stop WS server → 刪 pid.json */
  stop(): Promise<void>
  /** Underlying daemon handle（進階使用） */
  readonly daemonHandle: DaemonHandle
  /** Project registry（進階使用，Phase 2/3 給 Discord/Web wiring 用） */
  readonly registry: ProjectRegistry
  /** Default project runtime */
  readonly defaultRuntime: ProjectRuntime
  /** Discord supervisor（不自動 start；Phase 2 給 AgentEmbedded.startDiscordBot 用） */
  readonly discordSupervisor: DiscordSupervisor
}

/**
 * 啟動 embedded daemon WS server。
 *
 * 步驟：
 * 1. `startDaemon()` 啟 WS server + 寫 pid.json + 註冊 heartbeat
 * 2. 建 ProjectRegistry + factory，auto-load opts.cwd 為 default project
 * 3. 設定 onMessage/onConnect/onDisconnect closure（minimal 路由）
 *
 * onMessage 路由：
 * - permissionResponse → runtime.permissionRouter.handleResponse
 * - queryDaemonStatus → 回 daemonStatus frame
 * - 其他（input frame 等）→ handleClientMessage（broker submit）
 * - 暫不支援：cron mutation / memory mutation / discord admin / web control /
 *   llamacpp config mutation / slash command execute / cronCreateWizard
 */
export async function startEmbeddedDaemonServer(
  opts: EmbeddedDaemonServerOptions,
): Promise<EmbeddedDaemonServerHandle> {
  // Two-phase wiring：broker 需要 server handle 才能廣播，但 server 啟動時就要
  // 綁 onMessage 才能接第一條 frame。用可變 ref 讓 startDaemon 的 onMessage
  // 只是 forwarder；factory + registry 建好再覆蓋 ref。
  let onMessage: (c: ClientInfo, m: unknown) => void = () => {}
  let onConnect: (c: ClientInfo) => void = () => {}
  let onDisconnect: (c: ClientInfo) => void = () => {}

  const handle = await startDaemon({
    baseDir: opts.baseDir,
    agentVersion: opts.agentVersion ?? 'embedded',
    port: opts.port,
    host: opts.host,
    registerSignalHandlers: opts.registerSignalHandlers ?? false,
    onClientMessage: (c, m) => onMessage(c, m),
    onClientConnect: c => onConnect(c),
    onClientDisconnect: c => onDisconnect(c),
  })
  if (!handle.server) {
    throw new Error('startDaemon returned no server handle')
  }

  const cwd = opts.cwd
  const baseCwd = process.cwd()
  const mutex = createDaemonTurnMutex()
  const factory = createDefaultProjectRuntimeFactory({
    server: handle.server,
    mutex,
    baseCwd,
  })
  const registry = createProjectRegistry({
    factory,
    onLoad: id =>
      void handle.logger.info('project loaded', { projectId: id }),
    onUnload: (id, reason) =>
      void handle.logger.info('project unloaded', {
        projectId: id,
        reason,
      }),
  })

  // Auto-load the starting cwd as the default project.
  const defaultRuntime = await registry.loadProject(cwd)

  // 建 Discord supervisor（不自動 start；AgentEmbedded.startDiscordBot() 才會 start）
  const discordSupervisor = createDiscordSupervisor({
    registry,
    visionEnabled: () => isVisionEnabled(),
    log: msg => void handle.logger.info(`[discord] ${msg}`),
    broadcasts: {
      broadcastPermissionMode: (projectId, mode) => {
        handle.server!.broadcast(
          { type: 'permissionModeChanged', projectId, mode },
          c => c.projectId === projectId,
        )
      },
      broadcastDiscordInbound: (projectId, payload) => {
        handle.server!.broadcast(
          { type: 'discordInboundMessage', projectId, ...payload },
          c => c.projectId === projectId,
        )
      },
      broadcastDiscordTurn: (projectId, payload) => {
        handle.server!.broadcast(
          { type: 'discordTurnEvent', projectId, ...payload },
          c => c.projectId === projectId,
        )
      },
    },
  })

  // M-DISCORD-2：client 連線時若帶 cwd → lazy-load 對應 runtime；失敗 → reject
  const rejectedClients = new Set<string>()
  const pendingClients = new Map<string, string>()

  onMessage = (c, m): void => {
    if (rejectedClients.has(c.id)) return
    if (pendingClients.has(c.id)) {
      handle.server!.send(c.id, {
        type: 'projectLoading',
        cwd: pendingClients.get(c.id),
      })
      return
    }

    // /daemon attach|detach status 查詢（不屬於任何 project runtime）
    if (
      m &&
      typeof m === 'object' &&
      (m as { type?: string }).type === 'queryDaemonStatus'
    ) {
      const req = m as { type: string; requestId?: unknown }
      const replCount = handle.server!.registry
        .list()
        .filter(x => x.source === 'repl').length
      handle.server!.send(c.id, {
        type: 'daemonStatus',
        requestId: String(req.requestId ?? ''),
        replCount,
        discordEnabled: discordSupervisor.isRunning(),
      })
      return
    }

    // Route to the client's project runtime. projectId 由 onConnect resolve；
    // 沒 projectId 且沒 cwd 時 fallback 到 default runtime。
    const runtime = c.projectId
      ? (registry.getProject(c.projectId) ?? defaultRuntime)
      : defaultRuntime

    // permissionResponse 命中就 route 給該 runtime 的 router
    if (runtime.permissionRouter.handleResponse(c.id, m)) return

    // permissionContextSync（M-DAEMON-PERMS-B）同步 mode → 當前 runtime 的
    // toolPermissionContext.mode
    if (
      m &&
      typeof m === 'object' &&
      (m as { type?: string }).type === 'permissionContextSync'
    ) {
      const sync = m as { type: string; mode?: string }
      if (typeof sync.mode === 'string') {
        const mode = sync.mode as PermissionMode
        runtime.context.setAppState(prev =>
          prev.toolPermissionContext.mode === mode
            ? prev
            : {
                ...prev,
                toolPermissionContext: {
                  ...prev.toolPermissionContext,
                  mode,
                },
              },
        )
        void handle.logger.info('permission mode synced from client', {
          clientId: c.id,
          projectId: runtime.projectId,
          mode,
        })
      }
      return
    }

    runtime.touch()
    handleClientMessage(runtime.broker, c, m, (errMsg, raw) => {
      void handle.logger.warn('broker protocol error', {
        err: errMsg,
        raw,
        projectId: runtime.projectId,
      })
    })
  }

  onConnect = (c): void => {
    const attachRuntime = (runtime: ProjectRuntime): void => {
      handle.server!.registry.setClientProjectId(c.id, runtime.projectId)
      if (c.source === 'repl') runtime.attachRepl(c.id)
      runtime.touch()
      sendHelloFrame(runtime.broker, handle.server!, c.id)
    }
    if (c.cwd) {
      const found = registry.getProjectByCwd(c.cwd)
      if (found) {
        attachRuntime(found)
        return
      }
      pendingClients.set(c.id, c.cwd)
      void handle.logger.info('auto-loading project for client', {
        clientId: c.id,
        cwd: c.cwd,
      })
      registry.loadProject(c.cwd).then(
        loaded => {
          pendingClients.delete(c.id)
          attachRuntime(loaded)
        },
        err => {
          pendingClients.delete(c.id)
          rejectedClients.add(c.id)
          handle.server!.send(c.id, {
            type: 'attachRejected',
            reason: 'projectLoadFailed',
            cwd: c.cwd,
            hint: `failed to load project at ${c.cwd}: ${err instanceof Error ? err.message : String(err)}`,
          })
          void handle.logger.warn('auto-load project failed', {
            clientId: c.id,
            cwd: c.cwd,
            err: err instanceof Error ? err.message : String(err),
          })
        },
      )
    } else {
      attachRuntime(defaultRuntime)
    }
  }

  onDisconnect = (c): void => {
    rejectedClients.delete(c.id)
    pendingClients.delete(c.id)
    if (c.projectId && c.source === 'repl') {
      const runtime = registry.getProject(c.projectId)
      runtime?.detachRepl(c.id)
    }
  }

  const url = `ws://${handle.server.host}:${handle.server.port}/sessions`

  const stop = async (): Promise<void> => {
    try {
      await discordSupervisor.stop()
    } catch {
      // best-effort
    }
    try {
      await registry.dispose()
    } catch {
      // best-effort
    }
    await handle.stop('explicit')
  }

  return {
    url,
    host: handle.server.host,
    port: handle.server.port,
    token: handle.token,
    defaultProjectCwd: defaultRuntime.cwd,
    stop,
    daemonHandle: handle,
    registry,
    defaultRuntime,
    discordSupervisor,
  }
}
