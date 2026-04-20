/**
 * `/daemon attach` / `/daemon detach` 的 fallbackManager 層級測試。
 *
 * 覆蓋：
 *   - forceAttach 成功（daemon alive）
 *   - forceAttach 失敗（daemon offline）
 *   - forceDetach 切 standalone + suppress flag 擋自動重 attach
 *   - forceAttach 清掉 suppress flag
 *   - queryDaemonStatus round-trip resolve
 *   - queryDaemonStatus timeout
 *   - queryDaemonStatus 非 attached 時回 null
 *
 * 實際 SIGTERM daemon、spawnDetachedDaemon、discord gate 都屬於 e2e 範疇，
 * 由 smoke.sh 與手動測試覆蓋。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createDaemonDetector } from '../../../src/repl/thinClient/detectDaemon'
import { createFallbackManager } from '../../../src/repl/thinClient/fallbackManager'
import type {
  InboundFrame,
  ThinClientSocket,
} from '../../../src/repl/thinClient/thinClientSocket'
import {
  PID_SCHEMA_VERSION,
  writePidFile,
  deletePidFile,
} from '../../../src/daemon/pidFile'
import { writeToken } from '../../../src/daemon/authToken'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'attach-detach-'))
})
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

interface FakeSocketCap {
  sent: string[]
  closed: boolean
  openImmediately?: boolean
  frameHandlers: ((f: InboundFrame) => void)[]
  closeHandlers: (() => void)[]
}

function makeFakeSocket(cap: FakeSocketCap): ThinClientSocket {
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
      if (event === 'frame')
        cap.frameHandlers.push(handler as (f: InboundFrame) => void)
      if (event === 'close') cap.closeHandlers.push(handler as () => void)
    },
    off() {
      // no-op
    },
    close() {
      state = 'closed'
      cap.closed = true
    },
  }
}

async function setupAliveDaemon(dir: string, port = 7777): Promise<void> {
  const now = Date.now()
  await writePidFile(
    {
      version: PID_SCHEMA_VERSION,
      pid: process.pid,
      port,
      startedAt: now,
      lastHeartbeat: now,
      agentVersion: 'test',
    },
    dir,
  )
  await writeToken('a'.repeat(64), dir)
}

function makeCap(): FakeSocketCap {
  return {
    sent: [],
    closed: false,
    frameHandlers: [],
    closeHandlers: [],
  }
}

describe('forceAttach', () => {
  test('connects when daemon is alive', async () => {
    await setupAliveDaemon(tmpDir)
    const det = createDaemonDetector({
      baseDir: tmpDir,
      pollIntervalMs: 999_999,
      runImmediately: false,
    })
    const cap = makeCap()
    const fm = createFallbackManager({
      detector: det,
      createSocket: () => makeFakeSocket(cap),
    })
    expect(fm.state.mode).toBe('standalone')

    const r = await fm.forceAttach()
    expect(r.ok).toBe(true)
    expect(fm.state.mode).toBe('attached')

    await fm.stop()
    det.stop()
  })

  test('returns daemonOffline when no pid.json', async () => {
    const det = createDaemonDetector({
      baseDir: tmpDir,
      pollIntervalMs: 999_999,
      runImmediately: false,
    })
    const cap = makeCap()
    const fm = createFallbackManager({
      detector: det,
      createSocket: () => makeFakeSocket(cap),
    })
    const r = await fm.forceAttach()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('daemonOffline')
    expect(fm.state.mode).toBe('standalone')

    await fm.stop()
    det.stop()
  })

  test('returns connectFailed when socket refuses', async () => {
    await setupAliveDaemon(tmpDir)
    const det = createDaemonDetector({
      baseDir: tmpDir,
      pollIntervalMs: 999_999,
      runImmediately: false,
    })
    const cap: FakeSocketCap = { ...makeCap(), openImmediately: false }
    const fm = createFallbackManager({
      detector: det,
      createSocket: () => makeFakeSocket(cap),
    })
    const r = await fm.forceAttach()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('connectFailed')

    await fm.stop()
    det.stop()
  })
})

describe('forceDetach + suppressAutoReattach', () => {
  test('forceDetach transitions attached → standalone and closes socket', async () => {
    await setupAliveDaemon(tmpDir)
    const det = createDaemonDetector({
      baseDir: tmpDir,
      pollIntervalMs: 999_999,
      runImmediately: false,
    })
    const cap = makeCap()
    const fm = createFallbackManager({
      detector: det,
      createSocket: () => makeFakeSocket(cap),
    })
    await fm.forceAttach()
    expect(fm.state.mode).toBe('attached')

    await fm.forceDetach()
    expect(fm.state.mode).toBe('standalone')
    expect(cap.closed).toBe(true)

    await fm.stop()
    det.stop()
  })

  test('detector refresh after forceDetach does NOT auto-reattach', async () => {
    await setupAliveDaemon(tmpDir)
    const det = createDaemonDetector({
      baseDir: tmpDir,
      pollIntervalMs: 999_999,
      runImmediately: false,
    })
    const cap = makeCap()
    const fm = createFallbackManager({
      detector: det,
      createSocket: () => makeFakeSocket(cap),
    })
    await fm.forceAttach()
    await fm.forceDetach()
    expect(fm.state.mode).toBe('standalone')

    // daemon 仍活著；detector.check() 不應觸發重 attach（suppress flag）
    await det.check()
    await new Promise(r => setTimeout(r, 30))
    expect(fm.state.mode).toBe('standalone')

    await fm.stop()
    det.stop()
  })

  test('forceAttach after detach clears suppress flag and reconnects', async () => {
    await setupAliveDaemon(tmpDir)
    const det = createDaemonDetector({
      baseDir: tmpDir,
      pollIntervalMs: 999_999,
      runImmediately: false,
    })
    const caps: FakeSocketCap[] = []
    const fm = createFallbackManager({
      detector: det,
      createSocket: () => {
        const c = makeCap()
        caps.push(c)
        return makeFakeSocket(c)
      },
    })
    await fm.forceAttach()
    await fm.forceDetach()
    expect(fm.state.mode).toBe('standalone')

    const r = await fm.forceAttach()
    expect(r.ok).toBe(true)
    expect(fm.state.mode).toBe('attached')
    // 兩次各創一個 socket
    expect(caps.length).toBe(2)

    await fm.stop()
    det.stop()
  })
})

describe('queryDaemonStatus', () => {
  test('resolves from daemonStatus frame with matching requestId', async () => {
    await setupAliveDaemon(tmpDir)
    const det = createDaemonDetector({
      baseDir: tmpDir,
      pollIntervalMs: 999_999,
      runImmediately: false,
    })
    const cap = makeCap()
    const fm = createFallbackManager({
      detector: det,
      createSocket: () => makeFakeSocket(cap),
    })
    await fm.forceAttach()

    const pending = fm.queryDaemonStatus(5_000)
    // 等 send 出去
    await new Promise(r => setTimeout(r, 10))
    expect(cap.sent.length).toBe(1)
    const sent = JSON.parse(cap.sent[0])
    expect(sent.type).toBe('queryDaemonStatus')
    expect(typeof sent.requestId).toBe('string')

    // 模擬 daemon 回 daemonStatus
    for (const h of cap.frameHandlers) {
      h({
        type: 'daemonStatus',
        requestId: sent.requestId,
        replCount: 3,
        discordEnabled: true,
      } as InboundFrame)
    }
    const result = await pending
    expect(result).toEqual({ replCount: 3, discordEnabled: true })

    await fm.stop()
    det.stop()
  })

  test('times out when no response', async () => {
    await setupAliveDaemon(tmpDir)
    const det = createDaemonDetector({
      baseDir: tmpDir,
      pollIntervalMs: 999_999,
      runImmediately: false,
    })
    const cap = makeCap()
    const fm = createFallbackManager({
      detector: det,
      createSocket: () => makeFakeSocket(cap),
    })
    await fm.forceAttach()
    const result = await fm.queryDaemonStatus(100)
    expect(result).toBeNull()

    await fm.stop()
    det.stop()
  })

  test('returns null when not attached', async () => {
    const det = createDaemonDetector({
      baseDir: tmpDir,
      pollIntervalMs: 999_999,
      runImmediately: false,
    })
    const cap = makeCap()
    const fm = createFallbackManager({
      detector: det,
      createSocket: () => makeFakeSocket(cap),
    })
    const result = await fm.queryDaemonStatus(100)
    expect(result).toBeNull()
    expect(cap.sent.length).toBe(0)

    await fm.stop()
    det.stop()
  })
})

describe('integration: detect-then-attach-detach-reattach cycle', () => {
  test('standalone → attach → detach → reattach', async () => {
    await setupAliveDaemon(tmpDir)
    const det = createDaemonDetector({
      baseDir: tmpDir,
      pollIntervalMs: 999_999,
      runImmediately: false,
    })
    const cap = makeCap()
    const fm = createFallbackManager({
      detector: det,
      createSocket: () => makeFakeSocket(cap),
    })
    await det.check()
    // auto-attach 走 onDaemonChange（alive 初次出現時觸發）
    await new Promise(r => setTimeout(r, 30))
    expect(fm.state.mode).toBe('attached')

    await fm.forceDetach()
    expect(fm.state.mode).toBe('standalone')

    // daemon 消失再復活，suppress 仍擋
    await deletePidFile(tmpDir)
    await det.check()
    await new Promise(r => setTimeout(r, 10))
    await setupAliveDaemon(tmpDir, 8888)
    await det.check()
    await new Promise(r => setTimeout(r, 30))
    expect(fm.state.mode).toBe('standalone')

    // 手動 forceAttach 清旗標
    const r = await fm.forceAttach()
    expect(r.ok).toBe(true)
    expect(fm.state.mode).toBe('attached')

    await fm.stop()
    det.stop()
  })
})
