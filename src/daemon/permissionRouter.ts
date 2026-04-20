/**
 * M-DAEMON-7a：Permission router — tool permission prompt 的 daemon→client 路由。
 *
 * QueryEngineRunner 的 `canUseTool` 交給 router 處理：
 *   1. 組 permissionRequest frame（含 toolName、input、riskLevel、description、
 *      affectedPaths 等 metadata — Q1=b）→ server.send 給 **source client**
 *   2. 廣播 `permissionPending` 給其他 attached clients（Q2=b 讓他們知道
 *      「正在等 XXX 同意」）
 *   3. 等 source client 送 `permissionResponse{toolUseID, decision,
 *      updatedInput?}` 回來 → resolve PermissionDecision
 *   4. Timeout（預設 5min）→ auto-allow（Q3=c 沿用預設行為；5min 對人類有回應
 *      時間但不會無限卡 turn）
 *   5. source client 連線中斷 or 無法送達 → fallbackHandler（M-DISCORD 會接；
 *      預設再 auto-allow）
 *
 * Frame protocol（與 sessionBroker 的 frame type 共存）：
 *
 * 出站 (daemon → source client):
 *   {
 *     type: 'permissionRequest',
 *     toolUseID: string,
 *     inputId: string,         // 當前 turn 的 QueuedInput.id（reconciler 用）
 *     toolName: string,
 *     toolInput: unknown,      // tool 的 raw input
 *     riskLevel: 'read' | 'write' | 'destructive',
 *     description?: string,    // tool.userFacingName(input)
 *     affectedPaths?: string[] // 目前只支援有 file_path/path/command 欄位的
 *   }
 *
 * 出站 (daemon → 其他 attached clients，Q2=b):
 *   {
 *     type: 'permissionPending',
 *     toolUseID: string,
 *     inputId: string,
 *     toolName: string,
 *     sourceClientId: string,
 *     riskLevel: 'read' | 'write' | 'destructive',
 *     description?: string,
 *   }
 *
 * 入站 (client → daemon):
 *   {
 *     type: 'permissionResponse',
 *     toolUseID: string,
 *     decision: 'allow' | 'deny',
 *     updatedInput?: unknown,
 *     message?: string,        // deny 時的理由
 *   }
 */
import { randomUUID } from 'crypto'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import type { PermissionDecision } from '../types/permissions.js'
import type { DirectConnectServerHandle } from '../server/directConnectServer.js'
import type { ClientInfo } from '../server/clientRegistry.js'
import { hasPermissionsToUseTool } from '../utils/permissions/permissions.js'

export type RiskLevel = 'read' | 'write' | 'destructive'

export interface PermissionRequestMetadata {
  toolName: string
  toolInput: unknown
  riskLevel: RiskLevel
  description?: string
  affectedPaths?: string[]
}

export interface PermissionResponseFrame {
  type: 'permissionResponse'
  toolUseID: string
  decision: 'allow' | 'deny'
  updatedInput?: unknown
  message?: string
}

export interface PermissionFallbackHandler {
  /**
   * 當 source client 不存在 / 失聯 / timeout 時呼叫。回傳 PermissionDecision。
   * M-DISCORD 會實作這個 interface 把 prompt 送到 Discord DM。
   */
  requestPermission(
    meta: PermissionRequestMetadata & { toolUseID: string; inputId: string },
  ): Promise<PermissionDecision>
}

