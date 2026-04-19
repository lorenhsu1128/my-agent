/**
 * Direct-connect WS server（daemon 端）。
 *
 * 對應既有的 client-side `src/server/directConnectManager.ts`（213 行）。
 * 協議：
 *   - 連線：ws://<host>:<port>/sessions，header `Authorization: Bearer <token>`
 *     或 query `?token=<token>`（有些 WebSocket 客戶端無法自訂 header）
 *   - 每條訊息是**單行 JSON**（newline terminator 由 client 決定；server 兩種都接）
 *   - 未知 subtype 或 parse 失敗一律回 control_response error（不斷線）
 *
 * 此檔案只負責傳輸層：auth、registry、ping/pong、broadcast。
 * 業務層（QueryEngine、input queue、permission prompt 路由）在 M-DAEMON-4+
 * 由 sessionBroker 接上；此處只 expose `onMessage` callback 給上層處理。
 */
import { randomUUID } from 'crypto'
import type { Server, ServerWebSocket } from 'bun'
import { compareTokens } from '../daemon/authToken.js'
import type { DaemonLogger } from '../daemon/daemonLog.js'
import { logForDebugging } from '../utils/debug.js'
import { jsonStringify } from '../utils/slowOperations.js'
import {
  createClientRegistry,
  type ClientInfo,
  type ClientRegistry,
  type ClientSource,
} from './clientRegistry.js'

export const DEFAULT_HOST = '127.0.0.1'
/**
 * Ping interval — 保持連線活性 + 偵測死連線。
 * 客戶端收到 keep_alive 不需回應，純單向心跳。
 */
export const DEFAULT_PING_INTERVAL_MS = 30_000

export interface DirectConnectServerOptions {
  token: string
  port?: number // 0 → OS 指派
  host?: string // 預設 127.0.0.1（loopback only）
  pingIntervalMs?: number
  logger?: DaemonLogger
  /** 上層業務邏輯處理收到的 client 訊息（已 JSON parse）。 */
  onMessage?: (client: ClientInfo, msg: unknown) => void
  /** client 連上時通知上層（可用來 replay session history 等）。 */
  onClientConnect?: (client: ClientInfo) => void
  onClientDisconnect?: (client: ClientInfo) => void
}

export interface DirectConnectServerHandle {
  readonly host: string
  readonly port: number
  readonly registry: ClientRegistry
  /** Broadcast 已序列化 JSON 字串；回傳成功送出的 client 數。 */
  broadcast(msg: unknown, filter?: (c: ClientInfo) => boolean): number
  /** 點對點送訊息。 */
  send(clientId: string, msg: unknown): boolean
  /** 停止 server，關閉所有連線。冪等。 */
  stop(): Promise<void>
}

interface SocketData {
  clientId: string
  source: ClientSource
  remoteAddress?: string
  /** 累積未完整的 message fragment（WebSocket 保證完整 frame，這裡主要處理 newline 拆分） */
  buffer: string
}

function parseTokenFromRequest(req: Request): string | null {
  const auth = req.headers.get('authorization')
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim()
  }
  try {
    const url = new URL(req.url)
    const q = url.searchParams.get('token')
    if (q) return q
  } catch {
    // malformed URL — fall through
  }
  return null
}

function parseSourceFromRequest(req: Request): ClientSource {
  try {
    const url = new URL(req.url)
    const s = url.searchParams.get('source')?.toLowerCase()
    if (
      s === 'repl' ||
      s === 'discord' ||
      s === 'cron' ||
      s === 'slash'
    ) {
      return s
    }
  } catch {
    // ignore
  }
  return 'unknown'
}

