/**
 * M-WEB-CLOSEOUT-1：Llamacpp slot inspector REST 端點。
 *
 * 用 mock.module 換掉 llamacppMutations 的 fetchSlots / killSlot，
 * 驗證 REST handler 對成功 / 失敗 / 501 三種情境的對應行為。
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

function fakeRegistry(): ProjectRegistry {
  const projects = new Map<string, ProjectRuntime>()
  return {
    loadProject: async cwd => {
      const id = `pid-${cwd.replace(/[/\\]/g, '_')}`
      if (!projects.has(id)) projects.set(id, fakeRuntime(id, cwd))
      return projects.get(id)!
    },
    getProject: id => projects.get(id) ?? null,
    getProjectByCwd: cwd => {
      for (const p of projects.values()) if (p.cwd === cwd) return p
      return null
    },
    listProjects: () => [...projects.values()],
    unloadProject: async id => projects.delete(id),
    touchActivity: () => {},
    sweepIdle: async () => [],
    onLoad: () => () => {},
    onUnload: () => () => {},
    dispose: async () => {},
  }
}

describe('M-WEB-CLOSEOUT-1：/api/llamacpp/slots', () => {
  let mockFetchSlotsResult:
    | { ok: true; slots: unknown[] }
    | { ok: false; error: string }
  let mockKillSlotResult:
    | { ok: true }
    | { ok: false; error: string; status?: number }
  let killCalledWith: number | null

  beforeEach(async () => {
    mockFetchSlotsResult = { ok: true, slots: [] }
    mockKillSlotResult = { ok: true }
    killCalledWith = null
    // 沿用 M-MEMRECALL-LOCAL 的 mock pattern：spread 原 module 再覆蓋 export
    const orig = await import(
      '../../../src/commands/llamacpp/llamacppMutations.js'
    )
    mock.module('../../../src/commands/llamacpp/llamacppMutations.js', () => ({
      ...orig,
      fetchSlots: async () => mockFetchSlotsResult,
      killSlot: async (id: number) => {
        killCalledWith = id
        return mockKillSlotResult
      },
    }))
  })

  async function buildHandler() {
    const { createRestRoutes } = await import(
      '../../../src/web/restRoutes.js'
    )
    return createRestRoutes({ registry: fakeRegistry() })
  }

  test('GET /api/llamacpp/slots → server up returns slots[]', async () => {
    mockFetchSlotsResult = {
      ok: true,
      slots: [
        { id: 0, isProcessing: false, nDecoded: 0, nRemain: 0, hasNextToken: false },
        { id: 1, isProcessing: true, nDecoded: 1234, nRemain: 5678, hasNextToken: true },
      ],
    }
    const rest = await buildHandler()
    const r = await rest.handle(
      new Request('http://x/api/llamacpp/slots'),
    )
    expect(r!.status).toBe(200)
    const body = (await r!.json()) as { available: boolean; slots: unknown[] }
    expect(body.available).toBe(true)
    expect(body.slots).toHaveLength(2)
  })

  test('GET /api/llamacpp/slots → server down returns available:false + reason', async () => {
    mockFetchSlotsResult = { ok: false, error: 'ECONNREFUSED' }
    const rest = await buildHandler()
    const r = await rest.handle(
      new Request('http://x/api/llamacpp/slots'),
    )
    expect(r!.status).toBe(200)
    const body = (await r!.json()) as {
      available: boolean
      reason?: string
      slots: unknown[]
    }
    expect(body.available).toBe(false)
    expect(body.reason).toBe('ECONNREFUSED')
    expect(body.slots).toEqual([])
  })

  test('POST /api/llamacpp/slots/3/erase → ok', async () => {
    mockKillSlotResult = { ok: true }
    const rest = await buildHandler()
    const r = await rest.handle(
      new Request('http://x/api/llamacpp/slots/3/erase', { method: 'POST' }),
    )
    expect(r!.status).toBe(200)
    expect(killCalledWith).toBe(3)
    const body = (await r!.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  test('POST /api/llamacpp/slots/0/erase → 501 unsupported', async () => {
    mockKillSlotResult = { ok: false, error: 'not supported', status: 501 }
    const rest = await buildHandler()
    const r = await rest.handle(
      new Request('http://x/api/llamacpp/slots/0/erase', { method: 'POST' }),
    )
    expect(r!.status).toBe(501)
    const body = (await r!.json()) as { code: string }
    expect(body.code).toBe('SLOT_ERASE_UNSUPPORTED')
  })

  test('POST /api/llamacpp/slots/0/erase → generic failure 500', async () => {
    mockKillSlotResult = { ok: false, error: 'broken' }
    const rest = await buildHandler()
    const r = await rest.handle(
      new Request('http://x/api/llamacpp/slots/0/erase', { method: 'POST' }),
    )
    expect(r!.status).toBe(500)
    const body = (await r!.json()) as { code: string; error: string }
    expect(body.code).toBe('SLOT_ERASE_FAILED')
    expect(body.error).toBe('broken')
  })

  test('GET /api/llamacpp/slots/3 (no /erase) → 404 (falls through)', async () => {
    const rest = await buildHandler()
    const r = await rest.handle(
      new Request('http://x/api/llamacpp/slots/3'),
    )
    expect(r).toBeNull()
  })
})
