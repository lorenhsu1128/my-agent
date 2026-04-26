/**
 * M-WEB-14：REST cron CRUD 整合測試（真 daemon + 真 cronTasks 寫盤）。
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
  return 25000 + Math.floor(Math.random() * 1000)
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

describe('M-WEB-14 REST cron CRUD E2E', () => {
  let baseDir: string
  let projectDir: string
  let webRoot: string
  let webCfgPath: string
  let webPort: number
  let handle: import('../../../src/daemon/daemonMain.js').DaemonHandle | null =
    null
  let origConfigHome: string | undefined
  let origWebPath: string | undefined
  let origTestPersist: string | undefined

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'web-cron-base-'))
    projectDir = mkdtempSync(join(tmpdir(), 'web-cron-proj-'))
    webRoot = mkdtempSync(join(tmpdir(), 'web-cron-root-'))
    writeFileSync(join(webRoot, 'index.html'), 'x')
    webCfgPath = join(baseDir, 'web.jsonc')
    webPort = pickPort()
    writeFileSync(
      webCfgPath,
      JSON.stringify({
        enabled: true,
        autoStart: true,
        port: webPort,
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
    for (const d of [baseDir, projectDir, webRoot]) {
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
        agentVersion: 'web-cron',
        stdout: () => {},
        stderr: () => {},
      },
      {
        port: 0,
        blockUntilStopped: false,
        enableQueryEngine: true,
        cwd: projectDir,
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

  async function getProjectId(): Promise<string> {
    const r = await fetch(`http://127.0.0.1:${webPort}/api/projects`)
    const body = (await r.json()) as { projects: { projectId: string }[] }
    return body.projects[0]!.projectId
  }

  test('GET /api/cron empty → []', async () => {
    await startDaemon()
    await waitWebUp()
    const id = await getProjectId()
    const r = await fetch(
      `http://127.0.0.1:${webPort}/api/projects/${encodeURIComponent(id)}/cron`,
    )
    expect(r.status).toBe(200)
    const body = (await r.json()) as { tasks: unknown[] }
    expect(body.tasks).toEqual([])
  }, 30_000)

  test('POST /api/cron → create + GET shows it + cron.tasksChanged broadcast', async () => {
    await startDaemon()
    await waitWebUp()
    const id = await getProjectId()
    // 連 WS 訂閱該 project
    const ws = new WebSocket(`ws://127.0.0.1:${webPort}/ws`)
    const received: { type: string; projectId?: string }[] = []
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
    await waitFor(() => received.some(f => f.type === 'hello'), 5_000, 'hello')
    ws.send(JSON.stringify({ type: 'subscribe', projectIds: [id] }))
    await waitFor(
      () => received.some(f => f.type === 'subscribed'),
      5_000,
      'subscribed',
    )

    const r = await fetch(
      `http://127.0.0.1:${webPort}/api/projects/${encodeURIComponent(id)}/cron`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          cron: '0 9 * * *',
          prompt: 'morning checkin',
          recurring: true,
          name: 'morning',
        }),
      },
    )
    if (r.status !== 201) {
      console.error('POST /api/cron failed:', r.status, await r.text())
    }
    expect(r.status).toBe(201)
    const body = (await r.json()) as {
      taskId?: string
      task: { id: string; prompt: string } | null
    }
    expect(typeof body.taskId).toBe('string')
    const taskId = body.taskId!

    // GET 應看到
    const r2 = await fetch(
      `http://127.0.0.1:${webPort}/api/projects/${encodeURIComponent(id)}/cron`,
    )
    const body2 = (await r2.json()) as { tasks: { id: string; prompt: string }[] }
    expect(body2.tasks.length).toBe(1)
    expect(body2.tasks[0]!.id).toBe(taskId)
    expect(body2.tasks[0]!.prompt).toBe('morning checkin')

    // 應收到 cron.tasksChanged broadcast
    await waitFor(
      () =>
        received.some(
          f => f.type === 'cron.tasksChanged' && f.projectId === id,
        ),
      5_000,
      'cron.tasksChanged broadcast',
    )

    // PATCH pause
    const r3 = await fetch(
      `http://127.0.0.1:${webPort}/api/projects/${encodeURIComponent(id)}/cron/${taskId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'pause' }),
      },
    )
    expect(r3.status).toBe(200)

    // DELETE
    const r4 = await fetch(
      `http://127.0.0.1:${webPort}/api/projects/${encodeURIComponent(id)}/cron/${taskId}`,
      { method: 'DELETE' },
    )
    expect(r4.status).toBe(200)

    const r5 = await fetch(
      `http://127.0.0.1:${webPort}/api/projects/${encodeURIComponent(id)}/cron`,
    )
    const body5 = (await r5.json()) as { tasks: unknown[] }
    expect(body5.tasks.length).toBe(0)
    ws.close()
  }, 60_000)

  test('POST cron 無 cron/prompt → 400', async () => {
    await startDaemon()
    await waitWebUp()
    const id = await getProjectId()
    const r = await fetch(
      `http://127.0.0.1:${webPort}/api/projects/${encodeURIComponent(id)}/cron`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cron: '* * * * *' }),
      },
    )
    expect(r.status).toBe(400)
  }, 30_000)
})
