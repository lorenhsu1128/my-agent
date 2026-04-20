/**
 * M-DAEMON-6a：REPL ↔ daemon 的 WebSocket thin client。
 *
 * 對應 `src/server/directConnectServer.ts`；send 單行 JSON frame，接收 broadcast。
 * 本層只負責 transport；業務層（把 SDKMessage 塞 REPL 的 messages 陣列）在
 * `fallbackManager` / REPL.tsx。
 *
 * 生命週期：
 *   - connect: open WS (with token)；resolve on open；reject on error/timeout
 *   - send / broadcast 是單行 JSON + newline
 *   - onFrame: 每個解析成功的 inbound frame
 *   - onClose: 連線關閉原因（remote / local / error）
 */
import { EventEmitter } from 'node:events'

export type InboundFrame =
  | { type: 'hello'; sessionId: string; state: string; currentInputId?: string }
  | { type: 'state'; state: 'IDLE' | 'RUNNING' | 'INTERRUPTING' }
  | {
      type: 'turnStart'
      inputId: string
      clientId: string
      source: string
      startedAt: number
    }
  | {
      type: 'turnEnd'
      inputId: string
      reason: 'done' | 'error' | 'aborted'
      error?: string
      endedAt: number
    }
  | { type: 'runnerEvent'; inputId: string; event: unknown }
  | {
      /**
       * M-DISCORD-2：daemon 沒有 load 這個 project 的 runtime，拒絕 attach。
       * REPL 應 fallback 到 standalone 並告知使用者。
       */
      type: 'attachRejected'
      reason: 'projectNotLoaded' | string
      cwd?: string
      hint?: string
    }
  | {
      /**
       * M-DISCORD-4：daemon 通知 attached REPL：permission mode 被其他 client
       * （例如 Discord `/mode`）改了，REPL 應同步自己的 toolPermissionContext.mode。
       */
      type: 'permissionModeChanged'
      projectId: string
      mode: import('../../types/permissions.js').PermissionMode
    }
  | { type: string; [key: string]: unknown }

export type OutboundFrame =
  | {
      type: 'input'
      text: string
      intent?: 'interactive' | 'background' | 'slash'
    }
  | {
      type: 'permissionResponse'
      toolUseID: string
      decision: 'allow' | 'deny'
      updatedInput?: unknown
      message?: string
    }
  | {
      type: 'permissionContextSync'
      /** 當下 permission mode（從 TUI AppState.toolPermissionContext.mode 取）。 */
      mode: import('../../types/permissions.js').PermissionMode
    }

export interface ThinClientSocketOptions {
  host: string
  port: number
  token: string
  /**
   * M-DISCORD-2：client 所在的 cwd。daemon 端用它在 ProjectRegistry 查
   * 對應 ProjectRuntime — 有就 attach，沒有就回 `attachRejected`。
   * 未指定時 fallback 到 daemon 的 default runtime（backward compat）。
   */
  cwd?: string
  /**
   * ClientSource hint（'repl' / 'discord' / 'cron' / 'slash'）。未指定則 server
   * 視為 'unknown'。Discord gateway 將來會自行決定 source。
   */
  source?: 'repl' | 'discord' | 'cron' | 'slash'
  /** 連線超時；預設 3000ms。 */
  connectTimeoutMs?: number
  /** 客製 WebSocket 實作（測試 inject）。 */
  webSocketCtor?: typeof WebSocket
}

export type SocketCloseReason = 'local' | 'remote' | 'error'

export interface ThinClientSocket {
  readonly state: 'connecting' | 'open' | 'closed'
  connect(): Promise<void>
  send(frame: OutboundFrame): void
  on(event: 'frame', handler: (f: InboundFrame) => void): void
  on(event: 'close', handler: (reason: SocketCloseReason) => void): void
  off(event: string, handler: (...args: unknown[]) => void): void
  close(): void
}

export function createThinClientSocket(
  opts: ThinClientSocketOptions,
): ThinClientSocket {
  const emitter = new EventEmitter()
  const WsCtor = opts.webSocketCtor ?? WebSocket
  const params = new URLSearchParams({ token: opts.token })
  if (opts.cwd) params.set('cwd', opts.cwd)
  if (opts.source) params.set('source', opts.source)
  const url = `ws://${opts.host}:${opts.port}/sessions?${params.toString()}`
  const connectTimeoutMs = opts.connectTimeoutMs ?? 3_000

  let ws: WebSocket | null = null
  let state: 'connecting' | 'open' | 'closed' = 'connecting'

  const parseAndEmit = (raw: string): void => {
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim()
      if (!s) continue
      try {
        const obj = JSON.parse(s) as InboundFrame
        emitter.emit('frame', obj)
      } catch {
        // 協議錯誤；silently drop（server 同語意）
      }
    }
  }

  const connect = (): Promise<void> => {
    if (state !== 'connecting') {
      return Promise.reject(new Error(`socket already ${state}`))
    }
    return new Promise<void>((resolve, reject) => {
      try {
        ws = new WsCtor(url)
      } catch (err) {
        state = 'closed'
        return reject(err as Error)
      }
      const timer = setTimeout(() => {
        try {
          ws?.close()
        } catch {
          // ignore
        }
        state = 'closed'
        reject(new Error('connect timeout'))
      }, connectTimeoutMs)
      ws.onopen = (): void => {
        clearTimeout(timer)
        state = 'open'
        resolve()
      }
      ws.onerror = (evt): void => {
        clearTimeout(timer)
        if (state !== 'open') {
          state = 'closed'
          reject(new Error(`ws error: ${String((evt as ErrorEvent).message ?? evt)}`))
        } else {
          state = 'closed'
          emitter.emit('close', 'error')
        }
      }
      ws.onmessage = (ev: MessageEvent): void => {
        parseAndEmit(ev.data as string)
      }
      ws.onclose = (): void => {
        clearTimeout(timer)
        const prev = state
        state = 'closed'
        if (prev === 'open') {
          emitter.emit('close', 'remote')
        }
      }
    })
  }

  return {
    get state() {
      return state
    },
    connect,
    send(frame) {
      if (state !== 'open' || !ws) {
        throw new Error('socket not open')
      }
      ws.send(JSON.stringify(frame) + '\n')
    },
    on(event, handler) {
      emitter.on(event, handler as (...args: unknown[]) => void)
    },
    off(event, handler) {
      emitter.off(event, handler)
    },
    close() {
      if (state === 'closed') return
      const prev = state
      state = 'closed'
      try {
        ws?.close()
      } catch {
        // ignore
      }
      if (prev === 'open') {
        emitter.emit('close', 'local')
      }
    },
  }
}
