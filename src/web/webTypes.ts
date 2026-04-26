/**
 * M-WEB-6：Browser ↔ web bridge 對外協議的型別定義（K2）。
 *
 * 設計原則：
 *   - 完全與 daemon thin-client frame schema 解耦；browser 只認這份
 *   - 命名採點分隔（`turn.start` 而非 `turnStart`），方便分組過濾
 *   - 所有 frame 都帶 `type` 字串；mutation 有 requestId，server response
 *     回對應 requestId（同 daemon RPC 約定）
 */

/** WS server → browser 事件。 */
export type ServerEvent =
  | HelloEvent
  | KeepaliveEvent
  | SubscribedEvent
  | ErrorEvent
  | ProjectAddedEvent
  | ProjectRemovedEvent
  | ProjectUpdatedEvent
  | TurnStartEvent
  | TurnEventEvent
  | TurnEndEvent
  | StateEvent
  | PermissionPendingEvent
  | PermissionResolvedEvent
  | PermissionModeChangedEvent
  | CronTasksChangedEvent
  | CronFiredEvent
  | MemoryItemsChangedEvent
  | LlamacppConfigChangedEvent
  | WebStatusChangedEvent
  | PongEvent
  | MutationResultEvent

export interface HelloEvent {
  type: 'hello'
  sessionId: string
  serverTime: number
  /** Daemon version 等元資訊。 */
  meta?: { daemonVersion?: string; agentVersion?: string }
}
export interface KeepaliveEvent {
  type: 'keepalive'
}
export interface SubscribedEvent {
  type: 'subscribed'
  projectIds: string[]
}
export interface ErrorEvent {
  type: 'error'
  code: string
  message: string
  requestId?: string
}
export interface PongEvent {
  type: 'pong'
  t: number
}

export interface WebProjectInfo {
  projectId: string
  cwd: string
  /** 顯示用名稱（cwd basename 或自訂）。 */
  name: string
  hasAttachedRepl: boolean
  attachedReplCount: number
  lastActivityAt: number
}
export interface ProjectAddedEvent {
  type: 'project.added'
  project: WebProjectInfo
}
export interface ProjectRemovedEvent {
  type: 'project.removed'
  projectId: string
  reason: 'idle' | 'manual' | 'shutdown'
}
export interface ProjectUpdatedEvent {
  type: 'project.updated'
  project: WebProjectInfo
}

export type TurnSource = 'repl' | 'web' | 'discord' | 'cron' | 'agent' | 'slash' | 'unknown'

export interface TurnStartEvent {
  type: 'turn.start'
  projectId: string
  inputId: string
  source: TurnSource
  clientId?: string
  startedAt: number
}
export interface TurnEventEvent {
  type: 'turn.event'
  projectId: string
  inputId: string
  /** 完整 RunnerEvent payload（含 SDKMessage / 工具呼叫等）。 */
  event: unknown
}
export interface TurnEndEvent {
  type: 'turn.end'
  projectId: string
  inputId: string
  reason: 'done' | 'error' | 'aborted'
  error?: string
  endedAt: number
}
export interface StateEvent {
  type: 'state'
  projectId: string
  state: 'IDLE' | 'RUNNING' | 'INTERRUPTING'
}

export interface PermissionPendingEvent {
  type: 'permission.pending'
  projectId: string
  toolUseID: string
  toolName: string
  input: unknown
  riskLevel?: string
  description?: string
  affectedPaths?: string[]
  /** Source REPL/Discord client id，用來 audit「這個 prompt 從哪來」。 */
  sourceClientId?: string
}
export interface PermissionResolvedEvent {
  type: 'permission.resolved'
  projectId: string
  toolUseID: string
  decision: 'allow' | 'deny'
  by: TurnSource
}
export interface PermissionModeChangedEvent {
  type: 'permission.modeChanged'
  projectId: string
  mode: string
}

export interface CronTasksChangedEvent {
  type: 'cron.tasksChanged'
  projectId: string
}
export interface CronFiredEvent {
  type: 'cron.fired'
  projectId: string
  taskId: string
  ts: number
}
export interface MemoryItemsChangedEvent {
  type: 'memory.itemsChanged'
  projectId: string
}
export interface LlamacppConfigChangedEvent {
  type: 'llamacpp.configChanged'
  changedSection?: string
}
export interface WebStatusChangedEvent {
  type: 'web.statusChanged'
  running: boolean
  port?: number
  bindHost?: string
}

export interface MutationResultEvent {
  type: 'mutation.result'
  requestId: string
  ok: boolean
  data?: unknown
  error?: string
}

// --- Browser → server frames ---

export type ClientFrame =
  | SubscribeFrame
  | PingFrame
  | InputSubmitFrame
  | InputInterruptFrame
  | PermissionRespondFrame
  | PermissionModeFrame
  | MutationFrame

export interface SubscribeFrame {
  type: 'subscribe'
  projectIds: string[]
}
export interface PingFrame {
  type: 'ping'
}
export interface InputSubmitFrame {
  type: 'input.submit'
  projectId: string
  /** 訊息內容；多行字串。 */
  text: string
  intent?: 'interactive' | 'background' | 'slash'
}
export interface InputInterruptFrame {
  type: 'input.interrupt'
  projectId: string
  inputId?: string
}
export interface PermissionRespondFrame {
  type: 'permission.respond'
  projectId: string
  toolUseID: string
  decision: 'allow' | 'deny'
  updatedInput?: unknown
}
export interface PermissionModeFrame {
  type: 'permission.modeSet'
  projectId: string
  mode: string
}

/**
 * 通用 mutation：將 `cron.mutation` / `memory.mutation` / `llamacpp.configMutation`
 * 等 daemon RPC 統包成單一前端 API（K2：browser 不需知道 daemon 內部 frame 命名）。
 */
export interface MutationFrame {
  type: 'mutation'
  requestId: string
  /** 例：'cron.create', 'memory.update', 'llamacpp.setWatchdog'. */
  op: string
  payload: unknown
}