export interface PermissionRouterOptions {
  server: DirectConnectServerHandle
  /** Turn source client 解析函式：router 本身不追 turn state，由 broker inject。 */
  resolveSourceClientId: () => string | null
  /** Turn ID 解析函式：router 需要把 inputId 塞進 frame。 */
  resolveCurrentInputId: () => string | null
  /** 等 response 的 timeout；預設 5 分鐘，到點 auto-allow。 */
  timeoutMs?: number
  /** M-DISCORD 預留：source client 失聯時的後備 prompt 通道。 */
  fallbackHandler?: PermissionFallbackHandler
  /** 測試 inject timer（讓 timeout 測試可控）。 */
  scheduler?: {
    setTimeout: (fn: () => void, ms: number) => unknown
    clearTimeout: (handle: unknown) => void
  }
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

interface PendingRequest {
  toolUseID: string
  resolve: (d: PermissionDecision) => void
  timer: unknown
}

export interface PermissionRouter {
  /** CanUseToolFn — 裝到 QueryEngineRunner 的 canUseTool。 */
  readonly canUseTool: CanUseToolFn
  /** 從 broker 把收到的 permissionResponse frame 餵進來。 */
  handleResponse(clientId: string, frame: unknown): boolean
  /** 等待中 request 數量（測試用）。 */
  pendingCount(): number
  /** M-DISCORD-4：列出所有 pending toolUseID（for /allow /deny 等 UX）。 */
  listPendingIds(): string[]
  /** M-DISCORD-4：訂閱 pending lifecycle（Discord slashCommands 追蹤用）。 */
  onPending(
    handler: (info: { toolUseID: string; meta: PermissionRequestMetadata }) => void,
  ): () => void
  onResolved(handler: (info: { toolUseID: string }) => void): () => void
  /** 取消所有等待中 request（daemon shutdown / mode switch）。 */
  cancelAll(reason?: string): void
  /** 設 / 換 Discord fallback handler。 */
  setFallbackHandler(h: PermissionFallbackHandler | undefined): void
}

function isPermissionResponse(v: unknown): v is PermissionResponseFrame {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return (
    r.type === 'permissionResponse' &&
    typeof r.toolUseID === 'string' &&
    (r.decision === 'allow' || r.decision === 'deny')
  )
}

function inferRiskLevel(tool: {
  isReadOnly: (input: unknown) => boolean
  isDestructive?: (input: unknown) => boolean
}, input: unknown): RiskLevel {
  try {
    if (tool.isDestructive?.(input)) return 'destructive'
  } catch {
    // fallthrough
  }
  try {
    if (tool.isReadOnly(input)) return 'read'
  } catch {
    // fallthrough
  }
  return 'write'
}

function extractAffectedPaths(input: unknown): string[] | undefined {
  if (!input || typeof input !== 'object') return undefined
  const rec = input as Record<string, unknown>
  const paths: string[] = []
  for (const key of ['file_path', 'path', 'notebook_path', 'pattern']) {
    const v = rec[key]
    if (typeof v === 'string' && v) paths.push(v)
  }
  // Bash command — rough: first word of command
  const cmd = rec['command']
  if (typeof cmd === 'string' && cmd) {
    const first = cmd.split(/\s+/)[0]
    if (first) paths.push(`cmd:${first}`)
  }
  return paths.length > 0 ? paths : undefined
}

export function createPermissionRouter(
  opts: PermissionRouterOptions,
): PermissionRouter {
  const server = opts.server
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const scheduler = opts.scheduler ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: h => clearTimeout(h as Parameters<typeof clearTimeout>[0]),
  }
  const pending = new Map<string, PendingRequest>()
  let fallback: PermissionFallbackHandler | undefined = opts.fallbackHandler
  const pendingListeners = new Set<
    (info: { toolUseID: string; meta: PermissionRequestMetadata }) => void
  >()
  const resolvedListeners = new Set<(info: { toolUseID: string }) => void>()
  const firePending = (
    toolUseID: string,
    meta: PermissionRequestMetadata,
  ): void => {
    for (const l of pendingListeners) {
      try {
        l({ toolUseID, meta })
      } catch {
        // swallow listener errors
      }
    }
  }
  const fireResolved = (toolUseID: string): void => {
    for (const l of resolvedListeners) {
      try {
        l({ toolUseID })
      } catch {
        // swallow
      }
    }
  }

  const autoAllow = (input: unknown): PermissionDecision => ({
    behavior: 'allow',
    updatedInput: input as Record<string, unknown>,
  })

