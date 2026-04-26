// M-LLAMACPP-WATCHDOG Phase 2：translateRequestToOpenAI max_tokens ceiling clamp。

import { describe, expect, test } from 'bun:test'
import { translateRequestToOpenAI } from '../../../src/services/api/llamacpp-fetch-adapter.js'
import type { LlamaCppWatchdogConfig } from '../../../src/llamacppConfig/schema.js'

function watchdogCfg(over: Partial<LlamaCppWatchdogConfig> = {}): LlamaCppWatchdogConfig {
  return {
    enabled: true,
    interChunk: { enabled: false, gapMs: 30_000 },
    reasoning: { enabled: false, blockMs: 120_000 },
    tokenCap: {
      enabled: true,
      default: 16_000,
      memoryPrefetch: 256,
      sideQuery: 1_024,
      background: 4_000,
    },
    ...over,
  }
}

describe('translateRequestToOpenAI max_tokens clamp', () => {
  test('watchdog 全關 → max_tokens 不變', () => {
    const cfg = watchdogCfg({
      enabled: false,
      tokenCap: {
        enabled: false,
        default: 100,
        memoryPrefetch: 100,
        sideQuery: 100,
        background: 100,
      },
    })
    const out = translateRequestToOpenAI(
      { max_tokens: 32_000, messages: [{ role: 'user', content: 'hi' }] },
      'qwen-test',
      { watchdogCfg: cfg },
    )
    expect(out.max_tokens).toBe(32_000)
  })

  test('tokenCap 啟用 + caller 超過 ceiling → 被 clamp', () => {
    const out = translateRequestToOpenAI(
      { max_tokens: 32_000, messages: [{ role: 'user', content: 'hi' }] },
      'qwen-test',
      { callSite: 'turn', watchdogCfg: watchdogCfg() },
    )
    expect(out.max_tokens).toBe(16_000)
  })

  test('caller 比 ceiling 小 → 用 caller 的值（不 inflate）', () => {
    const out = translateRequestToOpenAI(
      { max_tokens: 500, messages: [{ role: 'user', content: 'hi' }] },
      'qwen-test',
      { callSite: 'turn', watchdogCfg: watchdogCfg() },
    )
    expect(out.max_tokens).toBe(500)
  })

  test('per call-site：memoryPrefetch ceiling=256，caller 4096 → clamp 256', () => {
    const out = translateRequestToOpenAI(
      { max_tokens: 4096, messages: [{ role: 'user', content: 'hi' }] },
      'qwen-test',
      { callSite: 'memoryPrefetch', watchdogCfg: watchdogCfg() },
    )
    expect(out.max_tokens).toBe(256)
  })

  test('per call-site：background ceiling=4000', () => {
    const out = translateRequestToOpenAI(
      { max_tokens: 16_000, messages: [{ role: 'user', content: 'hi' }] },
      'qwen-test',
      { callSite: 'background', watchdogCfg: watchdogCfg() },
    )
    expect(out.max_tokens).toBe(4_000)
  })

  test('沒指定 callSite → 預設 turn', () => {
    const out = translateRequestToOpenAI(
      { max_tokens: 32_000, messages: [{ role: 'user', content: 'hi' }] },
      'qwen-test',
      { watchdogCfg: watchdogCfg() },
    )
    expect(out.max_tokens).toBe(16_000) // turn ceiling
  })

  test('caller 沒給 max_tokens → 用預設 4096，再 clamp（low ceiling）', () => {
    const cfg = watchdogCfg({
      tokenCap: {
        enabled: true,
        default: 1000,
        memoryPrefetch: 256,
        sideQuery: 1024,
        background: 4000,
      },
    })
    const out = translateRequestToOpenAI(
      { messages: [{ role: 'user', content: 'hi' }] },
      'qwen-test',
      { callSite: 'turn', watchdogCfg: cfg },
    )
    expect(out.max_tokens).toBe(1000) // 4096 → clamp 1000
  })
})
