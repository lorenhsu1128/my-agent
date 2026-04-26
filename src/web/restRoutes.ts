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
import {
  handleCronMutation,
  type CronMutationRequest,
} from '../daemon/cronMutationRpc.js'
import {
  readCronTasks,
  writeCronTasks,
  type CronTask,
} from '../utils/cronTasks.js'
import { randomUUID } from 'crypto'
import { listAllMemoryEntries } from '../utils/memoryList.js'
import { readFile } from 'fs/promises'
import {
  handleMemoryMutation,
  type MemoryMutationRequest,
} from '../daemon/memoryMutationRpc.js'
import { getEffectiveWatchdogConfig } from '../llamacppConfig/loader.js'
import { writeWatchdogConfig } from '../commands/llamacpp/llamacppMutations.js'
import { existsSync } from 'fs'
import { resolve as resolvePath } from 'path'

export interface RestRoutesOptions {
  registry: ProjectRegistry
  /** 廣播 helper — 由 webController 注入；用於 mutation 後通知所有 web tab。 */
  broadcastAll?: (payload: unknown) => void
  /** Per-project broadcast — 用於 cron / memory 等 per-project 事件。 */
  broadcastToProject?: (projectId: string, payload: unknown) => void
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

    // ----- M-WEB-14：Cron CRUD -----
    // GET /api/projects/:id/cron → list raw tasks（client 端用 cronPickerLogic enrich）
    {
      const m = /^\/api\/projects\/([^/]+)\/cron$/.exec(url.pathname)
      if (m && method === 'GET') {
        const id = decodeURIComponent(m[1]!)
        const runtime = registry.getProject(id)
        if (!runtime) return errorResponse('NOT_FOUND', `project ${id} not loaded`, 404)
        try {
          const tasks = await readCronTasks(runtime.cwd)
          return jsonResponse({ tasks })
        } catch (e) {
          return errorResponse(
            'CRON_READ_FAILED',
            e instanceof Error ? e.message : String(e),
            500,
          )
        }
      }
    }

    // POST /api/projects/:id/cron — body 對齊 CronMutationRequest op=create
    {
      const m = /^\/api\/projects\/([^/]+)\/cron$/.exec(url.pathname)
      if (m && method === 'POST') {
        const id = decodeURIComponent(m[1]!)
        const runtime = registry.getProject(id)
        if (!runtime) return errorResponse('NOT_FOUND', `project ${id} not loaded`, 404)
        let body: Record<string, unknown>
        try {
          body = (await req.json()) as Record<string, unknown>
        } catch {
          return errorResponse('BAD_JSON', 'invalid JSON body', 400)
        }
        const cronStr = body.cron
        const prompt = body.prompt
        if (typeof cronStr !== 'string' || typeof prompt !== 'string') {
          return errorResponse(
            'BAD_FIELDS',
            'cron + prompt are required strings',
            400,
          )
        }
        // 直接走 readCronTasks(dir) + writeCronTasks(dir) — addCronTask 不收 dir
        // 參數，會走 bootstrap state 的 projectRoot 寫到錯位置（多 project 場景）。
        try {
          const recurring = body.recurring !== false
          const taskId = randomUUID().slice(0, 8)
          const newTask: CronTask = {
            id: taskId,
            cron: cronStr,
            prompt,
            createdAt: Date.now(),
            ...(recurring ? { recurring: true } : {}),
            ...(typeof body.name === 'string' ? { name: body.name } : {}),
            ...(typeof body.preRunScript === 'string'
              ? { preRunScript: body.preRunScript }
              : {}),
            ...(typeof body.modelOverride === 'string'
              ? { modelOverride: body.modelOverride }
              : {}),
            ...(body.scheduleSpec &&
            typeof body.scheduleSpec === 'object' &&
            'kind' in (body.scheduleSpec as object) &&
            'raw' in (body.scheduleSpec as object)
              ? {
                  scheduleSpec: body.scheduleSpec as {
                    kind: 'cron' | 'nl'
                    raw: string
                  },
                }
              : {}),
          }
          const tasks = await readCronTasks(runtime.cwd)
          tasks.push(newTask)
          await writeCronTasks(tasks, runtime.cwd)
          opts.broadcastToProject?.(runtime.projectId, {
            type: 'cron.tasksChanged',
            projectId: runtime.projectId,
          })
          return jsonResponse({ task: newTask, taskId }, 201)
        } catch (e) {
          return errorResponse(
            'CRON_CREATE_FAILED',
            e instanceof Error ? e.message : String(e),
            400,
          )
        }
      }
    }

