/**
 * M-DAEMON-4d：End-to-end 測試 — daemon start + QueryEngine 真實 round-trip。
 *
 * 起 daemon（enableQueryEngine=true）→ WS client attach → 送 `{type:'input',text}`
 * → 收 runnerEvent（含 SDKMessage）→ 收 turnEnd.reason='done' → session.jsonl 存在
 * 且非空。
 *
 * 前提：本地 llama.cpp server 在 127.0.0.1:8080。啟動前 health check；
 * 失敗就 skip（不擋 CI）。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

// MACRO 在 bundle 時由 bun --define 注入，裸 bun test 沒有，需要 shim。
// 同 `src/entrypoints/cli.tsx`。
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
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const LLAMACPP_URL = 'http://127.0.0.1:8080/health'

// Sync health check at module load — describe.skipIf 需要在 register time 拿到值。
async function checkLlamaAlive(): Promise<boolean> {
  try {
    const r = await fetch(LLAMACPP_URL, {
      signal: AbortSignal.timeout(1_000),
    })
    return r.ok
  } catch {
    return false
  }
}
const llamacppAlive = await checkLlamaAlive()

describe.skipIf(!llamacppAlive)('daemon E2E — QueryEngine round trip', () => {
  let tmpDir: string
  let handle: import('../../../src/daemon/daemonMain').DaemonHandle | null =
    null
  let origConfigHome: string | undefined

  let origTestPersist: string | undefined
  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'daemon-e2e-'))
    origConfigHome = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    // bun test 預設 NODE_ENV=test；sessionStorage 會 shouldSkipPersistence 吃掉
    // 寫入。設 TEST_ENABLE_SESSION_PERSISTENCE=1 讓真正寫 jsonl。
    origTestPersist = process.env.TEST_ENABLE_SESSION_PERSISTENCE
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  })

  afterAll(async () => {
    if (handle) {
      try {
        await handle.stop()
      } catch {
        // ignore
      }
    }
    if (origConfigHome === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = origConfigHome
    if (origTestPersist === undefined)
      delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    else process.env.TEST_ENABLE_SESSION_PERSISTENCE = origTestPersist
    // Windows 上 daemon 還沒完全放開 file handle 時 rmSync 會 EBUSY；best-effort。
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // 忽略；OS 最終會清 %TEMP%
    }
  })

  test('WS input → runnerEvent stream → turnEnd done → session.jsonl written', async () => {
    const { runDaemonStart } = await import(
      '../../../src/daemon/daemonCli.js'
    )
    const stdout: string[] = []
    const stderr: string[] = []
    handle = await runDaemonStart(
      {
        baseDir: tmpDir,
        agentVersion: 'e2e',
        stdout: m => stdout.push(m),
        stderr: m => stderr.push(m),
      },
      {
        port: 0,
        blockUntilStopped: false,
        enableQueryEngine: true,
        cwd: tmpDir,
      },
    )
    expect(handle.server).not.toBeNull()
    const port = handle.server!.port
    const token = handle.token
    expect(port).toBeGreaterThan(0)

    // 連 WS。
    const url = `ws://127.0.0.1:${port}/sessions?token=${token}`
    const ws = new WebSocket(url)
    const frames: Record<string, unknown>[] = []
    let gotHello = false
    let turnEndReason: string | null = null

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
      try {
        // Frame 可能是單行 JSON 或 multi。split by newline。
        const text = e.data as string
        for (const line of text.split(/\r?\n/)) {
          const s = line.trim()
          if (!s) continue
          const obj = JSON.parse(s) as Record<string, unknown>
          frames.push(obj)
          if (obj.type === 'hello') gotHello = true
          if (obj.type === 'turnEnd') {
            turnEndReason = String(obj.reason)
          }
        }
      } catch {
        // ignore malformed
      }
    }

    // 等 hello frame（表示 broker 已 wire 上；sessionHandle 的 hello 是
    // server.send onClientConnect 觸發的）。
    await waitFor(() => gotHello, 3_000)

    // 送一條 input。
    ws.send(
      JSON.stringify({
        type: 'input',
        text: 'Reply with exactly: pong',
        intent: 'interactive',
      }) + '\n',
    )

    // 等 turnEnd（llama.cpp 回一個短 reply 應該 <30s）。
    await waitFor(() => turnEndReason !== null, 45_000)
    expect(turnEndReason).toBe('done')

    // 收到的 runnerEvent 應該含至少一個 SDK 'assistant' message。
    const runnerEvents = frames.filter(f => f.type === 'runnerEvent')
    expect(runnerEvents.length).toBeGreaterThan(0)

    // 確保 Project async write queue 已刷下去。
    const { flushSessionStorage } = await import(
      '../../../src/utils/sessionStorage.js'
    )
    await flushSessionStorage()
    await new Promise(r => setTimeout(r, 200))

    const projectsDir = join(tmpDir, 'projects')
    const { readdirSync, statSync } = await import('fs')
    expect(existsSync(projectsDir)).toBe(true)
    const projects = readdirSync(projectsDir)
    let anyJsonl: string | null = null
    for (const p of projects) {
      const subdir = join(projectsDir, p)
      if (!statSync(subdir).isDirectory()) continue
      const files = readdirSync(subdir).filter(f => f.endsWith('.jsonl'))
      if (files.length > 0) {
        anyJsonl = join(subdir, files[0]!)
        break
      }
    }
    expect(anyJsonl).not.toBeNull()
    const content = readFileSync(anyJsonl!, 'utf-8')
    expect(content.length).toBeGreaterThan(0)
    // 至少有一筆 user 或 assistant 訊息。
    const lines = content.trim().split(/\n/)
    const types = lines
      .map(l => {
        try {
          return (JSON.parse(l) as { type?: string }).type
        } catch {
          return null
        }
      })
      .filter(Boolean)
    expect(types.some(t => t === 'user' || t === 'assistant')).toBe(true)

    ws.close()
  }, 60_000)
})

function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = (): void => {
      if (predicate()) return resolve()
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`timeout after ${timeoutMs}ms`))
      }
      setTimeout(tick, 30)
    }
    tick()
  })
}
