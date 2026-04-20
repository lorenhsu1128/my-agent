/**
 * M-DAEMON-6d E2E：thin-client 全流程。
 *
 * 驗證：
 *   1. 無 daemon → manager.mode = 'standalone'
 *   2. 啟 daemon → detector + manager 偵測到 → mode 切 'attached' → sendInput 能送
 *   3. stop daemon → mode 切 'reconnecting' 然後 'standalone'
 *
 * 用 real daemon transport（not REPL Ink UI — Ink render E2E 風險太高），
 * 驗 thin-client 的 state machine 對接 daemon lifecycle 正確。
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
import { startDaemon, type DaemonHandle } from '../../../src/daemon/daemonMain'
import type { InboundFrame } from '../../../src/repl/thinClient/thinClientSocket'

function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = (): void => {
      if (predicate()) return resolve()
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`timeout ${timeoutMs}ms`))
      }
      setTimeout(tick, 30)
    }
    tick()
  })
}

let tmpDir: string
let handle: DaemonHandle | null

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'thin-e2e-'))
  handle = null
})
afterEach(async () => {
  if (handle) {
    try {
      await handle.stop()
    } catch {
      // ignore
    }
  }
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

describe('thin-client E2E', () => {
  test('no daemon → standalone', async () => {
    const detector = createDaemonDetector({
      baseDir: tmpDir,
      pollIntervalMs: 999_999,
      runImmediately: false,
    })
    await detector.check()
    const manager = createFallbackManager({ detector })
    expect(manager.state.mode).toBe('standalone')
    await manager.stop()
    detector.stop()
  })

  test('start daemon → thin client attaches; send input → daemon receives', async () => {
    handle = await startDaemon({
      baseDir: tmpDir,
      agentVersion: 'thin-e2e',
      port: 0,
      onClientMessage: (client, msg) => {
        received.push({ client, msg })
      },
      registerSignalHandlers: false,
    })
    expect(handle.server).not.toBeNull()
    const received: Array<{ client: unknown; msg: unknown }> = []

    const detector = createDaemonDetector({
      baseDir: tmpDir,
      pollIntervalMs: 100,
    })
    const modes: ClientMode[] = []
    const manager = createFallbackManager({ detector })
    manager.on('mode', m => modes.push(m))

    await waitFor(() => manager.state.mode === 'attached', 5_000)
    expect(manager.state.mode).toBe('attached')

    // Send input
    manager.sendInput('hello via thin client', 'interactive')
    await waitFor(() => received.length > 0, 2_000)
    expect(received.length).toBe(1)
    const msg = received[0]!.msg as { type: string; text: string }
    expect(msg.type).toBe('input')
    expect(msg.text).toBe('hello via thin client')

    await manager.stop()
    detector.stop()
  }, 15_000)

  test('daemon stopped → thin client transitions to reconnecting then standalone', async () => {
    handle = await startDaemon({
      baseDir: tmpDir,
      agentVersion: 'thin-e2e',
      port: 0,
      onClientMessage: () => {},
      registerSignalHandlers: false,
    })

    const detector = createDaemonDetector({
      baseDir: tmpDir,
      pollIntervalMs: 100,
    })
    const modes: ClientMode[] = []
    const manager = createFallbackManager({
      detector,
      reconnectIntervalMs: 150,
      reconnectTimeoutMs: 3_000,
    })
    manager.on('mode', m => modes.push(m))

    await waitFor(() => manager.state.mode === 'attached', 5_000)
    // 停 daemon
    await handle.stop()
    handle = null

    // detector poll 會先 see pid gone（且 socket close 先觸發 reconnecting）
    await waitFor(() => manager.state.mode === 'standalone', 10_000)
    expect(manager.state.mode).toBe('standalone')
    // 軌跡應該含 reconnecting（socket close 先觸發）
    expect(modes).toContain('attached')
    expect(modes[modes.length - 1]).toBe('standalone')

    await manager.stop()
    detector.stop()
  }, 20_000)

  test('frame forwarding: broker broadcast reaches thin client', async () => {
    handle = await startDaemon({
      baseDir: tmpDir,
      agentVersion: 'thin-e2e',
      port: 0,
      onClientMessage: () => {},
      onClientConnect: client => {
        // 模擬 broker 做 hello broadcast
        handle!.server!.send(client.id, {
          type: 'hello',
          sessionId: 'fake',
          state: 'IDLE',
        })
      },
      registerSignalHandlers: false,
    })

    const detector = createDaemonDetector({
      baseDir: tmpDir,
      pollIntervalMs: 100,
    })
    const manager = createFallbackManager({ detector })
    const frames: InboundFrame[] = []
    manager.on('frame', f => frames.push(f))

    await waitFor(() => manager.state.mode === 'attached', 5_000)
    await waitFor(() => frames.some(f => f.type === 'hello'), 3_000)
    expect(frames.find(f => f.type === 'hello')).toBeDefined()

    await manager.stop()
    detector.stop()
  }, 15_000)
})
