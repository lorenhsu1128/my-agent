/**
 * M-DAEMON-2：WS server + client registry 測試。
 *
 * 測試策略：
 *   - 直接啟動 `startDirectConnectServer`，用 bun 內建 `WebSocket` 當 client
 *   - Auth：無 token → 401；錯 token → 403；對的 token → 成功升級
 *   - 訊息：newline-delimited JSON，server 呼叫 onMessage callback
 *   - Registry：broadcast / send / disconnect cleanup
 *   - 整合：`startDaemon({ enableServer: true })` 寫入實際 port 到 pid.json
 *
 * 這些測試都用 port 0（OS 指派），不綁固定 port 以避免 flaky。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startDaemon } from '../../../src/daemon/daemonMain'
import {
  startDirectConnectServer,
  type DirectConnectServerHandle,
} from '../../../src/server/directConnectServer'
import { readPidFile } from '../../../src/daemon/pidFile'
import type { ClientInfo } from '../../../src/server/clientRegistry'
import { createClientRegistry } from '../../../src/server/clientRegistry'
import { generateToken } from '../../../src/daemon/authToken'

let tmpDir: string
let server: DirectConnectServerHandle | null = null

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'daemon-ws-'))
})
afterEach(async () => {
  if (server) {
    await server.stop()
    server = null
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

// 小 helper：等 WS 進入特定 readyState
function waitForOpen(ws: WebSocket, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve()
    const t = setTimeout(
      () => reject(new Error(`WS did not open within ${timeoutMs}ms`)),
      timeoutMs,
    )
    ws.addEventListener('open', () => {
      clearTimeout(t)
      resolve()
    })
    ws.addEventListener('error', e => {
      clearTimeout(t)
      reject(new Error(`WS error before open: ${String(e)}`))
    })
  })
}

/**
 * 等 WS 關閉。Bun 的 WebSocket 在 server 硬關時可能不觸發 'close' event
 * 但 readyState 會變 CLOSED；用 poll 雙保險。
 */
function waitForClose(ws: WebSocket, timeoutMs = 3_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve()
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(t)
      clearInterval(poll)
      resolve()
    }
    const t = setTimeout(() => {
      if (done) return
      done = true
      clearInterval(poll)
      reject(new Error(`WS did not close within ${timeoutMs}ms`))
    }, timeoutMs)
    ws.addEventListener('close', () => finish())
    const poll = setInterval(() => {
      if (ws.readyState === WebSocket.CLOSED) finish()
    }, 25)
  })
}

describe('clientRegistry', () => {
  test('register / get / unregister lifecycle', () => {
    const reg = createClientRegistry()
    const fakeSock = { send: () => {}, close: () => {} }
    expect(reg.count()).toBe(0)
    const c = reg.register({
      id: 'c1',
      source: 'repl',
      socket: fakeSock,
    })
    expect(c.id).toBe('c1')
    expect(c.connectedAt).toBeGreaterThan(0)
    expect(reg.count()).toBe(1)
    expect(reg.get('c1')?.source).toBe('repl')
    const removed = reg.unregister('c1')
    expect(removed?.id).toBe('c1')
    expect(reg.count()).toBe(0)
    expect(reg.unregister('nonexistent')).toBeNull()
  })

  test('broadcast hits all matching clients', () => {
    const reg = createClientRegistry()
    const received: string[][] = [[], [], []]
    for (let i = 0; i < 3; i++) {
      const idx = i
      reg.register({
        id: `c${i}`,
        source: i === 0 ? 'repl' : 'discord',
        socket: {
          send: (d: string) => received[idx]!.push(d),
          close: () => {},
        },
      })
    }
    const n = reg.broadcast('hello')
    expect(n).toBe(3)
    expect(received.flat()).toEqual(['hello', 'hello', 'hello'])

    // filter
    const n2 = reg.broadcast('repl-only', c => c.source === 'repl')
    expect(n2).toBe(1)
  })

  test('send targets a specific client', () => {
    const reg = createClientRegistry()
    const got: string[] = []
    reg.register({
      id: 'target',
      source: 'repl',
      socket: { send: (d: string) => got.push(d), close: () => {} },
    })
    expect(reg.send('target', 'hi')).toBe(true)
    expect(reg.send('missing', 'lost')).toBe(false)
    expect(got).toEqual(['hi'])
  })

  test('closeAll clears registry and closes all sockets', () => {
    const reg = createClientRegistry()
    let closed = 0
    reg.register({
      id: 'a',
      source: 'repl',
      socket: {
        send: () => {},
        close: () => {
          closed++
        },
      },
    })
    reg.register({
      id: 'b',
      source: 'discord',
      socket: {
        send: () => {},
        close: () => {
          closed++
        },
      },
    })
    reg.closeAll(1000, 'bye')
    expect(closed).toBe(2)
    expect(reg.count()).toBe(0)
  })
})

