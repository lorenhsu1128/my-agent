/**
 * M-LLAMACPP-REMOTE：resolveEndpoint(callSite) 單元測試。
 *
 * 涵蓋：
 *   - 預設 routing（全 local）下所有 callsite 走頂層 baseUrl/model
 *   - routing 指 remote 但 remote.enabled=false → throw 顯式錯誤
 *   - routing 指 remote 且 remote.enabled=true → 回傳 remote.baseUrl/model/apiKey/contextSize
 *   - 缺 routing 欄位 → 視為 'local'（schema default 已處理）
 *   - vision callsite 已加進 enum 可被 resolve
 */
import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as realPaths from '../../../src/llamacppConfig/paths'
import { _resetLlamaCppConfigForTests } from '../../../src/llamacppConfig/loader'
import type { LlamaCppCallSite } from '../../../src/llamacppConfig/schema'

// 因 configMutationRpc.test.ts 在更前面也 mock.module 了 paths，bun test process
// 內 paths 已被 hijack；本 test 必須用同樣機制（spread real exports + 動態 closure
// 指向當前 configPath）才能拿到我們寫的測試檔。教訓見 LESSONS.md。
let _currentConfigPath = ''
mock.module('../../../src/llamacppConfig/paths.js', () => ({
  ...realPaths,
  getLlamaCppConfigPath: () => _currentConfigPath,
}))

const ALL_CALLSITES: LlamaCppCallSite[] = [
  'turn',
  'sideQuery',
  'memoryPrefetch',
  'background',
  'vision',
]

