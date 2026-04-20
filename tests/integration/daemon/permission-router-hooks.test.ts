/**
 * M-DISCORD-4：permissionRouter 新增的 onPending / onResolved / listPendingIds
 * 測試。
 */
import { describe, expect, test } from 'bun:test'
import { createPermissionRouter } from '../../../src/daemon/permissionRouter'
import type { DirectConnectServerHandle } from '../../../src/server/directConnectServer'
import type { ClientRegistry } from '../../../src/server/clientRegistry'

function fakeServer(): DirectConnectServerHandle {
  return {
    host: '127.0.0.1',
    port: 0,
    registry: {} as ClientRegistry,
    broadcast: () => 0,
    send: () => true,
    async stop() {},
  }
}

function fakeTool(): Parameters<
  ReturnType<typeof createPermissionRouter>['canUseTool']
>[0] {
  // Minimal tool implementing the bits router needs
  return {
    name: 'FakeTool',
    isReadOnly: () => false,
    isDestructive: () => false,
    userFacingName: () => 'Fake',
    // The remaining Tool interface fields the router doesn't call on
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('permissionRouter onPending / onResolved / listPendingIds', () => {
  test('onPending fires when canUseTool queues a request; listPendingIds reflects', async () => {
    const router = createPermissionRouter({
      server: fakeServer(),
      resolveSourceClientId: () => 'src-1',
      resolveCurrentInputId: () => 'input-1',
      timeoutMs: 1_000_000, // high so test doesn't flake
    })
    const fired: Array<{ toolUseID: string }> = []
    const unsub = router.onPending(info => fired.push(info))

    // 觸發 canUseTool：pre-judge 會回 ask (fake tool 沒權限規則) → 進 WS prompt 路徑
    const tool = fakeTool()
    // 不 await — 讓它 hanging 等 response
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = router.canUseTool(tool, { x: 1 }, {} as any, {} as any, 'tuid-1', undefined)

    // 等一小段讓 canUseTool 走完 pre-judge + WS send + pending map set
    await new Promise(r => setTimeout(r, 30))

    expect(fired.length).toBe(1)
    expect(fired[0]!.toolUseID).toBe('tuid-1')
    expect(router.listPendingIds()).toContain('tuid-1')

    // 讓 router resolve：送 frame
    const handled = router.handleResponse('src-1', {
      type: 'permissionResponse',
      toolUseID: 'tuid-1',
      decision: 'allow',
    })
    expect(handled).toBe(true)
    const decision = await p
    expect(decision.behavior).toBe('allow')
    expect(router.listPendingIds()).toEqual([])

    unsub()
  })

  test('onResolved fires on handleResponse + cancelAll', async () => {
    const router = createPermissionRouter({
      server: fakeServer(),
      resolveSourceClientId: () => 'src-1',
      resolveCurrentInputId: () => 'input-1',
      timeoutMs: 1_000_000,
    })
    const resolved: string[] = []
    router.onResolved(info => resolved.push(info.toolUseID))

    const tool = fakeTool()
    // 兩個 pending
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    void router.canUseTool(tool, { x: 1 }, {} as any, {} as any, 'a', undefined)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    void router.canUseTool(tool, { x: 1 }, {} as any, {} as any, 'b', undefined)
    await new Promise(r => setTimeout(r, 30))
    expect(router.listPendingIds().sort()).toEqual(['a', 'b'])

    // 一個透過 handleResponse resolve
    router.handleResponse('src-1', {
      type: 'permissionResponse',
      toolUseID: 'a',
      decision: 'deny',
      message: 'nope',
    })
    // 另一個透過 cancelAll
    router.cancelAll('shutdown')

    await new Promise(r => setTimeout(r, 10))
    expect(resolved.sort()).toEqual(['a', 'b'])
    expect(router.listPendingIds()).toEqual([])
  })

  test('multiple listeners each get called', async () => {
    const router = createPermissionRouter({
      server: fakeServer(),
      resolveSourceClientId: () => 'src-1',
      resolveCurrentInputId: () => 'input-1',
      timeoutMs: 1_000_000,
    })
    const a: string[] = []
    const b: string[] = []
    router.onPending(info => a.push(info.toolUseID))
    router.onPending(info => b.push(info.toolUseID))

    const tool = fakeTool()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    void router.canUseTool(tool, { x: 1 }, {} as any, {} as any, 't1', undefined)
    await new Promise(r => setTimeout(r, 30))

    expect(a).toEqual(['t1'])
    expect(b).toEqual(['t1'])
    router.cancelAll()
  })

  test('unsub stops further callbacks', async () => {
    const router = createPermissionRouter({
      server: fakeServer(),
      resolveSourceClientId: () => 'src-1',
      resolveCurrentInputId: () => 'input-1',
      timeoutMs: 1_000_000,
    })
    const fired: string[] = []
    const unsub = router.onPending(info => fired.push(info.toolUseID))
    unsub()
    const tool = fakeTool()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    void router.canUseTool(tool, { x: 1 }, {} as any, {} as any, 'x', undefined)
    await new Promise(r => setTimeout(r, 30))
    expect(fired).toEqual([])
    router.cancelAll()
  })
})
