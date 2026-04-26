/**
 * M-WEB-6：daemon broker frame ↔ web ServerEvent / ClientFrame 雙向翻譯。
 *
 * 純函式設計，無副作用。webGateway / wsServer 在事件邊界呼叫這裡，
 * browser 永遠看不到 daemon 內部命名（K2）。
 */
import type { ProjectRuntime } from '../daemon/projectRegistry.js'
import type {
  ClientFrame,
  PermissionPendingEvent,
  PermissionResolvedEvent,
  ServerEvent,
  TurnEndEvent,
  TurnEventEvent,
  TurnSource,
  TurnStartEvent,
  WebProjectInfo,
} from './webTypes.js'
import type {
  RunnerEventWrapper,
  TurnEndEvent as DaemonTurnEnd,
  TurnStartEvent as DaemonTurnStart,
} from '../daemon/inputQueue.js'
import type { ClientSource } from '../server/clientRegistry.js'

// =============================================================================
// daemon → web
// =============================================================================

export function projectToWebInfo(runtime: ProjectRuntime): WebProjectInfo {
  return {
    projectId: runtime.projectId,
    cwd: runtime.cwd,
    name: deriveName(runtime.cwd),
    hasAttachedRepl: runtime.hasAttachedRepl(),
    attachedReplCount: runtime.attachedReplIds.size,
    lastActivityAt: runtime.lastActivityAt,
  }
}

function deriveName(cwd: string): string {
  if (!cwd) return '(unknown)'
  const norm = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  const parts = norm.split('/')
  return parts[parts.length - 1] || norm
}

const SOURCE_MAP: Record<ClientSource, TurnSource> = {
  repl: 'repl',
  discord: 'discord',
  cron: 'cron',
  slash: 'slash',
  unknown: 'unknown',
}

export function mapTurnSource(source: ClientSource | string | undefined): TurnSource {
  if (!source) return 'unknown'
  if (source === 'web' || source === 'agent') return source
  return (SOURCE_MAP as Record<string, TurnSource>)[source] ?? 'unknown'
}

export function turnStartToWeb(
  projectId: string,
  e: DaemonTurnStart,
): TurnStartEvent {
  return {
    type: 'turn.start',
    projectId,
    inputId: e.input.id,
    source: mapTurnSource(e.input.source as string),
    clientId: e.input.clientId,
    startedAt: e.startedAt,
  }
}

export function turnEndToWeb(
  projectId: string,
  e: DaemonTurnEnd,
): TurnEndEvent {
  return {
    type: 'turn.end',
    projectId,
    inputId: e.input.id,
    reason: e.reason,
    error: e.error,
    endedAt: e.endedAt,
  }
}

export function runnerEventToWeb(
  projectId: string,
  w: RunnerEventWrapper,
): TurnEventEvent {
  return {
    type: 'turn.event',
    projectId,
    inputId: w.input.id,
    event: w.event,
  }
}

export function permissionPendingToWeb(opts: {
  projectId: string
  toolUseID: string
  toolName: string
  input: unknown
  riskLevel?: string
  description?: string
  affectedPaths?: string[]
  sourceClientId?: string
}): PermissionPendingEvent {
  return {
    type: 'permission.pending',
    projectId: opts.projectId,
    toolUseID: opts.toolUseID,
    toolName: opts.toolName,
    input: opts.input,
    riskLevel: opts.riskLevel,
    description: opts.description,
    affectedPaths: opts.affectedPaths,
    sourceClientId: opts.sourceClientId,
  }
}

export function permissionResolvedToWeb(opts: {
  projectId: string
  toolUseID: string
  decision: 'allow' | 'deny'
  by: TurnSource | string
}): PermissionResolvedEvent {
  return {
    type: 'permission.resolved',
    projectId: opts.projectId,
    toolUseID: opts.toolUseID,
    decision: opts.decision,
    by: mapTurnSource(opts.by),
  }
}

// =============================================================================
// web → daemon
// =============================================================================

export type ParsedClientFrame =
  | { ok: true; frame: ClientFrame }
  | { ok: false; reason: string; rawType?: string }

const VALID_FRAME_TYPES = new Set<ClientFrame['type']>([
  'subscribe',
  'ping',
  'input.submit',
  'input.interrupt',
  'permission.respond',
  'permission.modeSet',
  'mutation',
])

