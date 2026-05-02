/**
 * M-WEB-8：REST routes 單元測試（fake registry）。
 */
import { describe, expect, test, beforeEach } from 'bun:test'
import { createRestRoutes } from '../../../src/web/restRoutes.js'
import type {
  ProjectRegistry,
  ProjectRuntime,
} from '../../../src/daemon/projectRegistry.js'

function fakeRuntime(projectId: string, cwd: string): ProjectRuntime {
  const replIds = new Set<string>()
  return {
    projectId,
    cwd,
    context: {} as never,
    sessionHandle: { sessionId: 'sess-' + projectId } as never,
    broker: {} as never,
    permissionRouter: {} as never,
    cron: {} as never,
    lastActivityAt: 1234,
    attachedReplIds: replIds,
    hasAttachedRepl: () => replIds.size > 0,
    touch: () => {},
    attachRepl: id => replIds.add(id),
    detachRepl: id => replIds.delete(id),
    dispose: async () => {},
  }
}

function fakeRegistry(over?: {
  loadProject?: (cwd: string) => Promise<ProjectRuntime>
  unload?: (id: string) => Promise<boolean>
}): ProjectRegistry {
  const projects = new Map<string, ProjectRuntime>()
  return {
    loadProject:
      over?.loadProject ??
      (async cwd => {
        const id = `pid-${cwd.replace(/[/\\]/g, '_')}`
        if (!projects.has(id)) projects.set(id, fakeRuntime(id, cwd))
        return projects.get(id)!
      }),
    getProject: id => projects.get(id) ?? null,
    getProjectByCwd: cwd => {
      for (const p of projects.values()) if (p.cwd === cwd) return p
      return null
    },
    listProjects: () => [...projects.values()],
    unloadProject:
      over?.unload ??
      (async id => {
        return projects.delete(id)
      }),
    rotateProject: async id => {
      const old = projects.get(id)
      if (!old) return null
      const cwd = old.cwd
      const oldSessionId = old.sessionHandle.sessionId
      projects.delete(id)
      const fresh = fakeRuntime(id, cwd)
      // 模擬 rotate：sessionId 換新
      ;(fresh.sessionHandle as unknown as { sessionId: string }).sessionId =
        'sess-' + id + '-rotated-' + Date.now()
      projects.set(id, fresh)
      return {
        oldSessionId,
        newSessionId: fresh.sessionHandle.sessionId,
        runtime: fresh,
      }
    },
    touchActivity: () => {},
    sweepIdle: async () => [],
    onLoad: () => () => {},
    onUnload: () => () => {},
    dispose: async () => {},
  }
}

