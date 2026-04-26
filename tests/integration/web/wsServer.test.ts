/**
 * M-WEB-4：WS server + browserSession integration 測試。
 *   - 起 httpServer + 注入 wsServer 的 websocketHandler
 *   - 用真 WebSocket client 連線、收 hello、subscribe、ping/pong、broadcast 過濾
 *   - heartbeat（用短 interval 測試）
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startHttpServer, type HttpServerHandle } from '../../../src/web/httpServer.js'
import {
  createBrowserSessionRegistry,
} from '../../../src/web/browserSession.js'
import { createWebWsServer } from '../../../src/web/wsServer.js'

let tmpDir: string
let started: HttpServerHandle[] = []

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'web-ws-'))
  writeFileSync(join(tmpDir, 'index.html'), 'x')
})

afterEach(async () => {
  for (const h of started) {
    try {
      await h.stop()
    } catch {
      // ignore
    }
  }
  started = []
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

function pickPort() {
  return 21000 + Math.floor(Math.random() * 1000)
}

interface ConnectedClient {
  ws: WebSocket
  received: unknown[]
  receivedRaw: string[]
  closed: boolean
  closeCode?: number
  /** Wait for next frame matching predicate (or any frame if no predicate). 5s timeout. */
  next(matchType?: string, timeoutMs?: number): Promise<unknown>
  send(obj: unknown): void
  close(): void
}

async function connectClient(port: number): Promise<ConnectedClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  const received: unknown[] = []
  const receivedRaw: string[] = []
  const waiters: { match: (m: unknown) => boolean; resolve: (m: unknown) => void; timer: ReturnType<typeof setTimeout> }[] = []
  let closed = false
  let closeCode: number | undefined

  ws.addEventListener('message', e => {
    const text = typeof e.data === 'string' ? e.data : ''
    receivedRaw.push(text)
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }
    received.push(parsed)
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.match(parsed)) {
        clearTimeout(waiters[i]!.timer)
        waiters[i]!.resolve(parsed)
        waiters.splice(i, 1)
      }
    }
  })
  ws.addEventListener('close', e => {
    closed = true
    closeCode = e.code
  })

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('connect timeout')), 5000)
    ws.addEventListener('open', () => {
      clearTimeout(t)
      resolve()
    })
    ws.addEventListener('error', () => {
      clearTimeout(t)
      reject(new Error('connect error'))
    })
  })

  return {
    ws,
    received,
    receivedRaw,
    get closed() {
      return closed
    },
    get closeCode() {
      return closeCode
    },
    next(matchType?: string, timeoutMs = 5000) {
      const match = matchType
        ? (m: unknown) =>
            !!m &&
            typeof m === 'object' &&
            (m as { type?: string }).type === matchType
        : () => true
      // 已有匹配的就直接吐
      const existing = received.find(match)
      if (existing) return Promise.resolve(existing)
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex(w => w.match === match)
          if (idx >= 0) waiters.splice(idx, 1)
          reject(new Error(`timeout waiting for ${matchType ?? 'any frame'}`))
        }, timeoutMs)
        waiters.push({ match, resolve, timer })
      })
    },
    send(obj) {
      ws.send(JSON.stringify(obj))
    },
    close() {
      try {
        ws.close()
      } catch {
        // ignore
      }
    },
  }
}

describe('browserSession registry', () => {
  test('register / unregister', () => {
    const reg = createBrowserSessionRegistry()
    expect(reg.size()).toBe(0)
    // We can't easily make a real ws here; smoke via direct API using a stub
    const fakeWs = { send: () => {}, close: () => {}, data: {} as Record<string, unknown> } as unknown as Parameters<typeof reg.register>[0]['ws']
    const s = reg.register({ ws: fakeWs, remoteAddress: '127.0.0.1' })
    expect(reg.size()).toBe(1)
    expect(reg.get(s.id)).toBeDefined()
    reg.unregister(s.id)
    expect(reg.size()).toBe(0)
  })

  test('subscribe filter', () => {
    const reg = createBrowserSessionRegistry()
    let sent: string[] = []
    const fakeWs = {
      send: (p: string) => sent.push(p),
      close: () => {},
      data: {} as Record<string, unknown>,
    } as unknown as Parameters<typeof reg.register>[0]['ws']
    const s = reg.register({ ws: fakeWs })
    expect(s.hasAnySubscription()).toBe(false)
    s.setSubscriptions(['p1', 'p2'])
    expect(s.isSubscribedTo('p1')).toBe(true)
    expect(s.isSubscribedTo('p3')).toBe(false)
    expect(s.hasAnySubscription()).toBe(true)

    sent = []
    reg.broadcast('x', 'p1')
    expect(sent).toEqual(['x'])

    sent = []
    reg.broadcast('y', 'p3')
    expect(sent).toEqual([])

    sent = []
    reg.broadcast('z', null) // daemon-global
    expect(sent).toEqual(['z'])

    sent = []
    reg.broadcastAll('all')
    expect(sent).toEqual(['all'])
  })
})

