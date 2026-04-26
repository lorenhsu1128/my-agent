/**
 * M-WEB Phase 4 E2E：sessionIndex read API + QR endpoint。
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
  return 27000 + Math.floor(Math.random() * 1000)
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

describe('M-WEB Phase 4 E2E：sessionIndex + QR', () => {
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
    baseDir = mkdtempSync(join(tmpdir(), 'web-p4-base-'))
    projectDir = mkdtempSync(join(tmpdir(), 'web-p4-proj-'))
    webRoot = mkdtempSync(join(tmpdir(), 'web-p4-root-'))
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
        agentVersion: 'web-p4',
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

  test('GET /api/sessions returns active session at minimum', async () => {
    await startDaemon()
    await waitWebUp()
    const id = await getProjectId()
    const r = await fetch(
      `http://127.0.0.1:${webPort}/api/projects/${encodeURIComponent(id)}/sessions`,
    )
    expect(r.status).toBe(200)
    const body = (await r.json()) as {
      sessions: { sessionId: string; isActive: boolean }[]
      activeSessionId: string
    }
    expect(body.sessions.length).toBeGreaterThan(0)
    const active = body.sessions.find(s => s.isActive)
    expect(active).toBeDefined()
    expect(active!.sessionId).toBe(body.activeSessionId)
  }, 30_000)

  test('GET /api/messages for unknown session → empty array', async () => {
    await startDaemon()
    await waitWebUp()
    const id = await getProjectId()
    const fakeSid = '00000000-0000-0000-0000-000000000000'
    const r = await fetch(
      `http://127.0.0.1:${webPort}/api/projects/${encodeURIComponent(id)}/sessions/${fakeSid}/messages?limit=10`,
    )
    expect(r.status).toBe(200)
    const body = (await r.json()) as { messages: unknown[]; sessionId: string }
    expect(Array.isArray(body.messages)).toBe(true)
    expect(body.sessionId).toBe(fakeSid)
  }, 30_000)

  test('GET /api/search short query → empty hits（trigram min 3 char）', async () => {
    await startDaemon()
    await waitWebUp()
    const id = await getProjectId()
    const r = await fetch(
      `http://127.0.0.1:${webPort}/api/projects/${encodeURIComponent(id)}/search?q=hi`,
    )
    expect(r.status).toBe(200)
    const body = (await r.json()) as { hits: unknown[]; query: string }
    expect(body.hits).toEqual([])
    expect(body.query).toBe('hi')
  }, 30_000)

  test('GET /api/search valid query → array result', async () => {
    await startDaemon()
    await waitWebUp()
    const id = await getProjectId()
    const r = await fetch(
      `http://127.0.0.1:${webPort}/api/projects/${encodeURIComponent(id)}/search?q=hello`,
    )
    expect(r.status).toBe(200)
    const body = (await r.json()) as { hits: unknown[] }
    expect(Array.isArray(body.hits)).toBe(true)
  }, 30_000)

  test('GET /api/qr → PNG bytes', async () => {
    await startDaemon()
    await waitWebUp()
    const r = await fetch(
      `http://127.0.0.1:${webPort}/api/qr?url=${encodeURIComponent('http://192.168.1.5:9090')}`,
    )
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('image/png')
    const buf = await r.arrayBuffer()
    expect(buf.byteLength).toBeGreaterThan(100)
    // PNG magic: 89 50 4E 47
    const view = new Uint8Array(buf)
    expect(view[0]).toBe(0x89)
    expect(view[1]).toBe(0x50)
    expect(view[2]).toBe(0x4e)
    expect(view[3]).toBe(0x47)
  }, 30_000)

  test('GET /api/qr 缺 url → 400', async () => {
    await startDaemon()
    await waitWebUp()
    const r = await fetch(`http://127.0.0.1:${webPort}/api/qr`)
    expect(r.status).toBe(400)
  }, 30_000)
})
