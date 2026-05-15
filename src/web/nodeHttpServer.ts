/**
 * Node 版 web HTTP server（M-MASCOT-EMBED Phase 4b / G7 Phase 3）。
 *
 * 對應 src/web/httpServer.ts 的 Bun.serve 版本。協議完全相同：
 *   - GET /api/health / version / ...（caller fetchHandler 處理）
 *   - GET /*（靜態檔 + SPA fallback）
 *   - WS  /ws upgrade（轉給 wsServer.ts 既有 handler）
 *
 * 設計：
 *   - http.createServer 接 HTTP，httpServer.on('upgrade') 接 WS（noServer 模式）
 *   - 把 Node IncomingMessage 轉成 web Request 餵 buildFetch（既有邏輯）
 *   - 把 web Response 寫回 Node ServerResponse（headers + body stream）
 *   - WS upgrade 用 `ws.WebSocketServer({ noServer: true })`，再用 nodeWsShim
 *     把 Node ws 包成 Bun ServerWebSocket 形狀餵 wsServer.ts 的 websocketHandler
 *
 * @see src/web/httpServer.ts — Bun 版（含 startHttpServer dispatcher）
 * @see src/server/nodeDirectConnectServer.ts — daemon WS server 的 Node 範本
 */
import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'http'
import { Readable } from 'stream'
import { WebSocketServer, type WebSocket as NodeWs } from 'ws'
import { existsSync } from 'fs'
import type { WebSocketHandler, ServerWebSocket } from 'bun'

import {
  handleStaticRequest,
  resolveDefaultWebRoot,
  serveSpaFallback,
} from './staticServer.js'
import { buildBrowserSocketData } from './wsServer.js'
import type { BrowserSocketData } from './browserSession.js'
import { logForDebugging } from '../utils/debug.js'
import {
  type HttpServerHandle,
  type HttpServerOptions,
  HttpServerStartError,
} from './httpServer.js'

const DEFAULT_PORT_PROBES = 10

/**
 * Bun ServerWebSocket 的 minimal shim — 把 Node ws.WebSocket 包成 Bun 形狀，
 * 讓 wsServer.ts 既有的 `websocketHandler.open/message/close` 不必修改。
 *
 * 只實作 wsServer 實際用到的 method/property：send, close, data。
 */
function makeBunWsShim(
  ws: NodeWs,
  data: BrowserSocketData,
): ServerWebSocket<BrowserSocketData> {
  return {
    data,
    send(payload: string | Uint8Array): number {
      try {
        ws.send(payload)
        return typeof payload === 'string' ? payload.length : payload.byteLength
      } catch {
        return 0
      }
    },
    close(code?: number, reason?: string): void {
      try {
        ws.close(code ?? 1000, reason)
      } catch {
        // ignore
      }
    },
    // 其餘 Bun ServerWebSocket method 不應被呼叫；cast 過去保留型別
  } as unknown as ServerWebSocket<BrowserSocketData>
}

/** 把 Node IncomingMessage 轉成 web Request。 */
function nodeReqToWebReq(req: IncomingMessage, host: string, port: number): Request {
  const protocol = 'http'  // web HTTP server 不直接服務 TLS（loopback only）
  const url = `${protocol}://${req.headers.host ?? `${host}:${port}`}${req.url ?? '/'}`
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null) continue
    if (Array.isArray(v)) {
      for (const item of v) headers.append(k, item)
    } else {
      headers.set(k, v)
    }
  }
  const method = req.method ?? 'GET'
  // GET/HEAD 不能有 body；其餘把 IncomingMessage 當 Readable stream 包成 ReadableStream
  let body: BodyInit | undefined
  if (method !== 'GET' && method !== 'HEAD') {
    body = Readable.toWeb(req) as unknown as BodyInit
  }
  return new Request(url, {
    method,
    headers,
    body,
    // @ts-expect-error Node 需要 duplex 才能用 stream body
    duplex: 'half',
  })
}

/** 把 web Response 寫回 Node ServerResponse。 */
async function webResToNodeRes(webRes: Response, res: ServerResponse): Promise<void> {
  res.statusCode = webRes.status
  for (const [k, v] of webRes.headers.entries()) {
    res.setHeader(k, v)
  }
  if (!webRes.body) {
    res.end()
    return
  }
  // 把 web ReadableStream → Node Readable
  const nodeReadable = Readable.fromWeb(webRes.body as never)
  nodeReadable.pipe(res)
  await new Promise<void>(resolve => {
    res.on('finish', () => resolve())
    res.on('close', () => resolve())
    res.on('error', () => resolve())
  })
}

