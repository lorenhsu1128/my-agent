/**
 * M-DAEMON-4c：Session broker — WS ↔ InputQueue ↔ QueryEngineRunner 黏合層。
 *
 * 職責：
 *   - 解析從 WS client 進來的業務 frame（`{type:'input', text, intent?}`）、
 *     轉成 `queue.submit(...)`
 *   - 訂閱 InputQueue 的 events（state / turnStart / turnEnd / runnerEvent）、
 *     序列化成 outbound frame 廣播給所有 attached client
 *   - 新 client attach 時送 snapshot（當前 state / sessionId）
 *
 * 不做：
 *   - transport 層 auth / ping（那是 directConnectServer 的事）
 *   - transcript 寫入（QueryEngine.ask 內部 `recordTranscript()` 自己處理）
 *   - permission routing（M-DAEMON-7；此處仍走 runner 預設 auto-allow）
 *
 * 協議 frame（JSON over WS，單行 newline-terminated）：
 *
 * 進來（client → daemon）:
 *   - `{type:'input', text: string, intent?: 'interactive'|'background'|'slash'}`
 *
 * 出去（daemon → client，broadcast）:
 *   - `{type:'state', state: 'IDLE'|'RUNNING'|'INTERRUPTING'}`
 *   - `{type:'turnStart', inputId, clientId, source, startedAt}`
 *   - `{type:'turnEnd', inputId, reason, error?, endedAt}`
 *   - `{type:'runnerEvent', inputId, event}`  // event = RunnerEvent（含 SDKMessage）
 *   - `{type:'hello', sessionId, state, currentInputId?}`  // client 剛 attach 時送
 */
import {
  createInputQueue,
  defaultIntentForSource,
  type InputQueue,
  type QueueState,
  type TurnEndEvent,
  type TurnStartEvent,
  type RunnerEventWrapper,
} from './inputQueue.js'
import type { DaemonSessionContext } from './sessionBootstrap.js'
import type { DaemonSessionHandle } from './sessionWriter.js'
import type { SessionRunner, QueuedInputIntent } from './sessionRunner.js'
import type { DirectConnectServerHandle } from '../server/directConnectServer.js'
import type { ClientInfo } from '../server/clientRegistry.js'

export interface SessionBrokerOptions {
  server: DirectConnectServerHandle
  context: DaemonSessionContext
  runner: SessionRunner
  sessionHandle: DaemonSessionHandle
  projectId: string
  interruptGraceMs?: number
  /** 無效 frame 時的 warn 管道（預設 console.error，測試可 inject）。 */
  onProtocolError?: (err: string, raw: unknown) => void
}

export interface SessionBroker {
  readonly queue: InputQueue
  readonly sessionId: string
  dispose(): Promise<void>
}

interface InboundInputFrame {
  type: 'input'
  text: string
  intent?: QueuedInputIntent
}

function parseInbound(msg: unknown): InboundInputFrame | null {
  if (!msg || typeof msg !== 'object') return null
  const rec = msg as Record<string, unknown>
  if (rec.type !== 'input') return null
  if (typeof rec.text !== 'string') return null
  const intent = rec.intent
  if (
    intent !== undefined &&
    intent !== 'interactive' &&
    intent !== 'background' &&
    intent !== 'slash'
  ) {
    return null
  }
  return {
    type: 'input',
    text: rec.text,
    intent: intent as QueuedInputIntent | undefined,
  }
}

export function createSessionBroker(
  opts: SessionBrokerOptions,
): SessionBroker {
  const { server, runner, sessionHandle, projectId } = opts
  const onProtocolError =
    opts.onProtocolError ??
    ((err, raw): void => {
      // eslint-disable-next-line no-console
      console.error(`[daemon:broker] protocol error: ${err}`, raw)
    })

  const queue = createInputQueue({
    runner,
    interruptGraceMs: opts.interruptGraceMs,
  })

  // 廣播 helper — 只送給同 project 的 client，避免跨 project 洩漏。
  const broadcast = (payload: Record<string, unknown>): void => {
    server.broadcast(payload, c => c.projectId === projectId)
  }

  // --- Queue events → WS outbound ---
  queue.on('state', (state: QueueState) => {
    broadcast({ type: 'state', state })
  })
  queue.on('turnStart', (e: TurnStartEvent) => {
    broadcast({
      type: 'turnStart',
      inputId: e.input.id,
      clientId: e.input.clientId,
      source: e.input.source,
      startedAt: e.startedAt,
    })
  })
  queue.on('turnEnd', (e: TurnEndEvent) => {
    broadcast({
      type: 'turnEnd',
      inputId: e.input.id,
      reason: e.reason,
      error: e.error,
      endedAt: e.endedAt,
    })
  })
  queue.on('runnerEvent', (w: RunnerEventWrapper) => {
    broadcast({
      type: 'runnerEvent',
      inputId: w.input.id,
      event: w.event,
    })
  })

  return {
    queue,
    sessionId: sessionHandle.sessionId,
    async dispose() {
      await queue.dispose()
    },
  }
}

/**
 * 給 directConnectServer 用的 message router：解析 client frame + submit 到 queue。
 * 獨立函式讓測試可以直接呼叫不必起 WS。
 */
export function handleClientMessage(
  broker: SessionBroker,
  client: ClientInfo,
  msg: unknown,
  onProtocolError: (err: string, raw: unknown) => void,
): void {
  const parsed = parseInbound(msg)
  if (!parsed) {
    onProtocolError('invalid or unknown frame', msg)
    return
  }
  const intent = parsed.intent ?? defaultIntentForSource(client.source)
  broker.queue.submit(parsed.text, {
    clientId: client.id,
    source: client.source,
    intent,
  })
}

/**
 * 當新 client attach 時送 hello frame：報目前 session + queue 狀態。
 */
export function sendHelloFrame(
  broker: SessionBroker,
  server: DirectConnectServerHandle,
  clientId: string,
): void {
  const current = broker.queue.currentInput
  server.send(clientId, {
    type: 'hello',
    sessionId: broker.sessionId,
    state: broker.queue.state,
    currentInputId: current?.id,
  })
}
