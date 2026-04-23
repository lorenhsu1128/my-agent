import { describe, expect, test } from 'bun:test'
import {
  createCronCreateWizardRouter,
  getActiveCronWizardRouter,
  registerCronWizardRouter,
  unregisterCronWizardRouter,
} from '../../../src/daemon/cronCreateWizardRouter'
import type { DirectConnectServerHandle } from '../../../src/server/directConnectServer'
import type { ClientInfo } from '../../../src/server/clientRegistry'

type FakeServer = {
  broadcasts: Array<{ msg: unknown; clientId: string }>
  clients: ClientInfo[]
}

function makeFakeServer(clients: ClientInfo[]): {
  handle: DirectConnectServerHandle
  state: FakeServer
} {
  const state: FakeServer = { broadcasts: [], clients }
  const handle = {
    host: '127.0.0.1',
    port: 0,
    registry: {
      register: () => {},
      unregister: () => {},
      get: () => undefined,
      list: () => state.clients,
      broadcast: () => 0,
    } as unknown as DirectConnectServerHandle['registry'],
    broadcast: (msg: unknown, filter?: (c: ClientInfo) => boolean) => {
      const targets = state.clients.filter(c =>
        filter ? filter(c) : true,
      )
      for (const t of targets) state.broadcasts.push({ msg, clientId: t.id })
      return targets.length
    },
    send: () => false,
    stop: async () => {},
  } satisfies DirectConnectServerHandle
  return { handle, state }
}

function mkClient(id: string, projectId: string): ClientInfo {
  return {
    id,
    source: 'repl',
    projectId,
    cwd: '/tmp',
    connectedAt: Date.now(),
  } as unknown as ClientInfo
}

const flush = () => new Promise(r => setTimeout(r, 0))

describe('cronCreateWizardRouter', () => {
  test('no attached clients → resolves no-clients immediately', async () => {
    const { handle } = makeFakeServer([])
    const router = createCronCreateWizardRouter({
      server: handle,
      projectId: 'p1',
    })
    const result = await router.requestWizard({ prompt: 'hi' })
    expect(result.kind).toBe('no-clients')
    expect(router.pendingCount()).toBe(0)
  })

  test('requestWizard broadcasts cronCreateWizard to same-project clients', async () => {
    const clients = [
      mkClient('a', 'p1'),
      mkClient('b', 'p1'),
      mkClient('c', 'p2'),
    ]
    const { handle, state } = makeFakeServer(clients)
    const router = createCronCreateWizardRouter({
      server: handle,
      projectId: 'p1',
    })
    void router.requestWizard({ prompt: 'hi' })
    await flush()
    // 2 same-project (a, b) broadcasts
    const initBroadcasts = state.broadcasts.filter(
      b => (b.msg as { type?: string }).type === 'cronCreateWizard',
    )
    expect(initBroadcasts.length).toBe(2)
    expect(initBroadcasts[0]!.clientId).toBe('a')
    expect(initBroadcasts[1]!.clientId).toBe('b')
    expect(router.pendingCount()).toBe(1)
  })

  test('first client confirm wins; broadcasts resolved', async () => {
    const clients = [mkClient('a', 'p1'), mkClient('b', 'p1')]
    const { handle, state } = makeFakeServer(clients)
    const router = createCronCreateWizardRouter({
      server: handle,
      projectId: 'p1',
    })
    const p = router.requestWizard({ prompt: 'orig' })
    await flush()
    const wizId = (
      state.broadcasts.find(
        b => (b.msg as { type?: string }).type === 'cronCreateWizard',
      )!.msg as { wizardId: string }
    ).wizardId
    const accepted = router.handleResponse('a', {
      type: 'cronCreateWizardResult',
      wizardId: wizId,
      decision: 'confirm',
      task: { prompt: 'modified' },
    })
    expect(accepted).toBe(true)
    const result = await p
    expect(result.kind).toBe('confirm')
    if (result.kind === 'confirm') {
      expect(result.resolverClientId).toBe('a')
      expect(result.task).toEqual({ prompt: 'modified' })
    }
    // Resolved broadcast sent
    expect(
      state.broadcasts.filter(
        b => (b.msg as { type?: string }).type === 'cronCreateWizardResolved',
      ).length,
    ).toBeGreaterThan(0)
  })

  test('cancel decision returns kind=cancel with reason', async () => {
    const clients = [mkClient('a', 'p1')]
    const { handle, state } = makeFakeServer(clients)
    const router = createCronCreateWizardRouter({
      server: handle,
      projectId: 'p1',
    })
    const p = router.requestWizard({ prompt: 'x' })
    await flush()
    const wizId = (
      state.broadcasts.find(
        b => (b.msg as { type?: string }).type === 'cronCreateWizard',
      )!.msg as { wizardId: string }
    ).wizardId
    router.handleResponse('a', {
      type: 'cronCreateWizardResult',
      wizardId: wizId,
      decision: 'cancel',
      reason: 'changed-mind',
    })
    const r = await p
    expect(r.kind).toBe('cancel')
    if (r.kind === 'cancel') expect(r.reason).toBe('changed-mind')
  })

  test('handleResponse returns false for unknown wizardId', () => {
    const { handle } = makeFakeServer([mkClient('a', 'p1')])
    const router = createCronCreateWizardRouter({
      server: handle,
      projectId: 'p1',
    })
    expect(
      router.handleResponse('a', {
        type: 'cronCreateWizardResult',
        wizardId: 'nope',
        decision: 'confirm',
        task: {},
      }),
    ).toBe(false)
  })

  test('timeout resolves with kind=timeout', async () => {
    let timerFn: (() => void) | null = null
    const scheduler = {
      setTimeout: (fn: () => void) => {
        timerFn = fn
        return 1
      },
      clearTimeout: () => {},
    }
    const { handle } = makeFakeServer([mkClient('a', 'p1')])
    const router = createCronCreateWizardRouter({
      server: handle,
      projectId: 'p1',
      scheduler,
      timeoutMs: 100,
    })
    const p = router.requestWizard({ prompt: 'x' })
    await flush()
    expect(typeof timerFn).toBe('function')
    timerFn!()
    const r = await p
    expect(r.kind).toBe('timeout')
  })

  test('cancelAll flushes pending', async () => {
    const { handle } = makeFakeServer([mkClient('a', 'p1')])
    const router = createCronCreateWizardRouter({
      server: handle,
      projectId: 'p1',
    })
    const p = router.requestWizard({ prompt: 'x' })
    await flush()
    router.cancelAll('shutdown')
    const r = await p
    expect(r.kind).toBe('cancel')
    if (r.kind === 'cancel') expect(r.reason).toBe('shutdown')
    expect(router.pendingCount()).toBe(0)
  })

  test('singleton accessors work', () => {
    const { handle } = makeFakeServer([])
    const router = createCronCreateWizardRouter({
      server: handle,
      projectId: 'ptest',
    })
    registerCronWizardRouter('ptest', router)
    expect(getActiveCronWizardRouter('ptest')).toBe(router)
    expect(getActiveCronWizardRouter('nope')).toBeUndefined()
    unregisterCronWizardRouter('ptest')
    expect(getActiveCronWizardRouter('ptest')).toBeUndefined()
  })
})
