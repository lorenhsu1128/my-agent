/**
 * M-DAEMON-7a：permissionRouter 單元測試。
 */
import { describe, expect, test } from 'bun:test'
import { createPermissionRouter } from '../../../src/daemon/permissionRouter'
import type { DirectConnectServerHandle } from '../../../src/server/directConnectServer'
import type { Tool } from '../../../src/Tool'

interface SendCall {
  clientId: string
  payload: Record<string, unknown>
}
interface BroadcastCall {
  payload: Record<string, unknown>
  filter?: (c: { id: string }) => boolean
}

function makeFakeServer(cap: {
  sends: SendCall[]
  broadcasts: BroadcastCall[]
  sendSucceeds?: boolean
}): DirectConnectServerHandle {
  return {
    host: '127.0.0.1',
    port: 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registry: {} as any,
    send(clientId, msg) {
      cap.sends.push({ clientId, payload: msg as Record<string, unknown> })
      return cap.sendSucceeds !== false
    },
    broadcast(msg, filter) {
      cap.broadcasts.push({
        payload: msg as Record<string, unknown>,
        filter: filter as ((c: { id: string }) => boolean) | undefined,
      })
      return 1
    },
    async stop() {},
  }
}

function makeFakeTool(opts: {
  name?: string
  readOnly?: boolean
  destructive?: boolean
  userFacingName?: string
}): Tool {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {
    name: opts.name ?? 'FakeTool',
    isReadOnly: () => opts.readOnly ?? false,
    isDestructive: opts.destructive !== undefined ? () => opts.destructive! : undefined,
    userFacingName: () => opts.userFacingName ?? opts.name ?? 'FakeTool',
  } as any
}

// ---- Scheduler inject for timeout tests ----
function makeControllableScheduler() {
  const timers: Array<{ fn: () => void; ms: number; id: number }> = []
  let nextId = 1
  return {
    scheduler: {
      setTimeout(fn: () => void, ms: number) {
        const id = nextId++
        timers.push({ fn, ms, id })
        return id
      },
      clearTimeout(handle: unknown) {
        const id = handle as number
        const idx = timers.findIndex(t => t.id === id)
        if (idx >= 0) timers.splice(idx, 1)
      },
    },
    fireAll() {
      const snap = [...timers]
      timers.length = 0
      for (const t of snap) t.fn()
    },
  }
}

