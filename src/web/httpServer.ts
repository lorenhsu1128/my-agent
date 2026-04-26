/**
 * M-WEB-3：daemon 內第二個 Bun.serve listener，服務 web UI。
 *
 * 與 src/server/directConnectServer.ts（thin-client WS）平行存在，**不共用
 * Bun.serve 實例**，因為兩者：
 *   - 綁定 host 不同（loopback 127.0.0.1 vs LAN 0.0.0.0）
 *   - 認證模型不同（bearer token vs 無認證）
 *   - 故障隔離：web 出問題不影響 thin-client
 *
 * 路由（Phase 1）：
 *   - GET /api/health        — daemon 存活探測
 *   - GET /api/version       — daemon 版本資訊
 *   - GET /*                 — 靜態檔（web/dist）+ SPA fallback
 *   - WS  /ws                — M-WEB-4 才接，目前回 426
 *
 * Port 衝突自動 +1（最多 maxPortProbes 次）；全失敗 throw。
 *
 * Dev 模式：若 webRootPath 不存在但 devProxyUrl 有值，把 GET / 反向 proxy 到
 * Vite dev server（HMR 可用）。
 */
import type { Server, WebSocketHandler } from 'bun'
import {
  handleStaticRequest,
  resolveDefaultWebRoot,
  serveSpaFallback,
} from './staticServer.js'
import {
  buildBrowserSocketData,
  type Server as _Server,
} from './wsServer.js'
import type { BrowserSocketData } from './browserSession.js'
import { existsSync } from 'fs'
import { logForDebugging } from '../utils/debug.js'

export interface HttpServerOptions {
  /** 預期 port，衝突時自動往上找。 */
  port: number
  /** 綁定 host，例 '0.0.0.0' 或 '127.0.0.1'。 */
  host: string
  /** Port 衝突時最多嘗試 +N 次。 */
  maxPortProbes?: number
  /** 靜態檔根目錄（預設解析 web/dist）。 */
  webRootPath?: string
  /** Dev 反向 proxy URL（例 http://127.0.0.1:5173）。設了優先於靜態 serve。 */
  devProxyUrl?: string
  /**
   * 額外路由處理器。Caller（webGateway）可注入 REST routes / WS upgrade 邏輯。
   * 回傳 null = 路由未命中，httpServer 走 fallback（靜態檔 / SPA）。
   * 回傳 Response = 命中，直接回。
   */
  fetchHandler?: (req: Request, server: Server) => Promise<Response | null>
  /** WS upgrade handler — 通常由 wsServer.ts 提供（M-WEB-4）。 */
  websocketHandler?: WebSocketHandler<BrowserSocketData>
  /** Daemon log（可選）。 */
  log?: (msg: string) => void
}

export interface HttpServerHandle {
  readonly port: number
  readonly host: string
  readonly server: Server
  readonly webRootPath: string
  readonly inDevProxyMode: boolean
  /** 回傳所有可能的 LAN 地址（給 /web status 顯示）。 */
  listAccessibleUrls(): string[]
  stop(): Promise<void>
}

export class HttpServerStartError extends Error {
  constructor(
    message: string,
    public readonly attempts: { port: number; error: string }[],
  ) {
    super(message)
    this.name = 'HttpServerStartError'
  }
}

const DEFAULT_PORT_PROBES = 10

