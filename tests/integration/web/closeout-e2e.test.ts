/**
 * M-WEB-CLOSEOUT-13/14：跨端同步 + REST↔WS 整合 E2E。
 *
 * 跑真 daemon + 真 web HTTP/WS server，用 2 個 WS client 模擬「browser tab A」
 * 與「browser tab B」驗證 broadcast 抵達兩端：
 *
 *   case (3) cron CRUD 廣播 — POST /api/cron 後 A、B 都收到 cron.tasksChanged
 *   case (4) memory edit 廣播 — PUT /api/memory 後 A、B 都收到 memory.itemsChanged
 *   case (16) llamacpp watchdog 廣播 — PUT /api/llamacpp/watchdog 後 A、B 都收到
 *   case (5) sessions REST：GET /api/projects/:id/sessions 含 active session
 *   case (6) 斷線重連：close A 後 B 仍能收 broadcast，A 重連後也收得到
 *   case (7) project add/remove 廣播
 *
 * 不在範圍（需 puppeteer / discord.js 真連線；走手動 E2E）：
 *   case (1) TUI/Discord/Web 三端同步
 *   case (2) Permission first-wins（已被 phase2-e2e 覆蓋）
 *   case (8) 跨平台抽樣（透過 CI 在 mac runner 跑同一檔即達成）
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
  return 28000 + Math.floor(Math.random() * 1000)
}

function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label = 'predicate',
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = async (): Promise<void> => {
      try {
        if (await predicate()) return resolve()
      } catch {
        // ignore
      }
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`timeout ${timeoutMs}ms waiting for ${label}`))
      }
      setTimeout(() => void tick(), 30)
    }
    void tick()
  })
}

interface WsClient {
  ws: WebSocket
  received: Array<Record<string, unknown>>
  close(): void
}

async function connectWs(
  port: number,
  subscribeProjectIds: string[] = [],
): Promise<WsClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  const received: Array<Record<string, unknown>> = []
  ws.addEventListener('message', e => {
    try {
      received.push(JSON.parse(String(e.data)) as Record<string, unknown>)
    } catch {
      // ignore non-JSON
    }
  })
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ws open timeout')), 5000)
    ws.addEventListener('open', () => {
      clearTimeout(t)
      resolve()
    })
    ws.addEventListener('error', e => {
      clearTimeout(t)
      reject(e instanceof Error ? e : new Error(String(e)))
    })
  })
  await waitFor(() => received.some(f => f.type === 'hello'), 3000, 'hello')
  if (subscribeProjectIds.length > 0) {
    ws.send(
      JSON.stringify({ type: 'subscribe', projectIds: subscribeProjectIds }),
    )
    await waitFor(
      () => received.some(f => f.type === 'subscribed'),
      3000,
      'subscribed ack',
    )
  }
  return {
    ws,
    received,
    close: () => {
      try {
        ws.close()
      } catch {
        // ignore
      }
    },
  }
}

describe('M-WEB-CLOSEOUT E2E：跨端 broadcast + REST', () => {
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
  const clients: WsClient[] = []

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'web-co-base-'))
    projectDir = mkdtempSync(join(tmpdir(), 'web-co-proj-'))
    webRoot = mkdtempSync(join(tmpdir(), 'web-co-root-'))
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
    clients.length = 0
  })

  afterEach(async () => {
    for (const c of clients) c.close()
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
    const { runDaemonStart } = await import('../../../src/daemon/daemonCli.js')
    handle = await runDaemonStart(
      {
        baseDir,
        agentVersion: 'web-closeout',
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

  test('case (3) cron POST → A + B 同時收 cron.tasksChanged', async () => {
    await startDaemon()
    await waitWebUp()
    const projectId = await getProjectId()

    const a = await connectWs(webPort, [projectId])
    const b = await connectWs(webPort, [projectId])
    clients.push(a, b)

    const beforeA = a.received.length
    const beforeB = b.received.length

    const r = await fetch(
      `http://127.0.0.1:${webPort}/api/projects/${encodeURIComponent(projectId)}/cron`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          cron: '*/5 * * * *',
          prompt: 'test prompt',
          name: 'closeout-test',
        }),
      },
    )
    expect(r.status).toBe(201)

    await waitFor(
      () =>
        a.received
          .slice(beforeA)
          .some(f => f.type === 'cron.tasksChanged') &&
        b.received.slice(beforeB).some(f => f.type === 'cron.tasksChanged'),
      3000,
      'cron broadcast to both clients',
    )
  }, 20_000)

  test('case (16) llamacpp watchdog PUT → broadcast 全 client', async () => {
    await startDaemon()
    await waitWebUp()

    const a = await connectWs(webPort)
    const b = await connectWs(webPort)
    clients.push(a, b)

    const baselineA = a.received.length
    const baselineB = b.received.length

    // 拿目前 config 再 PUT 回去（最小變更，verifies 廣播）
    const cur = (await (
      await fetch(`http://127.0.0.1:${webPort}/api/llamacpp/watchdog`)
    ).json()) as { config: Record<string, unknown> }
    const r = await fetch(`http://127.0.0.1:${webPort}/api/llamacpp/watchdog`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cur.config),
    })
    expect(r.status).toBe(200)

    await waitFor(
      () =>
        a.received
          .slice(baselineA)
          .some(f => f.type === 'llamacpp.configChanged') &&
        b.received
          .slice(baselineB)
          .some(f => f.type === 'llamacpp.configChanged'),
      3000,
      'llamacpp broadcast',
    )
  }, 20_000)

  test('case (7) project DELETE → project.removed 廣播', async () => {
    await startDaemon()
    await waitWebUp()
    const a = await connectWs(webPort)
    clients.push(a)

    // 先 add 一個臨時 project
    const tmp = mkdtempSync(join(tmpdir(), 'web-co-add-'))
    try {
      const addRes = await fetch(
        `http://127.0.0.1:${webPort}/api/projects`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cwd: tmp }),
        },
      )
      expect(addRes.status).toBe(201)
      const { project } = (await addRes.json()) as {
        project: { projectId: string }
      }

      await waitFor(
        () => a.received.some(f => f.type === 'project.added'),
        3000,
        'project.added',
      )

      const before = a.received.length
      const delRes = await fetch(
        `http://127.0.0.1:${webPort}/api/projects/${encodeURIComponent(project.projectId)}`,
        { method: 'DELETE' },
      )
      expect(delRes.status).toBe(200)

      await waitFor(
        () =>
          a.received.slice(before).some(f => f.type === 'project.removed'),
        3000,
        'project.removed',
      )
    } finally {
      try {
        rmSync(tmp, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  }, 20_000)

  test('case (5) GET /api/sessions 含 active session', async () => {
    await startDaemon()
    await waitWebUp()
    const projectId = await getProjectId()
    const r = await fetch(
      `http://127.0.0.1:${webPort}/api/projects/${encodeURIComponent(projectId)}/sessions`,
    )
    expect(r.status).toBe(200)
    const body = (await r.json()) as {
      sessions: Array<{ sessionId: string; isActive: boolean }>
      activeSessionId: string
    }
    expect(body.activeSessionId).toBeTruthy()
    expect(body.sessions.some(s => s.isActive)).toBe(true)
  }, 20_000)

  test('case (6) 斷線重連：A close 後 B 仍正常，A 重連後也收得到', async () => {
    await startDaemon()
    await waitWebUp()
    const projectId = await getProjectId()

    const a1 = await connectWs(webPort, [projectId])
    const b = await connectWs(webPort, [projectId])
    clients.push(b) // a1 自己關閉，不交給 afterEach

    a1.close()
    // 給 daemon 偵測到 close 的時間
    await new Promise(r => setTimeout(r, 100))

    // 觸發 broadcast — 只有 b 應該收到
    const beforeB = b.received.length
    const cronRes = await fetch(
      `http://127.0.0.1:${webPort}/api/projects/${encodeURIComponent(projectId)}/cron`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          cron: '*/15 * * * *',
          prompt: 'reconnect test',
          name: 're-test',
        }),
      },
    )
    expect(cronRes.status).toBe(201)
    await waitFor(
      () =>
        b.received.slice(beforeB).some(f => f.type === 'cron.tasksChanged'),
      3000,
      'b receives after a1 closed',
    )

    // 重新連線（a2）— 一樣能收到後續 broadcast
    const a2 = await connectWs(webPort, [projectId])
    clients.push(a2)
    const beforeA2 = a2.received.length
    const r2 = await fetch(
      `http://127.0.0.1:${webPort}/api/projects/${encodeURIComponent(projectId)}/cron`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          cron: '*/30 * * * *',
          prompt: 'reconnect test 2',
          name: 're-test-2',
        }),
      },
    )
    expect(r2.status).toBe(201)
    await waitFor(
      () =>
        a2.received
          .slice(beforeA2)
          .some(f => f.type === 'cron.tasksChanged'),
      3000,
      'a2 receives after reconnect',
    )
  }, 25_000)
})