describe('REST /api/* routes', () => {
  let reg: ProjectRegistry
  let rest: ReturnType<typeof createRestRoutes>

  beforeEach(() => {
    reg = fakeRegistry()
    rest = createRestRoutes({ registry: reg })
  })

  test('returns null for non-/api paths', async () => {
    const r = await rest.handle(new Request('http://x/index.html'))
    expect(r).toBeNull()
  })

  test('GET /api/version → ok', async () => {
    const r = await rest.handle(new Request('http://x/api/version'))
    expect(r!.status).toBe(200)
    const body = (await r!.json()) as { api: string }
    expect(body.api).toBe('m-web/1')
  })

  test('GET /api/projects (empty) → []', async () => {
    const r = await rest.handle(new Request('http://x/api/projects'))
    expect(r!.status).toBe(200)
    const body = (await r!.json()) as { projects: unknown[] }
    expect(body.projects).toEqual([])
  })

  test('POST /api/projects { cwd } → loads + returns project', async () => {
    const r = await rest.handle(
      new Request('http://x/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: '/path/to/project' }),
      }),
    )
    expect(r!.status).toBe(201)
    const body = (await r!.json()) as { project: { cwd: string; projectId: string } }
    expect(body.project.cwd).toBe('/path/to/project')
    expect(body.project.projectId).toMatch(/^pid-/)
    // 接著 GET /api/projects 應看到
    const r2 = await rest.handle(new Request('http://x/api/projects'))
    const body2 = (await r2!.json()) as { projects: { cwd: string }[] }
    expect(body2.projects.length).toBe(1)
    expect(body2.projects[0]!.cwd).toBe('/path/to/project')
  })

  test('POST /api/projects bad body → 400', async () => {
    const r = await rest.handle(
      new Request('http://x/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not-json{{{',
      }),
    )
    expect(r!.status).toBe(400)
    const body = (await r!.json()) as { code: string }
    expect(body.code).toBe('BAD_JSON')
  })

  test('POST /api/projects missing cwd → 400', async () => {
    const r = await rest.handle(
      new Request('http://x/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    )
    expect(r!.status).toBe(400)
    const body = (await r!.json()) as { code: string }
    expect(body.code).toBe('MISSING_CWD')
  })

  test('POST /api/projects loadProject throws → 500', async () => {
    const reg2 = fakeRegistry({
      loadProject: async () => {
        throw new Error('disk full')
      },
    })
    const rest2 = createRestRoutes({ registry: reg2 })
    const r = await rest2.handle(
      new Request('http://x/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: '/a' }),
      }),
    )
    expect(r!.status).toBe(500)
    const body = (await r!.json()) as { code: string }
    expect(body.code).toBe('LOAD_FAILED')
  })

  test('GET /api/projects/:id → returns single', async () => {
    await reg.loadProject('/p1')
    const id = reg.listProjects()[0]!.projectId
    const r = await rest.handle(
      new Request(`http://x/api/projects/${encodeURIComponent(id)}`),
    )
    expect(r!.status).toBe(200)
    const body = (await r!.json()) as { project: { projectId: string } }
    expect(body.project.projectId).toBe(id)
  })

  test('GET /api/projects/:id missing → 404', async () => {
    const r = await rest.handle(
      new Request('http://x/api/projects/missing-id'),
    )
    expect(r!.status).toBe(404)
  })

  test('DELETE /api/projects/:id → unloads', async () => {
    await reg.loadProject('/p1')
    const id = reg.listProjects()[0]!.projectId
    const r = await rest.handle(
      new Request(`http://x/api/projects/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    )
    expect(r!.status).toBe(200)
    expect(reg.listProjects().length).toBe(0)
  })

  test('DELETE /api/projects/:id missing → 404', async () => {
    const r = await rest.handle(
      new Request('http://x/api/projects/nope', { method: 'DELETE' }),
    )
    expect(r!.status).toBe(404)
  })

  test('GET /api/projects/:id/sessions → current session stub', async () => {
    await reg.loadProject('/p1')
    const id = reg.listProjects()[0]!.projectId
    const r = await rest.handle(
      new Request(`http://x/api/projects/${encodeURIComponent(id)}/sessions`),
    )
    expect(r!.status).toBe(200)
    const body = (await r!.json()) as {
      sessions: { sessionId: string; isActive: boolean }[]
      activeSessionId: string
    }
    expect(body.sessions.length).toBe(1)
    expect(body.sessions[0]!.isActive).toBe(true)
    expect(body.activeSessionId).toBe(body.sessions[0]!.sessionId)
  })

  test('POST /api/projects/:id/sessions → 201 rotate (新 sessionId 不同舊的，且廣播 session.rotated)', async () => {
    await reg.loadProject('/p1')
    const id = reg.listProjects()[0]!.projectId
    const oldSessionId = reg.getProject(id)!.sessionHandle.sessionId
    const broadcasts: { projectId: string; payload: unknown }[] = []
    const restWithBroadcast = createRestRoutes({
      registry: reg,
      broadcastToProject: (pid, payload) => broadcasts.push({ projectId: pid, payload }),
    })
    const r = await restWithBroadcast.handle(
      new Request(`http://x/api/projects/${encodeURIComponent(id)}/sessions`, {
        method: 'POST',
      }),
    )
    expect(r!.status).toBe(201)
    const body = (await r!.json()) as {
      sessionId: string
      oldSessionId: string
      projectId: string
    }
    expect(body.oldSessionId).toBe(oldSessionId)
    expect(body.sessionId).not.toBe(oldSessionId)
    expect(body.projectId).toBe(id)
    // broadcast 至少 1 次 session.rotated
    const rotated = broadcasts.find(
      b =>
        (b.payload as { type?: string }).type === 'session.rotated' &&
        b.projectId === id,
    )
    expect(rotated).toBeDefined()
  })

  test('POST /api/projects/:id/sessions → 404 if not loaded', async () => {
    const r = await rest.handle(
      new Request(`http://x/api/projects/nonexistent/sessions`, {
        method: 'POST',
      }),
    )
    expect(r!.status).toBe(404)
  })

  test('OPTIONS preflight → 204', async () => {
    const r = await rest.handle(
      new Request('http://x/api/projects', { method: 'OPTIONS' }),
    )
    expect(r!.status).toBe(204)
    expect(r!.headers.get('access-control-allow-methods')).toContain('POST')
  })

  test('CORS headers on JSON responses', async () => {
    const r = await rest.handle(new Request('http://x/api/projects'))
    expect(r!.headers.get('access-control-allow-origin')).toBe('*')
  })
})
