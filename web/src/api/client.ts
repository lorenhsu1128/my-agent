/**
 * M-WEB browser → daemon REST API client。
 *
 * - 預設走相對 URL（同 origin），dev 模式靠 vite proxy 把 /api → daemon
 * - 統一錯誤格式：fail 時 throw `ApiError`，含 status + code + message
 */
import type { WebProjectInfo, WebSessionInfo } from './types'

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
}
