/**
 * AgentEmbedded — my-agent 的內嵌 library entry，供桌寵
 * virtual-assistant-desktop（Electron main process）直接 `import` 使用。
 *
 * 目標：
 * - 不破壞既有 Bun CLI / daemon 模式（共存）
 * - 重用 daemon 的 bootstrap / runner / queue 邏輯（不 reinvent）
 * - 提供 EventEmitter 風格的 session API（取代 ws NDJSON）
 * - frame schema 與 daemon WS 完全一致（桌寵 src-bubble adapter 不需修改）
 *
 * 用法範例（桌寵端）：
 * ```ts
 * import { AgentEmbedded } from 'my-agent/embedded'
 *
 * const agent = await AgentEmbedded.create({
 *   cwd: '/workspace',
 *   configDir: app.getPath('userData') + '/agent',
 *   extraTools: [setExpressionTool, playAnimationTool, ...],
 *   onPreloadProgress: p => console.log(`${p.phase}: ${(p.progress * 100).toFixed(0)}%`),
 * })
 * const session = agent.createSession({ source: 'mascot' })
 * session.on('frame', f => webContents.send('agent_session_frame', f))
 * session.send('你好')
 * ```
 *
 * @see src/embedded/sessionAdapter.ts — Frame emit 邏輯
 * @see src/embedded/types.ts — Frame schema
 * @see src/daemon/sessionBootstrap.ts — 重用的 context bootstrap
 * @see src/daemon/queryEngineRunner.ts — 重用的 LLM runner
 */
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'

import {
  bootstrapDaemonContext,
  type DaemonBootstrapOptions,
  type DaemonSessionContext,
} from '../daemon/sessionBootstrap.js'
import { enableConfigs } from '../utils/config.js'
import type { Tool } from '../Tool.js'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import type { ClientSource } from '../server/clientRegistry.js'

import { AgentSession } from './sessionAdapter.js'
import {
  startEmbeddedDaemonServer,
  type EmbeddedDaemonServerHandle,
  type EmbeddedDaemonServerOptions,
} from './daemonServer.js'
import type {
  DiscordSupervisor,
  DiscordTokenSource,
} from '../discord/discordSupervisor.js'
import type { DiscordConfig } from '../discordConfig/schema.js'
import type { WebServerStatus } from '../web/webController.js'
import type { WebConfig } from '../webConfig/schema.js'
import type { PreloadPhase, PreloadProgress } from './types.js'

/** AgentEmbedded.startDiscordBot() 選項。 */
export interface DiscordBotStartOptions {
  /** 覆寫 token；優先序：override > DISCORD_BOT_TOKEN env > discord.jsonc */
  tokenOverride?: string
  /** 跳過 cfg.enabled 檢查；預設 true（桌寵 UI 透過 toggle 啟用，不必編 jsonc） */
  forceEnabled?: boolean
}

/** Discord bot 運行 handle — 對應 supervisor 的 lifecycle。 */
export interface DiscordBotHandle {
  readonly isRunning: boolean
  /** 取得當前載入的 Discord config 快照（含 channelBindings / whitelistUserIds 等） */
  readonly config: DiscordConfig | null
  stop(): Promise<void>
  restart(opts?: DiscordBotStartOptions): Promise<{ ok: boolean; reason?: string }>
  /** 重讀 config snapshot；token/intents 變更需 restart */
  reload(): Promise<{ ok: boolean; reason?: string }>
}

/** AgentEmbedded.startWebUi() 選項。 */
export interface WebUiStartOptions {
  /** 覆寫 web.jsonc 內的 port；不傳則用 jsonc 設定 */
  port?: number
  /** 覆寫 web.jsonc 內的 bindHost；不傳則用 jsonc 設定 */
  bindHost?: string
  /** Dev proxy URL（指向 vite dev server，例 http://127.0.0.1:5173）。
   *  設了優先於靜態 serve，給開發模式 HMR 用 */
  devProxyUrl?: string
}

/** Web UI HTTP server 運行 handle。 */
export interface WebUiHandle {
  readonly isRunning: boolean
  readonly url: string | null
  readonly port: number | null
  readonly bindHost: string | null
  readonly urls: readonly string[]
  /** 連線中的瀏覽器 tab 數 */
  readonly connectedClients: number
  status(): WebServerStatus
  stop(): Promise<WebServerStatus>
  /** Restart：sequential stop + start with new opts */
  restart(opts?: WebUiStartOptions): Promise<WebUiHandle>
}

