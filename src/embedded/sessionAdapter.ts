/**
 * Embedded SessionAdapter — 把 daemon 的 InputQueue + QueryEngineRunner 包成
 * Node EventEmitter，emit 與 daemon WS NDJSON 完全相同 schema 的 `Frame`。
 *
 * 設計：在 daemon 外（embedded 模式）重用既有 runner / queue 邏輯，但替換
 * server.broadcast(...) 為 EventEmitter emit(...)。桌寵 main process 訂閱
 * `'frame'` 事件後直接 webContents.send('agent_session_frame', frame) 廣播
 * 給 renderer。
 *
 * @see src/daemon/sessionBroker.ts — daemon WS 模式的對應實作（共享 frame schema）
 */
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'

import {
  createInputQueue,
  defaultIntentForSource,
  type InputQueue,
  type QueueState,
  type RunnerEventWrapper,
  type TurnEndEvent,
  type TurnStartEvent,
} from '../daemon/inputQueue.js'
import {
  createQueryEngineRunner,
  type QueryEngineRunnerOptions,
} from '../daemon/queryEngineRunner.js'
import type { ClientSource } from '../server/clientRegistry.js'
import type { QueuedInputIntent } from '../daemon/sessionRunner.js'
import type { Frame } from './types.js'

export interface AgentSessionOptions {
  /** 已 bootstrap 的 DaemonSessionContext（可由 AgentEmbedded 包裝注入 extraTools） */
  context: QueryEngineRunnerOptions['context']
  /** 預設 'mascot'；可改 'repl' / 'web' / 'discord' 等 */
  source?: ClientSource
  /** Stable session id（hello frame 用） */
  sessionId?: string
  /** Permission handler；未提供 → defaultCanUseTool(auto-allow) */
  canUseTool?: QueryEngineRunnerOptions['canUseTool']
  /** Permission 副通道（log / broadcast 用，不影響真實 approve flow） */
  onPermissionRequest?: QueryEngineRunnerOptions['onPermissionRequest']
  userSpecifiedModel?: string
  fallbackModel?: string
  maxTurns?: number
  maxBudgetUsd?: number
  customSystemPrompt?: string
  appendSystemPrompt?: string
  /** Image storage 用的 projectId（refToken `[Image:<id>]` 解析） */
  projectId?: string
  /** Queue interrupt grace ms */
  interruptGraceMs?: number
}

/**
 * AgentSession — 對應 daemon 的「一個 client connection」。
 *
 * 事件：
 * - `frame`：與 daemon WS NDJSON 完全一致的 frame（hello / state / turnStart / runnerEvent / turnEnd）
 * - `error`：內部錯誤（不會打斷 session）
 */
export class AgentSession extends EventEmitter {
  private readonly queue: InputQueue
  private readonly clientId: string
  private readonly source: ClientSource
  private readonly sessionId: string
  private disposed = false

  constructor(opts: AgentSessionOptions) {
    super()
    this.clientId = `embedded-${randomUUID().slice(0, 8)}`
    this.source = opts.source ?? 'mascot'
    this.sessionId = opts.sessionId ?? randomUUID()

    const runner = createQueryEngineRunner({
      context: opts.context,
      canUseTool: opts.canUseTool,
      onPermissionRequest: opts.onPermissionRequest,
      userSpecifiedModel: opts.userSpecifiedModel,
      fallbackModel: opts.fallbackModel,
      maxTurns: opts.maxTurns,
      maxBudgetUsd: opts.maxBudgetUsd,
      customSystemPrompt: opts.customSystemPrompt,
      appendSystemPrompt: opts.appendSystemPrompt,
      projectId: opts.projectId,
    })
    this.queue = createInputQueue({
      runner,
      interruptGraceMs: opts.interruptGraceMs,
    })

    // 訂閱 queue 事件 → emit frame（schema 與 daemon WS NDJSON 一致）
    this.queue.on('state', (state: QueueState) => {
      this.emitFrame({ type: 'state', state })
    })
    this.queue.on('turnStart', (e: TurnStartEvent) => {
      this.emitFrame({
        type: 'turnStart',
        inputId: e.input.id,
        clientId: e.input.clientId,
        source: e.input.source,
        startedAt: e.startedAt,
      })
    })
    this.queue.on('turnEnd', (e: TurnEndEvent) => {
      this.emitFrame({
        type: 'turnEnd',
        inputId: e.input.id,
        reason: e.reason,
        error: e.error,
        endedAt: e.endedAt,
      })
    })
    this.queue.on('runnerEvent', (w: RunnerEventWrapper) => {
      this.emitFrame({
        type: 'runnerEvent',
        inputId: w.input.id,
        event: w.event,
      })
    })

    // queueMicrotask：確保呼叫端來得及 attach 'frame' listener
    queueMicrotask(() => {
      if (this.disposed) return
      this.emitFrame({
        type: 'hello',
        sessionId: this.sessionId,
        state: this.queue.state,
        currentInputId: this.queue.currentInput?.id,
      })
    })
  }

  /**
   * 送一筆 input（user message）進 queue。回傳 inputId（同步分配）。
   * 真正執行（RUNNING / queued）非同步 — 觀察 'frame' 事件。
   */
  send(
    payload: string | unknown[],
    opts?: { intent?: QueuedInputIntent },
  ): string {
    if (this.disposed) {
      throw new Error('AgentSession disposed')
    }
    return this.queue.submit(payload, {
      clientId: this.clientId,
      source: this.source,
      intent: opts?.intent ?? defaultIntentForSource(this.source),
    })
  }

  /**
   * 取消當前 turn — 觸發完整 abort chain：
   *   InputQueue.abort() → currentController.abort() → runner ac.abort()
   *   → ask({abortController}) → LLM fetch init.signal → embedded adapter
   *   runCtx.abort → tcqRunCore* 中止生成 → sink onDone graceful close
   *   → translator finally → 反向 abort 釋放 GPU。
   *
   * Fire-and-forget；caller 若需要等 turn 真正結束，訂閱 'frame' 取 turnEnd。
   * state === IDLE 時為 no-op。
   */
  abort(): void {
    if (this.disposed) return
    void this.queue.abort()
  }

  async close(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.queue.dispose()
    // close 後解掉所有 listener，避免 InputQueue 內部 timer / pending promise
    // resolve 時 emitFrame 又觸發到（reviewer S2）
    this.removeAllListeners()
  }

  get state(): QueueState {
    return this.queue.state
  }

  get id(): string {
    return this.sessionId
  }

  /**
   * Emit frame 前檢查 disposed — close() 後 InputQueue 的 dispose flow 仍可能
   * resolve 一個 pending `await runner.run()` 並 emit turnEnd，這時上層
   * （桌寵 AgentRuntime）已 detach listener，但若 disposed 沒擋，broadcast
   * 仍會送出 stale frame（reviewer S2）。
   */
  private emitFrame(frame: Frame): void {
    if (this.disposed) return
    this.emit('frame', frame)
  }
}