describe('createPermissionRouter', () => {
  test('no source client + no fallback → auto-allow', async () => {
    const cap = { sends: [] as SendCall[], broadcasts: [] as BroadcastCall[] }
    const router = createPermissionRouter({
      server: makeFakeServer(cap),
      resolveSourceClientId: () => null,
      resolveCurrentInputId: () => null,
    })
    const decision = await router.canUseTool(
      makeFakeTool({}),
      { path: '/tmp/a' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      'toolUseA',
    )
    expect(decision.behavior).toBe('allow')
    expect(cap.sends.length).toBe(0)
    expect(router.pendingCount()).toBe(0)
  })

  test('source client present → permissionRequest sent + permissionPending broadcast', async () => {
    const cap = {
      sends: [] as SendCall[],
      broadcasts: [] as BroadcastCall[],
    }
    const router = createPermissionRouter({
      server: makeFakeServer(cap),
      resolveSourceClientId: () => 'client-A',
      resolveCurrentInputId: () => 'input-1',
    })
    const p = router.canUseTool(
      makeFakeTool({ name: 'Edit', userFacingName: 'Edit file' }),
      { file_path: '/tmp/foo' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      'toolUse-1',
    )
    // 等一下讓 microtask 跑完
    await new Promise(r => setTimeout(r, 5))
    expect(router.pendingCount()).toBe(1)
    expect(cap.sends.length).toBe(1)
    expect(cap.sends[0]!.clientId).toBe('client-A')
    const req = cap.sends[0]!.payload as {
      type: string
      toolName: string
      riskLevel: string
      description: string
      affectedPaths: string[]
      inputId: string
      toolUseID: string
    }
    expect(req.type).toBe('permissionRequest')
    expect(req.toolName).toBe('Edit')
    expect(req.inputId).toBe('input-1')
    expect(req.toolUseID).toBe('toolUse-1')
    expect(req.riskLevel).toBe('write')
    expect(req.description).toBe('Edit file')
    expect(req.affectedPaths).toContain('/tmp/foo')

    // broadcast 應該排除 source
    expect(cap.broadcasts.length).toBe(1)
    const pending = cap.broadcasts[0]!.payload as {
      type: string
      sourceClientId: string
    }
    expect(pending.type).toBe('permissionPending')
    expect(pending.sourceClientId).toBe('client-A')
    expect(cap.broadcasts[0]!.filter!({ id: 'client-A' })).toBe(false)
    expect(cap.broadcasts[0]!.filter!({ id: 'client-B' })).toBe(true)

    // 解鎖 promise
    const ok = router.handleResponse('client-A', {
      type: 'permissionResponse',
      toolUseID: 'toolUse-1',
      decision: 'allow',
      updatedInput: { file_path: '/tmp/foo' },
    })
    expect(ok).toBe(true)
    const decision = await p
    expect(decision.behavior).toBe('allow')
    expect(router.pendingCount()).toBe(0)
  })

  test('deny response propagates to decision', async () => {
    const cap = { sends: [] as SendCall[], broadcasts: [] as BroadcastCall[] }
    const router = createPermissionRouter({
      server: makeFakeServer(cap),
      resolveSourceClientId: () => 'c',
      resolveCurrentInputId: () => 'i',
    })
    const p = router.canUseTool(
      makeFakeTool({}),
      {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      'tu',
    )
    await new Promise(r => setTimeout(r, 5))
    router.handleResponse('c', {
      type: 'permissionResponse',
      toolUseID: 'tu',
      decision: 'deny',
      message: 'No way',
    })
    const decision = await p
    expect(decision.behavior).toBe('deny')
    if (decision.behavior === 'deny') {
      expect(decision.message).toBe('No way')
    }
  })

  test('timeout → auto-allow', async () => {
    const cap = { sends: [] as SendCall[], broadcasts: [] as BroadcastCall[] }
    const ctrl = makeControllableScheduler()
    const router = createPermissionRouter({
      server: makeFakeServer(cap),
      resolveSourceClientId: () => 'c',
      resolveCurrentInputId: () => 'i',
      timeoutMs: 1000,
      scheduler: ctrl.scheduler,
    })
    const p = router.canUseTool(
      makeFakeTool({}),
      {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      'tu2',
    )
    await new Promise(r => setTimeout(r, 5))
    expect(router.pendingCount()).toBe(1)
    ctrl.fireAll()
    const decision = await p
    expect(decision.behavior).toBe('allow')
    expect(router.pendingCount()).toBe(0)
  })

  test('risk level: isReadOnly → read; isDestructive → destructive', async () => {
    const cap = { sends: [] as SendCall[], broadcasts: [] as BroadcastCall[] }
    const router = createPermissionRouter({
      server: makeFakeServer(cap),
      resolveSourceClientId: () => 'c',
      resolveCurrentInputId: () => 'i',
    })
    // read
    const p1 = router.canUseTool(
      makeFakeTool({ readOnly: true }),
      {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      'tuR',
    )
    await new Promise(r => setTimeout(r, 5))
    expect(
      (cap.sends[0]!.payload as { riskLevel: string }).riskLevel,
    ).toBe('read')
    router.handleResponse('c', {
      type: 'permissionResponse',
      toolUseID: 'tuR',
      decision: 'allow',
    })
    await p1

    // destructive wins over readOnly
    const p2 = router.canUseTool(
      makeFakeTool({ destructive: true }),
      {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      'tuD',
    )
    await new Promise(r => setTimeout(r, 5))
    expect(
      (cap.sends[1]!.payload as { riskLevel: string }).riskLevel,
    ).toBe('destructive')
    router.handleResponse('c', {
      type: 'permissionResponse',
      toolUseID: 'tuD',
      decision: 'allow',
    })
    await p2
  })

  test('send failure → fallback handler', async () => {
    const cap = {
      sends: [] as SendCall[],
      broadcasts: [] as BroadcastCall[],
      sendSucceeds: false,
    }
    let fallbackCalled = 0
    const router = createPermissionRouter({
      server: makeFakeServer(cap),
      resolveSourceClientId: () => 'dead',
      resolveCurrentInputId: () => 'i',
      fallbackHandler: {
        async requestPermission() {
          fallbackCalled++
          return {
            behavior: 'deny',
            message: 'via fallback',
            decisionReason: { type: 'other', reason: 'test' },
          }
        },
      },
    })
    const decision = await router.canUseTool(
      makeFakeTool({}),
      {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      'tuX',
    )
    expect(fallbackCalled).toBe(1)
    expect(decision.behavior).toBe('deny')
  })

  test('cancelAll resolves pending as deny', async () => {
    const cap = { sends: [] as SendCall[], broadcasts: [] as BroadcastCall[] }
    const router = createPermissionRouter({
      server: makeFakeServer(cap),
      resolveSourceClientId: () => 'c',
      resolveCurrentInputId: () => 'i',
    })
    const p = router.canUseTool(
      makeFakeTool({}),
      {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      'tuC',
    )
    await new Promise(r => setTimeout(r, 5))
    router.cancelAll('shutting down')
    const decision = await p
    expect(decision.behavior).toBe('deny')
    if (decision.behavior === 'deny') {
      expect(decision.message).toBe('shutting down')
    }
  })

  test('handleResponse returns false for unknown toolUseID', () => {
    const cap = { sends: [] as SendCall[], broadcasts: [] as BroadcastCall[] }
    const router = createPermissionRouter({
      server: makeFakeServer(cap),
      resolveSourceClientId: () => 'c',
      resolveCurrentInputId: () => 'i',
    })
    const ok = router.handleResponse('c', {
      type: 'permissionResponse',
      toolUseID: 'never-seen',
      decision: 'allow',
    })
    expect(ok).toBe(false)
  })

  test('handleResponse returns false for invalid frame', () => {
    const cap = { sends: [] as SendCall[], broadcasts: [] as BroadcastCall[] }
    const router = createPermissionRouter({
      server: makeFakeServer(cap),
      resolveSourceClientId: () => 'c',
      resolveCurrentInputId: () => 'i',
    })
    expect(router.handleResponse('c', { type: 'nope' })).toBe(false)
    expect(router.handleResponse('c', null)).toBe(false)
  })
})