export async function startNodeHttpServer(
  opts: HttpServerOptions,
): Promise<HttpServerHandle> {
  const maxProbes = opts.maxPortProbes ?? DEFAULT_PORT_PROBES
  const webRootPath = opts.webRootPath ?? resolveDefaultWebRoot()
  const inDevProxyMode = !!opts.devProxyUrl
  const log =
    opts.log ?? ((m: string) => logForDebugging(`[web-http-node] ${m}`))

  if (!inDevProxyMode && !existsSync(webRootPath)) {
    log(
      `web/dist 不存在於 ${webRootPath} — /api 仍可用、/ 路徑會回 build 提示`,
    )
  }

  // Bun.serve 簽名要求 fetchHandler 接 `server: Server`；Node 版沒有 Server 物件
  // 對應，傳 null assertion（caller 路由不應該 deref server 屬性）
  const serverShim = null as unknown as import('bun').Server
  const handleRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    let webReq: Request
    try {
      webReq = nodeReqToWebReq(req, opts.host, port)
    } catch (err) {
      res.statusCode = 400
      res.setHeader('content-type', 'text/plain')
      res.end(`Bad request: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    const url = new URL(webReq.url)

    // /api/health：built-in 永遠可用
    if (url.pathname === '/api/health' && webReq.method === 'GET') {
      const body = JSON.stringify({
        ok: true,
        serverTime: Date.now(),
        uptimeMs: Math.floor(process.uptime() * 1000),
      })
      res.statusCode = 200
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(body)
      return
    }

    // 額外 caller routes
    if (opts.fetchHandler) {
      try {
        const r = await opts.fetchHandler(webReq, serverShim)
        if (r !== null) {
          await webResToNodeRes(r, res)
          return
        }
      } catch (err) {
        log(`fetchHandler threw: ${err instanceof Error ? err.message : String(err)}`)
        res.statusCode = 500
        res.setHeader('content-type', 'text/plain')
        res.end('Internal Server Error')
        return
      }
    }

    // /api/* 但無 caller routes → 404 JSON
    if (url.pathname.startsWith('/api/')) {
      res.statusCode = 404
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ error: 'Not Found', path: url.pathname }))
      return
    }

    // Dev proxy 模式：把 / 路徑轉發到 Vite
    if (inDevProxyMode && opts.devProxyUrl) {
      try {
        const proxyRes = await proxyToDevServer(webReq, opts.devProxyUrl)
        await webResToNodeRes(proxyRes, res)
      } catch (err) {
        res.statusCode = 502
        res.setHeader('content-type', 'text/plain; charset=utf-8')
        res.end(
          `Dev proxy unreachable (${opts.devProxyUrl}): ${err instanceof Error ? err.message : String(err)}\n`,
        )
      }
      return
    }

    // 靜態檔
    const direct = await handleStaticRequest(webReq, webRootPath)
    if (direct) {
      await webResToNodeRes(direct, res)
      return
    }

    // SPA fallback
    const fallback = await serveSpaFallback(webRootPath)
    await webResToNodeRes(fallback, res)
  }

  // Port probing
  const attempts: { port: number; error: string }[] = []
  let port = opts.port
  let httpServer: HttpServer | null = null
  let actualPort = -1

  for (let i = 0; i < maxProbes; i++) {
    port = opts.port + i
    try {
      httpServer = createServer((req, res) => {
        handleRequest(req, res).catch(err => {
          log(`unhandled request error: ${err instanceof Error ? err.message : String(err)}`)
          if (!res.headersSent) {
            res.statusCode = 500
            res.end()
          }
        })
      })
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException): void => {
          httpServer!.off('listening', onListening)
          reject(err)
        }
        const onListening = (): void => {
          httpServer!.off('error', onError)
          resolve()
        }
        httpServer!.once('error', onError)
        httpServer!.once('listening', onListening)
        httpServer!.listen(port, opts.host)
      })
      // 從 server.address() 拿實際 port（opts.port=0 時 OS 指派的 ephemeral port）
      const addr = httpServer!.address()
      if (addr && typeof addr === 'object') {
        actualPort = addr.port
      } else {
        actualPort = port
      }
      break
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      attempts.push({ port, error: msg })
      try {
        httpServer?.close()
      } catch {
        // ignore
      }
      httpServer = null
      if (!isPortInUseError(msg)) {
        throw new HttpServerStartError(
          `web HTTP server start failed on ${opts.host}:${port}: ${msg}`,
          attempts,
        )
      }
      log(`port ${port} 占用，嘗試 +1`)
    }
  }

  if (!httpServer || actualPort < 0) {
    throw new HttpServerStartError(
      `web HTTP server 無法綁定任何 port（嘗試 ${attempts.length} 次）`,
      attempts,
    )
  }

  // WS upgrade — `noServer: true` 模式，自家 handleUpgrade
  const wss = new WebSocketServer({ noServer: true })
  const wsBookkeep = new WeakMap<NodeWs, ServerWebSocket<BrowserSocketData>>()

  httpServer.on('upgrade', (req, socket, head) => {
    let url: URL
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${opts.host}:${actualPort}`}`)
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }
    const handler = opts.websocketHandler
    if (!handler) {
      socket.write('HTTP/1.1 426 Upgrade Required\r\n\r\n')
      socket.destroy()
      return
    }
    // 從 Node IncomingMessage 建 web Request 給 buildBrowserSocketData
    let webReq: Request
    try {
      webReq = nodeReqToWebReq(req, opts.host, actualPort)
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }
    const remoteAddress = req.socket.remoteAddress ?? undefined
    const data = buildBrowserSocketData(webReq, remoteAddress)

    wss.handleUpgrade(req, socket, head, ws => {
      const shim = makeBunWsShim(ws, data)
      wsBookkeep.set(ws, shim)
      try {
        handler.open?.(shim)
      } catch (err) {
        log(`ws.open threw: ${err instanceof Error ? err.message : String(err)}`)
      }

      ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
        const text = isBinary
          ? '' // wsServer 預期 string；binary 一律當空字串（會被 BAD_JSON gate 擋）
          : Array.isArray(raw)
            ? Buffer.concat(raw).toString('utf-8')
            : raw instanceof ArrayBuffer
              ? Buffer.from(raw).toString('utf-8')
              : raw.toString('utf-8')
        try {
          handler.message?.(shim, text)
        } catch (err) {
          log(`ws.message threw: ${err instanceof Error ? err.message : String(err)}`)
        }
      })

      ws.on('close', (code: number, reason: Buffer) => {
        try {
          handler.close?.(shim, code, reason.toString('utf-8'))
        } catch (err) {
          log(`ws.close threw: ${err instanceof Error ? err.message : String(err)}`)
        }
        wsBookkeep.delete(ws)
      })

      ws.on('error', (err: Error) => {
        log(`ws error: ${err.message}`)
      })
    })
  })

  log(
    `listening on ${opts.host}:${actualPort}` +
      (inDevProxyMode ? ` (dev proxy → ${opts.devProxyUrl})` : ''),
  )

  // 提供與 Bun handle 同形狀的回傳
  const handle: HttpServerHandle = {
    // server 欄位是 Bun.Server 型別，Node 沒對應；用 null assertion，
    // caller 不應 deref 此屬性（既有 caller 都不用）
    server: null as unknown as import('bun').Server,
    host: opts.host,
    port: actualPort,
    webRootPath,
    inDevProxyMode,
    listAccessibleUrls() {
      return enumerateAccessibleUrls(opts.host, actualPort)
    },
    async stop() {
      try {
        wss.close()
      } catch {
        // ignore
      }
      await new Promise<void>(resolve => {
        if (!httpServer) return resolve()
        httpServer.close(() => resolve())
      })
    },
  }
  return handle
}

function isPortInUseError(msg: string): boolean {
  const m = msg.toLowerCase()
  return (
    m.includes('eaddrinuse') ||
    m.includes('address in use') ||
    m.includes('already in use')
  )
}

async function proxyToDevServer(
  req: Request,
  devUrl: string,
): Promise<Response> {
  const url = new URL(req.url)
  const target = new URL(url.pathname + url.search, devUrl)
  const upstream = await fetch(target.toString(), {
    method: req.method,
    headers: req.headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
    // @ts-expect-error Node duplex required for stream body
    duplex: 'half',
  })
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  })
}

function enumerateAccessibleUrls(host: string, port: number): string[] {
  const urls: string[] = []
  if (host === '0.0.0.0' || host === '::') {
    try {
      const { networkInterfaces } = require('os') as typeof import('os')
      const ifaces = networkInterfaces()
      for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name] ?? []) {
          if (iface.internal) continue
          if (iface.family === 'IPv4') {
            urls.push(`http://${iface.address}:${port}`)
          }
        }
      }
    } catch {
      // ignore
    }
    urls.unshift(`http://localhost:${port}`)
  } else {
    urls.push(`http://${host}:${port}`)
  }
  return urls
}
