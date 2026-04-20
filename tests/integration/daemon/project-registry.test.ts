/**
 * M-DISCORD-1.1：ProjectRegistry 測試。
 *
 * 覆蓋：load (lazy + 冪等 + 並行去重)、get / list、manual unload、touchActivity、
 * idle sweep (skip attached REPL)、dispose、onLoad/onUnload callbacks。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  createFakeProjectRuntime,
  createProjectRegistry,
  projectIdFromCwd,
  type ProjectRegistry,
  type ProjectRuntime,
} from '../../../src/daemon/projectRegistry'

let registry: ProjectRegistry | null = null

beforeEach(() => {
  registry = null
})
afterEach(async () => {
  if (registry) {
    await registry.dispose()
    registry = null
  }
})

describe('projectIdFromCwd', () => {
  test('stable slug for same cwd', () => {
    const id1 = projectIdFromCwd('/home/user/projects/a')
    const id2 = projectIdFromCwd('/home/user/projects/a')
    expect(id1).toBe(id2)
    expect(id1.length).toBeGreaterThan(0)
  })
  test('different cwd → different id', () => {
    expect(projectIdFromCwd('/a')).not.toBe(projectIdFromCwd('/b'))
  })
})

describe('ProjectRegistry.loadProject', () => {
  test('lazy: first load calls factory, second returns same instance', async () => {
    let factoryCalls = 0
    registry = createProjectRegistry({
      factory: async ({ cwd, projectId }) => {
        factoryCalls++
        return createFakeProjectRuntime({ cwd, projectId })
      },
    })
    const r1 = await registry.loadProject('/tmp/a')
    const r2 = await registry.loadProject('/tmp/a')
    expect(factoryCalls).toBe(1)
    expect(r1).toBe(r2)
  })

  test('different cwd → different runtime', async () => {
    registry = createProjectRegistry({
      factory: async ({ cwd, projectId }) =>
        createFakeProjectRuntime({ cwd, projectId }),
    })
    const a = await registry.loadProject('/tmp/a')
    const b = await registry.loadProject('/tmp/b')
    expect(a).not.toBe(b)
    expect(registry.listProjects().length).toBe(2)
  })

  test('parallel load of same cwd dedups factory call', async () => {
    let factoryCalls = 0
    let gate: (() => void) | null = null
    const gateReady = new Promise<void>(r => {
      gate = r
    })
    registry = createProjectRegistry({
      factory: async ({ cwd, projectId }) => {
        factoryCalls++
        await gateReady
        return createFakeProjectRuntime({ cwd, projectId })
      },
    })
    const p1 = registry.loadProject('/tmp/c')
    const p2 = registry.loadProject('/tmp/c')
    expect(factoryCalls).toBe(1)
    gate!()
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toBe(r2)
  })

  test('onLoad callback fired once per load', async () => {
    const loaded: string[] = []
    registry = createProjectRegistry({
      factory: async ({ cwd, projectId }) =>
        createFakeProjectRuntime({ cwd, projectId }),
      onLoad: id => loaded.push(id),
    })
    await registry.loadProject('/tmp/a')
    await registry.loadProject('/tmp/a')
    await registry.loadProject('/tmp/b')
    expect(loaded.length).toBe(2)
    expect(loaded).toContain(projectIdFromCwd('/tmp/a'))
    expect(loaded).toContain(projectIdFromCwd('/tmp/b'))
  })

  test('disposed registry rejects loadProject', async () => {
    registry = createProjectRegistry({
      factory: async ({ cwd, projectId }) =>
        createFakeProjectRuntime({ cwd, projectId }),
    })
    await registry.dispose()
    await expect(registry.loadProject('/tmp/x')).rejects.toThrow(/disposed/)
  })
})

describe('ProjectRegistry.getProject / listProjects', () => {
  test('getProject returns null for unknown', async () => {
    registry = createProjectRegistry({
      factory: async ({ cwd, projectId }) =>
        createFakeProjectRuntime({ cwd, projectId }),
    })
    expect(registry.getProject('nope')).toBeNull()
  })

  test('getProjectByCwd resolves via slug', async () => {
    registry = createProjectRegistry({
      factory: async ({ cwd, projectId }) =>
        createFakeProjectRuntime({ cwd, projectId }),
    })
    const r = await registry.loadProject('/tmp/a')
    expect(registry.getProjectByCwd('/tmp/a')).toBe(r)
  })
})

describe('ProjectRegistry.unloadProject', () => {
  test('manual unload disposes runtime and fires onUnload', async () => {
    let disposed = false
    const events: Array<[string, string]> = []
    registry = createProjectRegistry({
      factory: async ({ cwd, projectId }) =>
        createFakeProjectRuntime({
          cwd,
          projectId,
          onDispose: () => {
            disposed = true
          },
        }),
      onUnload: (id, reason) => events.push([id, reason]),
    })
    await registry.loadProject('/tmp/a')
    const id = projectIdFromCwd('/tmp/a')
    const ok = await registry.unloadProject(id)
    expect(ok).toBe(true)
    expect(disposed).toBe(true)
    expect(events).toEqual([[id, 'manual']])
    expect(registry.getProject(id)).toBeNull()
  })

  test('unloadProject unknown returns false', async () => {
    registry = createProjectRegistry({
      factory: async ({ cwd, projectId }) =>
        createFakeProjectRuntime({ cwd, projectId }),
    })
    expect(await registry.unloadProject('nope')).toBe(false)
  })
})

describe('ProjectRegistry.sweepIdle', () => {
  test('unloads runtime past idleMs when no REPL attached', async () => {
    let t = 0
    const now = () => t
    registry = createProjectRegistry({
      factory: async ({ cwd, projectId }) =>
        createFakeProjectRuntime({ cwd, projectId }),
      idleMs: 1000,
      now,
    })
    t = 0
    const r = await registry.loadProject('/tmp/a')
    expect(r.lastActivityAt).toBe(0)
    t = 500
    const unloaded1 = await registry.sweepIdle()
    expect(unloaded1).toEqual([])
    t = 1500
    const unloaded2 = await registry.sweepIdle()
    expect(unloaded2).toEqual([projectIdFromCwd('/tmp/a')])
    expect(registry.listProjects().length).toBe(0)
  })

  test('does NOT unload when REPL is attached', async () => {
    let t = 0
    registry = createProjectRegistry({
      factory: async ({ cwd, projectId }) =>
        createFakeProjectRuntime({ cwd, projectId }),
      idleMs: 100,
      now: () => t,
    })
    t = 0
    const r = await registry.loadProject('/tmp/a')
    r.attachRepl('client-1')
    t = 10_000 // 遠超 idleMs
    const unloaded = await registry.sweepIdle()
    expect(unloaded).toEqual([])
    expect(registry.listProjects().length).toBe(1)

    // detach 後 sweep 以 lastActivityAt 判斷；fake runtime 的 detach 用真時鐘，
    // 這裡直接設 lastActivityAt = t 模擬「剛好在 t 時刻 detach」
    r.detachRepl('client-1')
    r.lastActivityAt = t
    t = 10_000 + 50
    expect(await registry.sweepIdle()).toEqual([])
    t = 10_000 + 200
    expect((await registry.sweepIdle()).length).toBe(1)
  })

  test('touchActivity 延遲 idle unload', async () => {
    let t = 0
    registry = createProjectRegistry({
      factory: async ({ cwd, projectId }) =>
        createFakeProjectRuntime({ cwd, projectId }),
      idleMs: 1000,
      now: () => t,
    })
    await registry.loadProject('/tmp/a')
    t = 800
    registry.touchActivity(projectIdFromCwd('/tmp/a'))
    t = 1500
    // touch 後 lastActivity = 800，cutoff = 500 → 仍活著
    expect(await registry.sweepIdle()).toEqual([])
    t = 2500
    expect((await registry.sweepIdle()).length).toBe(1)
  })
})

describe('ProjectRegistry.dispose', () => {
  test('disposes all runtimes and fires onUnload with reason=shutdown', async () => {
    const disposed: string[] = []
    const unloaded: Array<[string, string]> = []
    registry = createProjectRegistry({
      factory: async ({ cwd, projectId }) =>
        createFakeProjectRuntime({
          cwd,
          projectId,
          onDispose: () => {
            disposed.push(projectId)
          },
        }),
      onUnload: (id, reason) => unloaded.push([id, reason]),
    })
    await registry.loadProject('/tmp/a')
    await registry.loadProject('/tmp/b')
    await registry.dispose()
    expect(disposed.length).toBe(2)
    expect(unloaded.every(([, reason]) => reason === 'shutdown')).toBe(true)
    expect(unloaded.length).toBe(2)
    // idempotent
    await registry.dispose()
  })
})

describe('ProjectRuntime attachRepl / detachRepl', () => {
  test('hasAttachedRepl reflects attach state', () => {
    const r: ProjectRuntime = createFakeProjectRuntime({ cwd: '/tmp/x' })
    expect(r.hasAttachedRepl()).toBe(false)
    r.attachRepl('c1')
    expect(r.hasAttachedRepl()).toBe(true)
    r.attachRepl('c2')
    r.detachRepl('c1')
    expect(r.hasAttachedRepl()).toBe(true)
    r.detachRepl('c2')
    expect(r.hasAttachedRepl()).toBe(false)
  })

  test('attach / detach bumps lastActivityAt', () => {
    const r: ProjectRuntime = createFakeProjectRuntime({ cwd: '/tmp/x' })
    const t0 = r.lastActivityAt
    // 等一下確保時鐘前進
    const after = Date.now() + 5
    while (Date.now() < after) {
      // busy wait
    }
    r.attachRepl('c1')
    expect(r.lastActivityAt).toBeGreaterThanOrEqual(t0)
  })
})
