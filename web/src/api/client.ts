/**
 * M-WEB browser → daemon REST API client。
 *
 * - 預設走相對 URL（同 origin），dev 模式靠 vite proxy 把 /api → daemon
 * - 統一錯誤格式：fail 時 throw `ApiError`，含 status + code + message
 */
import type {
  IndexedMessage,
  WebProjectInfo,
  WebSessionInfo,
} from './types'

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const headers: Record<string, string> = init?.headers
    ? { ...(init.headers as Record<string, string>) }
    : {}
  let body = init?.body
  if (init?.json !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(init.json)
  }
  const res = await fetch(path, { ...init, headers, body })
  if (res.status === 204) return undefined as never
  const text = await res.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      throw new ApiError(res.status, 'BAD_JSON', `bad json from ${path}`)
    }
  }
  if (!res.ok) {
    const obj = (data as { error?: string; code?: string }) ?? {}
    throw new ApiError(
      res.status,
      obj.code ?? `HTTP_${res.status}`,
      obj.error ?? res.statusText,
    )
  }
  return data as T
}

export const api = {
  health(): Promise<{ ok: boolean; serverTime: number; uptimeMs: number }> {
    return request('/api/health')
  },
  version(): Promise<{ agentVersion: string; api: string }> {
    return request('/api/version')
  },
  listProjects(): Promise<{ projects: WebProjectInfo[] }> {
    return request('/api/projects')
  },
  getProject(id: string): Promise<{ project: WebProjectInfo }> {
    return request(`/api/projects/${encodeURIComponent(id)}`)
  },
  loadProject(cwd: string): Promise<{ project: WebProjectInfo }> {
    return request('/api/projects', { method: 'POST', json: { cwd } })
  },
  unloadProject(id: string): Promise<{ ok: boolean }> {
    return request(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  },
  listSessions(projectId: string): Promise<{
    sessions: WebSessionInfo[]
    activeSessionId: string
  }> {
    return request(
      `/api/projects/${encodeURIComponent(projectId)}/sessions`,
    )
  },
  // M-WEB-22：messages backfill — 從 sessionIndex（FTS5 表）拉某 session 最近 N 條
  messages: {
    list(
      projectId: string,
      sessionId: string,
      opts?: { before?: number; limit?: number },
    ): Promise<{ messages: IndexedMessage[]; sessionId: string }> {
      const params = new URLSearchParams()
      if (opts?.before !== undefined) params.set('before', String(opts.before))
      if (opts?.limit !== undefined) params.set('limit', String(opts.limit))
      const qs = params.toString()
      return request(
        `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/messages${qs ? '?' + qs : ''}`,
      )
    },
  },
  // M-WEB-14：cron CRUD
  cron: {
    list(projectId: string): Promise<{ tasks: WebCronTask[] }> {
      return request(`/api/projects/${encodeURIComponent(projectId)}/cron`)
    },
    create(
      projectId: string,
      payload: {
        cron: string
        prompt: string
        recurring?: boolean
        name?: string
        preRunScript?: string
        modelOverride?: string
      },
    ): Promise<{ task: WebCronTask; taskId: string }> {
      return request(
        `/api/projects/${encodeURIComponent(projectId)}/cron`,
        { method: 'POST', json: payload },
      )
    },
    pause(projectId: string, taskId: string) {
      return request(
        `/api/projects/${encodeURIComponent(projectId)}/cron/${encodeURIComponent(taskId)}`,
        { method: 'PATCH', json: { op: 'pause' } },
      )
    },
    resume(projectId: string, taskId: string) {
      return request(
        `/api/projects/${encodeURIComponent(projectId)}/cron/${encodeURIComponent(taskId)}`,
        { method: 'PATCH', json: { op: 'resume' } },
      )
    },
    update(
      projectId: string,
      taskId: string,
      patch: Partial<WebCronTask>,
    ): Promise<{ task: WebCronTask }> {
      return request(
        `/api/projects/${encodeURIComponent(projectId)}/cron/${encodeURIComponent(taskId)}`,
        { method: 'PATCH', json: { op: 'update', patch } },
      )
    },
    delete(projectId: string, taskId: string): Promise<{ ok: boolean }> {
      return request(
        `/api/projects/${encodeURIComponent(projectId)}/cron/${encodeURIComponent(taskId)}`,
        { method: 'DELETE' },
      )
    },
  },
  // M-WEB-15：Memory（read + delete；編輯 wizard M-WEB-15b 補）
  memory: {
    list(projectId: string): Promise<{ entries: WebMemoryEntry[] }> {
      return request(`/api/projects/${encodeURIComponent(projectId)}/memory`)
    },
    body(projectId: string, absolutePath: string): Promise<{ body: string }> {
      return request(
        `/api/projects/${encodeURIComponent(projectId)}/memory/body?path=${encodeURIComponent(absolutePath)}`,
      )
    },
    delete(
      projectId: string,
      payload: { kind: string; absolutePath: string; filename?: string },
    ): Promise<{ ok: boolean }> {
      return request(
        `/api/projects/${encodeURIComponent(projectId)}/memory`,
        { method: 'DELETE', json: payload },
      )
    },
  },
  // M-WEB-16：Llamacpp watchdog（daemon 全域；不需 projectId）
  llamacpp: {
    getWatchdog(): Promise<{ config: WebWatchdogConfig }> {
      return request('/api/llamacpp/watchdog')
    },
    setWatchdog(config: WebWatchdogConfig): Promise<{ ok: boolean }> {
      return request('/api/llamacpp/watchdog', {
        method: 'PUT',
        json: config,
      })
    },
  },
}

export interface WebMemoryEntry {
  kind:
    | 'auto-memory'
    | 'user-profile'
    | 'project-memory'
    | 'local-config'
    | 'daily-log'
  displayName: string
  description: string
  absolutePath: string
  filename?: string
  sizeBytes: number
  mtimeMs: number
  userProfileScope?: 'global' | 'project'
}

export interface WebWatchdogConfig {
  enabled: boolean
  interChunk: { enabled: boolean; gapMs: number }
  reasoning: { enabled: boolean; blockMs: number }
  tokenCap: {
    enabled: boolean
    default: number
    memoryPrefetch: number
    sideQuery: number
    background: number
  }
}

// 輕量鏡像（避免 import daemon types）。寫入欄位才列；讀回的 task 含更多 optional 欄位。
export interface WebCronTask {
  id: string
  cron: string
  prompt: string
  createdAt: number
  recurring?: boolean
  name?: string
  state?: 'scheduled' | 'paused' | 'completed'
  lastFiredAt?: number
  lastStatus?: 'ok' | 'error'
  pausedAt?: string
  scheduleSpec?: { kind: 'cron' | 'nl'; raw: string }
  preRunScript?: string
  modelOverride?: string
}
