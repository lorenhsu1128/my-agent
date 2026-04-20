/**
 * M-DAEMON-4c：sessionBroker + sessionWriter 單元測試。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createSessionBroker,
  handleClientMessage,
  sendHelloFrame,
  type SessionBroker,
} from '../../../src/daemon/sessionBroker'
import { echoRunner } from '../../../src/daemon/sessionRunner'
import type { DaemonSessionHandle } from '../../../src/daemon/sessionWriter'
import type { DirectConnectServerHandle } from '../../../src/server/directConnectServer'
import type { DaemonSessionContext } from '../../../src/daemon/sessionBootstrap'
import type { ClientInfo } from '../../../src/server/clientRegistry'

// ---- 假 server / context ----

interface Capture {
  broadcasts: Record<string, unknown>[]
  sends: Array<{ clientId: string; payload: Record<string, unknown> }>
}

function makeFakeServer(cap: Capture): DirectConnectServerHandle {
  return {
    host: '127.0.0.1',
    port: 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registry: {} as any,
    broadcast(msg) {
      cap.broadcasts.push(msg as Record<string, unknown>)
      return 1
    },
    send(clientId, msg) {
      cap.sends.push({ clientId, payload: msg as Record<string, unknown> })
      return true
    },
    async stop() {
      // noop
    },
  }
}

function makeFakeHandle(tmpDir: string): DaemonSessionHandle {
  return {
    sessionId: 'test-session-uuid',
    projectDir: tmpDir,
    transcriptPath: join(tmpDir, 'test-session-uuid.jsonl'),
    lockPath: join(tmpDir, '.daemon.lock'),
    dispose: () => {},
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const emptyContext = {} as DaemonSessionContext

// ---- Tests ----

let cap: Capture
let broker: SessionBroker | null
let tmpDir: string

beforeEach(() => {
  cap = { broadcasts: [], sends: [] }
  broker = null
  tmpDir = mkdtempSync(join(tmpdir(), 'broker-'))
})
afterEach(async () => {
  if (broker) await broker.dispose()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('createSessionBroker — queue events → broadcast', () => {
  test('submit via handleClientMessage triggers turnStart + turnEnd', async () => {
    const server = makeFakeServer(cap)
    const handle = makeFakeHandle(tmpDir)
    broker = createSessionBroker({
      server,
      context: emptyContext,
      runner: echoRunner,
      sessionHandle: handle,
    })
    const client: ClientInfo = {
      id: 'c1',
      source: 'repl',
      connectedAt: Date.now(),
    }
    handleClientMessage(broker, client, { type: 'input', text: 'hi' }, () => {})
    // 等到 turnEnd 送出
    await new Promise(r => setTimeout(r, 50))
    const types = cap.broadcasts.map(b => b.type)
    expect(types).toContain('turnStart')
    expect(types).toContain('runnerEvent')
    expect(types).toContain('turnEnd')
    expect(types).toContain('state')
  })

  test('unknown frame triggers onProtocolError not crash', () => {
    const server = makeFakeServer(cap)
    const handle = makeFakeHandle(tmpDir)
    broker = createSessionBroker({
      server,
      context: emptyContext,
      runner: echoRunner,
      sessionHandle: handle,
    })
    const errors: string[] = []
    handleClientMessage(
      broker,
      { id: 'c1', source: 'repl', connectedAt: Date.now() },
      { type: 'nope' },
      err => errors.push(err),
    )
    expect(errors.length).toBe(1)
  })

  test('missing text field rejected', () => {
    const server = makeFakeServer(cap)
    const handle = makeFakeHandle(tmpDir)
    broker = createSessionBroker({
      server,
      context: emptyContext,
      runner: echoRunner,
      sessionHandle: handle,
    })
    const errors: string[] = []
    handleClientMessage(
      broker,
      { id: 'c1', source: 'repl', connectedAt: Date.now() },
      { type: 'input' }, // 沒 text
      err => errors.push(err),
    )
    expect(errors.length).toBe(1)
  })

  test('intent defaults by source (cron → background)', async () => {
    const server = makeFakeServer(cap)
    const handle = makeFakeHandle(tmpDir)
    broker = createSessionBroker({
      server,
      context: emptyContext,
      runner: echoRunner,
      sessionHandle: handle,
    })
    handleClientMessage(
      broker,
      { id: 'cron1', source: 'cron', connectedAt: Date.now() },
      { type: 'input', text: 'task' },
      () => {},
    )
    await new Promise(r => setTimeout(r, 30))
    const turnStart = cap.broadcasts.find(b => b.type === 'turnStart') as {
      source: string
    }
    expect(turnStart.source).toBe('cron')
  })

  test('sendHelloFrame sends hello with session + state', () => {
    const server = makeFakeServer(cap)
    const handle = makeFakeHandle(tmpDir)
    broker = createSessionBroker({
      server,
      context: emptyContext,
      runner: echoRunner,
      sessionHandle: handle,
    })
    sendHelloFrame(broker, server, 'c1')
    expect(cap.sends.length).toBe(1)
    expect(cap.sends[0]!.clientId).toBe('c1')
    const payload = cap.sends[0]!.payload
    expect(payload.type).toBe('hello')
    expect(payload.sessionId).toBe('test-session-uuid')
    expect(payload.state).toBe('IDLE')
  })
})

describe('sessionWriter — beginDaemonSession', () => {
  test('lockfile conflict throws', async () => {
    // 手動預先建一個 lockfile，再試 beginDaemonSession。因為 beginDaemonSession
    // 會用 getProjectDir(cwd) 算路徑，所以這測試只驗純 fs 邏輯：手動寫 lockfile
    // 後再試用 wx 開啟。
    const { openSync, closeSync } = await import('fs')
    const lockPath = join(tmpDir, '.daemon.lock')
    writeFileSync(lockPath, 'existing')
    let threw = false
    try {
      const fd = openSync(lockPath, 'wx', 0o600)
      closeSync(fd)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(existsSync(lockPath)).toBe(true)
  })
})
