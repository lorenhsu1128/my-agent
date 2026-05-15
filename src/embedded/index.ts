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
import type { PreloadPhase, PreloadProgress } from './types.js'

// Re-export public types so 桌寵 type-safe import
export { AgentSession } from './sessionAdapter.js'
export type {
  EmbeddedDaemonServerHandle,
  EmbeddedDaemonServerOptions,
} from './daemonServer.js'
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
