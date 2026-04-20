/**
 * M-DAEMON-4.5 E2E：cron → daemon broker → WS broadcast pipeline。
 *
 * 起 daemon（queryEngine + cron wiring 都開）→ WS client attach → 直接觸發
 * cronWiring 已 wire 好的 scheduler onFire（或等價）→ attached WS 看到
 * source='cron' 的 turnStart。不跑實 LLM（用 echoRunner 架構對 cron 觸發
 * 路徑無關），也不等 60s 真 cron minute boundary — 目的是驗 pipeline 不是
 * 測 scheduler 的 tick logic（那個已在 cronScheduler 自己的測試覆蓋）。
 *
 * 作法：起 daemon 時 QueryEngineRunner 取代為 echoRunner，cronWiring 用 fake
 * modules inject 一個 scheduler 我們可以拿到 onFire 控制；叫 onFire 就等同
 * 真 cron 觸發。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startDaemon } from '../../../src/daemon/daemonMain'
import { createSessionBroker, handleClientMessage, sendHelloFrame } from '../../../src/daemon/sessionBroker'
import { echoRunner } from '../../../src/daemon/sessionRunner'
import { startDaemonCronWiring } from '../../../src/daemon/cronWiring'
import type { DaemonSessionContext } from '../../../src/daemon/sessionBootstrap'
import type { DaemonSessionHandle } from '../../../src/daemon/sessionWriter'
import type { CronScheduler } from '../../../src/utils/cronScheduler'

describe('daemon + cron wiring E2E', () => {
  let tmpDir: string
  let handle: import('../../../src/daemon/daemonMain').DaemonHandle | null =
    null

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'daemon-cron-e2e-'))
  })
  afterAll(async () => {
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

  test('cron fire → broker submit → WS client sees source=cron turnStart', async () => {
    // 1. 啟 daemon transport 層（WS server + pid.json + token）。
    let onMessage: (c: { id: string; source: string; connectedAt: number }, m: unknown) => void = () => {}
    let onConnect: (c: { id: string; source: string; connectedAt: number }) => void = () => {}
    handle = await startDaemon({
      baseDir: tmpDir,
      agentVersion: 'e2e-cron',
      port: 0,
      host: '127.0.0.1',
      onClientMessage: (c, m) => onMessage(c, m),
      onClientConnect: c => onConnect(c),
      registerSignalHandlers: false,
    })
    expect(handle.server).not.toBeNull()

    // 2. 組一個 minimal broker（用 echoRunner 避免拉 QueryEngine / MCP）。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeCtx = {} as DaemonSessionContext
    const fakeSessionHandle: DaemonSessionHandle = {
      sessionId: 'cron-e2e-session',
      projectDir: tmpDir,
      transcriptPath: join(tmpDir, 'cron-e2e-session.jsonl'),
      lockPath: join(tmpDir, '.daemon.lock'),
      dispose: () => {},
    }
    const broker = createSessionBroker({
      server: handle.server!,
      context: fakeCtx,
      runner: echoRunner,
      sessionHandle: fakeSessionHandle,
    })
    onMessage = (c, m): void =>
      handleClientMessage(broker, c, m, () => {})
    onConnect = (c): void => sendHelloFrame(broker, handle!.server!, c.id)

    // 3. 裝 cron wiring；inject fake scheduler module 讓我們能直接 onFire。
    let capturedOnFire: ((prompt: string) => void) | null = null
    const fakeScheduler: CronScheduler = {
      start: () => {},
      stop: () => {},
      getNextFireTime: () => null,
    }
    const cronHandle = startDaemonCronWiring({
      broker,
      isEnabled: () => true,
      modules: {
        createCronScheduler: opts => {
          capturedOnFire = opts.onFire
          return fakeScheduler
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getCronJitterConfig: (() => ({})) as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        runPreRunScript: (async () => ({ output: '' })) as any,
        augmentPromptWithPreRun: p => p,
      },
    })
    expect(cronHandle.scheduler).not.toBeNull()
    expect(capturedOnFire).not.toBeNull()

    // 4. WS client attach。
    const url = `ws://127.0.0.1:${handle.server!.port}/sessions?token=${handle.token}`
    const ws = new WebSocket(url)
    const frames: Record<string, unknown>[] = []
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ws open timeout')), 3_000)
      ws.onopen = (): void => {
        clearTimeout(t)
        resolve()
      }
      ws.onerror = (e): void => {
        clearTimeout(t)
        reject(new Error(`ws error ${String(e)}`))
      }
    })
    ws.onmessage = (e: MessageEvent): void => {
      const text = e.data as string
      for (const line of text.split(/\r?\n/)) {
        const s = line.trim()
        if (!s) continue
        try {
          frames.push(JSON.parse(s) as Record<string, unknown>)
        } catch {
          // ignore
        }
      }
    }

    // 等 hello（確認 onConnect 觸發路徑通）。
    await waitFor(() => frames.some(f => f.type === 'hello'), 2_000)

    // 5. 觸發 cron fire。
    capturedOnFire!('hello from fake cron')

    // 6. 等 turnStart + turnEnd。echoRunner 快速，<1s。
    await waitFor(() => frames.some(f => f.type === 'turnEnd'), 3_000)

    const turnStart = frames.find(f => f.type === 'turnStart') as {
      source: string
      clientId: string
    }
    expect(turnStart).toBeDefined()
    expect(turnStart.source).toBe('cron')
    expect(turnStart.clientId).toBe('daemon-cron')

    const turnEnd = frames.find(f => f.type === 'turnEnd') as { reason: string }
    expect(turnEnd.reason).toBe('done')

    ws.close()
    cronHandle.stop()
    await broker.dispose()
  }, 10_000)
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
        return reject(new Error(`timeout ${timeoutMs}ms`))
      }
      setTimeout(tick, 30)
    }
    tick()
  })
}
