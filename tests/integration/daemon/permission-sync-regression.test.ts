/**
 * Regression repro：commit fe173e8 之後，REPL 連上 daemon 但 daemon 收不到
 * permissionContextSync。症狀：bypassPermissions 模式在 daemon 端失效。
 *
 * 此 test 驗：
 *   (1) FallbackManager (cwd 帶入) 收到 hello 後是否 emit mode='attached'
 *   (2) 模擬 REPL 流程：mode 變 attached → 呼 sendPermissionContextSync
 *   (3) daemon 端是否實際收到 permissionContextSync frame
 *
 * 若 (1)/(2)/(3) 任一段斷，print 出來定位根因。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (typeof (globalThis as any).MACRO === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).MACRO = {
    VERSION: 'test',
    BUILD_TIME: new Date().toISOString(),
    PACKAGE_URL: 'test-snapshot',
    FEEDBACK_CHANNEL: 'github',
  }
}

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label = 'predicate',
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = (): void => {
      if (predicate()) return resolve()
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`timeout ${timeoutMs}ms waiting for ${label}`))
      }
      setTimeout(tick, 30)
    }
    tick()
  })
}

describe('permissionContextSync regression (fe173e8)', () => {
  let baseDir: string
  let projectA: string
  let handle: import('../../../src/daemon/daemonMain').DaemonHandle | null =
    null
  let origConfigHome: string | undefined

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'perm-sync-base-'))
    projectA = mkdtempSync(join(tmpdir(), 'perm-sync-A-'))
    origConfigHome = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = baseDir
    handle = null
  })

  afterEach(async () => {
    if (handle) {
      try {
        await handle.stop()
      } catch {
        // ignore
      }
      handle = null
    }
    if (origConfigHome === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = origConfigHome
    for (const d of [baseDir, projectA]) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  })

  test('FallbackManager with cwd: hello → mode=attached → sendPermissionContextSync works', async () => {
    const { runDaemonStart } = await import(
      '../../../src/daemon/daemonCli.js'
    )
    const { createDaemonDetector } = await import(
      '../../../src/repl/thinClient/detectDaemon.js'
    )
    const { createFallbackManager } = await import(
      '../../../src/repl/thinClient/fallbackManager.js'
    )

    handle = await runDaemonStart(
      {
        baseDir,
        agentVersion: 'perm-sync-test',
        stdout: () => {},
        stderr: () => {},
      },
      {
        port: 0,
        blockUntilStopped: false,
        enableQueryEngine: true,
        cwd: projectA,
      },
    )

    // 建 detector + manager（與 REPL 相同的 API path），帶 cwd 觸發 requireHello 分支
    const detector = createDaemonDetector({
      baseDir,
      pollIntervalMs: 100,
    })
    const modeChanges: string[] = []
    const manager = createFallbackManager({
      detector,
      cwd: projectA,
      source: 'repl',
    })
    manager.on('mode', m => modeChanges.push(m))

    // 等 mode 變 attached
    await waitFor(() => modeChanges.includes('attached'), 10_000, 'mode=attached')

    // Hook daemon logger.info 捕捉 'permission mode synced from client'
    let syncLogged = false
    const origInfo = handle.logger.info
    handle.logger.info = ((msg: string, meta: unknown): void => {
      if (msg === 'permission mode synced from client') {
        syncLogged = true
      }
      return origInfo.call(handle.logger, msg, meta)
    }) as typeof origInfo

    // 模擬 REPL 的 useEffect 行為：mode 變 attached → 呼 sendPermissionContextSync
    manager.sendPermissionContextSync('bypassPermissions')

    // 給 daemon 幾百 ms 處理 frame
    await waitFor(() => syncLogged, 3_000, 'daemon received sync')

    expect(syncLogged).toBe(true)
  }, 45_000)

  test('REPL pattern: mode-change listener fires sync, daemon receives it', async () => {
    const { runDaemonStart } = await import(
      '../../../src/daemon/daemonCli.js'
    )
    const { createDaemonDetector } = await import(
      '../../../src/repl/thinClient/detectDaemon.js'
    )
    const { createFallbackManager } = await import(
      '../../../src/repl/thinClient/fallbackManager.js'
    )

    handle = await runDaemonStart(
      {
        baseDir,
        agentVersion: 'perm-sync-repl',
        stdout: () => {},
        stderr: () => {},
      },
      {
        port: 0,
        blockUntilStopped: false,
        enableQueryEngine: true,
        cwd: projectA,
      },
    )

    let syncLogged = false
    const origInfo = handle.logger.info
    handle.logger.info = ((msg: string, meta: unknown): void => {
      if (msg === 'permission mode synced from client') syncLogged = true
      return origInfo.call(handle.logger, msg, meta)
    }) as typeof origInfo

    const detector = createDaemonDetector({ baseDir, pollIntervalMs: 100 })
    const manager = createFallbackManager({
      detector,
      cwd: projectA,
      source: 'repl',
    })

    // 完全模擬 useDaemonMode.updateMode + REPL.onModeChange
    const modeLog: string[] = []
    const onModeChange = (mode: string): void => {
      modeLog.push(mode)
      if (mode === 'attached') {
        manager.sendPermissionContextSync('bypassPermissions')
      }
    }
    // 模擬 useEffect 初始 updateMode(initialMode)
    onModeChange(manager.state.mode)
    manager.on('mode', onModeChange)

    await waitFor(() => syncLogged, 10_000, 'daemon received sync via REPL pattern')

    console.log('REPL pattern mode log:', modeLog)
    expect(syncLogged).toBe(true)
    expect(modeLog).toContain('attached')

    await manager.stop()
    detector.stop()
    await new Promise(r => setTimeout(r, 100))
  }, 45_000)
})

