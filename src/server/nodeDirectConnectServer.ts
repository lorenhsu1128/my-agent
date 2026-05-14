/**
 * Node.js 版 direct-connect WS server（M-MASCOT-EMBED Phase 4）。
 *
 * 與 src/server/directConnectServer.ts 的 Bun.serve 版本對應，協議完全相同：
 * - 連線：ws://<host>:<port>/sessions?token=...&source=...&cwd=...
 *   或 Authorization: Bearer <token> header
 * - 訊息：newline-delimited JSON（單條訊息可能跨 frame，內部維護 buffer）
 * - 心跳：每 N ms broadcast `{type:'keep_alive'}`
 *
 * 用 `http.createServer` + `ws.WebSocketServer({ noServer: true })` + 手動 upgrade，
 * 避免任何 Bun-specific API。embedded（target=node）bundle 走此路徑。
 *
 * @see directConnectServer.ts — 入口 dispatcher（runtime 偵測 Bun / Node 後分派）
 */
import { randomUUID } from 'crypto'
import { createServer, type Server as HttpServer, type IncomingMessage } from 'http'
import { WebSocketServer, type WebSocket } from 'ws'

import { compareTokens } from '../daemon/authToken.js'
import { logForDebugging } from '../utils/debug.js'
import { jsonStringify } from '../utils/slowOperations.js'
import {
  createClientRegistry,
  type ClientInfo,
  type ClientSource,
} from './clientRegistry.js'

import {
  DEFAULT_HOST,
  DEFAULT_PING_INTERVAL_MS,
  type DirectConnectServerHandle,
  type DirectConnectServerOptions,
} from './directConnectServer.js'

interface SocketData {
  clientId: string
  source: ClientSource
  cwd?: string
  remoteAddress?: string
  buffer: string
}

function parseTokenFromRequest(req: IncomingMessage, url: URL): string | null {
  const auth = req.headers['authorization']
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim()
  }
  const q = url.searchParams.get('token')
  if (q) return q
  return null
}

function parseSourceFromUrl(url: URL): ClientSource {
  const s = url.searchParams.get('source')?.toLowerCase()
  if (
    s === 'repl' ||
    s === 'discord' ||
    s === 'cron' ||
    s === 'slash' ||
    s === 'mascot'
  ) {
    return s
  }
  return 'unknown'
}

function parseCwdFromUrl(url: URL): string | undefined {
  const c = url.searchParams.get('cwd')
  if (c && c.length > 0) return c
  return undefined
}

export async function startNodeDirectConnectServer(
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

  const httpServer: HttpServer = createServer((_req, res) => {
    // 非 WS 請求 — daemon 直連 server 不提供 HTTP REST endpoints（那是 web/httpServer 的事）
    res.statusCode = 426
    res.setHeader('content-type', 'text/plain')
    res.end('WebSocket upgrade required')
  })

  const wss = new WebSocketServer({ noServer: true })

  // 把 socketData 附在 ws instance 上（替代 Bun.ServerWebSocket<SocketData> 的 ws.data）
  const dataByWs = new WeakMap<WebSocket, SocketData>()

  httpServer.on('upgrade', (req, socket, head) => {
    let url: URL
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? host}`)
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }

    const providedToken = parseTokenFromRequest(req, url)
    if (!providedToken) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\nMissing auth token')
      socket.destroy()
      return
    }
    if (!compareTokens(providedToken, expectedToken)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\nInvalid token')
      socket.destroy()
      return
    }

    const clientId = randomUUID()
    const source = parseSourceFromUrl(url)
    const cwd = parseCwdFromUrl(url)
    const remoteAddress = req.socket.remoteAddress ?? undefined

    wss.handleUpgrade(req, socket, head, ws => {
      const data: SocketData = {
        clientId,
        source,
        cwd,
        remoteAddress,
        buffer: '',
      }
      dataByWs.set(ws, data)

      const client = registry.register({
        id: clientId,
        source,
        remoteAddress,
        cwd,
        socket: {
          send: (payload: string) => {
            try {
              ws.send(payload)
            } catch (err) {
              logForDebugging(
                `[daemon:ws-node] send failed for ${clientId}: ${err}`,
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
        cwd: client.cwd,
      })

      ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
        const data = dataByWs.get(ws)
        if (!data) return

        const text = isBinary
          ? '' // binary frames 拒絕（協議是 NDJSON）
          : Array.isArray(raw)
            ? Buffer.concat(raw).toString('utf-8')
            : raw instanceof ArrayBuffer
              ? Buffer.from(raw).toString('utf-8')
              : raw.toString('utf-8')

        data.buffer += text
        const lines = data.buffer.split('\n')
        data.buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          let parsed: unknown
          try {
            parsed = JSON.parse(trimmed)
          } catch (err) {
            void logger?.warn('client sent malformed JSON', {
              clientId: data.clientId,
              err: String(err),
              snippet: trimmed.slice(0, 120),
            })
            continue
          }
          const info = registry.get(data.clientId)
          if (!info) continue
          try {
            opts.onMessage?.(
              {
                id: info.id,
                source: info.source,
                connectedAt: info.connectedAt,
                remoteAddress: info.remoteAddress,
                cwd: info.cwd,
                projectId: info.projectId,
              },
              parsed,
            )
          } catch (err) {
            void logger?.error('onMessage handler threw', {
              clientId: data.clientId,
              err: String(err),
            })
          }
        }
      })

      ws.on('close', (code: number, reason: Buffer) => {
        const data = dataByWs.get(ws)
        if (!data) return
        dataByWs.delete(ws)
        const removed = registry.unregister(data.clientId)
        void logger?.info('client disconnected', {
          clientId: data.clientId,
          source: data.source,
          code,
          reason: reason.toString('utf-8'),
        })
        if (removed) {
          opts.onClientDisconnect?.({
            id: removed.id,
            source: removed.source,
            connectedAt: removed.connectedAt,
            remoteAddress: removed.remoteAddress,
            cwd: removed.cwd,
            projectId: removed.projectId,
          })
        }
      })
    })
  })

  // 等待 listen 完成才回傳，與 Bun.serve 同步 startup 行為一致
  const actualPort: number = await new Promise<number>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(requestedPort, host, () => {
      const addr = httpServer.address()
      if (addr && typeof addr === 'object') {
        resolve(addr.port)
      } else {
        reject(new Error('failed to resolve actual port'))
      }
    })
  })

  void logger?.info('WS server listening', {
    host,
    port: actualPort,
  })

  // Ping 心跳
  const pingTimer = setInterval(() => {
    if (stopping) return
    registry.broadcast(serializedPing)
  }, pingIntervalMs)
  ;(pingTimer as unknown as { unref?: () => void }).unref?.()

  const stop = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    clearInterval(pingTimer)
    registry.closeAll(1001, 'server shutting down')
    await new Promise<void>(resolve => {
      wss.close(() => resolve())
    })
    await new Promise<void>(resolve => {
      httpServer.close(() => resolve())
    })
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
