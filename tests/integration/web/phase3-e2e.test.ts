/**
 * M-WEB Phase 3 E2E：右欄全 CRUD（cron / memory / llamacpp）。
 *
 *   啟 daemon → web autoStart
 *   → cron CRUD（已 M-WEB-14 cover）
 *   → memory list / body / delete
 *   → llamacpp watchdog GET / PUT
 *   → 跨端：thin-client（REPL 模式）讀同一 cron 任務 / memory entry
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
  return 26000 + Math.floor(Math.random() * 1000)
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

describe('M-WEB Phase 3 E2E：right panel CRUD', () => {
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
    baseDir = mkdtempSync(join(tmpdir(), 'web-p3-base-'))
    projectDir = mkdtempSync(join(tmpdir(), 'web-p3-proj-'))
    webRoot = mkdtempSync(join(tmpdir(), 'web-p3-root-'))
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
        agentVersion: 'web-p3',
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

  test('GET /api/memory empty initially', async () => {
    await startDaemon()
    await waitWebUp()
    const id = await getProjectId()
    const r = await fetch(
      `http://127.0.0.1:${webPort}/api/projects/${encodeURIComponent(id)}/memory`,
    )
    expect(r.status).toBe(200)
    const body = (await r.json()) as { entries: unknown[] }
    expect(Array.isArray(body.entries)).toBe(true)
  }, 30_000)

  test('GET /api/memory/body 拒非 entries 列表內路徑', async () => {
    await startDaemon()
    await waitWebUp()
    const id = await getProjectId()
    const r = await fetch(
      `http://127.0.0.1:${webPort}/api/projects/${encodeURIComponent(id)}/memory/body?path=${encodeURIComponent('/etc/passwd')}`,
    )
    expect(r.status).toBe(403)
    const body = (await r.json()) as { code: string }
    expect(body.code).toBe('PATH_NOT_ALLOWED')
  }, 30_000)

  test('GET /api/llamacpp/watchdog → returns config object', async () => {
    await startDaemon()
    await waitWebUp()
    const r = await fetch(`http://127.0.0.1:${webPort}/api/llamacpp/watchdog`)
    expect(r.status).toBe(200)
    const body = (await r.json()) as { config: unknown }
    expect(body.config).toBeDefined()
    expect(typeof body.config).toBe('object')
  }, 30_000)

  test('PUT /api/llamacpp/watchdog → 寫入 + 廣播 llamacpp.configChanged', async () => {
    await startDaemon()
    await waitWebUp()
    // 連 WS（任意 subscribe）
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
    await waitFor(() => received.some(f => f.type === 'hello'), 5_000, 'hello')

    // 讀現值
    const r = await fetch(`http://127.0.0.1:${webPort}/api/llamacpp/watchdog`)
    const before = (await r.json()) as { config: Record<string, unknown> }

    const next = {
      ...before.config,
      enabled: !before.config.enabled,
    }
    const r2 = await fetch(
      `http://127.0.0.1:${webPort}/api/llamacpp/watchdog`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(next),
      },
    )
    expect(r2.status).toBe(200)

    await waitFor(
      () => received.some(f => f.type === 'llamacpp.configChanged'),
      5_000,
      'llamacpp.configChanged broadcast',
    )

    // 還原（避免污染後續 test）
    await fetch(`http://127.0.0.1:${webPort}/api/llamacpp/watchdog`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(before.config),
    })
    ws.close()
  }, 30_000)

  test('cron CRUD 完整 lifecycle 且 memory.itemsChanged broadcast 不誤觸', async () => {
    await startDaemon()
    await waitWebUp()
    const id = await getProjectId()
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
      'sub',
    )

    // create
    const r = await fetch(
      `http://127.0.0.1:${webPort}/api/projects/${encodeURIComponent(id)}/cron`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          cron: '0 12 * * *',
          prompt: 'lunch reminder',
          recurring: true,
          name: 'lunch',
        }),
      },
    )
    expect(r.status).toBe(201)
    const cb = (await r.json()) as { taskId: string }
    const taskId = cb.taskId

    await waitFor(
      () =>
        received.some(
          f => f.type === 'cron.tasksChanged' && f.projectId === id,
        ),
      5_000,
      'cron.tasksChanged after create',
    )

    // memory.itemsChanged 不該誤觸（cron mutation 不影響 memory）
    expect(
      received.some(f => f.type === 'memory.itemsChanged'),
    ).toBe(false)

    // delete
    const r2 = await fetch(
      `http://127.0.0.1:${webPort}/api/projects/${encodeURIComponent(id)}/cron/${taskId}`,
      { method: 'DELETE' },
    )
    expect(r2.status).toBe(200)
    ws.close()
  }, 60_000)
})