let testDir: string

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `llamacpp-resolve-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(testDir, { recursive: true })
  _currentConfigPath = join(testDir, 'llamacpp.jsonc')
  _resetLlamaCppConfigForTests()
})

afterEach(() => {
  _resetLlamaCppConfigForTests()
  try {
    rmSync(testDir, { recursive: true, force: true })
  } catch {
    // Windows lock 容忍
  }
})

function writeConfig(content: string): void {
  writeFileSync(_currentConfigPath, content, 'utf-8')
}

describe('resolveEndpoint — 全 local routing（預設）', () => {
  test.each(ALL_CALLSITES)(
    'callsite=%s 走頂層 baseUrl/model',
    async callSite => {
      writeConfig(`{
  "baseUrl": "http://127.0.0.1:8080/v1",
  "model": "qwen3.5-9b-neo",
  "contextSize": 131072
}`)
      const { resolveEndpoint } = await import(
        '../../../src/llamacppConfig/loader'
      )
      const ep = resolveEndpoint(callSite)
      expect(ep.target).toBe('local')
      expect(ep.baseUrl).toBe('http://127.0.0.1:8080/v1')
      expect(ep.model).toBe('qwen3.5-9b-neo')
      expect(ep.contextSize).toBe(131072)
      expect(ep.apiKey).toBeUndefined()
    },
  )
})

describe('resolveEndpoint — routing 指 remote 但 remote.enabled=false', () => {
  test('throw 顯式錯誤帶 callsite 名稱', async () => {
    writeConfig(`{
  "baseUrl": "http://127.0.0.1:8080/v1",
  "model": "qwen3.5-9b-neo",
  "remote": { "enabled": false, "baseUrl": "https://far.example/v1", "model": "qwen-32b" },
  "routing": { "turn": "remote" }
}`)
    const { resolveEndpoint } = await import(
      '../../../src/llamacppConfig/loader'
    )
    expect(() => resolveEndpoint('turn')).toThrow(
      /llamacpp routing=turn→remote/,
    )
    expect(() => resolveEndpoint('turn')).toThrow(/remote\.enabled=true/)
  })

  test('未指 remote 的 callsite 仍走 local 不受影響', async () => {
    writeConfig(`{
  "baseUrl": "http://127.0.0.1:8080/v1",
  "model": "qwen3.5-9b-neo",
  "remote": { "enabled": false, "baseUrl": "https://far.example/v1", "model": "qwen-32b" },
  "routing": { "turn": "remote", "sideQuery": "local" }
}`)
    const { resolveEndpoint } = await import(
      '../../../src/llamacppConfig/loader'
    )
    const ep = resolveEndpoint('sideQuery')
    expect(ep.target).toBe('local')
    expect(ep.baseUrl).toBe('http://127.0.0.1:8080/v1')
  })
})

describe('resolveEndpoint — routing 指 remote 且 remote.enabled=true', () => {
  test('回傳 remote endpoint 內容含 apiKey', async () => {
    writeConfig(`{
  "baseUrl": "http://127.0.0.1:8080/v1",
  "model": "qwen3.5-9b-neo",
  "remote": {
    "enabled": true,
    "baseUrl": "https://big-rig.example/v1",
    "model": "qwen3.5-32b",
    "apiKey": "sk-secret-123",
    "contextSize": 32768
  },
  "routing": { "turn": "remote" }
}`)
    const { resolveEndpoint } = await import(
      '../../../src/llamacppConfig/loader'
    )
    const ep = resolveEndpoint('turn')
    expect(ep.target).toBe('remote')
    expect(ep.baseUrl).toBe('https://big-rig.example/v1')
    expect(ep.model).toBe('qwen3.5-32b')
    expect(ep.apiKey).toBe('sk-secret-123')
    expect(ep.contextSize).toBe(32768)
  })

  test('apiKey 留空時 ep.apiKey 為 undefined', async () => {
    writeConfig(`{
  "baseUrl": "http://127.0.0.1:8080/v1",
  "model": "qwen3.5-9b-neo",
  "remote": {
    "enabled": true,
    "baseUrl": "https://big-rig.example/v1",
    "model": "qwen3.5-32b"
  },
  "routing": { "vision": "remote" }
}`)
    const { resolveEndpoint } = await import(
      '../../../src/llamacppConfig/loader'
    )
    const ep = resolveEndpoint('vision')
    expect(ep.target).toBe('remote')
    expect(ep.apiKey).toBeUndefined()
  })
})

describe('resolveEndpoint — routing 缺欄位', () => {
  test('沒 routing 區塊整個視為全 local', async () => {
    writeConfig(`{
  "baseUrl": "http://127.0.0.1:8080/v1",
  "model": "qwen3.5-9b-neo"
}`)
    const { resolveEndpoint } = await import(
      '../../../src/llamacppConfig/loader'
    )
    for (const cs of ALL_CALLSITES) {
      const ep = resolveEndpoint(cs)
      expect(ep.target).toBe('local')
    }
  })

  test('routing 部分欄位省略 → 該 callsite 走 local', async () => {
    writeConfig(`{
  "baseUrl": "http://127.0.0.1:8080/v1",
  "model": "qwen3.5-9b-neo",
  "remote": { "enabled": true, "baseUrl": "https://far.example/v1", "model": "qwen-32b" },
  "routing": { "turn": "remote" }
}`)
    const { resolveEndpoint } = await import(
      '../../../src/llamacppConfig/loader'
    )
    expect(resolveEndpoint('turn').target).toBe('remote')
    expect(resolveEndpoint('sideQuery').target).toBe('local')
    expect(resolveEndpoint('memoryPrefetch').target).toBe('local')
    expect(resolveEndpoint('background').target).toBe('local')
    expect(resolveEndpoint('vision').target).toBe('local')
  })
})

describe('resolveEndpoint — error message 包前綴 [llamacpp routing=...]', () => {
  test('error message 含 callsite 名稱與目標方便定位', async () => {
    writeConfig(`{
  "baseUrl": "http://127.0.0.1:8080/v1",
  "model": "qwen3.5-9b-neo",
  "remote": { "enabled": false, "baseUrl": "https://far.example/v1", "model": "x" },
  "routing": { "memoryPrefetch": "remote" }
}`)
    const { resolveEndpoint } = await import(
      '../../../src/llamacppConfig/loader'
    )
    let err: unknown
    try {
      resolveEndpoint('memoryPrefetch')
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain(
      '[llamacpp routing=memoryPrefetch→remote]',
    )
  })
})
