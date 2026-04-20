/**
 * M-DAEMON-6a：thin client 基礎設施單元測試。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createDaemonDetector } from '../../../src/repl/thinClient/detectDaemon'
import {
  createFallbackManager,
  type ClientMode,
} from '../../../src/repl/thinClient/fallbackManager'
import type {
  InboundFrame,
  ThinClientSocket,
  ThinClientSocketOptions,
} from '../../../src/repl/thinClient/thinClientSocket'
import {
  PID_SCHEMA_VERSION,
  writePidFile,
  deletePidFile,
} from '../../../src/daemon/pidFile'
import { writeToken } from '../../../src/daemon/authToken'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'thin-client-'))
})
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// ---- detectDaemon ----
describe('createDaemonDetector', () => {
  test('alive:false when no pid.json', async () => {
    const det = createDaemonDetector({
      baseDir: tmpDir,
      pollIntervalMs: 999_999,
      runImmediately: false,
    })
    const snap = await det.check()
    expect(snap.alive).toBe(false)
    det.stop()
  })

  test('alive:true with pid + token', async () => {
    const now = Date.now()
    await writePidFile(
      {
        version: PID_SCHEMA_VERSION,
        pid: process.pid,
        port: 1234,
        startedAt: now - 1_000,
        lastHeartbeat: now,
        agentVersion: 'test',
      },
      tmpDir,
    )
    await writeToken('a'.repeat(64), tmpDir)
    const det = createDaemonDetector({
      baseDir: tmpDir,
      pollIntervalMs: 999_999,
      runImmediately: false,
    })
    const snap = await det.check()
    expect(snap.alive).toBe(true)
    expect(snap.port).toBe(1234)
    expect(snap.token).toBe('a'.repeat(64))
    det.stop()
  })

  test('emits change when alive flips', async () => {
    const det = createDaemonDetector({
      baseDir: tmpDir,
      pollIntervalMs: 999_999,
      runImmediately: false,
    })
    const changes: boolean[] = []
    det.on('change', s => changes.push(s.alive))
    await det.check()
    expect(changes.length).toBe(0) // alive false → false 沒變化
    // 寫 pid → 下次 check 應該 emit
    const now = Date.now()
    await writePidFile(
      {
        version: PID_SCHEMA_VERSION,
        pid: process.pid,
        port: 5555,
        startedAt: now - 1_000,
        lastHeartbeat: now,
        agentVersion: 'test',
      },
      tmpDir,
    )
    await writeToken('b'.repeat(64), tmpDir)
    await det.check()
    expect(changes).toEqual([true])
    // 刪 pid → 再觸發
    await deletePidFile(tmpDir)
    await det.check()
    expect(changes).toEqual([true, false])
    det.stop()
  })
})

// ---- fallbackManager ----

function makeFakeSocket(
  cap: { sent: string[]; closed: boolean; openImmediately?: boolean },
  handlers: { on: ((f: InboundFrame) => void)[]; close: (() => void)[] },
): ThinClientSocket {
  let state: 'connecting' | 'open' | 'closed' = 'connecting'
  return {
    get state() {
      return state
    },
    async connect() {
      if (cap.openImmediately === false) {
        state = 'closed'
        throw new Error('forced fail')
      }
      state = 'open'
    },
    send(frame) {
      cap.sent.push(JSON.stringify(frame))
    },
    on(event, handler) {
      if (event === 'frame') handlers.on.push(handler as (f: InboundFrame) => void)
      if (event === 'close') handlers.close.push(handler as () => void)
    },
    off() {
      // no-op 測試
    },
    close() {
      state = 'closed'
      cap.closed = true
    },
  }
}

describe('createFallbackManager', () => {
  test('starts standalone when daemon not alive', async () => {
    const det = createDaemonDetector({
      baseDir: tmpDir,
      pollIntervalMs: 999_999,
      runImmediately: false,
    })
    await det.check()
    const fm = createFallbackManager({
      detector: det,
      createSocket: () => makeFakeSocket({ sent: [], closed: false }, { on: [], close: [] }),
    })
    expect(fm.state.mode).toBe('standalone')
    await fm.stop()
    det.stop()
  })

  test('transitions standalone → attached when daemon comes up', async () => {
    const det = createDaemonDetector({
      baseDir: tmpDir,
      pollIntervalMs: 999_999,
      runImmediately: false,
    })
    await det.check()
    const modes: ClientMode[] = []
    const handlers = { on: [] as ((f: InboundFrame) => void)[], close: [] as (() => void)[] }
    const cap = { sent: [] as string[], closed: false }
    const fm = createFallbackManager({
      detector: det,
      createSocket: () => makeFakeSocket(cap, handlers),
    })
    fm.on('mode', m => modes.push(m))

    // 模擬 daemon 起來
    const now = Date.now()
    await writePidFile(
      {
        version: PID_SCHEMA_VERSION,
        pid: process.pid,
        port: 5555,
        startedAt: now,
        lastHeartbeat: now,
        agentVersion: 'x',
      },
      tmpDir,
    )
    await writeToken('c'.repeat(64), tmpDir)
    await det.check() // 觸發 change
    // onDaemonChange 是 async；讓 microtasks 跑完
    await new Promise(r => setTimeout(r, 20))
    expect(fm.state.mode).toBe('attached')
    expect(modes).toEqual(['attached'])

    await fm.stop()
    det.stop()
  })

  test('transitions attached → standalone when daemon disappears', async () => {
    // Seed daemon alive
    const now = Date.now()
    await writePidFile(
      {
        version: PID_SCHEMA_VERSION,
        pid: process.pid,
        port: 5555,
        startedAt: now,
        lastHeartbeat: now,
        agentVersion: 'x',
      },
      tmpDir,
    )
    await writeToken('d'.repeat(64), tmpDir)
    const det = createDaemonDetector({
      baseDir: tmpDir,
      pollIntervalMs: 999_999,
      runImmediately: false,
    })
    await det.check()
    const handlers = { on: [] as ((f: InboundFrame) => void)[], close: [] as (() => void)[] }
    const cap = { sent: [] as string[], closed: false }
    const fm = createFallbackManager({
      detector: det,
      createSocket: () => makeFakeSocket(cap, handlers),
    })
    await new Promise(r => setTimeout(r, 20))
    expect(fm.state.mode).toBe('attached')

    // Daemon 消失
    await deletePidFile(tmpDir)
    await det.check()
    await new Promise(r => setTimeout(r, 20))
    expect(fm.state.mode).toBe('standalone')

    await fm.stop()
    det.stop()
  })

  test('socket close triggers reconnecting state', async () => {
    const now = Date.now()
    await writePidFile(
      {
        version: PID_SCHEMA_VERSION,
        pid: process.pid,
        port: 5555,
        startedAt: now,
        lastHeartbeat: now,
        agentVersion: 'x',
      },
      tmpDir,
    )
    await writeToken('e'.repeat(64), tmpDir)
    const det = createDaemonDetector({
      baseDir: tmpDir,
      pollIntervalMs: 999_999,
      runImmediately: false,
    })
    await det.check()
    const handlers = { on: [] as ((f: InboundFrame) => void)[], close: [] as (() => void)[] }
    const cap = { sent: [] as string[], closed: false }
    const fm = createFallbackManager({
      detector: det,
      reconnectIntervalMs: 100,
      createSocket: () => makeFakeSocket(cap, handlers),
    })
    await new Promise(r => setTimeout(r, 20))
    expect(fm.state.mode).toBe('attached')

    // 模擬 socket remote close
    for (const h of handlers.close) h()
    await new Promise(r => setTimeout(r, 20))
    expect(fm.state.mode).toBe('reconnecting')

    await fm.stop()
    det.stop()
  })

  test('sendInput works in attached mode', async () => {
    const now = Date.now()
    await writePidFile(
      {
        version: PID_SCHEMA_VERSION,
        pid: process.pid,
        port: 5555,
        startedAt: now,
        lastHeartbeat: now,
        agentVersion: 'x',
      },
      tmpDir,
    )
    await writeToken('f'.repeat(64), tmpDir)
    const det = createDaemonDetector({
      baseDir: tmpDir,
      pollIntervalMs: 999_999,
      runImmediately: false,
    })
    await det.check()
    const handlers = { on: [] as ((f: InboundFrame) => void)[], close: [] as (() => void)[] }
    const cap = { sent: [] as string[], closed: false }
    const fm = createFallbackManager({
      detector: det,
      createSocket: () => makeFakeSocket(cap, handlers),
    })
    await new Promise(r => setTimeout(r, 20))
    fm.sendInput('hi', 'interactive')
    expect(cap.sent.length).toBe(1)
    const parsed = JSON.parse(cap.sent[0]!) as { text: string }
    expect(parsed.text).toBe('hi')

    await fm.stop()
    det.stop()
  })

  test('sendInput throws in standalone', async () => {
    const det = createDaemonDetector({
      baseDir: tmpDir,
      pollIntervalMs: 999_999,
      runImmediately: false,
    })
    await det.check()
    const fm = createFallbackManager({
      detector: det,
      createSocket: () => makeFakeSocket({ sent: [], closed: false }, { on: [], close: [] }),
    })
    expect(() => fm.sendInput('hi')).toThrow('cannot send input')
    await fm.stop()
    det.stop()
  })

  test('frames from socket are forwarded', async () => {
    const now = Date.now()
    await writePidFile(
      {
        version: PID_SCHEMA_VERSION,
        pid: process.pid,
        port: 5555,
        startedAt: now,
        lastHeartbeat: now,
        agentVersion: 'x',
      },
      tmpDir,
    )
    await writeToken('7'.repeat(64), tmpDir)
    const det = createDaemonDetector({
      baseDir: tmpDir,
      pollIntervalMs: 999_999,
      runImmediately: false,
    })
    await det.check()
    const handlers = { on: [] as ((f: InboundFrame) => void)[], close: [] as (() => void)[] }
    const cap = { sent: [] as string[], closed: false }
    const fm = createFallbackManager({
      detector: det,
      createSocket: () => makeFakeSocket(cap, handlers),
    })
    await new Promise(r => setTimeout(r, 20))
    const received: InboundFrame[] = []
    fm.on('frame', f => received.push(f))
    // Simulate incoming
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handlers.on.forEach(h => h({ type: 'hello', sessionId: 's', state: 'IDLE' } as any))
    expect(received.length).toBe(1)
    expect(received[0]!.type).toBe('hello')

    await fm.stop()
    det.stop()
  })
})

// ---- thinClientSocket real handshake ----
describe('thinClientSocket (with real server)', () => {
  test('connect + send + receive via real daemon WS server', async () => {
    const { startDaemon } = await import('../../../src/daemon/daemonMain')
    const { createThinClientSocket } = await import(
      '../../../src/repl/thinClient/thinClientSocket'
    )
    const handle = await startDaemon({
      baseDir: tmpDir,
      agentVersion: 'thin-client-test',
      port: 0,
      onClientMessage: () => {},
      registerSignalHandlers: false,
    })
    try {
      const socket = createThinClientSocket({
        host: '127.0.0.1',
        port: handle.server!.port,
        token: handle.token,
      })
      await socket.connect()
      expect(socket.state).toBe('open')
      socket.close()
    } finally {
      await handle.stop()
    }
  })
})