function makeDiscordBotHandle(supervisor: DiscordSupervisor): DiscordBotHandle {
  return {
    get isRunning() {
      return supervisor.isRunning()
    },
    get config() {
      return supervisor.getConfig()
    },
    stop: () => supervisor.stop(),
    restart: opts => supervisor.restart(opts),
    reload: () => supervisor.reload(),
  }
}

function makeWebUiHandle(
  daemonServer: EmbeddedDaemonServerHandle,
  initialStatus: WebServerStatus,
): WebUiHandle {
  const controller = daemonServer.webController
  const buildUrl = (st: WebServerStatus): string | null => {
    if (!st.running || !st.port || !st.bindHost) return null
    // 0.0.0.0 → localhost 給瀏覽器友善的 URL
    const host = st.bindHost === '0.0.0.0' || st.bindHost === '::'
      ? 'localhost'
      : st.bindHost
    return `http://${host}:${st.port}`
  }
  let currentStatus = initialStatus
  return {
    get isRunning() {
      currentStatus = controller.status()
      return currentStatus.running
    },
    get url() {
      currentStatus = controller.status()
      return buildUrl(currentStatus)
    },
    get port() {
      currentStatus = controller.status()
      return currentStatus.port ?? null
    },
    get bindHost() {
      currentStatus = controller.status()
      return currentStatus.bindHost ?? null
    },
    get urls() {
      currentStatus = controller.status()
      return currentStatus.urls ?? []
    },
    get connectedClients() {
      currentStatus = controller.status()
      return currentStatus.connectedClients ?? 0
    },
    status() {
      currentStatus = controller.status()
      return currentStatus
    },
    stop: () => controller.stop(),
    async restart(opts) {
      await controller.stop()
      const override: Partial<WebConfig> = { enabled: true }
      if (opts?.port !== undefined) override.port = opts.port
      if (opts?.bindHost !== undefined) override.bindHost = opts.bindHost
      if (opts?.devProxyUrl !== undefined) override.devProxyUrl = opts.devProxyUrl
      daemonServer.setWebConfigOverride(override)
      const status = await controller.start()
      return makeWebUiHandle(daemonServer, status)
    },
  }
}

// Re-export public types so 桌寵 type-safe import
export { AgentSession } from './sessionAdapter.js'
export type {
  EmbeddedDaemonServerHandle,
  EmbeddedDaemonServerOptions,
} from './daemonServer.js'
export type { DiscordTokenSource } from '../discord/discordSupervisor.js'
export type { DiscordConfig } from '../discordConfig/schema.js'
export type { WebServerStatus } from '../web/webController.js'
export type { WebConfig } from '../webConfig/schema.js'
export type {
  Frame,
  PreloadPhase,
  PreloadProgress,
} from './types.js'
export type { Tool, Tools } from '../Tool.js'
export type { ClientSource } from '../server/clientRegistry.js'
export type {
  QueueState,
  TurnEndReason,
} from '../daemon/inputQueue.js'
export type { RunnerEvent } from '../daemon/sessionRunner.js'

/**
 * AgentEmbedded.create() 的設定。
 *
 * 配置目錄處理：若提供 `configDir` → 注入到 `process.env.CLAUDE_CONFIG_DIR`
 * **在** `bootstrapDaemonContext` **之前**，這樣 my-agent 內部所有讀 config 的
 * 函式（`getMyAgentConfigHomeDir()` 等）會自動切到對應目錄。
 */
export interface AgentEmbeddedConfig {
  /** 工作目錄；未提供 = `process.cwd()` */
  cwd?: string
  /** 配置根目錄；預設 `~/.virtual-assistant-desktop`（透過 CLAUDE_CONFIG_DIR env var） */
  configDir?: string
  /** 額外 tools（桌寵的 mascot tools — set_expression / play_animation / 等） */
  extraTools?: Tool[]
  /** 預設 permission handler；未提供 = auto-allow（daemon 既有預設行為） */
  canUseTool?: CanUseToolFn
  /** 進度回報（給桌寵 toggle ON 時顯示進度條） */
  onPreloadProgress?: (progress: PreloadProgress) => void
  /** 模型 / budget overrides（每個 session 預設值；可在 createSession 覆寫 — 未實作） */
  userSpecifiedModel?: string
  fallbackModel?: string
  maxTurns?: number
  maxBudgetUsd?: number
  customSystemPrompt?: string
  appendSystemPrompt?: string
  /** 略過 MCP 連線（測試 / 純文字最小化啟動） */
  skipMcp?: boolean
  /** 額外 bootstrap options（permissionMode / allowedTools / addDirs 等） */
  bootstrap?: Omit<DaemonBootstrapOptions, 'cwd' | 'skipMcp'>
}

