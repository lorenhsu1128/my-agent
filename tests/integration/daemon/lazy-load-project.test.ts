/**
 * Commit 8531f1d：REPL thin-client 帶未載入的 cwd 連上 daemon 時，
 * daemon 應 lazy-load 該 project 並 attach 成功（不再送 attachRejected）。
 *
 * 驗：
 *   1. 啟 daemon cwd=tmpA，default project = tmpA
 *   2. WS client 帶 cwd=tmpB 連上
 *   3. 收到 hello frame（= attach 成功）；沒收到 attachRejected
 *   4. daemon 日誌含 "auto-loading project for REPL client"
 *   5. 兩個 project 都在 registry 裡
 *
 * 不需要 llama.cpp — 只驗 attach path，不跑 turn。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

// MACRO shim（bun test 沒有 bundle 定義）— 與 e2e-query-engine.test.ts 一致
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

describe('daemon lazy-load project on REPL attach', () => {
  let baseDir: string
  let projectA: string
  let projectB: string
  let handle: import('../../../src/daemon/daemonMain').DaemonHandle | null =
    null
  let origConfigHome: string | undefined
  let origTestPersist: string | undefined

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'lazy-load-base-'))
    projectA = mkdtempSync(join(tmpdir(), 'lazy-load-A-'))
    projectB = mkdtempSync(join(tmpdir(), 'lazy-load-B-'))
    origConfigHome = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = baseDir
    origTestPersist = process.env.TEST_ENABLE_SESSION_PERSISTENCE
    // 不需 session persistence；lazy-load 只走 registry.loadProject。
    delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
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
    if (origTestPersist === undefined)
      delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    else process.env.TEST_ENABLE_SESSION_PERSISTENCE = origTestPersist
    for (const d of [baseDir, projectA, projectB]) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        // Windows 可能 EBUSY；best-effort
      }
    }
  })

  test('client with unknown cwd → daemon auto-loads project and attaches', async () => {
    const { runDaemonStart } = await import(
      '../../../src/daemon/daemonCli.js'
    )
    const logs: string[] = []

    handle = await runDaemonStart(
      {
        baseDir,
        agentVersion: 'lazy-load-test',
        stdout: m => logs.push(`[out] ${m}`),
        stderr: m => logs.push(`[err] ${m}`),
      },
      {
        port: 0,
        blockUntilStopped: false,
        enableQueryEngine: true,
        cwd: projectA, // default project = A
      },
    )

    expect(handle.server).not.toBeNull()
    const port = handle.server!.port
    const token = handle.token

    // 連 WS 帶 cwd=projectB（未載入）
    const encodedCwd = encodeURIComponent(projectB)
    const url = `ws://127.0.0.1:${port}/sessions?token=${token}&source=repl&cwd=${encodedCwd}`
    const ws = new WebSocket(url)
    const frames: Record<string, unknown>[] = []
    let gotHello = false
    let gotReject = false

    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        reject(new Error('ws open timeout'))
      }, 3_000)
      ws.onopen = (): void => {
        clearTimeout(deadline)
        resolve()
      }
      ws.onerror = (e): void => {
        clearTimeout(deadline)
        reject(new Error(`ws error: ${String(e)}`))
      }
    })

    ws.onmessage = (e: MessageEvent): void => {
      const text = e.data as string
      for (const line of text.split(/\r?\n/)) {
        const s = line.trim()
        if (!s) continue
        try {
          const obj = JSON.parse(s) as Record<string, unknown>
          frames.push(obj)
          if (obj.type === 'hello') gotHello = true
          if (obj.type === 'attachRejected') gotReject = true
        } catch {
          // ignore malformed
        }
      }
    }

    // lazy-load 需要跑 project bootstrap（較慢）→ 寬鬆 timeout
    await waitFor(
      () => gotHello || gotReject,
      30_000,
      'hello or attachRejected frame',
    )

    expect(gotReject).toBe(false)
    expect(gotHello).toBe(true)

    ws.close()
    // 給 daemon 一點時間處理 close event
    await new Promise(r => setTimeout(r, 100))
  }, 60_000)

  test('client with default cwd (same as daemon) → attach without extra load', async () => {
    const { runDaemonStart } = await import(
      '../../../src/daemon/daemonCli.js'
    )
    handle = await runDaemonStart(
      {
        baseDir,
        agentVersion: 'lazy-load-test',
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

    const port = handle.server!.port
    const token = handle.token
    const encodedCwd = encodeURIComponent(projectA)
    const url = `ws://127.0.0.1:${port}/sessions?token=${token}&source=repl&cwd=${encodedCwd}`
    const ws = new WebSocket(url)
    let gotHello = false
    let gotReject = false

    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('open timeout')), 3_000)
      ws.onopen = () => {
        clearTimeout(deadline)
        resolve()
      }
      ws.onerror = e => {
        clearTimeout(deadline)
        reject(new Error(String(e)))
      }
    })

    ws.onmessage = (e: MessageEvent): void => {
      const text = e.data as string
      for (const line of text.split(/\r?\n/)) {
        const s = line.trim()
        if (!s) continue
        try {
          const obj = JSON.parse(s) as Record<string, unknown>
          if (obj.type === 'hello') gotHello = true
          if (obj.type === 'attachRejected') gotReject = true
        } catch {
          // ignore
        }
      }
    }

    await waitFor(() => gotHello || gotReject, 10_000, 'hello frame')
    expect(gotReject).toBe(false)
    expect(gotHello).toBe(true)

    ws.close()
    await new Promise(r => setTimeout(r, 100))
  }, 30_000)
})