    // PATCH /api/projects/:id/cron/:taskId — op ∈ pause/resume/update（在 body.op 指定）
    // DELETE /api/projects/:id/cron/:taskId
    {
      const m = /^\/api\/projects\/([^/]+)\/cron\/([^/]+)$/.exec(url.pathname)
      if (m) {
        const id = decodeURIComponent(m[1]!)
        const taskId = decodeURIComponent(m[2]!)
        const runtime = registry.getProject(id)
        if (!runtime) return errorResponse('NOT_FOUND', `project ${id} not loaded`, 404)

        if (method === 'DELETE') {
          const r = await handleCronMutation(
            {
              type: 'cron.mutation',
              requestId: `web-${Date.now()}`,
              op: 'delete',
              ids: [taskId],
            } as CronMutationRequest,
            { projectRoot: runtime.cwd, projectId: id },
          )
          if (!r.ok) return errorResponse('CRON_DELETE_FAILED', r.error ?? 'unknown', 400)
          opts.broadcastToProject?.(id, { type: 'cron.tasksChanged', projectId: id })
          return jsonResponse({ ok: true })
        }

        if (method === 'PATCH') {
          let body: Record<string, unknown>
          try {
            body = (await req.json()) as Record<string, unknown>
          } catch {
            return errorResponse('BAD_JSON', 'invalid JSON body', 400)
          }
          const op = body.op
          if (op !== 'pause' && op !== 'resume' && op !== 'update') {
            return errorResponse(
              'BAD_OP',
              'body.op must be pause | resume | update',
              400,
            )
          }
          const reqFrame: CronMutationRequest =
            op === 'update'
              ? ({
                  type: 'cron.mutation',
                  requestId: `web-${Date.now()}`,
                  op: 'update',
                  id: taskId,
                  patch:
                    (body.patch as CronMutationRequest extends { op: 'update' }
                      ? CronMutationRequest['patch']
                      : never) ?? {},
                } as CronMutationRequest)
              : ({
                  type: 'cron.mutation',
                  requestId: `web-${Date.now()}`,
                  op,
                  id: taskId,
                } as CronMutationRequest)
          const r = await handleCronMutation(reqFrame, {
            projectRoot: runtime.cwd,
            projectId: id,
          })
          if (!r.ok) return errorResponse('CRON_UPDATE_FAILED', r.error ?? 'unknown', 400)
          opts.broadcastToProject?.(id, { type: 'cron.tasksChanged', projectId: id })
          return jsonResponse({ task: r.task })
        }
      }
    }

    // ----- M-WEB-15：Memory（read + delete；編輯 wizard M-WEB-15b 補）-----
    {
      const m = /^\/api\/projects\/([^/]+)\/memory$/.exec(url.pathname)
      if (m && method === 'GET') {
        const id = decodeURIComponent(m[1]!)
        const runtime = registry.getProject(id)
        if (!runtime) return errorResponse('NOT_FOUND', `project ${id} not loaded`, 404)
        try {
          const entries = listAllMemoryEntries(runtime.cwd)
          // 不送整份 body — 過大；只送 metadata（client 點開時再呼 body endpoint）
          return jsonResponse({
            entries: entries.map(e => ({
              kind: e.kind,
              displayName: e.displayName,
              description: e.description,
              absolutePath: e.absolutePath,
              filename: e.filename,
              sizeBytes: e.sizeBytes,
              mtimeMs: e.mtimeMs,
              userProfileScope: e.userProfileScope,
            })),
          })
        } catch (e) {
          return errorResponse(
            'MEMORY_LIST_FAILED',
            e instanceof Error ? e.message : String(e),
            500,
          )
        }
      }
    }

