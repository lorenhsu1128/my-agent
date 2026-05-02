/**
 * M-DAEMON-4b：QueryEngineRunner — SessionRunner 實作。
 *
 * 角色：把 `ask()`（src/QueryEngine.ts）包成 SessionRunner，讓 InputQueue 能
 * 直接驅動真實的 LLM turn：吃 QueuedInput → yield RunnerEvent → done。
 *
 * 資料流：
 *   ```
 *   WS input ─▶ InputQueue ─▶ QueryEngineRunner.run(input, signal)
 *                                │
 *                                ├─ ask({ prompt, tools, canUseTool, ... })
 *                                │     │
 *                                │     └─ yields SDKMessage[]
 *                                │         (assistant / partial / tool_progress / result / ...)
 *                                │
 *                                └─ yield { type: 'output', payload: SDKMessage }
 *                                   最後 yield { type: 'done' }（或 error）
 *   ```
 *
 * 設計：
 * - mutableMessages 由 Runner 本身持有（session-level continuity；跨多個
 *   turn 保留 assistant history）
 * - readFileCache 由 DaemonSessionContext 管（所以 turn N+1 的 Edit/Write
 *   看得到 turn N 剛 Read 過的檔案）
 * - canUseTool：建構時注入；預設 auto-allow（M-DAEMON-4 範圍，Q3=b）；
 *   broker 未來（M-DAEMON-7）會注入一個會路由到 WS client 的實作
 * - permission-request 事件：canUseTool 被呼叫時順便 emit 一個
 *   `permission-request` RunnerEvent（log / broadcast 用），真正 approve
 *   還是走 canUseTool return value
 */
import type { AbortController } from 'node:abort_controller'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import type { Message } from '../types/message.js'
import type { SDKMessage } from '../entrypoints/sdk/coreTypes.generated.js'
import type { PermissionDecision } from '../types/permissions.js'
import { ask } from '../QueryEngine.js'
import type { DaemonSessionContext } from './sessionBootstrap.js'
import type {
  QueuedInput,
  RunnerEvent,
  SessionRunner,
} from './sessionRunner.js'

/**
 * 擴充的 RunnerEvent：在原有 output/error/done 之上多一個
 * `permission-request`（資訊性；不影響 approve 流程，approve 走
 * `CanUseToolFn` return value）。
 */
export type QueryEngineRunnerEvent =
  | RunnerEvent
  | {
      type: 'permission-request'
      toolName: string
      toolUseID: string
      input: unknown
    }

export interface QueryEngineRunnerOptions {
  context: DaemonSessionContext
  /**
   * 自訂 canUseTool。未提供時走預設 auto-allow（M-DAEMON-4 範圍）。
   * Broker（M-DAEMON-7）會注入一個會路由到 WS client 的版本。
   */
  canUseTool?: CanUseToolFn
  userSpecifiedModel?: string
  fallbackModel?: string
  maxTurns?: number
  maxBudgetUsd?: number
  customSystemPrompt?: string
  appendSystemPrompt?: string
  /** 每當 Runner 檢測到 ask() 想要 permission 時 emit 的 side channel。 */
  onPermissionRequest?: (info: {
    toolName: string
    toolUseID: string
    input: unknown
  }) => void
  /**
   * M-WEB-PARITY-5：projectId — 用來解析 prompt 內的 `[Image:<id>]` refToken
   * 為 base64 image content block。未給 → 圖片功能停用（純 text passthrough）。
   */
  projectId?: string
}

/**
 * 預設 canUseTool：直接 allow。給單 client / M-DAEMON-4 用。
 */
const defaultCanUseTool: CanUseToolFn = async (
  _tool,
  input,
  _ctx,
  _msg,
  _id,
) => {
  return {
    behavior: 'allow',
    updatedInput: input,
  } satisfies PermissionDecision
}

