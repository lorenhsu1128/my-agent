/**
 * M-WEB Phase 2 E2E：REST /api/projects + /api/sessions + WS subscribe broadcast。
 *
 *   啟 daemon（enableQueryEngine + web autoStart）
 *   → GET /api/projects 看到 auto-loaded default project
 *   → POST /api/projects { cwd } 動態載入第二個 project
 *   → web WS 訂閱 → 收到 project.added 廣播
 *   → DELETE /api/projects/:id 卸載 → 收到 project.removed
 *   → GET /api/projects/:id/sessions 看到 active session
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
  return 24000 + Math.floor(Math.random() * 1000)
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

describe('M-WEB Phase 2 E2E：REST + WS subscribe-broadcast', () => {
  let baseDir: string
  let projectA: string
  let projectB: string
  let webRoot: string
  let webCfgPath: string
  let webPort: number
  let handle: import('../../../src/daemon/daemonMain.js').DaemonHandle | null =
    null
  let origConfigHome: string | undefined
  let origWebPath: string | undefined
  let origTestPersist: string | undefined

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'web-p2-base-'))
    projectA = mkdtempSync(join(tmpdir(), 'web-p2-A-'))
    projectB = mkdtempSync(join(tmpdir(), 'web-p2-B-'))
    webRoot = mkdtempSync(join(tmpdir(), 'web-p2-root-'))
    writeFileSync(join(webRoot, 'index.html'), '<html>p2</html>')
    webCfgPath = join(baseDir, 'web.jsonc')
    webPort = pickPort()
    writeFileSync(
      webCfgPath,
      JSON.stringify({
        enabled: true,
        autoStart: true,
        port: webPort,
        maxPortProbes: 5,
        bindHost: '127.0.0.1',
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
    for (const d of [baseDir, projectA, projectB, webRoot]) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  })

  async function startDaemon(): Promise<void> {
    const { _resetWebConfigForTests } = await import(
      '../../../src/webConfig/index.js'
    )
    _resetWebConfigForTests()
    const { runDaemonStart } = await import(
      '../../../src/daemon/daemonCli.js'
    )
    handle = await runDaemonStart(
      {
        baseDir,
        agentVersion: 'web-p2',
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
  }

  async function waitWebUp(): Promise<void> {
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
  }

  test('GET /api/projects → default auto-loaded project', async () => {
    await startDaemon()
    await waitWebUp()
    const r = await fetch(`http://127.0.0.1:${webPort}/api/projects`)
    expect(r.status).toBe(200)
    const body = (await r.json()) as {
      projects: { cwd: string; projectId: string; name: string }[]
    }
    expect(body.projects.length).toBe(1)
    // cwd 可能 normalize（C:\ vs c:/），所以比對 normalized basename
    const norm = body.projects[0]!.cwd.replace(/\\/g, '/').toLowerCase()
    expect(norm).toBe(projectA.replace(/\\/g, '/').toLowerCase())
  }, 30_000)

  test('POST /api/projects loads new project + WS receives project.added', async () => {
    await startDaemon()
    await waitWebUp()
    // 先連 WS 訂閱「全部」之前先收 hello + 既有 project.added
    const ws = new WebSocket(`ws://127.0.0.1:${webPort}/ws`)
    const received: { type: string; project?: { cwd: string } }[] = []
    ws.addEventListener('message', e => {
      try {
        received.push(JSON.parse(typeof e.data === 'string' ? e.data : ''))
      } catch {
        // ignore
      }
    })
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ws open')), 5_000)
      ws.addEventListener('open', () => {
        clearTimeout(t)
        resolve()
      })
    })
    await waitFor(() => received.some(f => f.type === 'hello'), 5_000, 'hello')

    // 用 POST 載入 projectB
    const r = await fetch(`http://127.0.0.1:${webPort}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: projectB }),
    })
    expect(r.status).toBe(201)
    const body = (await r.json()) as {
      project: { projectId: string; cwd: string }
    }
    expect(body.project.cwd.replace(/\\/g, '/').toLowerCase()).toBe(
      projectB.replace(/\\/g, '/').toLowerCase(),
    )
    const newId = body.project.projectId

    // WS 應收到 project.added 廣播
    await waitFor(
      () =>
        received.some(
          f =>
            f.type === 'project.added' &&
            f.project?.cwd.replace(/\\/g, '/').toLowerCase() ===
              projectB.replace(/\\/g, '/').toLowerCase(),
        ),
      10_000,
      'project.added broadcast',
    )

    // GET /api/projects 也看得到
    const r2 = await fetch(`http://127.0.0.1:${webPort}/api/projects`)
    const body2 = (await r2.json()) as { projects: unknown[] }
    expect(body2.projects.length).toBe(2)

    // DELETE → 應 broadcast project.removed
    const r3 = await fetch(
      `http://127.0.0.1:${webPort}/api/projects/${encodeURIComponent(newId)}`,
      { method: 'DELETE' },
    )
    expect(r3.status).toBe(200)
    await waitFor(
      () =>
        received.some(
          f =>
            f.type === 'project.removed' &&
            (f as { projectId?: string }).projectId === newId,
        ),
      10_000,
      'project.removed broadcast',
    )
    ws.close()
  }, 60_000)

  test('GET /api/projects/:id/sessions → active session', async () => {
    await startDaemon()
    await waitWebUp()
    const r1 = await fetch(`http://127.0.0.1:${webPort}/api/projects`)
    const body1 = (await r1.json()) as { projects: { projectId: string }[] }
    const id = body1.projects[0]!.projectId
    const r2 = await fetch(
      `http://127.0.0.1:${webPort}/api/projects/${encodeURIComponent(id)}/sessions`,
    )
    expect(r2.status).toBe(200)
    const body2 = (await r2.json()) as {
      sessions: { sessionId: string; isActive: boolean }[]
      activeSessionId: string
    }
    expect(body2.sessions.length).toBeGreaterThan(0)
    expect(body2.sessions[0]!.isActive).toBe(true)
    expect(body2.activeSessionId).toBe(body2.sessions[0]!.sessionId)
  }, 30_000)

  test('多 WS client 同時訂閱 — 都收到 broadcast', async () => {
    await startDaemon()
    await waitWebUp()

    async function connectAndCollect(): Promise<{
      ws: WebSocket
      received: { type: string }[]
    }> {
      const ws = new WebSocket(`ws://127.0.0.1:${webPort}/ws`)
      const received: { type: string }[] = []
      ws.addEventListener('message', e => {
        try {
          received.push(JSON.parse(typeof e.data === 'string' ? e.data : ''))
        } catch {
          // ignore
        }
      })
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('open')), 5_000)
        ws.addEventListener('open', () => {
          clearTimeout(t)
          resolve()
        })
      })
      return { ws, received }
    }

    const a = await connectAndCollect()
    const b = await connectAndCollect()

    await waitFor(
      () => a.received.some(f => f.type === 'hello'),
      5_000,
      'a hello',
    )
    await waitFor(
      () => b.received.some(f => f.type === 'hello'),
      5_000,
      'b hello',
    )

    // 載入 projectB → 兩端都應收到 project.added
    await fetch(`http://127.0.0.1:${webPort}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: projectB }),
    })
    await waitFor(
      () => a.received.some(f => f.type === 'project.added'),
      10_000,
      'a got project.added',
    )
    await waitFor(
      () => b.received.some(f => f.type === 'project.added'),
      10_000,
      'b got project.added',
    )
    a.ws.close()
    b.ws.close()
  }, 60_000)
})
