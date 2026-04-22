/**
 * M-DISCORD-2：cwd handshake E2E — thin-client 帶 cwd 連上 daemon，
 * daemon 側 onConnect 收到 client.cwd。
 *
 * 本測試驗「協議層 cwd 傳遞 + fallback attachRejected」，不跑真 QueryEngine
 * （那已由 e2e-query-engine.test.ts 覆蓋）。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createDaemonDetector } from '../../../src/repl/thinClient/detectDaemon'
import { createFallbackManager } from '../../../src/repl/thinClient/fallbackManager'
import { startDaemon, type DaemonHandle } from '../../../src/daemon/daemonMain'
import type { ClientInfo } from '../../../src/server/clientRegistry'

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
  tmpDir = mkdtempSync(join(tmpdir(), 'cwd-hs-'))
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

describe('cwd handshake', () => {
  test('thin-client with cwd → daemon onConnect sees client.cwd', async () => {
    const connects: ClientInfo[] = []
    handle = await startDaemon({
      baseDir: tmpDir,
      agentVersion: 'cwd-hs',
      port: 0,
      onClientConnect: c => {
        connects.push(c)
        // M-CWD-FIX：帶 cwd 的 client 需要 hello 才會切 attached
        handle!.server!.send(c.id, { type: 'hello', sessionId: 'test', state: 'IDLE' })
      },
      registerSignalHandlers: false,
    })

    const detector = createDaemonDetector({
      baseDir: tmpDir,
      pollIntervalMs: 100,
    })
    const manager = createFallbackManager({
      detector,
      cwd: '/tmp/project-A',
      source: 'repl',
    })

    await waitFor(() => manager.state.mode === 'attached', 5_000)
    expect(connects.length).toBe(1)
    expect(connects[0]!.cwd).toBe('/tmp/project-A')
    expect(connects[0]!.source).toBe('repl')

    await manager.stop()
    detector.stop()
  }, 15_000)

  test('thin-client without cwd → daemon onConnect sees undefined cwd', async () => {
    const connects: ClientInfo[] = []
    handle = await startDaemon({
      baseDir: tmpDir,
      agentVersion: 'cwd-hs',
      port: 0,
      onClientConnect: c => connects.push(c),
      registerSignalHandlers: false,
    })

    const detector = createDaemonDetector({
      baseDir: tmpDir,
      pollIntervalMs: 100,
    })
    const manager = createFallbackManager({ detector })

    await waitFor(() => manager.state.mode === 'attached', 5_000)
    expect(connects.length).toBe(1)
    expect(connects[0]!.cwd).toBeUndefined()

    await manager.stop()
    detector.stop()
  }, 15_000)

  test('attachRejected frame → manager falls to standalone + fires callback; no reconnect', async () => {
    // 自行 simulate daemon：onClientConnect 直接送 attachRejected。
    handle = await startDaemon({
      baseDir: tmpDir,
      agentVersion: 'cwd-hs',
      port: 0,
      onClientConnect: c => {
        // 模擬 daemonCli 的 reject 邏輯
        handle!.server!.send(c.id, {
          type: 'attachRejected',
          reason: 'projectNotLoaded',
          cwd: c.cwd,
          hint: 'run: my-agent daemon load',
        })
      },
      registerSignalHandlers: false,
    })

    const detector = createDaemonDetector({
      baseDir: tmpDir,
      pollIntervalMs: 100,
    })
    const rejections: Array<{ reason: string; cwd?: string; hint?: string }> = []
    const modes: string[] = []
    const manager = createFallbackManager({
      detector,
      cwd: '/tmp/unknown-project',
    })
    manager.on('mode', m => modes.push(m))
    manager.on('attachRejected', r => rejections.push(r))

    // 等 daemon 拒絕 + manager 回 standalone
    await waitFor(() => rejections.length > 0, 5_000)
    expect(rejections[0]!.reason).toBe('projectNotLoaded')
    expect(rejections[0]!.cwd).toBe('/tmp/unknown-project')
    expect(manager.lastAttachRejectedReason).toBe('projectNotLoaded')
    // 等幾個 detector tick 確定不會重試 attached
    await new Promise(r => setTimeout(r, 500))
    expect(manager.state.mode).toBe('standalone')
    expect(modes).not.toContain('attached')

    await manager.stop()
    detector.stop()
  }, 15_000)

  test('cwd with special chars (spaces, unicode) URL-encodes correctly', async () => {
    const connects: ClientInfo[] = []
    handle = await startDaemon({
      baseDir: tmpDir,
      agentVersion: 'cwd-hs',
      port: 0,
      onClientConnect: c => {
        connects.push(c)
        handle!.server!.send(c.id, { type: 'hello', sessionId: 'test', state: 'IDLE' })
      },
      registerSignalHandlers: false,
    })

    const detector = createDaemonDetector({
      baseDir: tmpDir,
      pollIntervalMs: 100,
    })
    const weirdCwd = 'C:/Users/Foo Bar/專案/my agent'
    const manager = createFallbackManager({
      detector,
      cwd: weirdCwd,
    })

    await waitFor(() => manager.state.mode === 'attached', 5_000)
    expect(connects[0]!.cwd).toBe(weirdCwd)

    await manager.stop()
    detector.stop()
  }, 15_000)
})
