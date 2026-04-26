/**
 * M-WEB-3：靜態檔服務 helper（serve `web/dist/`）。
 *
 * 設計：
 *   - 單純的純函式 + Response 產生器，無狀態
 *   - SPA fallback：未知路徑回傳 index.html，由 react-router 處理 404
 *   - MIME 表小巧但涵蓋 Vite 預設輸出（html / js / css / map / svg / png / ico / json / woff2）
 *   - Path traversal 防護：normalize 後拒絕跳出 webRoot
 */
import { existsSync, statSync } from 'fs'
import { readFile } from 'fs/promises'
import { extname, join, resolve, sep } from 'path'

const MIME_TABLE: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
}

export function getContentType(filePath: string): string {
  const ext = extname(filePath).toLowerCase()
  return MIME_TABLE[ext] ?? 'application/octet-stream'
}

/**
 * 把 URL pathname 解析成磁碟絕對路徑，並做 path traversal 防護。
 * 回傳 null 表示路徑不合法或檔案不存在（caller 應走 SPA fallback）。
 */
export function resolveStaticPath(
  webRoot: string,
  urlPathname: string,
): string | null {
  // 去開頭 `/`，去 query/hash（caller 應已切掉但保險）
  let rel = urlPathname.replace(/^\/+/, '').split('?')[0]!.split('#')[0]!
  if (rel === '' || rel === '/') {
    rel = 'index.html'
  }
  const root = resolve(webRoot)
  const target = resolve(root, rel)
  // path traversal：normalized target 必須以 root + sep 開頭（或恰好等於 root）
  if (target !== root && !target.startsWith(root + sep)) {
    return null
  }
  if (!existsSync(target)) return null
  try {
    const st = statSync(target)
    if (!st.isFile()) return null
  } catch {
    return null
  }
  return target
}

/**
 * 處理靜態檔請求；回傳 Response 或 null（表示 caller 應 fallback 到別處，例
 * 如 SPA 的 index.html 或 404）。
 */
export async function handleStaticRequest(
  req: Request,
  webRoot: string,
): Promise<Response | null> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return null
  const url = new URL(req.url)
  const direct = resolveStaticPath(webRoot, url.pathname)
  if (direct !== null) {
    return await serveFile(direct, req.method === 'HEAD')
  }
  return null
}

/**
 * SPA fallback：對未命中的路徑回 index.html，讓 react-router 接手。
 * 若 webRoot 不存在 index.html（例如 build 還沒跑）回 404 訊息。
 */
export async function serveSpaFallback(webRoot: string): Promise<Response> {
  const indexPath = resolve(webRoot, 'index.html')
  if (!existsSync(indexPath)) {
    return new Response(
      `web UI 尚未 build。請於 my-agent 根目錄執行：\n\n  bun run build:web\n\n然後重啟 daemon / web server。\n`,
      {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      },
    )
  }
  return await serveFile(indexPath, false)
}

async function serveFile(absPath: string, headOnly: boolean): Promise<Response> {
  try {
    if (headOnly) {
      const st = statSync(absPath)
      return new Response(null, {
        status: 200,
        headers: {
          'content-type': getContentType(absPath),
          'content-length': String(st.size),
          // 開發體驗：dev mode 不 cache；prod build 含 hash 檔名走 1y immutable
          'cache-control': absPath.includes('/assets/')
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
        },
      })
    }
    const buf = await readFile(absPath)
    return new Response(buf, {
      status: 200,
      headers: {
        'content-type': getContentType(absPath),
        'content-length': String(buf.byteLength),
        'cache-control': absPath.includes(`${sep}assets${sep}`)
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      },
    })
  } catch (e) {
    return new Response(`Read error: ${e instanceof Error ? e.message : String(e)}`, {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }
}

/**
 * 解析預設的 web/dist 路徑：相對 src/web/staticServer.ts 兩層上 + web/dist。
 * 若不存在，呼叫端應 catch 並提示 build:web。
 */
export function resolveDefaultWebRoot(): string {
  // import.meta.url → src/web/staticServer.ts → 上兩層為 repo root
  const here = new URL('.', import.meta.url).pathname
  // Windows 下 URL pathname 帶前導 `/` + drive letter（如 /C:/...），strip 掉
  const cleaned =
    process.platform === 'win32' && /^\/[a-zA-Z]:/.test(here)
      ? here.slice(1)
      : here
  return join(cleaned, '..', '..', 'web', 'dist')
}
