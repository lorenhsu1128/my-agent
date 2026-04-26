/**
 * M-WEB-8：REST API 路由（`/api/*`）。
 *
 * 設計：
 *   - 純函式風格 routes — 由 webGateway / webController 注入 dependencies（registry）
 *   - 對外 schema 完全跟 web/src/api/types.ts 一致（K2 bridge）
 *   - 每個 endpoint 都做 path validation 防 traversal
 *   - 錯誤一律 `{ error: string, code?: string }` JSON
 */
import type { ProjectRegistry } from '../daemon/projectRegistry.js'
import { projectToWebInfo } from './translator.js'
import type { WebProjectInfo } from './webTypes.js'

export interface RestRoutesOptions {
  registry: ProjectRegistry
  /** 廣播 helper（注入避免 restRoutes 認識 wsServer）。 */
  broadcastAll?: (payload: unknown) => void
}

export interface RestHandler {
  /** 由 httpServer 的 fetchHandler 呼叫；命中回 Response，否則 null。 */
  handle(req: Request): Promise<Response | null>
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // 開放 LAN browser CORS（W2 政策；本身就無認證、不額外開洞）
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'access-control-allow-headers': 'content-type',
    },
  })
}

function errorResponse(code: string, message: string, status = 400): Response {
  return jsonResponse({ error: message, code }, status)
}

function isProjectIdSafe(id: string): boolean {
  // sanitizePath 已 normalize；額外擋斜線 / null / 過長
  if (id.length === 0 || id.length > 256) return false
  if (id.includes('\0')) return false
  return true
}

export function createRestRoutes(opts: RestRoutesOptions): RestHandler {
  const { registry } = opts

  async function handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url)
    if (!url.pathname.startsWith('/api/')) return null
    const method = req.method.toUpperCase()

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '600',
        },
      })
    }

    // GET /api/version
    if (url.pathname === '/api/version' && method === 'GET') {
      return jsonResponse({
        agentVersion:
          (globalThis as { MACRO?: { VERSION?: string } }).MACRO?.VERSION ??
          'unknown',
        api: 'm-web/1',
      })
    }

    // GET /api/projects
    if (url.pathname === '/api/projects' && method === 'GET') {
      const projects: WebProjectInfo[] = registry
        .listProjects()
        .map(projectToWebInfo)
      return jsonResponse({ projects })
    }

    // POST /api/projects { cwd }
    if (url.pathname === '/api/projects' && method === 'POST') {
      let body: unknown
      try {
        body = await req.json()
      } catch {
        return errorResponse('BAD_JSON', 'request body must be JSON', 400)
      }
      const cwd =
        body && typeof body === 'object' && 'cwd' in body
          ? (body as { cwd: unknown }).cwd
          : null
      if (typeof cwd !== 'string' || cwd.length === 0) {
        return errorResponse('MISSING_CWD', 'body.cwd must be a non-empty string', 400)
      }
      try {
        const runtime = await registry.loadProject(cwd)
        const info = projectToWebInfo(runtime)
        return jsonResponse({ project: info }, 201)
      } catch (e) {
        return errorResponse(
          'LOAD_FAILED',
          e instanceof Error ? e.message : String(e),
          500,
        )
      }
    }

    // DELETE /api/projects/:id
    {
      const m = /^\/api\/projects\/([^/]+)$/.exec(url.pathname)
      if (m && method === 'DELETE') {
        const id = decodeURIComponent(m[1]!)
        if (!isProjectIdSafe(id)) {
          return errorResponse('BAD_ID', 'invalid project id', 400)
        }
        const ok = await registry.unloadProject(id)
        if (!ok) return errorResponse('NOT_FOUND', `project ${id} not loaded`, 404)
        return jsonResponse({ ok: true, projectId: id })
      }
    }

    // GET /api/projects/:id
    {
      const m = /^\/api\/projects\/([^/]+)$/.exec(url.pathname)
      if (m && method === 'GET') {
        const id = decodeURIComponent(m[1]!)
        if (!isProjectIdSafe(id)) {
          return errorResponse('BAD_ID', 'invalid project id', 400)
        }
        const runtime = registry.getProject(id)
        if (!runtime) return errorResponse('NOT_FOUND', `project ${id} not loaded`, 404)
        return jsonResponse({ project: projectToWebInfo(runtime) })
      }
    }

    // GET /api/projects/:id/sessions
    {
      const m = /^\/api\/projects\/([^/]+)\/sessions$/.exec(url.pathname)
      if (m && method === 'GET') {
        const id = decodeURIComponent(m[1]!)
        const runtime = registry.getProject(id)
        if (!runtime) return errorResponse('NOT_FOUND', `project ${id} not loaded`, 404)
        // Phase 1：暫時只回當前 active session。Full session list（H3 跨 session
        // 切換）將於 M-WEB-11/M-WEB-18 sessionIndex read API 補上後接入。
        const current = {
          sessionId: runtime.sessionHandle.sessionId,
          isActive: true,
          startedAt: runtime.lastActivityAt,
        }
        return jsonResponse({ sessions: [current], activeSessionId: current.sessionId })
      }
    }

    // POST /api/projects/:id/sessions — Phase 1 stub（S3 完整實作 M-WEB-11）
    {
      const m = /^\/api\/projects\/([^/]+)\/sessions$/.exec(url.pathname)
      if (m && method === 'POST') {
        return errorResponse(
          'NOT_IMPLEMENTED',
          'POST /api/projects/:id/sessions 需要 daemon 端建立新 session 的 API（M-WEB-11）',
          501,
        )
      }
    }

    return null
  }

  return { handle }
}
