/**
 * M-WEB-4：daemon 內 web WebSocket server（/ws endpoint）。
 *
 * 由 httpServer.ts 透過 `websocketHandler` 注入；本檔負責 frame parse、
 * subscribe 管理、heartbeat、把 client message 派發給 webGateway。
 *
 * Frame protocol（browser ↔ daemon）— Phase 1 最小集合：
 *   server → browser:
 *     - hello { sessionId, serverTime }
 *     - keepalive {}                                 — 30s 心跳
 *     - subscribed { projectIds }                    — ack
 *     - error { code, message }
 *   browser → server:
 *     - subscribe { projectIds: string[] }
 *     - ping {}                                       — 客戶端可主動 ping
 *     - input.submit / permission.respond / ...      — Phase 2+ 由 webGateway 接
 */
import type { Server, ServerWebSocket, WebSocketHandler } from 'bun'
import type { DaemonLogger } from '../daemon/daemonLog.js'
import {
  createBrowserSessionRegistry,
  type BrowserSession,
  type BrowserSessionRegistry,
  type BrowserSocketData,
} from './browserSession.js'

export interface WebWsServerOptions {
  heartbeatIntervalMs?: number
  /** 接收 client 訊息的 callback（已 JSON parse）。 */
  onMessage?: (session: BrowserSession, msg: unknown) => void
  /** Client 連上 / 斷線通知。 */
  onConnect?: (session: BrowserSession) => void
  onDisconnect?: (session: BrowserSession) => void
  /** Daemon log。 */
  logger?: DaemonLogger
}

export interface WebWsServerHandle {
  registry: BrowserSessionRegistry
  /** 由 httpServer 在 upgrade 時消費。 */
  websocketHandler: WebSocketHandler<BrowserSocketData>
  /** 停止：關閉所有 socket、停 heartbeat。 */
  stop(): void
}

const DEFAULT_HEARTBEAT_MS = 30_000

interface InternalFrame {
  type: string
  [k: string]: unknown
}

function jsonStringifySafe(obj: unknown): string {
  try {
    return JSON.stringify(obj)
  } catch {
    return JSON.stringify({ type: 'error', message: 'serialization failed' })
  }
}

export function createWebWsServer(
  opts: WebWsServerOptions = {},
): WebWsServerHandle {
  const heartbeatMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS
  const registry = createBrowserSessionRegistry()
  const log = (m: string) => opts.logger?.info?.({ msg: `[web-ws] ${m}` })

  const heartbeatPayload = jsonStringifySafe({ type: 'keepalive' })
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null

  function startHeartbeat() {
    if (heartbeatTimer) return
    heartbeatTimer = setInterval(() => {
      registry.broadcastAll(heartbeatPayload)
    }, heartbeatMs)
    // unref so heartbeat 不阻 event loop
    if (heartbeatTimer.unref) heartbeatTimer.unref()
  }
  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  const websocketHandler: WebSocketHandler<BrowserSocketData> = {
    open(ws: ServerWebSocket<BrowserSocketData>) {
      const remoteAddress = ws.data?.remoteAddress
      const userAgent = ws.data?.userAgent
      const session = registry.register({ ws, remoteAddress, userAgent })
      // hello frame
      session.send(
        jsonStringifySafe({
          type: 'hello',
          sessionId: session.id,
          serverTime: Date.now(),
        }),
      )
      log(`open ${session.id}` + (remoteAddress ? ` from ${remoteAddress}` : ''))
      opts.onConnect?.(session)
      startHeartbeat()
    },
    message(ws, raw) {
      const session = registry.get(ws.data?.sessionId ?? '')
      if (!session) return
      session.lastActivityAt = Date.now()
      let parsed: InternalFrame | null = null
      try {
        parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString()) as InternalFrame
      } catch {
        session.send(
          jsonStringifySafe({
            type: 'error',
            code: 'BAD_JSON',
            message: 'frame is not valid JSON',
          }),
        )
        return
      }
      if (!parsed || typeof parsed.type !== 'string') {
        session.send(
          jsonStringifySafe({
            type: 'error',
            code: 'BAD_FRAME',
            message: 'frame missing string `type`',
          }),
        )
        return
      }
      // 內建 ping / subscribe；其餘給 onMessage 處理
      if (parsed.type === 'ping') {
        session.send(jsonStringifySafe({ type: 'pong', t: Date.now() }))
        return
      }
      if (parsed.type === 'subscribe') {
        const ids = Array.isArray(parsed.projectIds)
          ? (parsed.projectIds.filter(x => typeof x === 'string') as string[])
          : []
        session.setSubscriptions(ids)
        session.send(
          jsonStringifySafe({ type: 'subscribed', projectIds: ids }),
        )
        return
      }
      opts.onMessage?.(session, parsed)
    },
    close(ws) {
      const id = ws.data?.sessionId
      if (!id) return
      const session = registry.get(id)
      registry.unregister(id)
      if (session) {
        log(`close ${id}`)
        opts.onDisconnect?.(session)
      }
      if (registry.size() === 0) stopHeartbeat()
    },
  }

  return {
    registry,
    websocketHandler,
    stop() {
      stopHeartbeat()
      registry.closeAll('server stopping')
    },
  }
}

/**
 * 把 cwd / UA 從 HTTP 升級 request 抽出來。供 httpServer fetch 在 upgrade 前
 * 預填到 ws.data。Bun.serve 的 upgrade option 第二個參數是 `data`，所以這個
 * helper 純粹解析 URL 和 headers。
 */
export function buildBrowserSocketData(
  req: Request,
  remoteAddress?: string,
): BrowserSocketData {
  return {
    sessionId: '', // 開啟時 registry.register 寫入
    remoteAddress,
    userAgent: req.headers.get('user-agent') ?? undefined,
    connectedAt: Date.now(),
  }
}

export type { Server }