export interface CreateSessionOptions {
  /** Client source；預設 'mascot' */
  source?: ClientSource
  /** Stable session id；未提供 → 隨機 UUID */
  sessionId?: string
}

/**
 * AgentEmbedded — 整個 agent 子系統的 root handle。
 *
 * Lifecycle：`create()` → 多個 `createSession()` → `shutdown()` 結束釋放所有資源。
 *
 * Tools 動態註冊：`registerTool()` / `unregisterTool()`。已存在的 session 下一個
 * turn 才會看到新 tool（因為 ask() 在 turn start 時 snapshot tools）。
 */
export class AgentEmbedded extends EventEmitter {
  private readonly config: AgentEmbeddedConfig
  private readonly context: DaemonSessionContext
  private extraTools: Tool[]
  private readonly sessions: Set<AgentSession> = new Set()
  private daemonServer: EmbeddedDaemonServerHandle | null = null
  private disposed = false

  private constructor(
    config: AgentEmbeddedConfig,
    context: DaemonSessionContext,
    extraTools: Tool[],
  ) {
    super()
    this.config = config
    this.context = context
    this.extraTools = [...extraTools]
  }

  /**
   * 建立 agent；過程含 LLM / MCP / tools / commands 初始化。
   *
   * 在桌寵 master toggle ON 路徑會觸發此 method。耗時 5-30s（GGUF 載入 +
   * MCP 連線 + tool 掃描）。透過 `onPreloadProgress` callback 回報進度。
   */
  static async create(config: AgentEmbeddedConfig): Promise<AgentEmbedded> {
    const reportProgress = (
      phase: PreloadPhase,
      progress: number,
      message?: string,
    ): void => {
      try {
        config.onPreloadProgress?.({ phase, progress, message })
      } catch {
        // 進度 callback 不應影響 preload；吞例外
      }
    }

    // Phase: configDir injection（必須在 enableConfigs / bootstrap 之前）
    reportProgress('configDir', 0.05)
    if (config.configDir) {
      process.env.CLAUDE_CONFIG_DIR = config.configDir
    }

    // Phase: enable config reading（my-agent 內部 getConfig() gate；
    // CLI 啟動會在 entry 呼叫 enableConfigs()，library 模式需自行觸發。
    // idempotent — 重複呼叫不影響）
    enableConfigs()

    // Phase: bootstrap daemon context（tools / commands / MCP / AppState）
    reportProgress('bootstrapContext', 0.15)
    const cwd = config.cwd ?? process.cwd()
    const context = await bootstrapDaemonContext({
      cwd,
      skipMcp: config.skipMcp ?? false,
      ...config.bootstrap,
    })

    // bootstrap 已完成；MCP 在 bootstrap 內部處理（不需另外 phase）
    reportProgress('mcpConnect', 0.85)

    reportProgress('ready', 1.0)
    return new AgentEmbedded(config, context, config.extraTools ?? [])
  }

  /**
   * 建立新 session。多 session 共享同一 QueryEngine context（tools / mcp / AppState），
   * 但對話歷史與 input queue 各自獨立。
   */
  createSession(opts: CreateSessionOptions = {}): AgentSession {
    if (this.disposed) {
      throw new Error('AgentEmbedded has been shut down')
    }
    const session = new AgentSession({
      context: this.wrapContextWithExtraTools(),
      source: opts.source ?? 'mascot',
      sessionId: opts.sessionId ?? randomUUID(),
      canUseTool: this.config.canUseTool,
      userSpecifiedModel: this.config.userSpecifiedModel,
      fallbackModel: this.config.fallbackModel,
      maxTurns: this.config.maxTurns,
      maxBudgetUsd: this.config.maxBudgetUsd,
      customSystemPrompt: this.config.customSystemPrompt,
      appendSystemPrompt: this.config.appendSystemPrompt,
    })
    this.sessions.add(session)
    return session
  }

