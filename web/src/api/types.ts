/**
 * M-WEB browser-side 協議型別。
 *
 * **必須與 `src/web/webTypes.ts`（daemon 端）保持一致** — 改一邊一定要同步。
 *
 * 為避免 web/ Vite 專案直接 import daemon code（會把整個 src/ 拉進 bundle），
 * 採鏡像複製。M-WEB-MOBILE / M-WEB-AUTH 之類後續 milestone 會評估搬到共用
 * package 或產 .d.ts。
 */

export interface WebProjectInfo {
  projectId: string
  cwd: string
  name: string
  hasAttachedRepl: boolean
  attachedReplCount: number
  lastActivityAt: number
}

export interface WebSessionInfo {
  sessionId: string
  isActive: boolean
  startedAt: number
  /** 訊息數（後續 sessionIndex read API 補上後填）。 */
  messageCount?: number
  /** 最近一條訊息預覽。 */
  lastMessageSnippet?: string
}

export type TurnSource =
  | 'repl'
  | 'web'
  | 'discord'
  | 'cron'
  | 'agent'
  | 'slash'
  | 'unknown'

// =============================================================================
// WS server → browser
// =============================================================================

export type ServerEvent =
  | HelloEvent
  | KeepaliveEvent
  | SubscribedEvent
  | ErrorEvent
  | PongEvent
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
  | MutationResultEvent

export interface HelloEvent {
  type: 'hello'
  sessionId: string
  serverTime: number
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

// =============================================================================
// Browser → server
// =============================================================================

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
export interface MutationFrame {
  type: 'mutation'
  requestId: string
  op: string
  payload: unknown
}
