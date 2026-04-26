/**
 * M-WEB-CLOSEOUT-4：Memory PUT (update) + POST (create) REST 端點。
 *
 * 用 mock.module 換掉 memoryMutationRpc + memoryList，避免真寫到使用者
 * memdir。重點驗證：
 *   - PUT 更新 user-profile body（path traversal check pass）
 *   - PUT 更新 daily-log → 403 READ_ONLY
 *   - PUT secret 偵測 → 422，加 override:true 後通過
 *   - POST create auto-memory（含 frontmatter）
 *   - POST create kind=user-profile → 403 KIND_NOT_CREATABLE
 *   - PUT path 不在 entries 列表 → 403 PATH_NOT_ALLOWED
 *   - 廣播 memory.itemsChanged
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'
import type {
  ProjectRegistry,
  ProjectRuntime,
} from '../../../src/daemon/projectRegistry.js'

// MACRO shim
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (typeof (globalThis as any).MACRO === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).MACRO = {
    VERSION: 'test',
    BUILD_TIME: new Date().toISOString(),
    PACKAGE_URL: 'test-snapshot',
    FEEDBACK_CHANNEL: 'github',
  }
}

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

function fakeRegistry(rt: ProjectRuntime): ProjectRegistry {
  const projects = new Map<string, ProjectRuntime>([[rt.projectId, rt]])
  return {
    loadProject: async () => rt,
    getProject: id => projects.get(id) ?? null,
    getProjectByCwd: cwd => (rt.cwd === cwd ? rt : null),
    listProjects: () => [...projects.values()],
    unloadProject: async id => projects.delete(id),
    touchActivity: () => {},
    sweepIdle: async () => [],
    onLoad: () => () => {},
    onUnload: () => () => {},
    dispose: async () => {},
  }
}

describe('M-WEB-CLOSEOUT-4：/api/projects/:id/memory PUT + POST', () => {
  let mutationCalls: Array<{ op: string; payload: unknown }>
  let mutationOk: boolean
  let projectId: string
  let cwd: string
  let entries: Array<{
    kind: string
    absolutePath: string
    filename?: string
    displayName: string
    description: string
    sizeBytes: number
    mtimeMs: number
  }>
  let broadcasted: Array<{ projectId: string; frame: unknown }>

  beforeEach(async () => {
    mutationCalls = []
    mutationOk = true
    projectId = 'pid-test'
    cwd = '/test/proj'
    broadcasted = []
    entries = [
      {
        kind: 'user-profile',
        absolutePath: '/global/USER.md',
        filename: 'USER.md',
        displayName: 'USER.md',
        description: 'global user profile',
        sizeBytes: 100,
        mtimeMs: 0,
      },
      {
        kind: 'daily-log',
        absolutePath: '/log/2026-04-26.md',
        filename: '2026-04-26.md',
        displayName: '2026-04-26',
        description: 'daily',
        sizeBytes: 50,
        mtimeMs: 0,
      },
    ]

    const origRpc = await import(
      '../../../src/daemon/memoryMutationRpc.js'
    )
    mock.module('../../../src/daemon/memoryMutationRpc.js', () => ({
      ...origRpc,
      handleMemoryMutation: async (req: { op: string; payload: unknown }) => {
        mutationCalls.push({ op: req.op, payload: req.payload })
        if (mutationOk) {
          return {
            type: 'memory.mutationResult',
            requestId: 'r',
            ok: true,
            message: 'ok',
          }
        }
        return {
          type: 'memory.mutationResult',
          requestId: 'r',
          ok: false,
          error: 'simulated',
        }
      },
    }))

    const origList = await import('../../../src/utils/memoryList.js')
    mock.module('../../../src/utils/memoryList.js', () => ({
      ...origList,
      listAllMemoryEntries: () => entries,
    }))
  })

  async function build() {
    const { createRestRoutes } = await import(
      '../../../src/web/restRoutes.js'
    )
    return createRestRoutes({
      registry: fakeRegistry(fakeRuntime(projectId, cwd)),
      broadcastToProject: (pid, frame) => broadcasted.push({ projectId: pid, frame }),
    })
  }

  test('PUT user-profile body → ok + 廣播', async () => {
    const rest = await build()
    const r = await rest.handle(
      new Request(
        `http://x/api/projects/${projectId}/memory`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            kind: 'user-profile',
            absolutePath: '/global/USER.md',
            body: 'new content',
          }),
        },
      ),
    )
    expect(r!.status).toBe(200)
    expect(mutationCalls).toHaveLength(1)
    expect(mutationCalls[0]!.op).toBe('update')
    expect(broadcasted).toHaveLength(1)
    expect((broadcasted[0]!.frame as { type: string }).type).toBe(
      'memory.itemsChanged',
    )
  })

  test('PUT daily-log → 403 READ_ONLY', async () => {
    const rest = await build()
    const r = await rest.handle(
      new Request(`http://x/api/projects/${projectId}/memory`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'daily-log',
          absolutePath: '/log/2026-04-26.md',
          body: 'tampering',
        }),
      }),
    )
    expect(r!.status).toBe(403)
    const body = (await r!.json()) as { code: string }
    expect(body.code).toBe('READ_ONLY')
    expect(mutationCalls).toHaveLength(0)
  })

  test('PUT body 含 sk_live secret → 422 SECRET_DETECTED', async () => {
    const rest = await build()
    const r = await rest.handle(
      new Request(`http://x/api/projects/${projectId}/memory`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'user-profile',
          absolutePath: '/global/USER.md',
          body: 'my key is sk_live_abc1234567890def',
        }),
      }),
    )
    expect(r!.status).toBe(422)
    const body = (await r!.json()) as { code: string }
    expect(body.code).toBe('SECRET_DETECTED')
    expect(mutationCalls).toHaveLength(0)
  })

  test('PUT body 含 secret + override:true → 通過', async () => {
    const rest = await build()
    const r = await rest.handle(
      new Request(`http://x/api/projects/${projectId}/memory`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'user-profile',
          absolutePath: '/global/USER.md',
          body: 'my key is sk_live_abc1234567890def',
          override: true,
        }),
      }),
    )
    expect(r!.status).toBe(200)
    expect(mutationCalls).toHaveLength(1)
  })

  test('PUT path 不在 entries → 403 PATH_NOT_ALLOWED', async () => {
    const rest = await build()
    const r = await rest.handle(
      new Request(`http://x/api/projects/${projectId}/memory`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'user-profile',
          absolutePath: '/etc/passwd',
          body: 'evil',
        }),
      }),
    )
    expect(r!.status).toBe(403)
    const body = (await r!.json()) as { code: string }
    expect(body.code).toBe('PATH_NOT_ALLOWED')
  })

  test('POST create auto-memory → ok + 廣播', async () => {
    const rest = await build()
    const r = await rest.handle(
      new Request(`http://x/api/projects/${projectId}/memory`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'auto-memory',
          filename: 'feedback_test.md',
          body: 'remember this',
          frontmatter: {
            name: 'test',
            description: 'a test memory',
            type: 'feedback',
          },
        }),
      }),
    )
    expect(r!.status).toBe(200)
    expect(mutationCalls).toHaveLength(1)
    expect(mutationCalls[0]!.op).toBe('create')
    expect(broadcasted).toHaveLength(1)
  })

  test('POST kind=user-profile → 403 KIND_NOT_CREATABLE', async () => {
    const rest = await build()
    const r = await rest.handle(
      new Request(`http://x/api/projects/${projectId}/memory`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'user-profile',
          filename: 'USER.md',
          body: 'evil',
        }),
      }),
    )
    expect(r!.status).toBe(403)
    const body = (await r!.json()) as { code: string }
    expect(body.code).toBe('KIND_NOT_CREATABLE')
    expect(mutationCalls).toHaveLength(0)
  })

  test('POST auto-memory 缺 frontmatter → 400', async () => {
    const rest = await build()
    const r = await rest.handle(
      new Request(`http://x/api/projects/${projectId}/memory`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'auto-memory',
          filename: 'test.md',
          body: 'no fm',
        }),
      }),
    )
    expect(r!.status).toBe(400)
  })

  test('POST create local-config → ok（無 frontmatter 也通過）', async () => {
    const rest = await build()
    const r = await rest.handle(
      new Request(`http://x/api/projects/${projectId}/memory`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'local-config',
          filename: 'CLAUDE.local.md',
          body: 'project-only override',
        }),
      }),
    )
    expect(r!.status).toBe(200)
    expect(mutationCalls).toHaveLength(1)
  })

  test('PUT mutation 失敗 → 400 MEMORY_UPDATE_FAILED', async () => {
    mutationOk = false
    const rest = await build()
    const r = await rest.handle(
      new Request(`http://x/api/projects/${projectId}/memory`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'user-profile',
          absolutePath: '/global/USER.md',
          body: 'fine',
        }),
      }),
    )
    expect(r!.status).toBe(400)
    const body = (await r!.json()) as { code: string; error: string }
    expect(body.code).toBe('MEMORY_UPDATE_FAILED')
    expect(body.error).toBe('simulated')
  })
})