  const canUseTool: CanUseToolFn = async (
    tool,
    input,
    toolUseContext,
    assistantMessage,
    toolUseID,
    forceDecision,
  ) => {
    // M-DAEMON-PERMS-C：先用 daemon 的（已同步 settings + mode）context 跑
    // hasPermissionsToUseTool 做 pre-judge。allow / deny 直接回，不浪費 WS
    // 往返；只有 'ask'（需要 UI 決定）才走 permissionRequest 路由到 source
    // client。若 forceDecision 已給（譬如 classifier 自動通過）也直接用。
    if (forceDecision !== undefined) {
      return forceDecision
    }
    try {
      const preJudge = await hasPermissionsToUseTool(
        tool,
        input,
        toolUseContext,
        assistantMessage,
        toolUseID,
      )
      if (preJudge.behavior === 'allow' || preJudge.behavior === 'deny') {
        return preJudge
      }
      // ask / passthrough → 繼續下面的 WS prompt 流程。
    } catch {
      // 評估失敗不擋 tool，照走 WS prompt 路徑。
    }

    const sourceId = opts.resolveSourceClientId()
    const inputId = opts.resolveCurrentInputId() ?? ''
    const meta: PermissionRequestMetadata = {
      toolName: tool.name,
      toolInput: input,
      riskLevel: inferRiskLevel(tool, input),
      description: tool.userFacingName(input) ?? tool.name,
      affectedPaths: extractAffectedPaths(input),
    }

    // 沒 source client → fallback 或 auto-allow。
    if (!sourceId) {
      if (fallback) {
        try {
          return await fallback.requestPermission({
            ...meta,
            toolUseID,
            inputId,
          })
        } catch {
          return autoAllow(input)
        }
      }
      return autoAllow(input)
    }

    // 點對點送 source client。失敗（client 已中斷）→ fallback。
    const requestFrame = {
      type: 'permissionRequest',
      toolUseID,
      inputId,
      toolName: meta.toolName,
      toolInput: meta.toolInput,
      riskLevel: meta.riskLevel,
      description: meta.description,
      affectedPaths: meta.affectedPaths,
    }
    const delivered = server.send(sourceId, requestFrame)
    if (!delivered) {
      if (fallback) {
        try {
          return await fallback.requestPermission({
            ...meta,
            toolUseID,
            inputId,
          })
        } catch {
          return autoAllow(input)
        }
      }
      return autoAllow(input)
    }

    // 廣播 permissionPending 給其他 attached clients（Q2=b）
    server.broadcast(
      {
        type: 'permissionPending',
        toolUseID,
        inputId,
        toolName: meta.toolName,
        sourceClientId: sourceId,
        riskLevel: meta.riskLevel,
        description: meta.description,
      },
      (c: ClientInfo) => c.id !== sourceId,
    )

    // 等 response — timeout 則 auto-allow。
    firePending(toolUseID, meta)
    return new Promise<PermissionDecision>(resolve => {
      const timer = scheduler.setTimeout(() => {
        pending.delete(toolUseID)
        fireResolved(toolUseID)
        resolve(autoAllow(input))
      }, timeoutMs)
      pending.set(toolUseID, {
        toolUseID,
        resolve,
        timer,
      })
    })
  }

  return {
    canUseTool,
    handleResponse(_clientId, frame) {
      if (!isPermissionResponse(frame)) return false
      const entry = pending.get(frame.toolUseID)
      if (!entry) return false
      pending.delete(frame.toolUseID)
      scheduler.clearTimeout(entry.timer)
      fireResolved(frame.toolUseID)
      if (frame.decision === 'allow') {
        entry.resolve({
          behavior: 'allow',
          updatedInput: (frame.updatedInput ?? {}) as Record<string, unknown>,
        })
      } else {
        entry.resolve({
          behavior: 'deny',
          message: frame.message ?? 'Denied by client',
          decisionReason: {
            type: 'other',
            reason: `permission denied via WS client (toolUseID=${frame.toolUseID})`,
          },
        })
      }
      return true
    },
    pendingCount() {
      return pending.size
    },
    cancelAll(reason) {
      for (const [id, entry] of pending.entries()) {
        scheduler.clearTimeout(entry.timer)
        entry.resolve({
          behavior: 'deny',
          message: reason ?? 'cancelled',
          decisionReason: {
            type: 'other',
            reason: reason ?? 'router cancelled',
          },
        })
        pending.delete(id)
        fireResolved(id)
      }
    },
    listPendingIds() {
      return Array.from(pending.keys())
    },
    onPending(handler) {
      pendingListeners.add(handler)
      return () => pendingListeners.delete(handler)
    },
    onResolved(handler) {
      resolvedListeners.add(handler)
      return () => resolvedListeners.delete(handler)
    },
    setFallbackHandler(h) {
      fallback = h
    },
  }
  // randomUUID 保留給未來 trace id 用。
  void randomUUID
}
