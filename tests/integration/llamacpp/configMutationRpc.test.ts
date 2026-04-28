// M-LLAMACPP-WATCHDOG Phase 3-9：daemon llamacppConfigRpc 單元測試。

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let tmpDir: string
let tmpConfigPath: string

beforeEach(() => {
  const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8)
  tmpDir = join(tmpdir(), `llamacpp-rpc-${stamp}`)
  mkdirSync(tmpDir, { recursive: true })
  tmpConfigPath = join(tmpDir, 'llamacpp.json')
})

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
})

const realPaths = await import('../../../src/llamacppConfig/paths.js')
mock.module('../../../src/llamacppConfig/paths.js', () => ({
  ...realPaths,
  getLlamaCppConfigPath: () => tmpConfigPath,
}))

async function loadRpc(): Promise<
  typeof import('../../../src/daemon/llamacppConfigRpc.js')
> {
  return await import('../../../src/daemon/llamacppConfigRpc.js')
}

describe('isLlamacppConfigMutationRequest', () => {
  test('合法 setWatchdog frame', async () => {
    const rpc = await loadRpc()
    expect(
      rpc.isLlamacppConfigMutationRequest({
        type: 'llamacpp.configMutation',
        requestId: 'r1',
        op: 'setWatchdog',
        payload: {
          enabled: true,
          interChunk: { enabled: true, gapMs: 30000 },
          reasoning: { enabled: false, blockMs: 120000 },
          tokenCap: {
            enabled: false,
            default: 16000,
            memoryPrefetch: 256,
            sideQuery: 1024,
            background: 4000,
          },
        },
      }),
    ).toBe(true)
  })
  test('未知 op 拒絕', async () => {
    const rpc = await loadRpc()
    expect(
      rpc.isLlamacppConfigMutationRequest({
        type: 'llamacpp.configMutation',
        requestId: 'r1',
        op: 'foo',
        payload: {},
      }),
    ).toBe(false)
  })
  test('type 錯誤拒絕', async () => {
    const rpc = await loadRpc()
    expect(
      rpc.isLlamacppConfigMutationRequest({
        type: 'foo',
        requestId: 'r1',
        op: 'setWatchdog',
        payload: {},
      }),
    ).toBe(false)
  })
})

describe('handleLlamacppConfigMutation', () => {
  test('setWatchdog 寫入 llamacpp.json', async () => {
    const rpc = await loadRpc()
    const watchdog = {
      enabled: true,
      interChunk: { enabled: true, gapMs: 25000 },
      reasoning: { enabled: false, blockMs: 120000 },
      tokenCap: {
        enabled: false,
        default: 16000,
        memoryPrefetch: 256,
        sideQuery: 1024,
        background: 4000,
      },
    }
    const res = await rpc.handleLlamacppConfigMutation({
      type: 'llamacpp.configMutation',
      requestId: 'r1',
      op: 'setWatchdog',
      payload: watchdog,
    })
    expect(res.ok).toBe(true)
    expect(res.requestId).toBe('r1')
    expect(existsSync(tmpConfigPath)).toBe(true)
    const written = JSON.parse(readFileSync(tmpConfigPath, 'utf-8'))
    expect(written.watchdog.enabled).toBe(true)
    expect(written.watchdog.interChunk.gapMs).toBe(25000)
  })

  // ─── M-LLAMACPP-REMOTE：setRemote / setRouting / testRemote ───────────────
  test('setRemote 寫入 remote 區塊', async () => {
    const rpc = await loadRpc()
    const res = await rpc.handleLlamacppConfigMutation({
      type: 'llamacpp.configMutation',
      requestId: 'rm1',
      op: 'setRemote',
      payload: {
        enabled: true,
        baseUrl: 'https://big-rig.example/v1',
        model: 'qwen3.5-32b',
        apiKey: 'sk-test',
        contextSize: 32768,
      },
    })
    expect(res.ok).toBe(true)
    const written = JSON.parse(readFileSync(tmpConfigPath, 'utf-8'))
    expect(written.remote.enabled).toBe(true)
    expect(written.remote.baseUrl).toBe('https://big-rig.example/v1')
    expect(written.remote.apiKey).toBe('sk-test')
  })

  test('setRouting 寫入 routing 表', async () => {
    const rpc = await loadRpc()
    const res = await rpc.handleLlamacppConfigMutation({
      type: 'llamacpp.configMutation',
      requestId: 'rt1',
      op: 'setRouting',
      payload: {
        turn: 'remote',
        sideQuery: 'local',
        memoryPrefetch: 'local',
        background: 'local',
        vision: 'remote',
      },
    })
    expect(res.ok).toBe(true)
    const written = JSON.parse(readFileSync(tmpConfigPath, 'utf-8'))
    expect(written.routing.turn).toBe('remote')
    expect(written.routing.vision).toBe('remote')
    expect(written.routing.sideQuery).toBe('local')
  })

  test('testRemote 成功回 model 名單', async () => {
    const rpc = await loadRpc()
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [{ id: 'qwen3.5-32b' }, { id: 'gemma-3-27b' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch
    try {
      const res = await rpc.handleLlamacppConfigMutation({
        type: 'llamacpp.configMutation',
        requestId: 'tr1',
        op: 'testRemote',
        payload: { baseUrl: 'https://stub.example/v1' },
      })
      expect(res.ok).toBe(true)
      expect(res.data?.models).toEqual(['qwen3.5-32b', 'gemma-3-27b'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('testRemote HTTP 401 → ok=false 帶 status', async () => {
    const rpc = await loadRpc()
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('unauthorized', { status: 401 })) as typeof fetch
    try {
      const res = await rpc.handleLlamacppConfigMutation({
        type: 'llamacpp.configMutation',
        requestId: 'tr2',
        op: 'testRemote',
        payload: { baseUrl: 'https://stub.example/v1', apiKey: 'bad' },
      })
      expect(res.ok).toBe(false)
      expect(res.error).toContain('401')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('broadcastSectionForOp 對應正確', async () => {
    const rpc = await loadRpc()
    expect(rpc.broadcastSectionForOp('setWatchdog')).toBe('watchdog')
    expect(rpc.broadcastSectionForOp('setRemote')).toBe('remote')
    expect(rpc.broadcastSectionForOp('setRouting')).toBe('routing')
    expect(rpc.broadcastSectionForOp('testRemote')).toBe(null)
  })

  test('連續寫入兩次 — 第二次反映新值', async () => {
    const rpc = await loadRpc()
    const baseWd = {
      enabled: true,
      interChunk: { enabled: true, gapMs: 30000 },
      reasoning: { enabled: false, blockMs: 120000 },
      tokenCap: {
        enabled: false,
        default: 16000,
        memoryPrefetch: 256,
        sideQuery: 1024,
        background: 4000,
      },
    }
    await rpc.handleLlamacppConfigMutation({
      type: 'llamacpp.configMutation',
      requestId: 'r1',
      op: 'setWatchdog',
      payload: baseWd,
    })
    await rpc.handleLlamacppConfigMutation({
      type: 'llamacpp.configMutation',
      requestId: 'r2',
      op: 'setWatchdog',
      payload: { ...baseWd, reasoning: { enabled: true, blockMs: 60_000 } },
    })
    const written = JSON.parse(readFileSync(tmpConfigPath, 'utf-8'))
    expect(written.watchdog.reasoning.enabled).toBe(true)
    expect(written.watchdog.reasoning.blockMs).toBe(60_000)
  })
})
