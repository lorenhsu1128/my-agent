/**
 * M-WEB Phase 1 E2E：
 *
 *   啟 daemon（enableQueryEngine + web.jsonc enabled+autoStart）
 *   → 驗 web HTTP server auto-started
 *   → curl /api/health  → 200 ok
 *   → curl unknown /api/foo → 404 JSON
 *   → connect WS /ws  → 收 hello frame
 *   → subscribe / ping / pong
 *   → 用 thin-client 送 web.control op=status → 收到正確狀態
 *   → 用 thin-client 送 web.control op=stop → server 停 + broadcast statusChanged
 *   → daemon stop
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// MACRO shim
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

function pickPort(): number {
  return 23000 + Math.floor(Math.random() * 1000)
}

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

describe('M-WEB Phase 1 daemon E2E', () => {
  let baseDir: string
  let webRoot: string
  let projectDir: string
  let webCfgPath: string
  let webPort: number
  let handle: import('../../../src/daemon/daemonMain.js').DaemonHandle | null =
    null
  let origConfigHome: string | undefined
  let origWebPath: string | undefined
  let origTestPersist: string | undefined

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'web-e2e-base-'))
    webRoot = mkdtempSync(join(tmpdir(), 'web-e2e-root-'))
    projectDir = mkdtempSync(join(tmpdir(), 'web-e2e-proj-'))
    webCfgPath = join(baseDir, 'web.jsonc')
    webPort = pickPort()
    // 將 webRoot 當作 web/dist 來服務（minimal index.html）
    writeFileSync(join(webRoot, 'index.html'), '<html>e2e</html>')
    writeFileSync(
      webCfgPath,
      JSON.stringify({
        enabled: true,
        autoStart: true,
        port: webPort,
        maxPortProbes: 5,
        bindHost: '127.0.0.1',
        heartbeatIntervalMs: 5_000,
      }),
    )
    origConfigHome = process.env.CLAUDE_CONFIG_DIR
    origWebPath = process.env.MYAGENT_WEB_CONFIG_PATH
    origTestPersist = process.env.TEST_ENABLE_SESSION_PERSISTENCE
    process.env.CLAUDE_CONFIG_DIR = baseDir
    process.env.MYAGENT_WEB_CONFIG_PATH = webCfgPath
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
    if (origWebPath === undefined) delete process.env.MYAGENT_WEB_CONFIG_PATH
    else process.env.MYAGENT_WEB_CONFIG_PATH = origWebPath
    if (origTestPersist === undefined)
      delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    else process.env.TEST_ENABLE_SESSION_PERSISTENCE = origTestPersist
    for (const d of [baseDir, webRoot, projectDir]) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        // Windows EBUSY best-effort
      }
    }
  })

  async function startDaemon(): Promise<void> {
    // 重 reset web config snapshot（其他 testcase 可能已 frozen）
    const { _resetWebConfigForTests } = await import(
      '../../../src/webConfig/index.js'
    )
    _resetWebConfigForTests()
    const { runDaemonStart } = await import(
      '../../../src/daemon/daemonCli.js'
    )
    const logs: string[] = []
    handle = await runDaemonStart(
      {
        baseDir,
        agentVersion: 'web-e2e',
        stdout: m => logs.push(`[out] ${m}`),
        stderr: m => logs.push(`[err] ${m}`),
      },
      {
        port: 0,
        blockUntilStopped: false,
        enableQueryEngine: true,
        cwd: projectDir,
      },
    )
  }

  test('daemon auto-starts web server (enabled + autoStart)', async () => {
    await startDaemon()
    // poll /api/health 直到 OK 或 timeout
    let ok = false
    let body: { ok?: boolean; serverTime?: number } | null = null
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${webPort}/api/health`)
        if (r.status === 200) {
          body = (await r.json()) as { ok: boolean; serverTime: number }
          ok = true
          break
        }
      } catch {
        // not yet
      }
      await new Promise(r => setTimeout(r, 200))
    }
    expect(ok).toBe(true)
    expect(body?.ok).toBe(true)
  }, 30_000)

  test('GET /api/foo (unknown) → 404 JSON', async () => {
    await startDaemon()
    await waitFor(
      async () => {
        try {
          const r = await fetch(`http://127.0.0.1:${webPort}/api/health`)
          return r.status === 200
        } catch {
          return false
        }
      },
      10_000,
      'web up',
    )
    const r = await fetch(`http://127.0.0.1:${webPort}/api/unknown`)
    expect(r.status).toBe(404)
    expect(r.headers.get('content-type')).toContain('json')
  }, 30_000)

  test('WS /ws receives hello + subscribe ack + ping/pong', async () => {
    await startDaemon()
    await waitFor(
      async () => {
        try {
          const r = await fetch(`http://127.0.0.1:${webPort}/api/health`)
          return r.status === 200
        } catch {
          return false
        }
      },
      10_000,
      'web up',
    )
    const ws = new WebSocket(`ws://127.0.0.1:${webPort}/ws`)
    const received: Record<string, unknown>[] = []
    ws.addEventListener('message', e => {
      try {
        received.push(JSON.parse(typeof e.data === 'string' ? e.data : ''))
      } catch {
        // ignore
      }
    })
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ws open timeout')), 5_000)
      ws.addEventListener('open', () => {
        clearTimeout(t)
        resolve()
      })
    })
    await waitFor(
      () => received.some(f => f.type === 'hello'),
      5_000,
      'hello frame',
    )
    ws.send(JSON.stringify({ type: 'subscribe', projectIds: ['p1'] }))
    await waitFor(
      () => received.some(f => f.type === 'subscribed'),
      5_000,
      'subscribed ack',
    )
    ws.send(JSON.stringify({ type: 'ping' }))
    await waitFor(() => received.some(f => f.type === 'pong'), 5_000, 'pong')
    ws.close()
  }, 30_000)

  test('daemon thin-client sends web.control op=status / stop', async () => {
    await startDaemon()
    const port = handle!.server!.port
    const token = handle!.token
    // 用 daemon 自己的 thin-client WS（不是 web /ws）— 透過 sessionRequest
    const replWs = new WebSocket(
      `ws://127.0.0.1:${port}/sessions?token=${token}&source=repl&cwd=${encodeURIComponent(projectDir)}`,
    )
    const replReceived: Record<string, unknown>[] = []
    replWs.addEventListener('message', e => {
      const txt = typeof e.data === 'string' ? e.data : ''
      for (const line of txt.split(/\r?\n/)) {
        const t = line.trim()
        if (!t) continue
        try {
          replReceived.push(JSON.parse(t))
        } catch {
          // ignore
        }
      }
    })
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('repl ws open')), 5_000)
      replWs.addEventListener('open', () => {
        clearTimeout(t)
        resolve()
      })
    })
    // 等 hello frame（attach 成功）
    await waitFor(
      () => replReceived.some(f => f.type === 'hello'),
      30_000,
      'thin-client hello',
    )
    // 送 web.control op=status
    replWs.send(JSON.stringify({ type: 'web.control', requestId: 's1', op: 'status' }) + '\n')
    await waitFor(
      () =>
        replReceived.some(
          f => f.type === 'web.controlResult' && f.requestId === 's1',
        ),
      5_000,
      'status result',
    )
    const statusFrame = replReceived.find(
      f => f.type === 'web.controlResult' && f.requestId === 's1',
    ) as { ok: boolean; status: { running: boolean; port: number } }
    expect(statusFrame.ok).toBe(true)
    expect(statusFrame.status.running).toBe(true)
    expect(statusFrame.status.port).toBe(webPort)

    // 送 stop
    replWs.send(JSON.stringify({ type: 'web.control', requestId: 's2', op: 'stop' }) + '\n')
    await waitFor(
      () =>
        replReceived.some(
          f => f.type === 'web.controlResult' && f.requestId === 's2',
        ),
      10_000,
      'stop result',
    )
    const stopFrame = replReceived.find(
      f => f.type === 'web.controlResult' && f.requestId === 's2',
    ) as { ok: boolean; status: { running: boolean } }
    expect(stopFrame.ok).toBe(true)
    expect(stopFrame.status.running).toBe(false)
    // broadcast 也應收到
    await waitFor(
      () => replReceived.some(f => f.type === 'web.statusChanged'),
      3_000,
      'statusChanged broadcast',
    )

    // 確認 web 真的停了
    await new Promise(r => setTimeout(r, 200))
    let webDown = false
    try {
      await fetch(`http://127.0.0.1:${webPort}/api/health`, {
        signal: AbortSignal.timeout(500),
      })
    } catch {
      webDown = true
    }
    expect(webDown).toBe(true)
    replWs.close()
  }, 60_000)
})