  /**
   * 動態註冊 tool。已建立的 session 下一個 turn 才生效（buildTools snapshot）。
   */
  registerTool(tool: Tool): void {
    if (this.disposed) {
      throw new Error('AgentEmbedded has been shut down')
    }
    if (this.extraTools.find(t => t.name === tool.name)) {
      return
    }
    this.extraTools.push(tool)
  }

  unregisterTool(name: string): void {
    this.extraTools = this.extraTools.filter(t => t.name !== name)
  }

  /**
   * 取得已註冊的 extra tools snapshot（debug / 設定 UI 顯示用）。
   */
  getExtraTools(): readonly Tool[] {
    return this.extraTools
  }

  /**
   * 啟動 opt-in daemon WS server，讓外部 client（my-agent CLI / 第二個視窗 /
   * Discord adapter / Web UI）連入共用同個 in-process agent。
   *
   * - 預設不啟動（mascot 對話走 in-process createSession() 不需要 WS）
   * - 同一個 AgentEmbedded 只能啟動一次；重複呼叫回現有 handle
   * - 啟動後，外部 client 連 `ws://host:port/sessions?token=...&source=...&cwd=...`
   *   即可對話；frame schema 與 createSession() 完全一致
   * - 與 mascot AgentSession 共用 LLM singleton（TCQ-shim cache），但對話歷史
   *   獨立（daemon 走自己的 ProjectRegistry + InputQueue）
   *
   * @see src/embedded/daemonServer.ts — 實作細節與限制
   */
  async startDaemonServer(
    opts: Omit<EmbeddedDaemonServerOptions, 'cwd'> & { cwd?: string } = {},
  ): Promise<EmbeddedDaemonServerHandle> {
    if (this.disposed) {
      throw new Error('AgentEmbedded has been shut down')
    }
    if (this.daemonServer) {
      return this.daemonServer
    }
    const cwd = opts.cwd ?? this.config.cwd ?? process.cwd()
    this.daemonServer = await startEmbeddedDaemonServer({
      ...opts,
      cwd,
    })
    return this.daemonServer
  }

  /**
   * 取得目前 daemon server handle（未啟動則回 null）。
   */
  getDaemonServer(): EmbeddedDaemonServerHandle | null {
    return this.daemonServer
  }

  /**
   * 啟動 Discord bot。需先 `startDaemonServer()`。
   *
   * Token 解析優先序：tokenOverride > DISCORD_BOT_TOKEN env > discord.jsonc 內 botToken。
   * 預設 `forceEnabled=true`：跳過 `discord.jsonc` 內 `enabled` 欄位檢查（桌寵
   * UI 直接 toggle 用，使用者不必手動編輯 jsonc）。
   *
   * Channel binding / whitelistUserIds 等其餘設定仍從 `~/.virtual-assistant-desktop/discord.jsonc`
   * 載入（`seedDiscordConfigIfMissing()` 已自動建立預設範本）。
   *
   * @see src/discord/discordSupervisor.ts — 真正啟 Discord gateway 的邏輯
   */
  async startDiscordBot(
    opts: DiscordBotStartOptions = {},
  ): Promise<DiscordBotHandle> {
    if (this.disposed) {
      throw new Error('AgentEmbedded has been shut down')
    }
    if (!this.daemonServer) {
      throw new Error(
        'startDiscordBot requires startDaemonServer() to be called first',
      )
    }
    const supervisor = this.daemonServer.discordSupervisor
    if (supervisor.isRunning()) {
      // 已 running — 回現有 handle（idempotent）
      return makeDiscordBotHandle(supervisor)
    }
    const result = await supervisor.start({
      tokenOverride: opts.tokenOverride,
      forceEnabled: opts.forceEnabled ?? true,
    })
    if (!result.ok) {
      throw new Error(`Discord bot start failed: ${result.reason}`)
    }
    return makeDiscordBotHandle(supervisor)
  }

  /**
   * 取得目前 Discord bot 狀態（未啟動 daemon 或 supervisor 未 start 則 isRunning=false）。
   */
  getDiscordBot(): DiscordBotHandle | null {
    if (!this.daemonServer) return null
    return makeDiscordBotHandle(this.daemonServer.discordSupervisor)
  }

