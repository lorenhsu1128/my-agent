/**
 * M-DISCORD-5：ProjectRegistry onLoad / onUnload listener 測試。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  createFakeProjectRuntime,
  createProjectRegistry,
  projectIdFromCwd,
  type ProjectRegistry,
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

describe('ProjectRegistry onLoad / onUnload listeners', () => {
  test('onLoad fires once per new runtime; cache hit does NOT refire', async () => {
    const loaded: string[] = []
    registry = createProjectRegistry({
      factory: async ({ cwd, projectId }) =>
        createFakeProjectRuntime({ cwd, projectId }),
    })
    registry.onLoad(r => loaded.push(r.projectId))
    await registry.loadProject('/tmp/p1')
    await registry.loadProject('/tmp/p1') // cache hit
    await registry.loadProject('/tmp/p2')
    expect(loaded.length).toBe(2)
    expect(loaded).toEqual([
      projectIdFromCwd('/tmp/p1'),
      projectIdFromCwd('/tmp/p2'),
    ])
  })

  test('onUnload fires with reason=manual / idle / shutdown', async () => {
    const events: Array<[string, string]> = []
    let t = 0
    registry = createProjectRegistry({
      factory: async ({ cwd, projectId }) =>
        createFakeProjectRuntime({ cwd, projectId }),
      idleMs: 100,
      now: () => t,
    })
    registry.onUnload(info => events.push([info.projectId, info.reason]))

    const id1 = projectIdFromCwd('/tmp/u1')
    const id2 = projectIdFromCwd('/tmp/u2')
    const id3 = projectIdFromCwd('/tmp/u3')

    // manual
    await registry.loadProject('/tmp/u1')
    await registry.unloadProject(id1)

    // idle sweep
    await registry.loadProject('/tmp/u2')
    t = 1000
    await registry.sweepIdle()

    // shutdown
    await registry.loadProject('/tmp/u3')
    await registry.dispose()
    registry = null // avoid double dispose in afterEach

    expect(events).toEqual([
      [id1, 'manual'],
      [id2, 'idle'],
      [id3, 'shutdown'],
    ])
  })

  test('multiple listeners each fire; unsub stops', async () => {
    registry = createProjectRegistry({
      factory: async ({ cwd, projectId }) =>
        createFakeProjectRuntime({ cwd, projectId }),
    })
    const a: string[] = []
    const b: string[] = []
    const unsubA = registry.onLoad(r => a.push(r.projectId))
    registry.onLoad(r => b.push(r.projectId))

    await registry.loadProject('/tmp/m1')
    expect(a.length).toBe(1)
    expect(b.length).toBe(1)

    unsubA()
    await registry.loadProject('/tmp/m2')
    expect(a.length).toBe(1) // unsubbed
    expect(b.length).toBe(2)
  })

  test('listener error does not break others', async () => {
    registry = createProjectRegistry({
      factory: async ({ cwd, projectId }) =>
        createFakeProjectRuntime({ cwd, projectId }),
    })
    const b: string[] = []
    registry.onLoad(() => {
      throw new Error('boom')
    })
    registry.onLoad(r => b.push(r.projectId))

    // 不 throw；b listener 仍然 fire
    await registry.loadProject('/tmp/err1')
    expect(b.length).toBe(1)
  })
})
