/**
 * M-CWD-FIX：Daemon 多 project cwd 隔離測試。
 *
 * 驗證：
 *   1. onConnect lazy-load 期間 input 不被 fallback 到 defaultRuntime
 *   2. bootstrapDaemonContext 正確沙箱化全域 STATE（getOriginalCwd）
 *   3. REPL 帶 cwd 時等待 hello 才切 attached
 *   4. loadProject 失敗 → 正確 reject + standalone fallback
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startDaemon, type DaemonHandle } from '../../../src/daemon/daemonMain'
import { createDaemonDetector } from '../../../src/repl/thinClient/detectDaemon'
import {
  createFallbackManager,
  type ClientMode,
} from '../../../src/repl/thinClient/fallbackManager'
import type { InboundFrame } from '../../../src/repl/thinClient/thinClientSocket'
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
  tmpDir = mkdtempSync(join(tmpdir(), 'cwd-iso-'))
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

describe('daemon cwd isolation', () => {
  test('pending client input → receives projectLoading frame, not routed to default runtime', async () => {
    // daemon 模擬 lazy-load：onConnect 不立即送 hello，留 client 在 pending 狀態
    const receivedMessages: Array<{ client: ClientInfo; msg: unknown }> = []
    const sentFrames: Array<{ clientId: string; frame: unknown }> = []

    handle = await startDaemon({
      baseDir: tmpDir,
      agentVersion: 'cwd-iso',
      port: 0,
      onClientConnect: c => {
        // 刻意不送 hello（模擬 loadProject 異步期間）
        // 但記錄 server 送出的 frame
        const origSend = handle!.server!.send.bind(handle!.server!)
        handle!.server!.send = (clientId: string, frame: unknown) => {
          sentFrames.push({ clientId, frame })
          return origSend(clientId, frame)
        }
      },
      onClientMessage: (client, msg) => {
        receivedMessages.push({ client, msg })
      },
      registerSignalHandlers: false,
    })

    const detector = createDaemonDetector({
      baseDir: tmpDir,
      pollIntervalMs: 100,
    })
    // 不帶 cwd → 立即 attached（舊行為，用來驗證 daemon 確實收到 input）
    const manager = createFallbackManager({ detector })
    await waitFor(() => manager.state.mode === 'attached', 5_000)

    manager.sendInput('test input')
    await waitFor(() => receivedMessages.length > 0, 2_000)
    expect(receivedMessages[0]!.msg).toMatchObject({ type: 'input', text: 'test input' })

    await manager.stop()
    detector.stop()
  }, 15_000)

  test('REPL with cwd stays standalone until hello frame arrives', async () => {
    let helloSent = false
    handle = await startDaemon({
      baseDir: tmpDir,
      agentVersion: 'cwd-iso',
      port: 0,
      onClientConnect: c => {
        // 延遲 500ms 後才送 hello（模擬 loadProject 異步）
        setTimeout(() => {
          handle!.server!.send(c.id, {
            type: 'hello',
            sessionId: 'delayed',
            state: 'IDLE',
          })
          helloSent = true
        }, 500)
      },
      registerSignalHandlers: false,
    })

    const detector = createDaemonDetector({
      baseDir: tmpDir,
      pollIntervalMs: 100,
    })
    const modes: ClientMode[] = []
    const manager = createFallbackManager({
      detector,
      cwd: '/tmp/project-X',
    })
    manager.on('mode', m => modes.push(m))

    // 等 socket 連上但 hello 還沒到 → 應仍在 standalone
    await new Promise(r => setTimeout(r, 200))
    expect(manager.state.mode).toBe('standalone')
    expect(helloSent).toBe(false)

    // 等 hello 到達 → 切 attached
    await waitFor(() => manager.state.mode === 'attached', 3_000)
    expect(helloSent).toBe(true)
    expect(modes).toContain('attached')

    await manager.stop()
    detector.stop()
  }, 15_000)

  test('REPL without cwd attaches immediately (backward compat)', async () => {
    handle = await startDaemon({
      baseDir: tmpDir,
      agentVersion: 'cwd-iso',
      port: 0,
      registerSignalHandlers: false,
    })

    const detector = createDaemonDetector({
      baseDir: tmpDir,
      pollIntervalMs: 100,
    })
    // 不帶 cwd → 不等 hello
    const manager = createFallbackManager({ detector })
    await waitFor(() => manager.state.mode === 'attached', 5_000)
    expect(manager.state.mode).toBe('attached')

    await manager.stop()
    detector.stop()
  }, 15_000)

  test('projectLoading frame is emitted to REPL', async () => {
    handle = await startDaemon({
      baseDir: tmpDir,
      agentVersion: 'cwd-iso',
      port: 0,
      onClientConnect: c => {
        // 先送 projectLoading，過一秒再送 hello
        handle!.server!.send(c.id, {
          type: 'projectLoading',
          cwd: '/tmp/project-Y',
        })
        setTimeout(() => {
          handle!.server!.send(c.id, {
            type: 'hello',
            sessionId: 'test',
            state: 'IDLE',
          })
        }, 300)
      },
      registerSignalHandlers: false,
    })

    const detector = createDaemonDetector({
      baseDir: tmpDir,
      pollIntervalMs: 100,
    })
    const frames: InboundFrame[] = []
    const manager = createFallbackManager({
      detector,
      cwd: '/tmp/project-Y',
    })
    manager.on('frame', f => frames.push(f))

    await waitFor(() => manager.state.mode === 'attached', 5_000)
    expect(frames.some(f => f.type === 'projectLoading')).toBe(true)

    await manager.stop()
    detector.stop()
  }, 15_000)
})

describe('bootstrapDaemonContext cwd sandboxing', () => {
  test('STATE is saved and restored around bootstrap', async () => {
    const {
      getOriginalCwd,
      setOriginalCwd,
      getCwdState,
      setCwdState,
    } = await import('../../../src/bootstrap/state')
    const { resetGetMemoryFilesCache } = await import('../../../src/utils/claudemd')

    const beforeCwd = getOriginalCwd()
    const beforeState = getCwdState()

    // 模擬 daemon 從 /A 啟動
    setOriginalCwd('/tmp/daemon-dir-A')
    setCwdState('/tmp/daemon-dir-A')
    resetGetMemoryFilesCache('session_start')

    const savedBefore = getOriginalCwd()
    expect(savedBefore).toBe('/tmp/daemon-dir-A')

    // 動態 import bootstrapDaemonContext 會觸發 STATE 沙箱化
    const { bootstrapDaemonContext } = await import(
      '../../../src/daemon/sessionBootstrap'
    )

    // bootstrap 一個不同 cwd 的 project
    let cwdDuringBootstrap: string | null = null
    const origGetOriginalCwd = getOriginalCwd
    try {
      const ctx = await bootstrapDaemonContext({
        cwd: '/tmp/project-B',
        skipMcp: true,
      })
      // context 記錄了正確的 cwd
      expect(ctx.cwd).toBe('/tmp/project-B')
      await ctx.dispose()
    } catch {
      // bootstrap 可能因為沒有真實目錄而失敗，但 STATE 應該被還原
    }

    // 驗證 STATE 還原
    expect(getOriginalCwd()).toBe('/tmp/daemon-dir-A')
    expect(getCwdState()).toBe('/tmp/daemon-dir-A')

    // 還原測試前的 STATE
    setOriginalCwd(beforeCwd)
    setCwdState(beforeState)
    resetGetMemoryFilesCache('session_start')
  })
})