describe('wsServer integration', () => {
  test('hello on connect', async () => {
    const ws = createWebWsServer({})
    const h = await startHttpServer({
      host: '127.0.0.1',
      port: pickPort(),
      webRootPath: tmpDir,
      websocketHandler: ws.websocketHandler,
      log: () => {},
    })
    started.push(h)
    const c = await connectClient(h.port)
    const hello = (await c.next('hello')) as { type: string; sessionId: string }
    expect(hello.type).toBe('hello')
    expect(typeof hello.sessionId).toBe('string')
    expect(hello.sessionId.length).toBeGreaterThan(0)
    expect(ws.registry.size()).toBe(1)
    c.close()
    // Wait for close to propagate
    await new Promise(r => setTimeout(r, 100))
    expect(ws.registry.size()).toBe(0)
    ws.stop()
  })

  test('subscribe + ack', async () => {
    const ws = createWebWsServer({})
    const h = await startHttpServer({
      host: '127.0.0.1',
      port: pickPort(),
      webRootPath: tmpDir,
      websocketHandler: ws.websocketHandler,
      log: () => {},
    })
    started.push(h)
    const c = await connectClient(h.port)
    await c.next('hello')
    c.send({ type: 'subscribe', projectIds: ['p1', 'p2'] })
    const ack = (await c.next('subscribed')) as {
      type: string
      projectIds: string[]
    }
    expect(ack.projectIds).toEqual(['p1', 'p2'])
    c.close()
    ws.stop()
  })

  test('ping → pong', async () => {
    const ws = createWebWsServer({})
    const h = await startHttpServer({
      host: '127.0.0.1',
      port: pickPort(),
      webRootPath: tmpDir,
      websocketHandler: ws.websocketHandler,
      log: () => {},
    })
    started.push(h)
    const c = await connectClient(h.port)
    await c.next('hello')
    c.send({ type: 'ping' })
    const pong = (await c.next('pong')) as { type: string; t: number }
    expect(pong.type).toBe('pong')
    expect(typeof pong.t).toBe('number')
    c.close()
    ws.stop()
  })

  test('bad JSON → error frame', async () => {
    const ws = createWebWsServer({})
    const h = await startHttpServer({
      host: '127.0.0.1',
      port: pickPort(),
      webRootPath: tmpDir,
      websocketHandler: ws.websocketHandler,
      log: () => {},
    })
    started.push(h)
    const c = await connectClient(h.port)
    await c.next('hello')
    c.ws.send('not json {{{')
    const err = (await c.next('error')) as { code: string }
    expect(err.code).toBe('BAD_JSON')
    c.close()
    ws.stop()
  })

  test('missing type → error frame', async () => {
    const ws = createWebWsServer({})
    const h = await startHttpServer({
      host: '127.0.0.1',
      port: pickPort(),
      webRootPath: tmpDir,
      websocketHandler: ws.websocketHandler,
      log: () => {},
    })
    started.push(h)
    const c = await connectClient(h.port)
    await c.next('hello')
    c.send({ foo: 'bar' })
    const err = (await c.next('error')) as { code: string }
    expect(err.code).toBe('BAD_FRAME')
    c.close()
    ws.stop()
  })

  test('onMessage callback receives non-built-in frames', async () => {
    const received: unknown[] = []
    const ws = createWebWsServer({
      onMessage: (_s, m) => received.push(m),
    })
    const h = await startHttpServer({
      host: '127.0.0.1',
      port: pickPort(),
      webRootPath: tmpDir,
      websocketHandler: ws.websocketHandler,
      log: () => {},
    })
    started.push(h)
    const c = await connectClient(h.port)
    await c.next('hello')
    c.send({ type: 'input.submit', text: 'hello' })
    // give a tick
    await new Promise(r => setTimeout(r, 100))
    expect(received.length).toBe(1)
    expect((received[0] as { type: string }).type).toBe('input.submit')
    c.close()
    ws.stop()
  })

  test('broadcast respects subscribe filter', async () => {
    const ws = createWebWsServer({})
    const h = await startHttpServer({
      host: '127.0.0.1',
      port: pickPort(),
      webRootPath: tmpDir,
      websocketHandler: ws.websocketHandler,
      log: () => {},
    })
    started.push(h)
    const a = await connectClient(h.port)
    const b = await connectClient(h.port)
    await a.next('hello')
    await b.next('hello')
    a.send({ type: 'subscribe', projectIds: ['p1'] })
    b.send({ type: 'subscribe', projectIds: ['p2'] })
    await a.next('subscribed')
    await b.next('subscribed')

    const aBefore = a.received.length
    const bBefore = b.received.length

    const sent = ws.registry.broadcast(
      JSON.stringify({ type: 'turn.event', projectId: 'p1', payload: 'foo' }),
      'p1',
    )
    expect(sent).toBe(1)
    // wait for delivery
    await new Promise(r => setTimeout(r, 100))
    expect(a.received.length).toBe(aBefore + 1)
    expect(b.received.length).toBe(bBefore)

    a.close()
    b.close()
    ws.stop()
  })

  test('heartbeat ticks (short interval)', async () => {
    const ws = createWebWsServer({ heartbeatIntervalMs: 200 })
    const h = await startHttpServer({
      host: '127.0.0.1',
      port: pickPort(),
      webRootPath: tmpDir,
      websocketHandler: ws.websocketHandler,
      log: () => {},
    })
    started.push(h)
    const c = await connectClient(h.port)
    await c.next('hello')
    // wait for at least 2 heartbeats
    const ka = (await c.next('keepalive', 2000)) as { type: string }
    expect(ka.type).toBe('keepalive')
    c.close()
    ws.stop()
  })
})