describe('directConnectServer — auth', () => {
  test('rejects connection with no Authorization header (401)', async () => {
    const token = generateToken()
    server = await startDirectConnectServer({ token, port: 0 })
    // fetch the upgrade URL without auth
    const res = await fetch(`http://${server.host}:${server.port}/`)
    expect(res.status).toBe(401)
  })

  test('rejects connection with wrong token (403)', async () => {
    const token = generateToken()
    server = await startDirectConnectServer({ token, port: 0 })
    const res = await fetch(`http://${server.host}:${server.port}/`, {
      headers: { authorization: 'Bearer wrongwrongwrong' },
    })
    expect(res.status).toBe(403)
  })

  test('accepts WS upgrade with correct token (header)', async () => {
    const token = generateToken()
    server = await startDirectConnectServer({ token, port: 0 })
    // Bun 接受 `{headers}` 作為 WebSocket 第二個建構子參數（非標準但 bun 支援，
    // 也是 src/server/directConnectManager.ts:56 實際的用法）
    const ws = new WebSocket(`ws://${server.host}:${server.port}/`, {
      headers: { authorization: `Bearer ${token}` },
    } as unknown as string[])
    await waitForOpen(ws)
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
    await waitForClose(ws)
  })

  test('accepts WS upgrade with token query param', async () => {
    const token = generateToken()
    server = await startDirectConnectServer({ token, port: 0 })
    const ws = new WebSocket(
      `ws://${server.host}:${server.port}/?token=${token}`,
    )
    await waitForOpen(ws)
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
    await waitForClose(ws)
  })
})

describe('directConnectServer — messaging', () => {
  test('onMessage receives parsed JSON', async () => {
    const token = generateToken()
    const received: Array<{ client: ClientInfo; msg: unknown }> = []
    server = await startDirectConnectServer({
      token,
      port: 0,
      onMessage: (client, msg) => {
        received.push({ client, msg })
      },
    })
    const ws = new WebSocket(
      `ws://${server.host}:${server.port}/?token=${token}`,
    )
    await waitForOpen(ws)
    ws.send(JSON.stringify({ type: 'user', content: 'hello' }) + '\n')
    ws.send(JSON.stringify({ type: 'user', content: 'world' }) + '\n')
    // 等 server 處理
    await new Promise(r => setTimeout(r, 100))
    expect(received.length).toBe(2)
    expect((received[0]!.msg as { content: string }).content).toBe('hello')
    expect((received[1]!.msg as { content: string }).content).toBe('world')
    ws.close()
    await waitForClose(ws)
  })

  test('malformed JSON is ignored silently', async () => {
    const token = generateToken()
    const received: unknown[] = []
    server = await startDirectConnectServer({
      token,
      port: 0,
      onMessage: (_c, m) => received.push(m),
    })
    const ws = new WebSocket(
      `ws://${server.host}:${server.port}/?token=${token}`,
    )
    await waitForOpen(ws)
    ws.send('{ this is not json\n')
    ws.send(JSON.stringify({ ok: true }) + '\n')
    await new Promise(r => setTimeout(r, 100))
    expect(received.length).toBe(1)
    expect((received[0] as { ok: boolean }).ok).toBe(true)
    ws.close()
    await waitForClose(ws)
  })

  test('server broadcast reaches all connected clients', async () => {
    const token = generateToken()
    server = await startDirectConnectServer({ token, port: 0 })
    const got: Array<string[]> = [[], []]
    const wsA = new WebSocket(
      `ws://${server.host}:${server.port}/?token=${token}`,
    )
    const wsB = new WebSocket(
      `ws://${server.host}:${server.port}/?token=${token}`,
    )
    wsA.addEventListener('message', e => got[0]!.push(String(e.data)))
    wsB.addEventListener('message', e => got[1]!.push(String(e.data)))
    await Promise.all([waitForOpen(wsA), waitForOpen(wsB)])
    // 稍等 register 完成
    await new Promise(r => setTimeout(r, 50))
    const sent = server.broadcast({ type: 'result', text: 'hi' })
    expect(sent).toBe(2)
    await new Promise(r => setTimeout(r, 100))
    expect(got[0]!.length).toBe(1)
    expect(got[1]!.length).toBe(1)
    expect(JSON.parse(got[0]![0]!).text).toBe('hi')
    wsA.close()
    wsB.close()
    await Promise.all([waitForClose(wsA), waitForClose(wsB)])
  })

  test('disconnect triggers cleanup', async () => {
    const token = generateToken()
    const connects: ClientInfo[] = []
    const disconnects: ClientInfo[] = []
    server = await startDirectConnectServer({
      token,
      port: 0,
      onClientConnect: c => connects.push(c),
      onClientDisconnect: c => disconnects.push(c),
    })
    const ws = new WebSocket(
      `ws://${server.host}:${server.port}/?token=${token}`,
    )
    await waitForOpen(ws)
    await new Promise(r => setTimeout(r, 50))
    expect(connects.length).toBe(1)
    expect(server.registry.count()).toBe(1)
    ws.close()
    await waitForClose(ws)
    await new Promise(r => setTimeout(r, 100))
    expect(disconnects.length).toBe(1)
    expect(server.registry.count()).toBe(0)
    expect(disconnects[0]!.id).toBe(connects[0]!.id)
  })

  test('source query param is captured on ClientInfo', async () => {
    const token = generateToken()
    const connects: ClientInfo[] = []
    server = await startDirectConnectServer({
      token,
      port: 0,
      onClientConnect: c => connects.push(c),
    })
    const ws = new WebSocket(
      `ws://${server.host}:${server.port}/?token=${token}&source=repl`,
    )
    await waitForOpen(ws)
    await new Promise(r => setTimeout(r, 50))
    expect(connects[0]!.source).toBe('repl')
    ws.close()
    await waitForClose(ws)
  })
})