    // GET /api/projects/:id/memory/body?path=<absolutePath>
    // path 必須在 entries 列表內（防 traversal）
    {
      const m = /^\/api\/projects\/([^/]+)\/memory\/body$/.exec(url.pathname)
      if (m && method === 'GET') {
        const id = decodeURIComponent(m[1]!)
        const runtime = registry.getProject(id)
        if (!runtime) return errorResponse('NOT_FOUND', `project ${id} not loaded`, 404)
        const requestedPath = url.searchParams.get('path')
        if (!requestedPath) {
          return errorResponse('MISSING_PATH', 'query.path required', 400)
        }
        try {
          const entries = listAllMemoryEntries(runtime.cwd)
          const target = resolvePath(requestedPath)
          const allowed = entries.some(e => resolvePath(e.absolutePath) === target)
          if (!allowed) {
            return errorResponse('PATH_NOT_ALLOWED', 'path not in memory entries', 403)
          }
          if (!existsSync(target)) {
            return errorResponse('FILE_NOT_FOUND', 'file does not exist', 404)
          }
          const body = await readFile(target, 'utf-8')
          return jsonResponse({ body, sizeBytes: body.length })
        } catch (e) {
          return errorResponse(
            'MEMORY_READ_FAILED',
            e instanceof Error ? e.message : String(e),
            500,
          )
        }
      }
    }

    // DELETE /api/projects/:id/memory — body { kind, absolutePath, filename? }
    {
      const m = /^\/api\/projects\/([^/]+)\/memory$/.exec(url.pathname)
      if (m && method === 'DELETE') {
        const id = decodeURIComponent(m[1]!)
        const runtime = registry.getProject(id)
        if (!runtime) return errorResponse('NOT_FOUND', `project ${id} not loaded`, 404)
        let body: Record<string, unknown>
        try {
          body = (await req.json()) as Record<string, unknown>
        } catch {
          return errorResponse('BAD_JSON', 'invalid JSON body', 400)
        }
        const kind = body.kind
        const absolutePath = body.absolutePath
        if (typeof kind !== 'string' || typeof absolutePath !== 'string') {
          return errorResponse(
            'BAD_FIELDS',
            'kind + absolutePath are required strings',
            400,
          )
        }
        const r = await handleMemoryMutation(
          {
            type: 'memory.mutation',
            requestId: `web-${Date.now()}`,
            op: 'delete',
            payload: {
              kind: kind as never,
              absolutePath,
              filename:
                typeof body.filename === 'string' ? body.filename : undefined,
            },
          } as MemoryMutationRequest,
          { projectRoot: runtime.cwd, projectId: runtime.projectId },
        )
        if (!r.ok) {
          return errorResponse('MEMORY_DELETE_FAILED', r.error ?? 'unknown', 400)
        }
        opts.broadcastToProject?.(runtime.projectId, {
          type: 'memory.itemsChanged',
          projectId: runtime.projectId,
        })
        return jsonResponse({ ok: true })
      }
    }

    // ----- M-WEB-16：Llamacpp watchdog config（global, not per-project）-----
    if (url.pathname === '/api/llamacpp/watchdog' && method === 'GET') {
      try {
        const cfg = getEffectiveWatchdogConfig()
        return jsonResponse({ config: cfg })
      } catch (e) {
        return errorResponse(
          'LLAMACPP_READ_FAILED',
          e instanceof Error ? e.message : String(e),
          500,
        )
      }
    }
    if (url.pathname === '/api/llamacpp/watchdog' && method === 'PUT') {
      let body: unknown
      try {
        body = await req.json()
      } catch {
        return errorResponse('BAD_JSON', 'invalid JSON body', 400)
      }
      try {
        const r = await writeWatchdogConfig(
          body as Parameters<typeof writeWatchdogConfig>[0],
        )
        if (!r.ok) {
          return errorResponse('LLAMACPP_WRITE_FAILED', r.error, 400)
        }
        // 廣播全 client（daemon 全域）
        opts.broadcastAll?.({
          type: 'llamacpp.configChanged',
          changedSection: 'watchdog',
        })
        return jsonResponse({ ok: true, message: r.message })
      } catch (e) {
        return errorResponse(
          'LLAMACPP_WRITE_FAILED',
          e instanceof Error ? e.message : String(e),
          500,
        )
      }
    }

    return null
  }

  return { handle }
}
