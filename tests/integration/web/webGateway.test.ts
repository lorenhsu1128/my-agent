/**
 * M-WEB-5：webGateway integration 測試（用 stub registry / runtime / sessions）。
 */
import { describe, expect, test, beforeEach } from 'bun:test'
import { EventEmitter } from 'events'
import { createWebGateway } from '../../../src/web/webGateway.js'
import type {
  ProjectRegistry,
  ProjectRuntime,
} from '../../../src/daemon/projectRegistry.js'
import type {
  BrowserSession,
  BrowserSessionRegistry,
} from '../../../src/web/browserSession.js'

// ----------------------------------------------------------------------------
// Stubs
// ----------------------------------------------------------------------------

interface FakeQueue {
  emitter: EventEmitter
  submitted: { text: unknown; opts: unknown }[]
  on: ProjectRuntime['broker']['queue']['on']
  off: ProjectRuntime['broker']['queue']['off']
  submit: ProjectRuntime['broker']['queue']['submit']
  state: 'IDLE' | 'RUNNING' | 'INTERRUPTING'
  pendingCount: number
  currentInput: null
  dispose: ProjectRuntime['broker']['queue']['dispose']
}

function fakeQueue(): FakeQueue {
  const ee = new EventEmitter()
  const submitted: FakeQueue['submitted'] = []
  return {
    emitter: ee,
    submitted,
    state: 'IDLE',
    pendingCount: 0,
    currentInput: null,
    on: ((event: string, h: (...a: unknown[]) => void) => {
      ee.on(event, h)
    }) as never,
    off: ((event: string, h: (...a: unknown[]) => void) => {
      ee.off(event, h)
    }) as never,
    submit: ((payload: unknown, opts: unknown) => {
      submitted.push({ text: payload, opts })
      return 'in-' + submitted.length
    }) as never,
    dispose: (async () => {}) as never,
  }
}

function fakePermissionRouter() {
  let pendingHandlers: Array<(info: unknown) => void> = []
  let resolvedHandlers: Array<(info: unknown) => void> = []
  const responses: { clientId: string; frame: unknown }[] = []
  return {
    canUseTool: (() => Promise.resolve({ behavior: 'allow' as const })) as never,
    handleResponse: (clientId: string, frame: unknown) => {
      responses.push({ clientId, frame })
      return true
    },
    pendingCount: () => 0,
    listPendingIds: () => [],
    onPending: (h: (info: unknown) => void) => {
      pendingHandlers.push(h)
      return () => {
        pendingHandlers = pendingHandlers.filter(x => x !== h)
      }
    },
    onResolved: (h: (info: unknown) => void) => {
      resolvedHandlers.push(h)
      return () => {
        resolvedHandlers = resolvedHandlers.filter(x => x !== h)
      }
    },
    cancelAll: () => {},
    setFallbackHandler: () => {},
    // helpers for tests
    _firePending: (info: unknown) => {
      for (const h of pendingHandlers) h(info)
    },
    _fireResolved: (info: unknown) => {
      for (const h of resolvedHandlers) h(info)
    },
    _responses: responses,
  }
}

function fakeRuntime(projectId: string, cwd: string): ProjectRuntime & {
  _q: FakeQueue
  _permissionRouter: ReturnType<typeof fakePermissionRouter>
  _cronEvents: EventEmitter
} {
  const q = fakeQueue()
  const router = fakePermissionRouter()
  const cronEvents = new EventEmitter()
  const replIds = new Set<string>()
  const r = {
    projectId,
    cwd,
    context: {} as never,
    sessionHandle: {} as never,
    broker: { queue: q, sessionId: 'sess-' + projectId, dispose: async () => {} } as never,
    permissionRouter: router as never,
    cron: { scheduler: null, events: cronEvents, stop: () => {} },
    lastActivityAt: 1000,
    attachedReplIds: replIds,
    hasAttachedRepl: () => replIds.size > 0,
    touch: () => {},
    attachRepl: (id: string) => replIds.add(id),
    detachRepl: (id: string) => replIds.delete(id),
    dispose: async () => {},
    _q: q,
    _permissionRouter: router,
    _cronEvents: cronEvents,
  }
  return r
}