export function parseClientFrame(raw: unknown): ParsedClientFrame {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'frame must be an object' }
  }
  const rec = raw as Record<string, unknown>
  if (typeof rec.type !== 'string') {
    return { ok: false, reason: 'frame.type must be string' }
  }
  if (!VALID_FRAME_TYPES.has(rec.type as ClientFrame['type'])) {
    return { ok: false, reason: 'unknown frame type', rawType: rec.type }
  }

  switch (rec.type) {
    case 'subscribe': {
      const ids = Array.isArray(rec.projectIds)
        ? rec.projectIds.filter(x => typeof x === 'string')
        : []
      return { ok: true, frame: { type: 'subscribe', projectIds: ids as string[] } }
    }
    case 'ping':
      return { ok: true, frame: { type: 'ping' } }
    case 'input.submit': {
      if (typeof rec.projectId !== 'string' || rec.projectId.length === 0) {
        return { ok: false, reason: 'input.submit missing projectId' }
      }
      if (typeof rec.text !== 'string') {
        return { ok: false, reason: 'input.submit missing text' }
      }
      const intent = rec.intent
      if (
        intent !== undefined &&
        intent !== 'interactive' &&
        intent !== 'background' &&
        intent !== 'slash'
      ) {
        return { ok: false, reason: 'input.submit invalid intent' }
      }
      return {
        ok: true,
        frame: {
          type: 'input.submit',
          projectId: rec.projectId,
          text: rec.text,
          intent: intent as 'interactive' | 'background' | 'slash' | undefined,
        },
      }
    }
    case 'input.interrupt': {
      if (typeof rec.projectId !== 'string') {
        return { ok: false, reason: 'input.interrupt missing projectId' }
      }
      return {
        ok: true,
        frame: {
          type: 'input.interrupt',
          projectId: rec.projectId,
          inputId: typeof rec.inputId === 'string' ? rec.inputId : undefined,
        },
      }
    }
    case 'permission.respond': {
      if (
        typeof rec.projectId !== 'string' ||
        typeof rec.toolUseID !== 'string' ||
        (rec.decision !== 'allow' && rec.decision !== 'deny')
      ) {
        return { ok: false, reason: 'permission.respond missing required fields' }
      }
      return {
        ok: true,
        frame: {
          type: 'permission.respond',
          projectId: rec.projectId,
          toolUseID: rec.toolUseID,
          decision: rec.decision,
          updatedInput: rec.updatedInput,
        },
      }
    }
    case 'permission.modeSet': {
      if (typeof rec.projectId !== 'string' || typeof rec.mode !== 'string') {
        return { ok: false, reason: 'permission.modeSet missing fields' }
      }
      return {
        ok: true,
        frame: {
          type: 'permission.modeSet',
          projectId: rec.projectId,
          mode: rec.mode,
        },
      }
    }
    case 'mutation': {
      if (typeof rec.requestId !== 'string' || typeof rec.op !== 'string') {
        return { ok: false, reason: 'mutation missing requestId/op' }
      }
      return {
        ok: true,
        frame: {
          type: 'mutation',
          requestId: rec.requestId,
          op: rec.op,
          payload: rec.payload,
        },
      }
    }
  }
}

/**
 * 把 web `mutation` op 翻譯成 daemon 內部 RPC frame name。
 * Phase 1 不接 daemon mutation；保留映射表以便 Phase 2/3 直接擴。
 */
export const MUTATION_OP_TO_DAEMON: Record<
  string,
  { frameType: string; opField?: string }
> = {
  'cron.create': { frameType: 'cron.mutation', opField: 'create' },
  'cron.update': { frameType: 'cron.mutation', opField: 'update' },
  'cron.delete': { frameType: 'cron.mutation', opField: 'delete' },
  'cron.pause': { frameType: 'cron.mutation', opField: 'pause' },
  'cron.resume': { frameType: 'cron.mutation', opField: 'resume' },
  'memory.create': { frameType: 'memory.mutation', opField: 'create' },
  'memory.update': { frameType: 'memory.mutation', opField: 'update' },
  'memory.rename': { frameType: 'memory.mutation', opField: 'rename' },
  'memory.delete': { frameType: 'memory.mutation', opField: 'delete' },
  'memory.restore': { frameType: 'memory.mutation', opField: 'restore' },
  'llamacpp.setWatchdog': {
    frameType: 'llamacpp.configMutation',
    opField: 'setWatchdog',
  },
}

export function translateMutationToDaemonFrame(
  webOp: string,
  payload: unknown,
  requestId: string,
): { frame: Record<string, unknown> } | { error: string } {
  const mapping = MUTATION_OP_TO_DAEMON[webOp]
  if (!mapping) {
    return { error: `unknown mutation op: ${webOp}` }
  }
  return {
    frame: {
      type: mapping.frameType,
      op: mapping.opField,
      requestId,
      payload,
      // 為了相容 daemon 既有 RPC，把 payload 內欄位也展平
      ...(typeof payload === 'object' && payload !== null
        ? (payload as Record<string, unknown>)
        : {}),
    },
  }
}
