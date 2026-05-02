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
import {
  getEffectiveWatchdogConfig,
  getLlamaCppConfigSnapshot,
} from '../llamacppConfig/loader.js'
import {
  writeWatchdogConfig,
  writeRemoteConfig,
  writeRoutingConfig,
  testRemoteEndpoint,
  fetchSlots,
  killSlot,
} from '../commands/llamacpp/llamacppMutations.js'
import { existsSync } from 'fs'
import { resolve as resolvePath } from 'path'
import {
  getMessagesBySession,
  listSessionsForProject,
  searchProject,
} from '../services/sessionIndex/index.js'
import { getSlashCommandMetadataSnapshot } from '../daemon/slashCommandRegistry.js'
import { searchProjectFiles } from './fileSearch.js'
import { storeImage, MAX_IMAGE_BYTES } from './imageStorage.js'
import { getModelOptions } from '../utils/model/modelOptions.js'
import {
  getDefaultMainLoopModel,
  getUserSpecifiedModelSetting,
} from '../utils/model/model.js'
import { setMainLoopModelOverride } from '../bootstrap/state.js'

export interface RestRoutesOptions {
  registry: ProjectRegistry
  /** 廣播 helper — 由 webController 注入；用於 mutation 後通知所有 web tab。 */
  broadcastAll?: (payload: unknown) => void
  /** Per-project broadcast — 用於 cron / memory 等 per-project 事件。 */
  broadcastToProject?: (projectId: string, payload: unknown) => void
  /**
   * M-WEB-CLOSEOUT-10：Discord admin 操作（每次 request 取 live ref；未注入或返回
   * null 則所有 /api/discord/* 回 503）。Getter 形式避免 daemon 啟動 race（web
   * 起來時 supervisor 可能還沒準備好）。
   */
  getDiscordController?: () =>
    | import('../discord/discordController.js').DiscordController
    | null
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

// M-WEB-PARITY-2：slot 查詢 cache TTL（多 client polling 不重複打 llamacpp）。
// 實際 cache state 在 createRestRoutes 閉包內，每個 handler 獨立（避免測試串擾）。
const SLOTS_CACHE_TTL_MS = 500

function isProjectIdSafe(id: string): boolean {
  // sanitizePath 已 normalize；額外擋斜線 / null / 過長
  if (id.length === 0 || id.length > 256) return false
  if (id.includes('\0')) return false
  return true
}

export function createRestRoutes(opts: RestRoutesOptions): RestHandler {
  const { registry } = opts
  let slotsCache: { at: number; payload: unknown } | null = null
  const getCachedSlots = (): unknown => {
    if (!slotsCache) return null
    if (Date.now() - slotsCache.at > SLOTS_CACHE_TTL_MS) return null
    return slotsCache.payload
  }
  const setCachedSlots = (payload: unknown): void => {
    slotsCache = { at: Date.now(), payload }
  }

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

    // GET /api/slash-commands?cwd=...
    // 拉 daemon 端 87 個 command 的 metadata snapshot 給 web autocomplete。
    // cwd 可選 — 沒給就用 default project；給了就走 registry 找對應 runtime
    // 的 cwd（讓 plugin / skill 命令吃到 per-project 設定）。
    if (url.pathname === '/api/slash-commands' && method === 'GET') {
      const projectId = url.searchParams.get('projectId')
      let cwd: string
      if (projectId && isProjectIdSafe(projectId)) {
        const runtime = registry.getProject(projectId)
        cwd = runtime?.cwd ?? process.cwd()
      } else {
        cwd = process.cwd()
      }
      try {
        const commands = await getSlashCommandMetadataSnapshot(cwd)
        return jsonResponse({ commands })
      } catch (err) {
        return errorResponse(
          'SLASH_LIST_FAILED',
          err instanceof Error ? err.message : String(err),
          500,
        )
      }
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

    // GET /api/projects/:id/sessions — M-WEB-18：sessionIndex 真資料
    {
      const m = /^\/api\/projects\/([^/]+)\/sessions$/.exec(url.pathname)
      if (m && method === 'GET') {
        const id = decodeURIComponent(m[1]!)
        const runtime = registry.getProject(id)
        if (!runtime) return errorResponse('NOT_FOUND', `project ${id} not loaded`, 404)
        const limit = Number(url.searchParams.get('limit') ?? '100')
        const activeSessionId = runtime.sessionHandle.sessionId
        try {
          const rows = listSessionsForProject(
            runtime.cwd,
            Number.isFinite(limit) ? limit : 100,
          )
          const sessions = rows.map(r => ({
            sessionId: r.sessionId,
            isActive: r.sessionId === activeSessionId,
            startedAt: r.startedAt,
            endedAt: r.endedAt ?? undefined,
            messageCount: r.messageCount,
            firstUserMessage: r.firstUserMessage ?? undefined,
            model: r.model ?? undefined,
          }))
          if (!sessions.some(s => s.sessionId === activeSessionId)) {
            sessions.unshift({
              sessionId: activeSessionId,
              isActive: true,
              startedAt: runtime.lastActivityAt,
              endedAt: undefined,
              messageCount: 0,
              firstUserMessage: undefined,
              model: undefined,
            })
          }
          return jsonResponse({ sessions, activeSessionId })
        } catch (e) {
          // sessionIndex 失敗 graceful fallback 到只回 active
          return jsonResponse({
            sessions: [
              {
                sessionId: activeSessionId,
                isActive: true,
                startedAt: runtime.lastActivityAt,
              },
            ],
            activeSessionId,
            indexError: e instanceof Error ? e.message : String(e),
          })
        }
      }
    }

    // GET /api/projects/:id/sessions/:sid/messages?before=&limit=100
    {
      const m =
        /^\/api\/projects\/([^/]+)\/sessions\/([^/]+)\/messages$/.exec(
          url.pathname,
        )
      if (m && method === 'GET') {
        const id = decodeURIComponent(m[1]!)
        const sid = decodeURIComponent(m[2]!)
        const runtime = registry.getProject(id)
        if (!runtime) return errorResponse('NOT_FOUND', `project ${id} not loaded`, 404)
        const beforeRaw = url.searchParams.get('before')
        const limitRaw = url.searchParams.get('limit')
        const before = beforeRaw !== null ? Number(beforeRaw) : undefined
        const limit = limitRaw !== null ? Number(limitRaw) : 100
        try {
          const messages = getMessagesBySession(runtime.cwd, sid, {
            before:
              before !== undefined && Number.isFinite(before)
                ? before
                : undefined,
            limit: Number.isFinite(limit)
              ? Math.min(Math.max(limit, 1), 500)
              : 100,
          })
          return jsonResponse({ messages, sessionId: sid })
        } catch (e) {
          return errorResponse(
            'MESSAGES_READ_FAILED',
            e instanceof Error ? e.message : String(e),
            500,
          )
        }
      }
    }

    // GET /api/projects/:id/search?q=&limit=50
    {
      const m = /^\/api\/projects\/([^/]+)\/search$/.exec(url.pathname)
      if (m && method === 'GET') {
        const id = decodeURIComponent(m[1]!)
        const runtime = registry.getProject(id)
        if (!runtime) return errorResponse('NOT_FOUND', `project ${id} not loaded`, 404)
        const q = url.searchParams.get('q') ?? ''
        const limitRaw = url.searchParams.get('limit')
        const limit = limitRaw !== null ? Number(limitRaw) : 50
        try {
          const hits = searchProject(
            runtime.cwd,
            q,
            Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 500) : 50,
          )
          return jsonResponse({ hits, query: q })
        } catch (e) {
          return errorResponse(
            'SEARCH_FAILED',
            e instanceof Error ? e.message : String(e),
            500,
          )
        }
      }
    }

    // GET /api/models — M-WEB-PARITY-7：列可用 model + 當前選擇
    if (url.pathname === '/api/models' && method === 'GET') {
      try {
        const options = getModelOptions()
        const current =
          getUserSpecifiedModelSetting() ?? getDefaultMainLoopModel() ?? null
        return jsonResponse({
          // 過濾 sentinel 值（NO_PREFERENCE / null）— UI 只該選真實 model id
          models: options
            .filter(o => typeof o.value === 'string' && o.value.length > 0)
            .map(o => ({
              value: o.value,
              label: o.label,
              description: o.description,
            })),
          current: typeof current === 'string' ? current : null,
        })
      } catch (e) {
        return errorResponse(
          'MODEL_LIST_FAILED',
          e instanceof Error ? e.message : String(e),
          500,
        )
      }
    }

    // PUT /api/models/current — M-WEB-PARITY-7：切 model（走 in-session override）
    // 等價於 /model command 的效果：setMainLoopModelOverride 是優先級最高的
    // 來源（高於 env / userSettings.model），下次 turn 立即生效。
    if (url.pathname === '/api/models/current' && method === 'PUT') {
      try {
        const body = (await req.json()) as { model?: unknown }
        if (typeof body.model !== 'string' || body.model.length === 0) {
          return errorResponse('BAD_INPUT', 'body.model 必須是非空字串', 400)
        }
        const known = getModelOptions().map(o => o.value)
        if (!known.includes(body.model)) {
          return errorResponse(
            'UNKNOWN_MODEL',
            `model ${body.model} 不在已知清單`,
            400,
          )
        }
        setMainLoopModelOverride(body.model)
        opts.broadcastAll?.({
          type: 'model.changed',
          model: body.model,
        })
        return jsonResponse({ ok: true, model: body.model })
      } catch (e) {
        return errorResponse(
          'MODEL_SET_FAILED',
          e instanceof Error ? e.message : String(e),
          500,
        )
      }
    }

    // POST /api/projects/:id/images — M-WEB-PARITY-5：Web 圖片上傳
    // body 期望 { mimeType, data: base64 }；存到 ~/.my-agent/web-images/...，
    // 回 refToken 讓 web textarea 插入。
    {
      const m = /^\/api\/projects\/([^/]+)\/images$/.exec(url.pathname)
      if (m && method === 'POST') {
        const id = decodeURIComponent(m[1]!)
        if (!isProjectIdSafe(id)) {
          return errorResponse('BAD_ID', 'invalid project id', 400)
        }
        if (!registry.getProject(id)) {
          return errorResponse('NOT_FOUND', `project ${id} not loaded`, 404)
        }
        try {
          const body = (await req.json()) as {
            mimeType?: unknown
            data?: unknown
          }
          if (typeof body.mimeType !== 'string' || typeof body.data !== 'string') {
            return errorResponse(
              'BAD_INPUT',
              'body 需要 { mimeType: string, data: base64 string }',
              400,
            )
          }
          const buf = Buffer.from(body.data, 'base64')
          if (buf.length === 0) {
            return errorResponse('BAD_INPUT', 'empty image data', 400)
          }
          if (buf.length > MAX_IMAGE_BYTES) {
            return errorResponse(
              'IMAGE_TOO_LARGE',
              `max ${MAX_IMAGE_BYTES} bytes`,
              413,
            )
          }
          const stored = storeImage({
            projectId: id,
            data: buf,
            mimeType: body.mimeType,
          })
          return jsonResponse(
            {
              imageId: stored.imageId,
              refToken: stored.refToken,
              size: stored.size,
              mimeType: stored.mimeType,
            },
            201,
          )
        } catch (e) {
          return errorResponse(
            'IMAGE_STORE_FAILED',
            e instanceof Error ? e.message : String(e),
            500,
          )
        }
      }
    }

    // GET /api/projects/:id/files?q=&limit=50 — M-WEB-PARITY-4：@file typeahead
    // 簡單子字串 + 子路徑分數 fuzzy match，跳過常見 ignore dir。
    {
      const m = /^\/api\/projects\/([^/]+)\/files$/.exec(url.pathname)
      if (m && method === 'GET') {
        const id = decodeURIComponent(m[1]!)
        if (!isProjectIdSafe(id)) {
          return errorResponse('BAD_ID', 'invalid project id', 400)
        }
        const runtime = registry.getProject(id)
        if (!runtime)
          return errorResponse('NOT_FOUND', `project ${id} not loaded`, 404)
        const q = (url.searchParams.get('q') ?? '').trim()
        const limitRaw = url.searchParams.get('limit')
        const limit = limitRaw ? Number(limitRaw) : 50
        const cap = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50
        try {
          const files = await searchProjectFiles(runtime.cwd, q, cap)
          return jsonResponse({ files, query: q })
        } catch (e) {
          return errorResponse(
            'FILE_SEARCH_FAILED',
            e instanceof Error ? e.message : String(e),
            500,
          )
        }
      }
    }

    // POST /api/projects/:id/sessions — M-WEB-PARITY-1：rotate（= /clear 等價）
    // 拆掉舊 runtime（dispose broker + 釋放 lockfile）→ 同 cwd 重新 bootstrap →
    // 廣播 session.rotated frame，attached client 收到後切到新 sessionId。
    {
      const m = /^\/api\/projects\/([^/]+)\/sessions$/.exec(url.pathname)
      if (m && method === 'POST') {
        const id = decodeURIComponent(m[1]!)
        if (!isProjectIdSafe(id)) {
          return errorResponse('BAD_ID', 'invalid project id', 400)
        }
        const existing = registry.getProject(id)
        if (!existing) return errorResponse('NOT_FOUND', `project ${id} not loaded`, 404)
        try {
          const result = await registry.rotateProject(id)
          if (!result) {
            return errorResponse('ROTATE_FAILED', 'rotateProject returned null', 500)
          }
          // 通知所有同 project 的 web client 切到新 sessionId。WS reconnect /
          // hello frame 自然會帶新 sessionId，但 rotated 事件可讓 client 立即
          // 觸發 backfill / 切換 UI 而不必等 ws 重連。
          opts.broadcastToProject?.(id, {
            type: 'session.rotated',
            projectId: id,
            oldSessionId: result.oldSessionId,
            newSessionId: result.newSessionId,
          })
          return jsonResponse(
            {
              sessionId: result.newSessionId,
              oldSessionId: result.oldSessionId,
              projectId: id,
              createdAt: Date.now(),
            },
            201,
          )
        } catch (e) {
          return errorResponse(
            'ROTATE_FAILED',
            e instanceof Error ? e.message : String(e),
            500,
          )
        }
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

    // M-WEB-CLOSEOUT-4：PUT /api/projects/:id/memory — update body / frontmatter
    // body { kind, absolutePath?, filename?, body, frontmatter? { name, description, type }, override? }
    {
      const m = /^\/api\/projects\/([^/]+)\/memory$/.exec(url.pathname)
      if (m && method === 'PUT') {
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
        const newBody = body.body
        if (typeof kind !== 'string' || typeof newBody !== 'string') {
          return errorResponse('BAD_FIELDS', 'kind + body required', 400)
        }
        if (kind === 'daily-log') {
          return errorResponse('READ_ONLY', 'daily-log entries are read-only', 403)
        }
        // 注入掃描（reuse 既有 secretScan）— 命中且未 override 則回 422
        if (!body.override) {
          const { containsSecret } = await import('../utils/web/secretScan.js')
          if (containsSecret(newBody)) {
            return errorResponse(
              'SECRET_DETECTED',
              'body contains potential secret; resend with override:true to confirm',
              422,
            )
          }
        }
        let mutation: MemoryMutationRequest
        if (kind === 'auto-memory') {
          const filename = body.filename
          const fm = body.frontmatter as Record<string, unknown> | undefined
          if (typeof filename !== 'string' || !fm) {
            return errorResponse(
              'BAD_FIELDS',
              'auto-memory update requires filename + frontmatter',
              400,
            )
          }
          if (
            typeof fm.name !== 'string' ||
            typeof fm.description !== 'string' ||
            typeof fm.type !== 'string'
          ) {
            return errorResponse(
              'BAD_FIELDS',
              'frontmatter.name/description/type all required',
              400,
            )
          }
          mutation = {
            type: 'memory.mutation',
            requestId: `web-${Date.now()}`,
            op: 'update',
            payload: {
              kind: 'auto-memory',
              filename,
              name: fm.name,
              description: fm.description,
              type: fm.type as never,
              body: newBody,
            },
          }
        } else {
          const absolutePath = body.absolutePath
          if (typeof absolutePath !== 'string') {
            return errorResponse(
              'BAD_FIELDS',
              `${kind} update requires absolutePath`,
              400,
            )
          }
          // path traversal 防護：path 必須在 entries 列表內
          const entries = listAllMemoryEntries(runtime.cwd)
          const target = resolvePath(absolutePath)
          const allowed = entries.some(
            e => resolvePath(e.absolutePath) === target,
          )
          if (!allowed) {
            return errorResponse(
              'PATH_NOT_ALLOWED',
              'path not in memory entries',
              403,
            )
          }
          mutation = {
            type: 'memory.mutation',
            requestId: `web-${Date.now()}`,
            op: 'update',
            payload: {
              kind: kind as never,
              absolutePath,
              body: newBody,
            },
          }
        }
        const r = await handleMemoryMutation(mutation, {
          projectRoot: runtime.cwd,
          projectId: runtime.projectId,
        })
        if (!r.ok) {
          return errorResponse('MEMORY_UPDATE_FAILED', r.error ?? 'unknown', 400)
        }
        opts.broadcastToProject?.(runtime.projectId, {
          type: 'memory.itemsChanged',
          projectId: runtime.projectId,
        })
        return jsonResponse({ ok: true, message: r.message })
      }
    }

    // M-WEB-CLOSEOUT-4：POST /api/projects/:id/memory — create new entry
    // body { kind: 'auto-memory' | 'local-config', filename, body, frontmatter?, override? }
    {
      const m = /^\/api\/projects\/([^/]+)\/memory$/.exec(url.pathname)
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
        const kind = body.kind
        const filename = body.filename
        const newBody = body.body
        if (
          typeof kind !== 'string' ||
          typeof filename !== 'string' ||
          typeof newBody !== 'string'
        ) {
          return errorResponse(
            'BAD_FIELDS',
            'kind + filename + body required',
            400,
          )
        }
        if (kind !== 'auto-memory' && kind !== 'local-config') {
          return errorResponse(
            'KIND_NOT_CREATABLE',
            `cannot create kind=${kind}; only auto-memory + local-config support create`,
            403,
          )
        }
        if (!body.override) {
          const { containsSecret } = await import('../utils/web/secretScan.js')
          if (containsSecret(newBody)) {
            return errorResponse(
              'SECRET_DETECTED',
              'body contains potential secret; resend with override:true to confirm',
              422,
            )
          }
        }
        let mutation: MemoryMutationRequest
        if (kind === 'auto-memory') {
          const fm = body.frontmatter as Record<string, unknown> | undefined
          if (
            !fm ||
            typeof fm.name !== 'string' ||
            typeof fm.description !== 'string' ||
            typeof fm.type !== 'string'
          ) {
            return errorResponse(
              'BAD_FIELDS',
              'auto-memory create requires frontmatter.name/description/type',
              400,
            )
          }
          mutation = {
            type: 'memory.mutation',
            requestId: `web-${Date.now()}`,
            op: 'create',
            payload: {
              kind: 'auto-memory',
              filename,
              name: fm.name,
              description: fm.description,
              type: fm.type as never,
              body: newBody,
            },
          }
        } else {
          mutation = {
            type: 'memory.mutation',
            requestId: `web-${Date.now()}`,
            op: 'create',
            payload: {
              kind: 'local-config',
              filename,
              body: newBody,
            },
          }
        }
        const r = await handleMemoryMutation(mutation, {
          projectRoot: runtime.cwd,
          projectId: runtime.projectId,
        })
        if (!r.ok) {
          return errorResponse('MEMORY_CREATE_FAILED', r.error ?? 'unknown', 400)
        }
        opts.broadcastToProject?.(runtime.projectId, {
          type: 'memory.itemsChanged',
          projectId: runtime.projectId,
        })
        return jsonResponse({ ok: true, message: r.message })
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

    // ----- M-WEB-20：PNG QR code endpoint（給瀏覽器顯示給手機掃）-----
    if (url.pathname === '/api/qr' && method === 'GET') {
      const target = url.searchParams.get('url')
      if (!target) {
        return errorResponse('MISSING_URL', 'query.url required', 400)
      }
      try {
        const { toBuffer } = await import('qrcode')
        const png = await toBuffer(target, {
          type: 'png',
          errorCorrectionLevel: 'M',
          margin: 2,
          width: 320,
        })
        return new Response(png, {
          status: 200,
          headers: {
            'content-type': 'image/png',
            'cache-control': 'public, max-age=300',
            'access-control-allow-origin': '*',
          },
        })
      } catch (e) {
        return errorResponse(
          'QR_FAILED',
          e instanceof Error ? e.message : String(e),
          500,
        )
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

    // ----- M-LLAMACPP-REMOTE：Endpoints (local + remote) + Routing -----
    if (url.pathname === '/api/llamacpp/endpoints' && method === 'GET') {
      try {
        const cfg = getLlamaCppConfigSnapshot()
        const remote = cfg.remote
        // apiKey masked — UI 不需要看到完整 key
        const maskedRemote = {
          ...remote,
          apiKey:
            remote.apiKey && remote.apiKey.length > 0
              ? remote.apiKey.length <= 6
                ? '***'
                : `${remote.apiKey.slice(0, 3)}***${remote.apiKey.slice(-3)}`
              : undefined,
        }
        return jsonResponse({
          local: {
            baseUrl: cfg.baseUrl,
            model: cfg.model,
            contextSize: cfg.contextSize,
          },
          remote: maskedRemote,
          routing: cfg.routing,
        })
      } catch (e) {
        return errorResponse(
          'LLAMACPP_READ_FAILED',
          e instanceof Error ? e.message : String(e),
          500,
        )
      }
    }
    if (url.pathname === '/api/llamacpp/endpoints/remote' && method === 'PUT') {
      let body: unknown
      try {
        body = await req.json()
      } catch {
        return errorResponse('BAD_JSON', 'invalid JSON body', 400)
      }
      try {
        const r = await writeRemoteConfig(
          body as Parameters<typeof writeRemoteConfig>[0],
        )
        if (!r.ok) {
          return errorResponse('LLAMACPP_WRITE_FAILED', r.error, 400)
        }
        opts.broadcastAll?.({
          type: 'llamacpp.configChanged',
          changedSection: 'remote',
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
    if (url.pathname === '/api/llamacpp/routing' && method === 'PUT') {
      let body: unknown
      try {
        body = await req.json()
      } catch {
        return errorResponse('BAD_JSON', 'invalid JSON body', 400)
      }
      try {
        const r = await writeRoutingConfig(
          body as Parameters<typeof writeRoutingConfig>[0],
        )
        if (!r.ok) {
          return errorResponse('LLAMACPP_WRITE_FAILED', r.error, 400)
        }
        opts.broadcastAll?.({
          type: 'llamacpp.configChanged',
          changedSection: 'routing',
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
    if (
      url.pathname === '/api/llamacpp/endpoints/remote/test' &&
      method === 'POST'
    ) {
      let body: { baseUrl?: string; apiKey?: string; timeoutMs?: number }
      try {
        body = (await req.json()) as typeof body
      } catch {
        return errorResponse('BAD_JSON', 'invalid JSON body', 400)
      }
      if (typeof body.baseUrl !== 'string' || body.baseUrl.length === 0) {
        return errorResponse('BAD_FIELDS', 'baseUrl required', 400)
      }
      const r = await testRemoteEndpoint({
        baseUrl: body.baseUrl,
        apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
        timeoutMs:
          typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
      })
      if (r.ok) return jsonResponse({ ok: true, models: r.models })
      return jsonResponse({ ok: false, error: r.error, status: r.status }, 200)
    }

    // ----- M-WEB-CLOSEOUT-10：Discord admin（status / bindings / bind / unbind / reload / restart）-----
    if (url.pathname.startsWith('/api/discord/')) {
      const ctl = opts.getDiscordController?.() ?? null
      if (!ctl) {
        return errorResponse(
          'DISCORD_NOT_AVAILABLE',
          'discord controller not wired into web server (daemon should expose it)',
          503,
        )
      }
      if (url.pathname === '/api/discord/status' && method === 'GET') {
        return jsonResponse(ctl.getStatus())
      }
      if (url.pathname === '/api/discord/bindings' && method === 'GET') {
        return jsonResponse({ bindings: ctl.listBindings() })
      }
      const broadcastChange = () => {
        opts.broadcastAll?.({ type: 'discord.statusChanged' })
      }
      if (url.pathname === '/api/discord/bind' && method === 'POST') {
        let body: Record<string, unknown>
        try {
          body = (await req.json()) as Record<string, unknown>
        } catch {
          return errorResponse('BAD_JSON', 'invalid JSON body', 400)
        }
        if (typeof body.cwd !== 'string') {
          return errorResponse('BAD_FIELDS', 'cwd required', 400)
        }
        const r = await ctl.bind(
          body.cwd,
          typeof body.projectName === 'string' ? body.projectName : undefined,
        )
        if (!r.ok) {
          return errorResponse('DISCORD_BIND_FAILED', r.error ?? 'unknown', 400)
        }
        broadcastChange()
        return jsonResponse(r)
      }
      if (url.pathname === '/api/discord/unbind' && method === 'POST') {
        let body: Record<string, unknown>
        try {
          body = (await req.json()) as Record<string, unknown>
        } catch {
          return errorResponse('BAD_JSON', 'invalid JSON body', 400)
        }
        if (typeof body.cwd !== 'string') {
          return errorResponse('BAD_FIELDS', 'cwd required', 400)
        }
        const r = await ctl.unbind(body.cwd)
        if (!r.ok) {
          return errorResponse('DISCORD_UNBIND_FAILED', r.error ?? 'unknown', 400)
        }
        broadcastChange()
        return jsonResponse(r)
      }
      if (url.pathname === '/api/discord/reload' && method === 'POST') {
        const r = await ctl.reload()
        if (!r.ok) {
          return errorResponse('DISCORD_RELOAD_FAILED', r.error ?? 'unknown', 400)
        }
        broadcastChange()
        return jsonResponse(r)
      }
      if (url.pathname === '/api/discord/restart' && method === 'POST') {
        const r = await ctl.restart()
        if (!r.ok) {
          return errorResponse('DISCORD_RESTART_FAILED', r.error ?? 'unknown', 400)
        }
        broadcastChange()
        return jsonResponse(r)
      }
      // discord 路徑沒命中 — 回 404
      return errorResponse('NOT_FOUND', `discord endpoint ${url.pathname} not recognized`, 404)
    }

    // ----- M-WEB-CLOSEOUT-1：Llamacpp slots inspector（read-only + erase action）-----
    // M-WEB-PARITY-2：多 client polling 時加 500ms in-memory cache，防止打爆 llamacpp。
    if (url.pathname === '/api/llamacpp/slots' && method === 'GET') {
      const cached = getCachedSlots()
      if (cached) return jsonResponse(cached)
      const r = await fetchSlots()
      const payload = r.ok
        ? { available: true, slots: r.slots }
        : { available: false, reason: r.error, slots: [] }
      setCachedSlots(payload)
      return jsonResponse(payload)
    }
    {
      const m = url.pathname.match(/^\/api\/llamacpp\/slots\/(\d+)\/erase$/)
      if (m && method === 'POST') {
        const slotId = Number(m[1])
        const r = await killSlot(slotId)
        if (r.ok) {
          return jsonResponse({ ok: true })
        }
        if (r.status === 501) {
          return errorResponse(
            'SLOT_ERASE_UNSUPPORTED',
            'server 未啟用 slot cancel — 請以 --slot-save-path 重啟 llama-server',
            501,
          )
        }
        return errorResponse('SLOT_ERASE_FAILED', r.error, r.status ?? 500)
      }
    }

    return null
  }

  return { handle }
}