export function createQueryEngineRunner(
  opts: QueryEngineRunnerOptions,
): SessionRunner {
  const { context } = opts
  const mutableMessages: Message[] = []

  // Wrap canUseTool 讓我們能在 tool permission 檢查時 emit side-channel event。
  const userCanUseTool = opts.canUseTool ?? defaultCanUseTool
  const canUseToolWrapped: CanUseToolFn = async (
    tool,
    input,
    toolUseContext,
    assistantMessage,
    toolUseID,
    forceDecision,
  ) => {
    try {
      opts.onPermissionRequest?.({
        toolName: tool.name,
        toolUseID,
        input,
      })
    } catch {
      // 絕不阻擋實際 permission flow。
    }
    return userCanUseTool(
      tool,
      input,
      toolUseContext,
      assistantMessage,
      toolUseID,
      forceDecision,
    )
  }

  return {
    async *run(
      input: QueuedInput,
      signal: AbortSignal,
    ): AsyncIterable<RunnerEvent> {
      if (signal.aborted) {
        yield { type: 'error', error: 'aborted-before-start' }
        return
      }

      // Wire AbortController to the incoming signal.
      const ac = new (globalThis as unknown as {
        AbortController: typeof AbortController
      }).AbortController()
      const forward = (): void => {
        try {
          ac.abort()
        } catch {
          // ignore
        }
      }
      if (signal.aborted) forward()
      else signal.addEventListener('abort', forward, { once: true })

      // Prompt：payload 可能是 string 或 ContentBlockParam[]。
      // M-WEB-PARITY-5：string payload 內如有 [Image:<id>] refToken，解析成
      // base64 image content block，prompt 改成 ContentBlockParam[]。
      let prompt: string | unknown[]
      if (typeof input.payload === 'string') {
        if (opts.projectId && /\[Image:[0-9a-f-]{16,}\]/i.test(input.payload)) {
          // 動態 import 避免 image storage 依賴洩漏到沒有 web 的 daemon path
          const { resolveImageRefs } = await import('../web/imageStorage.js')
          const r = resolveImageRefs(input.payload, opts.projectId)
          if (r.images.length > 0) {
            prompt = [
              ...r.images,
              { type: 'text', text: r.text || '請看上面的圖片' },
            ]
          } else {
            prompt = input.payload
          }
        } else {
          prompt = input.payload
        }
      } else {
        prompt = input.payload as unknown[]
      }

      let done = false
      try {
        for await (const sdkMessage of ask({
          commands: context.commands,
          // ContentBlockParam[] 是 SDK 提供型別；此處 prompt 已限制為兩種其中之一
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          prompt: prompt as any,
          promptUuid: input.id as `${string}-${string}-${string}-${string}-${string}`,
          cwd: context.cwd,
          tools: context.buildTools(),
          mcpClients: context.mcpClients,
          canUseTool: canUseToolWrapped,
          mutableMessages,
          getReadFileCache: context.getReadFileCache,
          setReadFileCache: context.setReadFileCache,
          getAppState: context.getAppState,
          setAppState: context.setAppState,
          userSpecifiedModel: opts.userSpecifiedModel,
          fallbackModel: opts.fallbackModel,
          maxTurns: opts.maxTurns,
          maxBudgetUsd: opts.maxBudgetUsd,
          customSystemPrompt: opts.customSystemPrompt,
          appendSystemPrompt: opts.appendSystemPrompt,
          agents: [...context.agents],
          // 把 ac cast 成 ask() 期待的型別（Node AbortController 與 DOM 同形）。
          abortController: ac as unknown as import('../utils/AbortController.js').AbortController,
          includePartialMessages: true,
        })) {
          const msg = sdkMessage as SDKMessage
          if (signal.aborted) {
            yield { type: 'error', error: 'aborted' }
            return
          }
          // 把 SDKMessage 原封不動包成 output.payload；下游（broker）自己解析 +
          // 決定怎麼廣播。這保留最多資訊也最 forward-compat。
          yield { type: 'output', payload: msg }
          if (msg.type === 'result') {
            done = true
            break
          }
          if (msg.type === 'assistant_error') {
            yield {
              type: 'error',
              error:
                typeof msg.message === 'string'
                  ? msg.message
                  : 'assistant_error',
            }
            return
          }
        }
      } catch (e) {
        if (signal.aborted) {
          yield { type: 'error', error: 'aborted' }
        } else {
          yield { type: 'error', error: String(e) }
        }
        return
      } finally {
        signal.removeEventListener('abort', forward)
      }

      if (done) {
        yield { type: 'done' }
      } else {
        yield {
          type: 'error',
          error: 'ask() ended without a result message',
        }
      }
    },
  }
}
