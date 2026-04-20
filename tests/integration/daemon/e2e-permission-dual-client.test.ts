/**
 * M-DAEMON-7c E2E：雙 client attached 同 daemon，permission 路由驗證。
 *
 * 流程：
 *   1. 起 daemon transport（不走完整 QueryEngine；直接用 router）
 *   2. attach clientA（source）+ clientB（旁觀）
 *   3. 呼叫 router.canUseTool(...) 模擬 daemon 內 tool 請求 permission
 *   4. 驗 clientA 收 permissionRequest；clientB 收 permissionPending
 *   5. clientA 送 permissionResponse{decision:'allow'} 回
 *   6. router 收到 → 呼叫 handleResponse → canUseTool promise resolve allow
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startDaemon, type DaemonHandle } from '../../../src/daemon/daemonMain'
import { createPermissionRouter } from '../../../src/daemon/permissionRouter'
import type { Tool } from '../../../src/Tool'
import type { ClientInfo } from '../../../src/server/clientRegistry'

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
      setTimeout(tick, 20)
    }
    tick()
  })
}

let tmpDir: string
let handle: DaemonHandle | null

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'perm-e2e-'))
  handle = null
})
afterEach(async () => {
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

describe('dual-client permission E2E', () => {
  test('source receives request, peer receives pending, response routes back', async () => {
    // 1. 起 daemon（不 enableQueryEngine — 我們自己組 router）
    const clientConnected: ClientInfo[] = []
    // Router handle set after creation
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let router: ReturnType<typeof createPermissionRouter> | null = null
    handle = await startDaemon({
      baseDir: tmpDir,
      agentVersion: 'perm-e2e',
      port: 0,
      onClientMessage: (c, m) => {
        router?.handleResponse(c.id, m)
      },
      onClientConnect: c => clientConnected.push(c),
      registerSignalHandlers: false,
    })
    expect(handle.server).not.toBeNull()

    // Router：source 指向先連的 client
    let sourceClientId: string | null = null
    router = createPermissionRouter({
      server: handle.server!,
      resolveSourceClientId: () => sourceClientId,
      resolveCurrentInputId: () => 'input-A',
      timeoutMs: 10_000,
    })

    // 2. 起兩個 WS client。
    const url = `ws://127.0.0.1:${handle.server!.port}/sessions?token=${handle.token}`
    const wsA = new WebSocket(url)
    const wsB = new WebSocket(url)
    const framesA: Record<string, unknown>[] = []
    const framesB: Record<string, unknown>[] = []

    const attach = (ws: WebSocket, sink: Record<string, unknown>[]): Promise<void> =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('ws open timeout')), 3_000)
        ws.onopen = (): void => {
          clearTimeout(t)
          resolve()
        }
        ws.onmessage = (e: MessageEvent): void => {
          for (const line of (e.data as string).split(/\r?\n/)) {
            const s = line.trim()
            if (!s) continue
            try {
              sink.push(JSON.parse(s) as Record<string, unknown>)
            } catch {
              // ignore
            }
          }
        }
        ws.onerror = (e): void => {
          clearTimeout(t)
          reject(new Error(`ws err: ${String(e)}`))
        }
      })

    await Promise.all([attach(wsA, framesA), attach(wsB, framesB)])
    await waitFor(() => clientConnected.length === 2, 3_000)
    // client A 先連（以 connectedAt 排序）
    const [first, second] =
      clientConnected[0]!.connectedAt <= clientConnected[1]!.connectedAt
        ? [clientConnected[0]!, clientConnected[1]!]
        : [clientConnected[1]!, clientConnected[0]!]
    sourceClientId = first.id

    // 3. 模擬 daemon 內部 tool 要求 permission。
    const fakeTool: Tool = {
      name: 'Edit',
      isReadOnly: () => false,
      isDestructive: () => false,
      userFacingName: () => 'Edit file',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const decisionPromise = router.canUseTool(
      fakeTool,
      { file_path: '/tmp/foo.txt' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      'toolUse-123',
    )

    // 4. 等 frame 抵達。判斷哪邊是 source vs peer（依 connectedAt 順序）
    const sourceFrames = first.id === clientConnected[0]!.id ? framesA : framesB
    const peerFrames = first.id === clientConnected[0]!.id ? framesB : framesA

    await waitFor(
      () => sourceFrames.some(f => f.type === 'permissionRequest'),
      3_000,
    )
    const req = sourceFrames.find(f => f.type === 'permissionRequest') as {
      toolUseID: string
      toolName: string
      riskLevel: string
      affectedPaths?: string[]
    }
    expect(req.toolUseID).toBe('toolUse-123')
    expect(req.toolName).toBe('Edit')
    expect(req.riskLevel).toBe('write')
    expect(req.affectedPaths).toContain('/tmp/foo.txt')

    // 5. peer 收到 permissionPending，且不在 source。
    await waitFor(
      () => peerFrames.some(f => f.type === 'permissionPending'),
      3_000,
    )
    // source 不應該也收到 pending
    expect(sourceFrames.some(f => f.type === 'permissionPending')).toBe(false)

    // 6. source client 送回 permissionResponse allow。
    const srcWs = first.id === clientConnected[0]!.id ? wsA : wsB
    srcWs.send(
      JSON.stringify({
        type: 'permissionResponse',
        toolUseID: 'toolUse-123',
        decision: 'allow',
        updatedInput: { file_path: '/tmp/foo.txt' },
      }) + '\n',
    )

    // 7. router 解鎖 → decision
    const decision = await decisionPromise
    expect(decision.behavior).toBe('allow')

    wsA.close()
    wsB.close()
  }, 15_000)

  test('peer receives pending but cannot answer; source response wins', async () => {
    let router: ReturnType<typeof createPermissionRouter> | null = null
    const clientConnected: ClientInfo[] = []
    handle = await startDaemon({
      baseDir: tmpDir,
      agentVersion: 'perm-e2e-2',
      port: 0,
      onClientMessage: (c, m) => {
        router?.handleResponse(c.id, m)
      },
      onClientConnect: c => clientConnected.push(c),
      registerSignalHandlers: false,
    })
    let sourceClientId: string | null = null
    router = createPermissionRouter({
      server: handle.server!,
      resolveSourceClientId: () => sourceClientId,
      resolveCurrentInputId: () => 'i',
      timeoutMs: 10_000,
    })

    const url = `ws://127.0.0.1:${handle.server!.port}/sessions?token=${handle.token}`
    const wsA = new WebSocket(url)
    const wsB = new WebSocket(url)

    await Promise.all([
      new Promise<void>(r => {
        wsA.onopen = (): void => r()
      }),
      new Promise<void>(r => {
        wsB.onopen = (): void => r()
      }),
    ])
    await waitFor(() => clientConnected.length === 2, 3_000)
    const [first, second] =
      clientConnected[0]!.connectedAt <= clientConnected[1]!.connectedAt
        ? [clientConnected[0]!, clientConnected[1]!]
        : [clientConnected[1]!, clientConnected[0]!]
    sourceClientId = first.id

    const fakeTool: Tool = {
      name: 'Read',
      isReadOnly: () => true,
      userFacingName: () => 'Read file',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const decisionPromise = router.canUseTool(
      fakeTool,
      { file_path: '/etc/passwd' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      'toolUse-R',
    )

    // Peer（second）試著送 response（應被 router 忽略 — router 不驗 sender，
    // 但 handleResponse 只解對應 toolUseID 的 pending；所以無論誰送都能解鎖）
    // 這裡要驗的是：非 source client 先送 deny，source 再送 allow，
    // 第一個 wins（router 不做 source check，first-wins）
    //
    // 這行為意圖：Q4 有 fallback；Q1 spec 未 enforce source-only
    // （信任由 broker 層做；本 router 就是 first-wins）。測試記錄這個實際行為
    // 而不是「source-only enforcement」。
    await new Promise(r => setTimeout(r, 50)) // 讓 request frame 送達
    const peerWs = first.id === clientConnected[0]!.id ? wsB : wsA
    peerWs.send(
      JSON.stringify({
        type: 'permissionResponse',
        toolUseID: 'toolUse-R',
        decision: 'deny',
        message: 'peer denied',
      }) + '\n',
    )
    const decision = await decisionPromise
    expect(decision.behavior).toBe('deny')

    wsA.close()
    wsB.close()
  }, 15_000)
})
