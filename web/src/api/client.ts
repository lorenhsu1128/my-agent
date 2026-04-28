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
    // M-WEB-CLOSEOUT-4：update / create
    update(
      projectId: string,
      payload: WebMemoryUpdatePayload,
    ): Promise<{ ok: boolean; message?: string }> {
      return request(
        `/api/projects/${encodeURIComponent(projectId)}/memory`,
        { method: 'PUT', json: payload },
      )
    },
    create(
      projectId: string,
      payload: WebMemoryCreatePayload,
    ): Promise<{ ok: boolean; message?: string }> {
      return request(
        `/api/projects/${encodeURIComponent(projectId)}/memory`,
        { method: 'POST', json: payload },
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
    // M-WEB-CLOSEOUT-1：Slot inspector
    getSlots(): Promise<{
      available: boolean
      reason?: string
      slots: WebSlotInfo[]
    }> {
      return request('/api/llamacpp/slots')
    },
    eraseSlot(slotId: number): Promise<{ ok: boolean }> {
      return request(`/api/llamacpp/slots/${slotId}/erase`, {
        method: 'POST',
      })
    },
    // M-LLAMACPP-REMOTE：endpoints + routing
    getEndpoints(): Promise<{
      local: { baseUrl: string; model: string; contextSize: number }
      remote: {
        enabled: boolean
        baseUrl: string
        model: string
        apiKey?: string
        contextSize: number
      }
      routing: Record<
        'turn' | 'sideQuery' | 'memoryPrefetch' | 'background' | 'vision',
        'local' | 'remote'
      >
    }> {
      return request('/api/llamacpp/endpoints')
    },
    setRemote(remote: {
      enabled: boolean
      baseUrl: string
      model: string
      apiKey?: string
      contextSize: number
    }): Promise<{ ok: boolean; message?: string }> {
      return request('/api/llamacpp/endpoints/remote', {
        method: 'PUT',
        json: remote,
      })
    },
    setRouting(routing: Record<string, 'local' | 'remote'>): Promise<{
      ok: boolean
      message?: string
    }> {
      return request('/api/llamacpp/routing', { method: 'PUT', json: routing })
    },
    testRemote(args: {
      baseUrl: string
      apiKey?: string
    }): Promise<{ ok: true; models: string[] } | { ok: false; error: string; status?: number }> {
      return request('/api/llamacpp/endpoints/remote/test', {
        method: 'POST',
        json: args,
      })
    },
  },
  // M-WEB-CLOSEOUT-10：Discord admin（daemon 全域；不需 projectId）
  discord: {
    status(): Promise<WebDiscordStatus> {
      return request('/api/discord/status')
    },
    bindings(): Promise<{ bindings: WebDiscordBinding[] }> {
      return request('/api/discord/bindings')
    },
    bind(
      cwd: string,
      projectName?: string,
    ): Promise<{
      ok: boolean
      channelId?: string
      channelName?: string
      url?: string
      alreadyBound?: boolean
    }> {
      return request('/api/discord/bind', {
        method: 'POST',
        json: { cwd, projectName },
      })
    },
    unbind(cwd: string): Promise<{ ok: boolean }> {
      return request('/api/discord/unbind', {
        method: 'POST',
        json: { cwd },
      })
    },
    reload(): Promise<{ ok: boolean }> {
      return request('/api/discord/reload', { method: 'POST' })
    },
    restart(): Promise<{ ok: boolean }> {
      return request('/api/discord/restart', { method: 'POST' })
    },
  },
  // M-WEB-SLASH-A3：拉 daemon 全 87 個 slash command 的 metadata snapshot
  slashCommands: {
    list(projectId?: string): Promise<{ commands: WebSlashCommandMetadata[] }> {
      const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
      return request(`/api/slash-commands${qs}`)
    },
  },
}

// M-WEB-SLASH-A3：與 src/daemon/slashCommandRegistry.ts SlashCommandMetadata
// 對齊（K2 bridge — 維持 daemon 端 type rename 時要同步改這裡）。
export type WebSlashCommandKind = 'runnable' | 'jsx-handoff' | 'web-redirect'
export interface WebSlashCommandMetadata {
  name: string
  userFacingName: string
  description: string
  argumentHint?: string
  aliases?: string[]
  type: 'prompt' | 'local' | 'local-jsx'
  webKind: WebSlashCommandKind
  handoffKey?: string
  source?: string
  argNames?: string[]
  isHidden?: boolean
  kind?: 'workflow'
  disableModelInvocation?: boolean
}

export interface WebDiscordStatus {
  enabled: boolean
  running: boolean
  guildId?: string
  homeChannelId?: string
  archiveCategoryId?: string
  whitelistUserCount: number
  projectCount: number
  bindingCount: number
  botTag?: string
}

export interface WebDiscordBinding {
  channelId: string
  cwd: string
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

export type MemoryAutoType = 'user' | 'feedback' | 'project' | 'reference'

export interface WebMemoryFrontmatter {
  name: string
  description: string
  type: MemoryAutoType
}

export type WebMemoryUpdatePayload =
  | {
      kind: 'auto-memory'
      filename: string
      body: string
      frontmatter: WebMemoryFrontmatter
      override?: boolean
    }
  | {
      kind: 'user-profile' | 'project-memory' | 'local-config'
      absolutePath: string
      body: string
      override?: boolean
    }

export type WebMemoryCreatePayload =
  | {
      kind: 'auto-memory'
      filename: string
      body: string
      frontmatter: WebMemoryFrontmatter
      override?: boolean
    }
  | {
      kind: 'local-config'
      filename: string
      body: string
      override?: boolean
    }

export interface WebSlotInfo {
  id: number
  isProcessing: boolean
  nDecoded: number
  nRemain: number
  hasNextToken: boolean
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