function fakeRegistry(): ProjectRegistry & {
  _emitLoad: (r: ProjectRuntime) => void
  _emitUnload: (
    info: { projectId: string; reason: 'idle' | 'manual' | 'shutdown' },
  ) => void
  _add: (r: ProjectRuntime) => void
  _remove: (id: string) => void
} {
  const projects = new Map<string, ProjectRuntime>()
  let loadHandlers: Array<(r: ProjectRuntime) => void> = []
  let unloadHandlers: Array<
    (info: { projectId: string; reason: 'idle' | 'manual' | 'shutdown' }) => void
  > = []
  return {
    loadProject: async cwd => {
      for (const p of projects.values()) if (p.cwd === cwd) return p
      throw new Error('not implemented for stub')
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
    onLoad: h => {
      loadHandlers.push(h)
      return () => {
        loadHandlers = loadHandlers.filter(x => x !== h)
      }
    },
    onUnload: h => {
      unloadHandlers.push(h)
      return () => {
        unloadHandlers = unloadHandlers.filter(x => x !== h)
      }
    },
    dispose: async () => {},
    _emitLoad: r => {
      projects.set(r.projectId, r)
      for (const h of loadHandlers) h(r)
    },
    _emitUnload: info => {
      projects.delete(info.projectId)
      for (const h of unloadHandlers) h(info)
    },
    _add: r => {
      projects.set(r.projectId, r)
    },
    _remove: id => projects.delete(id),
  }
}

function fakeSession(id: string): {
  session: BrowserSession
  sent: string[]
  subs: Set<string>
} {
  const sent: string[] = []
  const subs = new Set<string>()
  const session: BrowserSession = {
    id,
    remoteAddress: '127.0.0.1',
    userAgent: 'test',
    connectedAt: 0,
    lastActivityAt: 0,
    get subscribedProjects() {
      return subs
    },
    send: payload => {
      sent.push(payload)
    },
    setSubscriptions: ids => {
      subs.clear()
      for (const i of ids) subs.add(i)
    },
    isSubscribedTo: id => subs.has(id),
    hasAnySubscription: () => subs.size > 0,
    close: () => {},
  }
  return { session, sent, subs }
}

function fakeBrowserSessions(): BrowserSessionRegistry & {
  _addSession: (s: BrowserSession) => void
  _broadcasts: { payload: string; projectId: string | null }[]
  _broadcastAlls: string[]
} {
  const sessions = new Map<string, BrowserSession>()
  const broadcasts: { payload: string; projectId: string | null }[] = []
  const broadcastAlls: string[] = []
  return {
    size: () => sessions.size,
    list: () => [...sessions.values()],
    get: id => sessions.get(id),
    register: () => {
      throw new Error('not used in stub')
    },
    unregister: id => sessions.delete(id),
    broadcast: (payload, projectId) => {
      broadcasts.push({ payload, projectId })
      let n = 0
      for (const s of sessions.values()) {
        const t =
          projectId === null ? s.hasAnySubscription() : s.isSubscribedTo(projectId)
        if (t) {
          s.send(payload)
          n++
        }
      }
      return n
    },
    broadcastWithSeq: (payload, projectId) => {
      // 測試 stub：行為等價 broadcast，但記錄成 broadcasts（讓既有 expect 不變）。
      const stamped = JSON.stringify(payload)
      broadcasts.push({ payload: stamped, projectId })
      for (const s of sessions.values()) {
        if (s.isSubscribedTo(projectId)) s.send(stamped)
      }
      return 1
    },
    replayTo: () => 0,
    broadcastAll: payload => {
      broadcastAlls.push(payload)
      let n = 0
      for (const s of sessions.values()) {
        s.send(payload)
        n++
      }
      return n
    },
    send: (id, p) => {
      const s = sessions.get(id)
      if (!s) return false
      s.send(p)
      return true
    },
    closeAll: () => sessions.clear(),
    _addSession: s => sessions.set(s.id, s),
    _broadcasts: broadcasts,
    _broadcastAlls: broadcastAlls,
  }
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe('webGateway lifecycle', () => {
  let reg: ReturnType<typeof fakeRegistry>
  let sessions: ReturnType<typeof fakeBrowserSessions>

  beforeEach(() => {
    reg = fakeRegistry()
    sessions = fakeBrowserSessions()
  })

  test('attaches existing runtimes at startup', () => {
    const r = fakeRuntime('p1', '/x/p1')
    reg._add(r)
    const gw = createWebGateway({ registry: reg, browserSessions: sessions })
    // listProjects 應回 1
    expect(gw.listProjects().length).toBe(1)
    // 應廣播 project.added 給所有 tab（broadcastAll）
    expect(sessions._broadcastAlls.length).toBe(1)
    expect(sessions._broadcastAlls[0]).toContain('project.added')
    gw.dispose()
  })

  test('on registry.onLoad → broadcasts project.added', () => {
    const gw = createWebGateway({ registry: reg, browserSessions: sessions })
    const r = fakeRuntime('p2', '/x/p2')
    reg._emitLoad(r)
    const found = sessions._broadcastAlls.find(m => m.includes('project.added'))
    expect(found).toBeTruthy()
    gw.dispose()
  })

  test('on registry.onUnload → broadcasts project.removed + detaches', () => {
    const r = fakeRuntime('p3', '/x/p3')
    reg._add(r)
    const gw = createWebGateway({ registry: reg, browserSessions: sessions })
    sessions._broadcastAlls.length = 0
    reg._emitUnload({ projectId: 'p3', reason: 'manual' })
    expect(sessions._broadcastAlls.find(m => m.includes('project.removed'))).toBeTruthy()
    // 之後 turn 事件不再廣播
    const before = sessions._broadcasts.length
    r._q.emitter.emit('state', 'RUNNING')
    expect(sessions._broadcasts.length).toBe(before)
    gw.dispose()
  })
})

describe('webGateway broker → web frames', () => {
  test('queue events translated and broadcast to projectId', () => {
    const reg = fakeRegistry()
    const sessions = fakeBrowserSessions()
    const r = fakeRuntime('p1', '/x/p1')
    reg._add(r)
    const gw = createWebGateway({ registry: reg, browserSessions: sessions })

    const sub = fakeSession('s1')
    sub.subs.add('p1')
    sessions._addSession(sub.session)

    r._q.emitter.emit('state', 'RUNNING')
    r._q.emitter.emit('turnStart', {
      input: {
        id: 'i1',
        source: 'repl',
        clientId: 'c1',
        intent: 'interactive',
        text: 'hi',
        submittedAt: 0,
      },
      startedAt: 100,
    })
    r._q.emitter.emit('runnerEvent', {
      input: { id: 'i1' },
      event: { type: 'output', text: 'hello' },
    })
    r._q.emitter.emit('turnEnd', {
      input: { id: 'i1' },
      reason: 'done',
      endedAt: 200,
    })

    const types = sub.sent
      .map(s => {
        try {
          return JSON.parse(s).type
        } catch {
          return ''
        }
      })
      .filter(t => t !== '')
    expect(types).toContain('state')
    expect(types).toContain('turn.start')
    expect(types).toContain('turn.event')
    expect(types).toContain('turn.end')
    gw.dispose()
  })

  test('not subscribed → no leak', () => {
    const reg = fakeRegistry()
    const sessions = fakeBrowserSessions()
    const r = fakeRuntime('p1', '/x/p1')
    reg._add(r)
    const gw = createWebGateway({ registry: reg, browserSessions: sessions })

    const sub = fakeSession('s1')
    sub.subs.add('p2') // 訂另一個
    sessions._addSession(sub.session)

    r._q.emitter.emit('state', 'RUNNING')
    expect(sub.sent.length).toBe(0)
    gw.dispose()
  })

  test('permissionRouter onPending → web frame', () => {
    const reg = fakeRegistry()
    const sessions = fakeBrowserSessions()
    const r = fakeRuntime('p1', '/x/p1')
    reg._add(r)
    const gw = createWebGateway({ registry: reg, browserSessions: sessions })
    const sub = fakeSession('s1')
    sub.subs.add('p1')
    sessions._addSession(sub.session)
    r._permissionRouter._firePending({
      toolUseID: 't1',
      meta: {
        toolName: 'Read',
        toolInput: { path: '/x' },
        riskLevel: 'read',
      },
    })
    const types = sub.sent.map(s => JSON.parse(s).type)
    expect(types).toContain('permission.pending')
    gw.dispose()
  })

  test('cron fired event broadcast', () => {
    const reg = fakeRegistry()
    const sessions = fakeBrowserSessions()
    const r = fakeRuntime('p1', '/x/p1')
    reg._add(r)
    const gw = createWebGateway({ registry: reg, browserSessions: sessions })
    const sub = fakeSession('s1')
    sub.subs.add('p1')
    sessions._addSession(sub.session)
    r._cronEvents.emit('cronFireEvent', {
      type: 'cronFireEvent',
      taskId: 'task1',
      schedule: '* * * * *',
      status: 'fired',
      startedAt: 5000,
      source: 'cron',
    })
    const types = sub.sent.map(s => JSON.parse(s).type)
    expect(types).toContain('cron.fired')
    gw.dispose()
  })

  test('cronFireEvent with status != fired → not broadcast', () => {
    const reg = fakeRegistry()
    const sessions = fakeBrowserSessions()
    const r = fakeRuntime('p1', '/x/p1')
    reg._add(r)
    const gw = createWebGateway({ registry: reg, browserSessions: sessions })
    const sub = fakeSession('s1')
    sub.subs.add('p1')
    sessions._addSession(sub.session)
    sub.sent.length = 0
    r._cronEvents.emit('cronFireEvent', {
      type: 'cronFireEvent',
      taskId: 'task1',
      schedule: '*',
      status: 'completed',
      startedAt: 1,
      source: 'cron',
    })
    expect(sub.sent.length).toBe(0)
    gw.dispose()
  })
})

describe('webGateway inbound message routing', () => {
  test('input.submit → broker.queue.submit with source=web', () => {
    const reg = fakeRegistry()
    const sessions = fakeBrowserSessions()
    const r = fakeRuntime('p1', '/x/p1')
    reg._add(r)
    const gw = createWebGateway({ registry: reg, browserSessions: sessions })
    const sub = fakeSession('s1')
    sessions._addSession(sub.session)
    gw.handleClientMessage(sub.session, {
      type: 'input.submit',
      projectId: 'p1',
      text: 'hello world',
    })
    expect(r._q.submitted.length).toBe(1)
    expect(r._q.submitted[0]!.text).toBe('hello world')
    expect((r._q.submitted[0]!.opts as { source: string }).source).toBe('web')
    gw.dispose()
  })

  test('input.submit on missing project → error frame', () => {
    const reg = fakeRegistry()
    const sessions = fakeBrowserSessions()
    const gw = createWebGateway({ registry: reg, browserSessions: sessions })
    const sub = fakeSession('s1')
    sessions._addSession(sub.session)
    gw.handleClientMessage(sub.session, {
      type: 'input.submit',
      projectId: 'p1',
      text: 'hi',
    })
    const err = sub.sent.find(s => JSON.parse(s).code === 'PROJECT_NOT_FOUND')
    expect(err).toBeTruthy()
    gw.dispose()
  })

  test('bad frame → error response', () => {
    const reg = fakeRegistry()
    const sessions = fakeBrowserSessions()
    const gw = createWebGateway({ registry: reg, browserSessions: sessions })
    const sub = fakeSession('s1')
    sessions._addSession(sub.session)
    gw.handleClientMessage(sub.session, { type: 'totally.bogus' })
    const err = sub.sent.find(s => JSON.parse(s).code === 'BAD_FRAME')
    expect(err).toBeTruthy()
    gw.dispose()
  })

  test('permission.respond → router.handleResponse', () => {
    const reg = fakeRegistry()
    const sessions = fakeBrowserSessions()
    const r = fakeRuntime('p1', '/x/p1')
    reg._add(r)
    const gw = createWebGateway({ registry: reg, browserSessions: sessions })
    const sub = fakeSession('s1')
    sessions._addSession(sub.session)
    gw.handleClientMessage(sub.session, {
      type: 'permission.respond',
      projectId: 'p1',
      toolUseID: 't1',
      decision: 'allow',
    })
    expect(r._permissionRouter._responses.length).toBe(1)
    expect(r._permissionRouter._responses[0]!.clientId).toBe('s1')
    gw.dispose()
  })

  test('mutation → not implemented response (Phase 1)', () => {
    const reg = fakeRegistry()
    const sessions = fakeBrowserSessions()
    const gw = createWebGateway({ registry: reg, browserSessions: sessions })
    const sub = fakeSession('s1')
    sessions._addSession(sub.session)
    gw.handleClientMessage(sub.session, {
      type: 'mutation',
      requestId: 'r1',
      op: 'cron.create',
      payload: {},
    })
    const result = sub.sent
      .map(s => JSON.parse(s))
      .find(o => o.type === 'mutation.result')
    expect(result).toBeTruthy()
    expect(result.ok).toBe(false)
  })
})

describe('webGateway connect handshake', () => {
  test('handleClientConnect sends current projects', () => {
    const reg = fakeRegistry()
    reg._add(fakeRuntime('p1', '/x/p1'))
    reg._add(fakeRuntime('p2', '/x/p2'))
    const sessions = fakeBrowserSessions()
    const gw = createWebGateway({ registry: reg, browserSessions: sessions })
    const sub = fakeSession('s1')
    gw.handleClientConnect(sub.session)
    const types = sub.sent.map(s => JSON.parse(s).type)
    expect(types.filter(t => t === 'project.added').length).toBe(2)
    gw.dispose()
  })
})

describe('webGateway broadcastStatusChange', () => {
  test('broadcasts web.statusChanged to all', () => {
    const reg = fakeRegistry()
    const sessions = fakeBrowserSessions()
    const gw = createWebGateway({ registry: reg, browserSessions: sessions })
    const sub = fakeSession('s1')
    sessions._addSession(sub.session)
    gw.broadcastStatusChange({ running: true, port: 9090, bindHost: '0.0.0.0' })
    const found = sub.sent
      .map(s => JSON.parse(s))
      .find(o => o.type === 'web.statusChanged')
    expect(found).toBeTruthy()
    expect(found.running).toBe(true)
    expect(found.port).toBe(9090)
    gw.dispose()
  })
})