export async function startDirectConnectServer(
  opts: DirectConnectServerOptions,
): Promise<DirectConnectServerHandle> {
  const host = opts.host ?? DEFAULT_HOST
  const requestedPort = opts.port ?? 0
  const pingIntervalMs = opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS
  const logger = opts.logger
  const registry = createClientRegistry()
  const expectedToken = opts.token

  const serializedPing = jsonStringify({ type: 'keep_alive' })

  let stopping = false

  const server: Server = Bun.serve<SocketData, undefined>({
    hostname: host,
    port: requestedPort,
    fetch(req, srv) {
      const providedToken = parseTokenFromRequest(req)
      if (!providedToken) {
        return new Response('Missing auth token', { status: 401 })
      }
      if (!compareTokens(providedToken, expectedToken)) {
        return new Response('Invalid token', { status: 403 })
      }
      const clientId = randomUUID()
      const source = parseSourceFromRequest(req)
      const remoteAddress = srv.requestIP(req)?.address
      const data: SocketData = {
        clientId,
        source,
        remoteAddress,
        buffer: '',
      }
      if (srv.upgrade(req, { data })) {
        return undefined
      }
      return new Response('WebSocket upgrade required', { status: 426 })
    },
    websocket: {
      open(ws: ServerWebSocket<SocketData>) {
        const client = registry.register({
          id: ws.data.clientId,
          source: ws.data.source,
          remoteAddress: ws.data.remoteAddress,
          socket: {
            send: (data: string) => {
              try {
                ws.send(data)
              } catch (err) {
                logForDebugging(
                  `[daemon:ws] send failed for ${ws.data.clientId}: ${err}`,
                  { level: 'warn' },
                )
              }
            },
            close: (code, reason) => {
              try {
                ws.close(code ?? 1000, reason)
              } catch {
                // ignore
              }
            },
          },
        })
        void logger?.info('client connected', {
          clientId: client.id,
          source: client.source,
          remoteAddress: client.remoteAddress,
        })
        opts.onClientConnect?.({
          id: client.id,
          source: client.source,
          connectedAt: client.connectedAt,
          remoteAddress: client.remoteAddress,
        })
      },
      message(ws: ServerWebSocket<SocketData>, raw: string | Buffer) {
        const text = typeof raw === 'string' ? raw : raw.toString('utf-8')
        ws.data.buffer += text
        // Protocol 是 newline-delimited JSON；一個 frame 可能含多筆或不含整筆
        const lines = ws.data.buffer.split('\n')
        ws.data.buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          let parsed: unknown
          try {
            parsed = JSON.parse(trimmed)
          } catch (err) {
            void logger?.warn('client sent malformed JSON', {
              clientId: ws.data.clientId,
              err: String(err),
              snippet: trimmed.slice(0, 120),
            })
            continue
          }
          const info = registry.get(ws.data.clientId)
          if (!info) continue
          try {
            opts.onMessage?.(
              {
                id: info.id,
                source: info.source,
                connectedAt: info.connectedAt,
                remoteAddress: info.remoteAddress,
              },
              parsed,
            )
          } catch (err) {
            void logger?.error('onMessage handler threw', {
              clientId: ws.data.clientId,
              err: String(err),
            })
          }
        }
      },
      close(ws: ServerWebSocket<SocketData>, code: number, reason: string) {
        const removed = registry.unregister(ws.data.clientId)
        void logger?.info('client disconnected', {
          clientId: ws.data.clientId,
          source: ws.data.source,
          code,
          reason,
        })
        if (removed) {
          opts.onClientDisconnect?.({
            id: removed.id,
            source: removed.source,
            connectedAt: removed.connectedAt,
            remoteAddress: removed.remoteAddress,
          })
        }
      },
    },
  })

  const actualPort = server.port
  void logger?.info('WS server listening', {
    host,
    port: actualPort,
  })

  // Ping 心跳（廣播）
  const pingTimer = setInterval(() => {
    if (stopping) return
    registry.broadcast(serializedPing)
  }, pingIntervalMs)
  // Timer 不應阻止 process 退出（daemon 主迴圈由 startDaemon 自己控制）
  ;(pingTimer as unknown as { unref?: () => void }).unref?.()

  const stop = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    clearInterval(pingTimer)
    registry.closeAll(1001, 'server shutting down')
    server.stop(true)
    void logger?.info('WS server stopped')
  }

  return {
    host,
    port: actualPort,
    registry,
    broadcast(msg, filter) {
      const payload = typeof msg === 'string' ? msg : jsonStringify(msg)
      return registry.broadcast(payload, filter)
    },
    send(clientId, msg) {
      const payload = typeof msg === 'string' ? msg : jsonStringify(msg)
      return registry.send(clientId, payload)
    },
    stop,
  }
}