  /**
   * 啟動 Web UI（chat HTTP server）。需先 `startDaemonServer()`。
   *
   * 服務內容：
   *   - GET /api/* — REST routes（health / version / cron CRUD / memory / discord admin
   *     / slash command list/execute 等，整套 my-agent web admin API）
   *   - WS /ws — browser chat client 連線（共用 daemon ProjectRegistry）
   *   - GET /* — 靜態檔（web/dist）+ SPA fallback；devProxyUrl 設了則轉發到 Vite
   *
   * Port / bindHost / devProxyUrl 透過 opts 覆寫 `web.jsonc` 內對應欄位。
   *
   * @see src/web/webController.ts — 真正啟 HTTP + WS server 的 lifecycle
   * @see src/web/nodeHttpServer.ts — Node runtime 的 http.createServer 實作
   */
  async startWebUi(opts: WebUiStartOptions = {}): Promise<WebUiHandle> {
    if (this.disposed) {
      throw new Error('AgentEmbedded has been shut down')
    }
    if (!this.daemonServer) {
      throw new Error(
        'startWebUi requires startDaemonServer() to be called first',
      )
    }
    const daemonServer = this.daemonServer
    // 套用 user override 到 webController 下次 reloadConfig() 取得的 config
    const override: Partial<WebConfig> = {}
    if (opts.port !== undefined) override.port = opts.port
    if (opts.bindHost !== undefined) override.bindHost = opts.bindHost
    if (opts.devProxyUrl !== undefined) override.devProxyUrl = opts.devProxyUrl
    // 強制 enabled = true（桌寵 UI 直接啟動，不需要 jsonc 設 enabled:true）
    override.enabled = true
    daemonServer.setWebConfigOverride(override)

    const status = await daemonServer.webController.start()
    return makeWebUiHandle(daemonServer, status)
  }

  /**
   * 取得目前 Web UI 狀態（未啟動 daemon 或 controller 未 start 則 isRunning=false）。
   */
  getWebUi(): WebUiHandle | null {
    if (!this.daemonServer) return null
    return makeWebUiHandle(this.daemonServer, this.daemonServer.webController.status())
  }

  /**
   * 釋放整個 agent：關閉所有 session、dispose context（含 settings watcher）。
   *
   * 注意：node-llama-tcq model / context 由 llamacpp-embedded-adapter
   * 的 singleton 管理，不在這層 dispose（避免 race condition；adapter 內部
   * 由 LRU 或 unload signal 釋放）。
   */
  async shutdown(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    // 先停 daemon server（避免外部 client 在 shutdown 期間還送 input）
    if (this.daemonServer) {
      try {
        await this.daemonServer.stop()
      } catch {
        // best-effort
      }
      this.daemonServer = null
    }
    for (const session of this.sessions) {
      try {
        await session.close()
      } catch {
        // 個別 session close 失敗不阻擋其他 session 清理
      }
    }
    this.sessions.clear()
    await this.context.dispose()
  }

  /**
   * 包一層 DaemonSessionContext，讓 buildTools() 回傳「基底 tools + extraTools」。
   * mcpClients 用 getter forwarding（保留 daemon AppState 動態 MCP 更新行為）。
   */
  private wrapContextWithExtraTools(): DaemonSessionContext {
    const inner = this.context
    const extraToolsRef = this.extraTools
    return {
      cwd: inner.cwd,
      getAppState: inner.getAppState,
      setAppState: inner.setAppState,
      commands: inner.commands,
      get mcpClients() {
        return inner.mcpClients
      },
      agents: inner.agents,
      getReadFileCache: inner.getReadFileCache,
      setReadFileCache: inner.setReadFileCache,
      buildTools: () => {
        const base = inner.buildTools()
        return [...base, ...extraToolsRef]
      },
      dispose: inner.dispose,
    }
  }
}

/**
 * 釋放 embedded LLM 的 native handle（VRAM）。
 * 包 llamacpp-embedded-adapter 的 `_resetEmbeddedAdapterCache`，
 * 內部呼叫 tcqDisposeSession 釋放 model + context + sequence + mtmdCtx。
 * 桌寵 master toggle OFF 時呼叫，避免 LLM 常駐 VRAM。
 */
export { _resetEmbeddedAdapterCache as releaseEmbeddedLlm } from '../services/api/llamacpp-embedded-adapter.js'