describe('startDaemon + WS server integration', () => {
  test('daemon writes actual port to pid.json when enableServer:true', async () => {
    const handle = await startDaemon({
      baseDir: tmpDir,
      agentVersion: 'x',
      registerSignalHandlers: false,
      heartbeatIntervalMs: 60_000,
      port: 0,
    })
    expect(handle.server).not.toBeNull()
    const actualPort = handle.server!.port
    expect(actualPort).toBeGreaterThan(0)
    const pidData = await readPidFile(tmpDir)
    expect(pidData?.port).toBe(actualPort)
    await handle.stop()
  })

  test('daemon with enableServer:false skips server and writes port 0', async () => {
    const handle = await startDaemon({
      baseDir: tmpDir,
      agentVersion: 'x',
      registerSignalHandlers: false,
      heartbeatIntervalMs: 60_000,
      enableServer: false,
    })
    expect(handle.server).toBeNull()
    const pidData = await readPidFile(tmpDir)
    expect(pidData?.port).toBe(0)
    await handle.stop()
  })

  test('end-to-end: client can connect to daemon-hosted server', async () => {
    const received: unknown[] = []
    const handle = await startDaemon({
      baseDir: tmpDir,
      agentVersion: 'x',
      registerSignalHandlers: false,
      heartbeatIntervalMs: 60_000,
      onClientMessage: (_c, m) => received.push(m),
    })
    const ws = new WebSocket(
      `ws://${handle.server!.host}:${handle.server!.port}/?token=${handle.token}`,
    )
    await waitForOpen(ws)
    ws.send(JSON.stringify({ type: 'user', text: 'hi' }) + '\n')
    await new Promise(r => setTimeout(r, 100))
    expect(received.length).toBe(1)
    ws.close()
    await waitForClose(ws)
    await handle.stop()
  })

  test('daemon.stop() closes WS server and disconnects clients', async () => {
    const handle = await startDaemon({
      baseDir: tmpDir,
      agentVersion: 'x',
      registerSignalHandlers: false,
      heartbeatIntervalMs: 60_000,
    })
    const ws = new WebSocket(
      `ws://${handle.server!.host}:${handle.server!.port}/?token=${handle.token}`,
    )
    await waitForOpen(ws)
    await new Promise(r => setTimeout(r, 50))
    expect(handle.server!.registry.count()).toBe(1)
    await handle.stop()
    await waitForClose(ws)
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })
})