export async function startHttpServer(
  opts: HttpServerOptions,
): Promise<HttpServerHandle> {
  const maxProbes = opts.maxPortProbes ?? DEFAULT_PORT_PROBES
  const webRootPath = opts.webRootPath ?? resolveDefaultWebRoot()
  const inDevProxyMode = !!opts.devProxyUrl
  const log =
    opts.log ?? ((m: string) => logForDebugging(`[web-http] ${m}`))

  if (!inDevProxyMode && !existsSync(webRootPath)) {
    log(
      `web/dist 不存在於 ${webRootPath} — /api 仍可用、/ 路徑會回 build 提示`,
    )
  }

  const buildFetch = (server: Server) => {
    return async (req: Request): Promise<Response | undefined> => {
      const url = new URL(req.url)

      // WS upgrade：/ws 路徑
      if (url.pathname === '/ws' && req.headers.get('upgrade') === 'websocket') {
        const remoteAddress = server.requestIP(req)?.address
        const data = buildBrowserSocketData(req, remoteAddress)
        if (server.upgrade(req, { data })) {
          return undefined
        }
        return new Response('WebSocket upgrade failed', { status: 426 })
      }

      // /api/health：built-in 永遠可用，不依賴 caller
      if (url.pathname === '/api/health' && req.method === 'GET') {
        return jsonResponse({
          ok: true,
          serverTime: Date.now(),
          uptimeMs: Math.floor(process.uptime() * 1000),
        })
      }

      // 額外 caller routes
      if (opts.fetchHandler) {
        const r = await opts.fetchHandler(req, server)
        if (r !== null) return r
      }

      // /api/* 但無 caller routes → 404 JSON
      if (url.pathname.startsWith('/api/')) {
        return jsonResponse({ error: 'Not Found', path: url.pathname }, 404)
      }

      // Dev proxy 模式：把 / 路徑轉發到 Vite
      if (inDevProxyMode && opts.devProxyUrl) {
        return await proxyToDevServer(req, opts.devProxyUrl)
      }

      // 靜態檔
      const direct = await handleStaticRequest(req, webRootPath)
      if (direct) return direct

      // SPA fallback
      return await serveSpaFallback(webRootPath)
    }
  }

  // Port probing
  const attempts: { port: number; error: string }[] = []
  for (let i = 0; i < maxProbes; i++) {
    const tryPort = opts.port + i
    try {
      let serverRef: Server | null = null
      const fetchFn = (req: Request) => buildFetch(serverRef!)(req)
      const server = Bun.serve<BrowserSocketData, undefined>({
        hostname: opts.host,
        port: tryPort,
        fetch: fetchFn as never,
        websocket: (opts.websocketHandler ?? {
          message() {},
          open() {},
          close() {},
        }) as WebSocketHandler<BrowserSocketData>,
      })
      serverRef = server
      log(
        `listening on ${opts.host}:${tryPort}` +
          (inDevProxyMode ? ` (dev proxy → ${opts.devProxyUrl})` : ''),
      )
      return makeHandle(server, opts.host, tryPort, webRootPath, inDevProxyMode)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      attempts.push({ port: tryPort, error: msg })
      // 只在常見「占用」訊息時才繼續探下一 port；其餘錯誤直接 fail
      if (!isPortInUseError(msg)) {
        throw new HttpServerStartError(
          `web HTTP server start failed on ${opts.host}:${tryPort}: ${msg}`,
          attempts,
        )
      }
      log(`port ${tryPort} 占用，嘗試 +1`)
    }
  }
  throw new HttpServerStartError(
    `web HTTP server 無法綁定任何 port（嘗試 ${attempts.length} 次）`,
    attempts,
  )
}

function isPortInUseError(msg: string): boolean {
  const m = msg.toLowerCase()
  return (
    m.includes('eaddrinuse') ||
    m.includes('address in use') ||
    m.includes('already in use') ||
    m.includes('already bound') ||
    // Bun: "Failed to start server. Is port X in use?"
    (m.includes('failed to start server') && m.includes('port'))
  )
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

async function proxyToDevServer(
  req: Request,
  devUrl: string,
): Promise<Response> {
  const url = new URL(req.url)
  const target = new URL(url.pathname + url.search, devUrl)
  try {
    const upstream = await fetch(target.toString(), {
      method: req.method,
      headers: req.headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
      // @ts-expect-error Bun-specific option
      duplex: 'half',
    })
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    })
  } catch (e) {
    return new Response(
      `Dev proxy unreachable (${devUrl}): ${e instanceof Error ? e.message : String(e)}\n\n啟動 vite：bun run dev:web`,
      {
        status: 502,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      },
    )
  }
}

function makeHandle(
  server: Server,
  host: string,
  port: number,
  webRootPath: string,
  inDevProxyMode: boolean,
): HttpServerHandle {
  return {
    server,
    host,
    port,
    webRootPath,
    inDevProxyMode,
    listAccessibleUrls() {
      return enumerateAccessibleUrls(host, port)
    },
    async stop() {
      try {
        server.stop(true)
      } catch {
        // already stopped
      }
    },
  }
}

/**
 * 列出使用者可在瀏覽器打開的 URL。當綁定 0.0.0.0 時要列所有非 internal 的
 * IPv4 + IPv6 LAN 地址，方便使用者複製給手機 / 平板。
 */
function enumerateAccessibleUrls(host: string, port: number): string[] {
  const urls: string[] = []
  if (host === '0.0.0.0' || host === '::') {
    // 列所有非 internal 介面
    try {
      // node:os ESM
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
